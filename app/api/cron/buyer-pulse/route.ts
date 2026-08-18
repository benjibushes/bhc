// Buyer-side pulse — the symmetric counterpart to close-detector.
//
// While close-detector asks Ben "did this close?", buyer-pulse asks the
// BUYER directly: "did your rancher reach out?"
//
// Why this matters: Russell at Gift Farms calls within hours; Ace at High
// Lonesome doesn't. Without inbound capture, you couldn't see WHICH rancher
// was ghosting which buyer. The buyer's "No — never heard back" answer is
// pure gold — it pinpoints the ghosting rancher without nagging them.
//
// FLOW:
//   1. Daily, scan referrals stuck in Intro Sent for 5+ days where no
//      buyer-side pulse has been sent yet.
//   2. Email the buyer a 3-button check-in:
//        ✅ Yes — connecting now
//        ❌ No — never heard back
//        🤔 Yes but stalled
//   3. Each button is a unique URL with a JWT — when the buyer clicks,
//      `/api/buyer-pulse-response` records the answer + Telegrams Ben.
//   4. Mark `Buyer Pulse Sent At` so we don't re-ask.
//
// IDEMPOTENT: each buyer gets at most ONE pulse per intro.
//
// DAY-5 COLLISION FIX (Wave 2 buyer-comms, 2026-08-01): referral-chasup fires
// its own day-5 buyer follow-up ~1h after this cron, and neither rail read the
// other's stamp — the same buyer got two "did the rancher reach out?" emails
// back to back, and with both riding the capped generic 'sendEmail' template
// the 3/week cap ate one while its claim-before-send stamp was already burnt.
// Now:
//   • this cron SKIPS any referral chasup touched in the last
//     CROSS_RAIL_COOLDOWN_DAYS ('Last Chased At' — chasup's stamp);
//   • the send uses its own whitelisted templateName 'buyer_pulse_check_in';
//   • the 'Buyer Pulse Sent At' stamp is written AFTER {success:true}, so a
//     suppressed/failed send no longer burns the once-ever stamp with nothing
//     delivered. Double-send protection while the stamp is un-written comes
//     from a Redis claimOnce per referral (degrades open only when Redis is
//     absent, i.e. local dev).

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { isSmsWindow } from '@/lib/sendWindow';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { railForLoadedRancher, referralCarriesBrokerMarker, rancherIdForReferral } from '@/lib/brokerDownstream';
import { claimOnce } from '@/lib/rancherCapacity';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// Days post-intro before we ask. Real conversations start within a few
// days when the rancher's awake. 5 days = enough lag that ghosting is
// the most likely explanation for silence.
const MIN_DAYS_SINCE_INTRO = 5;
// Per-run cap to spread sends + avoid spam-flag heuristics.
const MAX_PULSES_PER_RUN = 25;
// Cross-rail cooldown vs referral-chasup: if chasup emailed this buyer within
// this window, defer the pulse to a later run (the referral stays unpulsed, so
// nothing is lost — it just doesn't stack two check-ins in one inbox day).
const CROSS_RAIL_COOLDOWN_DAYS = 2;

const rf = (v: any) => v == null ? '' : (typeof v === 'object' && 'name' in v) ? String(v.name) : String(v);

