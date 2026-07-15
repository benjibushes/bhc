import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

// Stuck-onboarding nudge cron. Runs daily 16:00 UTC.
//
// Stuck-buckets the platform was previously not nudging:
//   - Connect-stuck (started Stripe Connect KYC, never finished, page not live)
//   - Live-no-deposits (tier_v2, Page Live = true, Connect never went active —
//     the page is up but every buyer deposit is blocked)
//   - Onboarding Status = 'Call Complete' (had the call, never finished wizard)
//   - Onboarding Status = 'Docs Sent' (got setup link, never opened it)
//   - Agreement Signed = true AND Page Live = false (signed but didn't finish
//     pricing / about / logo / payment link → batch-approve gate not met)
//
// Cadence per rancher: day 3, day 7, day 14 since the relevant timestamp
// (every bucket carries a fallback anchor chain so a missing stamp can never
// hide a rancher from this rail).
// After day 14 we stop emailing and Telegram-ping admin for manual outreach —
// ONCE per rancher per bucket ('Stuck Escalated At' + 'Stuck Escalated
// Bucket' terminal markers; a bucket change re-arms exactly one escalation).
// Uses a per-rancher "Last Onboarding Nudge At" stamp to throttle.
//
// Why this exists: 31 ranchers currently stuck mid-funnel with zero
// platform-driven follow-up. Same network density they would deliver if
// completed = ~30 more states routable.

export const maxDuration = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// Per-run ceiling — protects sender reputation under cohort growth.
// Matches existing caps on buyer-pulse + email-sequences.
const MAX_PER_RUN = 25;

