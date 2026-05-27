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

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendSMS } from '@/lib/twilio';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
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
    const candidates = referrals.filter((r: any) => {
      const introAt = r['Intro Sent At'] || r['Approved At'];
      if (!introAt) return false;
      const days = (now - new Date(introAt).getTime()) / DAY_MS;
      if (days < MIN_DAYS_SINCE_INTRO) return false;
      if (r['Buyer Pulse Sent At']) return false; // already pulsed
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

        await sendEmail({
          to: buyerEmail,
          subject: `${firstName}, did ${rancherName} reach out?`,
          html,
          // Tagged Reply-To: replies thread back to this referral
          _replyContext: { type: 'ref', recordId: ref.id },
        } as any);

        // G14: SMS day-4-ish check-in alongside the email. Higher open rate
        // than email; lifts pulse-response rate which feeds ghosting signal.
        // Fire-and-forget — never block the per-referral loop on a Twilio
        // hiccup, and never re-pulse (gated above by Buyer Pulse Sent At).
        // TODO: gate on explicit SMS opt-in field once captured at signup.
        const buyerPhone = (buyer['Phone'] || '').toString().trim();
        if (buyerPhone) {
          sendSMS({
            to: buyerPhone,
            body: `hey ${firstName} — quick check in. did ${rancherName} text you yet? reply 1=yes 2=no 3=need help — Ben`,
          }).catch(() => {});
        }

        // Mark pulsed so we don't re-ask
        try {
          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Buyer Pulse Sent At': new Date().toISOString(),
          });
        } catch (fieldErr: any) {
          if (skippedReasons.length === 0) {
            skippedReasons.push(`Add "Buyer Pulse Sent At" datetime field to Referrals table — until then, pulses re-fire each run. (${fieldErr?.message})`);
          }
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
      notes: `sent=${sent} failed=${failed} candidates=${candidates.length}${skippedReasons.length ? ` warn=${skippedReasons[0].slice(0, 80)}` : ''}`,
    };
  }
}

async function authedHandler(request: Request): Promise<Response> {
  const { CRON_SECRET } = await import('@/lib/secrets');
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
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