async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  {
    const now = Date.now();

    const referrals = await getAllRecords(
      TABLES.REFERRALS,
      '{Status} = "Intro Sent"'
    ) as any[];
    const ranchers = await getAllRecords(TABLES.RANCHERS) as any[];
    const ranchersById = new Map(ranchers.map((r: any) => [r.id, r]));

    // Filter to ones aged into the pulse window + not already pulsed
    let brokerSkipped = 0;
    const candidates = referrals.filter((r: any) => {
      const introAt = r['Intro Sent At'] || r['Approved At'];
      if (!introAt) return false;
      const days = (now - new Date(introAt).getTime()) / DAY_MS;
      if (days < MIN_DAYS_SINCE_INTRO) return false;
      if (r['Buyer Pulse Sent At']) return false; // already pulsed
      // BROKER RAIL (comms containment 2026-08-18): "did your rancher reach
      // out?" — on the broker rail nobody was ever going to (the ranch never
      // sees the buyer pre-deposit), the question contradicts the deposit
      // chase running on the same row, and the "ghosted" tap triggers
      // Connect-shaped remediation. Marker first, then the already-loaded
      // Ranchers row through the shared predicate — fail-closed (an unlinked
      // referral or missing rancher row reads broker) to a counted skip.
      if (
        referralCarriesBrokerMarker(r) ||
        railForLoadedRancher(ranchersById.get(rancherIdForReferral(r))) === 'broker'
      ) {
        brokerSkipped++;
        return false;
      }
      // CROSS-READ referral-chasup's stamp: chasup emailed this buyer within
      // the cooldown window → defer (don't stack two check-ins in one day).
      const lastChased = r['Last Chased At'];
      if (lastChased) {
        const daysSinceChase = (now - new Date(lastChased).getTime()) / DAY_MS;
        if (Number.isFinite(daysSinceChase) && daysSinceChase < CROSS_RAIL_COOLDOWN_DAYS) {
          return false;
        }
      }
      const buyerLinks = r['Buyer'] || [];
      return Array.isArray(buyerLinks) && buyerLinks.length > 0;
    });

    candidates.sort((a: any, b: any) => {
      const aTime = new Date(a['Intro Sent At'] || a['Approved At']).getTime();
      const bTime = new Date(b['Intro Sent At'] || b['Approved At']).getTime();
      return aTime - bTime;
    });

    const targets = candidates.slice(0, MAX_PULSES_PER_RUN);

    let sent = 0, failed = 0;
    const skippedReasons: string[] = [];

    for (const ref of targets) {
      try {
        const buyerId = (ref['Buyer'] as string[])[0];
        const buyer = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
        if (!buyer) continue;
        const buyerEmail = (buyer['Email'] || '').toString().trim();
        if (!buyerEmail) continue;
        if (buyer['Unsubscribed'] || buyer['Bounced'] || buyer['Complained']) continue;

        const buyerName = (buyer['Full Name'] || '').toString();
        const firstName = buyerName.split(' ')[0] || 'there';

        const rancherLinks = ref['Rancher'] || ref['Suggested Rancher'] || [];
        const rancherId = Array.isArray(rancherLinks) ? rancherLinks[0] : null;
        const rancher = rancherId ? ranchersById.get(rancherId) : null;
        const rancherName = rancher
          ? ((rancher as any)['Operator Name'] || (rancher as any)['Ranch Name'] || 'your rancher')
          : (rf(ref['Suggested Rancher Name']) || 'your rancher');

        // Generate signed click tokens for each button. Short-lived (14d).
        const mkToken = (answer: string) =>
          jwt.sign(
            { type: 'buyer-pulse', referralId: ref.id, buyerId, answer },
            JWT_SECRET,
            { expiresIn: '14d' }
          );
        const yesUrl = `${SITE_URL}/api/buyer-pulse?token=${mkToken('connected')}`;
        const noUrl = `${SITE_URL}/api/buyer-pulse?token=${mkToken('ghosted')}`;
        const stalledUrl = `${SITE_URL}/api/buyer-pulse?token=${mkToken('stalled')}`;

        const html = `<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}
.c{max-width:560px;margin:0 auto;background:white;padding:36px 32px;border:1px solid #A7A29A}
h1{font-family:Georgia,serif;font-size:24px;margin:0 0 16px}
p{margin:14px 0;color:#2A2A2A;font-size:15px}
.btn{display:block;padding:14px 24px;text-align:center;text-decoration:none;font-weight:600;letter-spacing:0.5px;margin:10px 0;border:1px solid #0E0E0E}
.yes{background:#0E0E0E;color:#F4F1EC!important}
.no{background:#FFF;color:#0E0E0E!important}
.stalled{background:#FFF;color:#0E0E0E!important}
.foot{margin-top:24px;padding-top:16px;border-top:1px solid #E5E2DC;font-size:11px;color:#A7A29A}
</style></head><body><div class="c">
<h1>Quick check-in, ${esc(firstName)}</h1>
<p>I introduced you to <strong>${esc(rancherName)}</strong> a few days ago. Just making sure they reached out — and if not, fixing it.</p>
<p>One tap below:</p>
<a href="${yesUrl}" class="btn yes">✅ YES — we're connecting</a>
<a href="${noUrl}" class="btn no">❌ NO — never heard from them</a>
<a href="${stalledUrl}" class="btn stalled">🤔 YES but stalled / questions</a>
<p style="margin-top:24px;font-size:13px;color:#6B6B6B;">If you tap "No," I'll personally fix it — find you a different rancher or get this one moving today. No pressure either way.</p>
<p style="margin-top:18px;">— Benjamin</p>
<div class="foot"><p style="margin:0;">BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901</p></div>
</div></body></html>`;

        // STAMP-AFTER-SUCCESS (Wave 2 collision fix): the old claim-before-send
        // order meant a cap-suppressed send burnt the once-ever stamp with
        // nothing delivered. Now the Redis claimOnce guards the un-stamped
        // window (a crashed run or failed stamp write cannot double-send
        // within the claim TTL), the send happens on its own whitelisted
        // template, and the Airtable stamp is written only on {success:true}.
        const won = await claimOnce(`buyer-pulse:${ref.id}`, 14 * 24 * 60 * 60);
        if (!won) continue; // another run (or a stamp-write-failed prior run) holds it

        const result = await sendEmail({
          to: buyerEmail,
          subject: `${firstName}, did ${rancherName} reach out?`,
          html,
          templateName: 'buyer_pulse_check_in',
          // Tagged Reply-To: replies thread back to this referral
          _replyContext: { type: 'ref', recordId: ref.id },
        } as any);

        if (!result?.success) {
          // Suppressed (unsub/bounce) or failed — nothing was delivered, so
          // do NOT burn the once-ever stamp. The Redis claim throttles retries.
          failed++;
          continue;
        }

        try {
          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Buyer Pulse Sent At': new Date().toISOString(),
          });
        } catch (fieldErr: any) {
          // Email already went out — surface the broken stamp loudly. The
          // 14-day Redis claim above prevents a re-send while this is broken.
          if (skippedReasons.length === 0) {
            skippedReasons.push(`"Buyer Pulse Sent At" stamp write FAILED after a delivered pulse — Redis claim is the only dedupe until the field is fixed. (${fieldErr?.message})`);
          }
        }

        // G14: SMS day-4-ish check-in alongside the email. Higher open rate
        // than email; lifts pulse-response rate which feeds ghosting signal.
        // Fire-and-forget — never block the per-referral loop on a Twilio
        // hiccup. F-3 / P4-D audit fix: routed through sendSMSToConsumer which
        // gates on SMS Opt-In + Unsubscribed.
        //
        // TCPA QUIET-HOURS GATE (8pm-8am local): only text inside the buyer's
        // local SMS window (isSmsWindow — lib/sendWindow.ts, same gate the
        // demand-router uses). The pulse EMAIL already fired above, so skipping
        // the SMS outside the window just forgoes the bonus channel — no
        // quiet-hours text. The pulse is stamped once, so this referral won't
        // re-pulse later; SMS is best-effort by design.
        if (isSmsWindow(buyer['State'], Date.now())) {
          sendSMSToConsumer({
            consumer: buyer,
            body: `hey ${firstName} — quick check in. did ${rancherName} text you yet? reply 1=yes 2=no 3=need help. reply STOP to opt out. — Ben`,
            reason: 'buyer-pulse day-5 check-in',
          }).catch(() => {});
        }

        sent++;
        await new Promise((r) => setTimeout(r, 600));
      } catch (e: any) {
        failed++;
        console.error('[buyer-pulse] failed for ref', ref.id, e?.message);
      }
    }

    if (sent > 0) {
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `📨 <b>Buyer pulse swept</b>\n\n` +
          `Sent ${sent} buyer-side check-in${sent === 1 ? '' : 's'}\n` +
          `Stale Intro Sent referrals scanned: ${candidates.length}\n` +
          `Failed: ${failed}` +
          (skippedReasons.length ? `\n\n⚠️ ${skippedReasons[0]}` : '') +
          `\n\n<i>Each buyer can tap ✅ ❌ or 🤔. Replies stream into Telegram.</i>`
        );
      } catch {}
    }

    return {
      status: failed > 0 ? 'partial' : 'success',
      recordsTouched: sent,
      notes: `sent=${sent} failed=${failed} candidates=${candidates.length} brokerSkipped=${brokerSkipped}${skippedReasons.length ? ` warn=${skippedReasons[0].slice(0, 80)}` : ''}`,
    };
  }
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('buyer-pulse', realHandler)(request);
}

export const GET = authedHandler;

function esc(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