function mintSetupUrl(rancherId: string): string {
  const token = jwt.sign({ type: 'rancher-setup', rancherId }, JWT_SECRET, { expiresIn: '60d' });
  return `${SITE_URL}/rancher/setup?token=${token}`;
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

function pickNudgeBucket(d: number): 'day3' | 'day7' | 'day14' | null {
  if (d >= 14) return 'day14';
  if (d >= 7) return 'day7';
  if (d >= 3) return 'day3';
  return null;
}

function emailHtml(name: string, missing: string[], setupUrl: string, dayBucket: string): string {
  const list = missing.length
    ? `<ul style="color:#6B4F3F;line-height:1.8;">${missing.map((m) => `<li>${m}</li>`).join('')}</ul>`
    : '';
  const urgency =
    dayBucket === 'day14'
      ? `<p><strong>This is your final automated nudge.</strong> If now isn't the right time, just reply STOP and we'll close your account cleanly.</p>`
      : `<p>5 minutes and you're live + receiving buyer leads.</p>`;
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;margin:0 0 18px 0;">${name.split(' ')[0]} — you're almost live</h1>
<p>You started your BuyHalfCow setup but haven't finished. We've got buyers in your area waiting.</p>
${missing.length ? `<p><strong>To go live, we still need:</strong></p>${list}` : ''}
<div style="text-align:center;margin:32px 0;">
  <a href="${setupUrl}" style="display:inline-block;padding:16px 40px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Finish Setup</a>
</div>
${urgency}
<p style="font-size:14px;color:#6B4F3F;margin-top:24px;">Questions? Reply to this email.<br>— Benjamin, BuyHalfCow</p>
</body></html>`;
}

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const all = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const results: any[] = [];
  let sent = 0;
  let escalated = 0;

  for (const r of all) {
    if (sent + escalated >= MAX_PER_RUN) {
      console.log(`[onboarding-stuck] hit MAX_PER_RUN=${MAX_PER_RUN}, stopping`);
      break;
    }
    if (r['Unsubscribed']) continue;
    const onboarding = (r['Onboarding Status'] || '').toString();
    const agreementSigned = !!r['Agreement Signed'];
    const pageLive = !!r['Page Live'];

    // Pick anchor date based on bucket.
    let anchorISO: string | null = null;
    let bucketLabel = '';
    const missing: string[] = [];

    const connectAcct = !!(r['Stripe Connect Account Id'] || r['Stripe Account Id']);
    const connectActive = String(r['Stripe Connect Status'] || '').toLowerCase() === 'active';
    const isTierV2 = String(r['Pricing Model'] || '').toLowerCase() === 'tier_v2';

    if (connectAcct && !connectActive && !pageLive) {
      // CONNECT-STUCK — started Stripe Connect KYC but never finished. The #1
      // silent drop-off: previously NO bucket caught them, so a rancher who
      // abandoned the bank/SSN step just vanished with zero follow-up. Anchor on
      // when they started. The fallback chain matters: tier/select persisted the
      // Connect account WITHOUT stamping 'Connect Started At' (only connect/start
      // stamped it — fixed now, but historical rows carry a null anchor), so
      // fall through signed → docs → record creation; no rancher is unreachable.
      anchorISO =
        r['Connect Started At'] || r['Agreement Signed At'] || r['Docs Sent At'] || r._createdTime || null;
      bucketLabel = 'connect-stuck';
      missing.push('Finish connecting your bank with Stripe — about 5 minutes, then buyers can pay you');
    } else if (isTierV2 && pageLive && !connectActive) {
      // LIVE-NO-DEPOSITS — page is live but Stripe Connect never went active, so
      // every buyer deposit is blocked (tier_v2 eligibility requires
      // Connect=active). Both the bucket above and signed-no-page below exclude
      // Page Live=true, which left the realest stuck cohort — signed ranchers
      // sitting live for months at Connect='onboarding' — with zero chasing.
      // Same anchor fallback chain as connect-stuck so a missing stamp can't
      // hide them.
      anchorISO =
        r['Connect Started At'] || r['Agreement Signed At'] || r['Docs Sent At'] || r._createdTime || null;
      bucketLabel = 'live-no-deposits';
      missing.push(
        "Your page is live, but you can't take buyer deposits until you finish connecting your bank with Stripe — about 5 minutes"
      );
    } else if (agreementSigned && !pageLive) {
      anchorISO = r['Agreement Signed At'] || null;
      bucketLabel = 'signed-no-page';
      if (!r['Slug']) missing.push('A URL slug (in My Page tab)');
      if (!(r['Quarter Price'] || r['Half Price'] || r['Whole Price'])) missing.push('At least one price');
      // tier_v2 collects via Stripe Connect, never a legacy Payment Link — asking
      // them for a "payment link" was the confusing wrong message the audit flagged.
      if (isTierV2) {
        if (!connectActive) missing.push('Connect your bank with Stripe');
      } else if (!(r['Quarter Payment Link'] || r['Half Payment Link'] || r['Whole Payment Link'])) {
        missing.push('At least one payment link (Square / Stripe / PayPal)');
      }
    } else if (onboarding === 'Call Complete') {
      // Fallback chain (mirrors the connect buckets above): the status is
      // routinely hand-set in Airtable WITHOUT its timestamp — a stampless
      // rancher previously got days=null → continue → invisible to this rail
      // forever. Every fallback is at-or-before the true anchor, so the nudge
      // can only fire LATER than day 3, never early.
      anchorISO = r['Call Completed At'] || r['Docs Sent At'] || r._createdTime || null;
      bucketLabel = 'call-complete';
      missing.push('Sign the partner agreement (1 click in the setup wizard)');
    } else if (onboarding === 'Docs Sent') {
      // Same fallback rationale — send-onboarding's own failure path even
      // instructs hand-setting 'Docs Sent' without the timestamp.
      anchorISO = r['Docs Sent At'] || r['Call Completed At'] || r._createdTime || null;
      bucketLabel = 'docs-sent';
      missing.push('Open your setup link and finish the wizard');
    } else {
      continue;
    }

    // GO-LIVE-READY GUARD (silent-skip fix): the `signed-no-page` bucket fires on
    // (Agreement Signed && !Page Live). But a rancher who signed AND already has
    // slug + price (+ Connect active for tier_v2 / payment link for legacy) has
    // NOTHING left to do — they're fully eligible and the rancher-go-live-sync
    // cron (06:30 UTC daily) will flip them Active/Live. Nudging them anyway sends
    // a self-contradicting "you're 1 step from live, finish setup" email with an
    // EMPTY checklist, burning sender reputation on a rancher who did everything
    // right. Skip them here and let go-live-sync own the flip. (connect-stuck and
    // the call-complete/docs-sent buckets always have a concrete missing item, so
    // this only short-circuits the genuinely-done signed-no-page case.)
    if (bucketLabel === 'signed-no-page' && missing.length === 0) {
      console.log(`[onboarding-stuck] skip go-live-ready rancher ${r.id} — go-live-sync will flip`);
      continue;
    }

    const days = daysSince(anchorISO || undefined);
    if (days === null || days < 3) continue;
    const bucket = pickNudgeBucket(days);
    if (!bucket) continue;

    // Throttle: don't re-send same bucket within 4 days.
    const lastNudgeISO: string | undefined = r['Last Onboarding Nudge At'] || undefined;
    const sinceLast = daysSince(lastNudgeISO);
    if (sinceLast !== null && sinceLast < 4) continue;

    const email = (r['Email'] || '').toString().trim();
    const name = (r['Operator Name'] || r['Ranch Name'] || 'Rancher').toString();

    if (bucket === 'day14') {
      // Hand off to admin instead of emailing again. Manual outreach
      // beats automation past 2 weeks of silence.
      //
      // TERMINAL STATE: this branch used to re-Telegram the SAME rancher
      // every 4 days forever (the throttle only spaces the pings) — eating
      // MAX_PER_RUN slots and training ops to ignore the channel. Escalate
      // ONCE per rancher per bucket: stamp 'Stuck Escalated At' + the bucket
      // label, then skip while the stamp matches. A rancher who PROGRESSES
      // (bucket changes) earns exactly one fresh escalation for the new
      // bucket. A stamped record with no bucket on file (field created after
      // the stamp, or bucket field missing in the base) is treated as
      // terminal — conservative: stopping the spam is the point.
      const escalatedBucket = String(r['Stuck Escalated Bucket'] || '');
      if (r['Stuck Escalated At'] && (!escalatedBucket || escalatedBucket === bucketLabel)) {
        continue; // already escalated for this bucket — terminal, no re-ping
      }
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚨 <b>STUCK ONBOARDING (14d)</b>\n\n${name}\n${email}\nBucket: ${bucketLabel}\nMissing: ${missing.join('; ') || '(see record)'}\n\n<i>Bot has nudged 3x with no progress. Call them or close the loop manually. This is the ONE escalation for this rancher/bucket — no repeats.</i>`
        );
        escalated++;
        // Stamp throttle + terminal marker. 'Stuck Escalated At' /
        // 'Stuck Escalated Bucket' may not exist in the Airtable base yet
        // (possibly-missing-field pattern, cf. Previous Slugs in
        // landing-page): retry with just the throttle stamp so the run never
        // crashes — behavior simply degrades to the old 4-day re-ping until
        // the fields are created.
        try {
          await updateRecord(TABLES.RANCHERS, r.id, {
            'Last Onboarding Nudge At': new Date().toISOString(),
            'Stuck Escalated At': new Date().toISOString(),
            'Stuck Escalated Bucket': bucketLabel,
          });
        } catch (stampErr: any) {
          console.warn(
            '[onboarding-stuck] terminal-stamp failed (create Stuck Escalated At + Stuck Escalated Bucket fields on Ranchers to enable one-shot escalation):',
            stampErr?.message
          );
          await updateRecord(TABLES.RANCHERS, r.id, {
            'Last Onboarding Nudge At': new Date().toISOString(),
          });
        }
        results.push({ id: r.id, name, action: 'escalated-to-admin', bucket: bucketLabel });
      } catch (e: any) {
        console.error('Escalation failed:', e?.message);
      }
      continue;
    }

    if (!email) continue;
    try {
      // Claim BEFORE sending: stamp the throttle first so a stamp failure skips
      // + retries rather than re-nudging. (A suppressed/failed send after the
      // claim simply won't retry — fine for a 1-step-from-live nudge.)
      await updateRecord(TABLES.RANCHERS, r.id, {
        'Last Onboarding Nudge At': new Date().toISOString(),
      });
      const setupUrl = mintSetupUrl(r.id);
      const result: any = await sendEmail({
        to: email,
        subject: `${name.split(' ')[0]}, you're 1 step from live on BuyHalfCow`,
        html: emailHtml(name, missing, setupUrl, bucket),
        _replyContext: { type: 'rnc', recordId: r.id },
      } as any);
      if (result?.suppressed) {
        console.error('Stuck-onboarding send suppressed:', result.reason ?? 'no reason');
        continue;
      }
      sent++;
      results.push({ id: r.id, name, action: `sent-${bucket}`, bucket: bucketLabel });
    } catch (e: any) {
      console.error('Stuck-onboarding send error:', e?.message);
    }
  }

  if (sent + escalated > 0) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📬 <b>Onboarding-stuck cron</b>\n\nNudged: ${sent}\nEscalated to you: ${escalated}\nTotal touched: ${sent + escalated}`
      );
    } catch {}
  }

  return {
    status: 'success',
    recordsTouched: sent + escalated,
    notes: `sent=${sent} escalated=${escalated}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('onboarding-stuck', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
