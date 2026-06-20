import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { addCalPrefill } from '@/lib/calPrefill';
import { getOperatorBookingUrl } from '@/lib/calBooking';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { requireRole } from '@/lib/adminAuth';

// POST /api/admin/ranchers/[id]/send-v2-upgrade
//
// Sends a tier_v2 upgrade invite to an existing live rancher. Migrates them
// from the legacy invoice-offline model to the platform-collected deposit
// model (Stripe Connect direct charges + BHC final invoice tooling).
//
// Flow when rancher clicks link:
//   1. Lands in /rancher/setup wizard with a fresh 60-day token
//   2. Wizard detects existing data, jumps past confirmed steps
//   3. Picks a subscription tier (Pasture / Ranch / Operator)
//   4. Completes Stripe Connect onboarding
//   5. Sets per-tier Deposit + Processing Fee amounts (already in Step 3)
//   6. Pricing Model flips to 'tier_v2'
//   7. Next buyer match shows Reserve-Your-Share deposit CTA in intro email
//
// Why this exists: 16 of 16 live ranchers are on legacy as of 2026-06-03.
// Standardizing the funnel to handle deposits means migrating all of them.
// This endpoint is the canonical operator-side trigger.

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
// Ben's Cal.com migration-call link is now resolved at request time via
// getOperatorBookingUrl() (lib/calBooking.ts) — single source of truth that
// fetches the operator's LIVE Cal event via CAL_API_KEY and falls back to
// /contact if no live event exists. The old hardcoded slug 404'd after the
// Cal events were deleted (incident 2026-06-14).
// 14-day soft-cutover deadline. After this, migration-deadline-pause cron
// flips non-upgraded ranchers to Paused status (stops routing). Plenty of
// runway for a 5-min wizard + 15-min call.
const MIGRATION_DEADLINE_DAYS = 14;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const internalHeader = request.headers.get('x-internal-secret') || '';
    const isInternal = INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
    if (!isInternal) {
      // Opened to 'onboarding' partner: sending tier_v2 upgrade invites is a
      // core onboarding task; sends only to the rancher, no consumer PII.
      const unauthorized = await requireRole(request, ['admin', 'onboarding']);
      if (unauthorized) return unauthorized;
    }

    const { id } = await context.params;
    if (!id || !id.startsWith('rec')) {
      return NextResponse.json({ error: 'Invalid rancher id' }, { status: 400 });
    }

    let rancher: any;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, id);
    } catch {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }
    if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

    const email: string = (rancher['Email'] || '').toString().trim();
    if (!email) {
      return NextResponse.json({ error: 'Rancher has no email on file' }, { status: 400 });
    }
    const name: string = (rancher['Operator Name'] || rancher['Ranch Name'] || '').toString();
    const firstName = name.split(' ')[0] || 'there';
    const ranchName: string = (rancher['Ranch Name'] || name).toString();

    // Idempotency: if rancher is already tier_v2, refuse politely so admin
    // doesn't accidentally re-invite. They can still hit the regular
    // resend-setup if they need wizard access for a different reason.
    const currentPM = String(rancher['Pricing Model'] || '').toLowerCase();
    if (currentPM === 'tier_v2') {
      return NextResponse.json({
        error: 'Rancher is already on tier_v2 — no upgrade invite needed',
        currentPricingModel: currentPM,
      }, { status: 409 });
    }

    // 60-day token, same shape as resend-setup. Wizard handles re-entry
    // gracefully via its localStorage-keyed step persistence + Stripe
    // resume hooks. Lands at Step 0 by default; the wizard auto-skips
    // confirmed steps based on data already in Airtable.
    const token = jwt.sign({ type: 'rancher-setup', rancherId: id }, JWT_SECRET, { expiresIn: '60d' });
    const setupUrl = `${SITE_URL}/rancher/setup?token=${token}`;

    // Migration deadline = invite send + 14 days. Soft cutover: ranchers
    // who don't complete the upgrade by this date get auto-paused (no
    // more leads) until they finish. Surfaced in email so the rancher
    // sees the urgency.
    const deadline = new Date(Date.now() + MIGRATION_DEADLINE_DAYS * 24 * 60 * 60 * 1000);

    // Resolve the operator booking link at request time (single source of
    // truth). Never throws; falls back to /contact if no live Cal event.
    const benMigrationCalUrl = await getOperatorBookingUrl('rancher');

    const subject = `${firstName} — buyers can pay you direct now`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;margin:0 0 20px 0;">${firstName}, buyers can pay you direct now</h1>

<p>Hey ${firstName} — for a while I've wanted buyers to pay you directly through BuyHalfCow instead of you chasing invoices. I had to get the payment setup approved to move money on your behalf. That's done. So I'm turning it on for the ranchers actually moving beef — and ${ranchName} is one of them.</p>

<p><strong>What changes:</strong></p>
<ul style="color:#2A2A2A;line-height:1.8;">
  <li><strong>Buyers reserve their share with a deposit that lands in YOUR Stripe account same-day.</strong> Money down means they show up — no ghosting.</li>
  <li><strong>I run every buyer call + qualification.</strong> You just fulfill the order.</li>
  <li><strong>Same beef, same payout</strong> — I collect the commission once, up front, instead of chasing it after the close.</li>
</ul>

<p><strong>Your options</strong> (start small, upgrade anytime):</p>

<table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;color:#2A2A2A;">
  <tr style="background:#FFFFFF;">
    <td style="border:1px solid #A7A29A;padding:10px 14px;"><strong>Legacy Connect — keep your 10%, $0/mo</strong></td>
    <td style="border:1px solid #A7A29A;padding:10px 14px;">Deposits + I run the calls. Most ranchers start here.</td>
  </tr>
  <tr style="background:#F4F1EC;">
    <td style="border:1px solid #A7A29A;padding:10px 14px;"><strong>Pasture — $150/mo · 7%</strong></td>
    <td style="border:1px solid #A7A29A;padding:10px 14px;">Listing, landing page, buyer matching.</td>
  </tr>
  <tr style="background:#FFFFFF;">
    <td style="border:1px solid #A7A29A;padding:10px 14px;"><strong>Ranch — $350/mo · 3%</strong></td>
    <td style="border:1px solid #A7A29A;padding:10px 14px;">+ priority routing, quarterly copy rewrites, social features.</td>
  </tr>
  <tr style="background:#F4F1EC;">
    <td style="border:1px solid #A7A29A;padding:10px 14px;"><strong>Operator — $500/mo · 0%</strong></td>
    <td style="border:1px solid #A7A29A;padding:10px 14px;">+ done-for-you marketing. Zero commission.</td>
  </tr>
</table>

<p><strong>Two ways to go:</strong></p>

<div style="background:#FFFFFF;border:2px solid #0E0E0E;padding:22px;margin:20px 0;">
  <p style="margin:0 0 6px 0;font-family:Georgia,serif;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#0E0E0E;">Set it up myself (5 min)</p>
  <p style="margin:8px 0;font-size:14px;color:#2A2A2A;">Pick your plan, connect your bank, set your deposit — taking orders the same day. Have your business info + bank account handy.</p>
  <div style="text-align:center;margin:16px 0 4px;">
    <a href="${setupUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Set it up myself →</a>
  </div>
</div>

<div style="background:#FFFFFF;border:2px solid #6B4F3F;padding:22px;margin:20px 0;">
  <p style="margin:0 0 6px 0;font-family:Georgia,serif;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6B4F3F;">Book 15 min with me</p>
  <p style="margin:8px 0;font-size:14px;color:#2A2A2A;">Questions, or want to do it together? Grab a slot and I'll set you up live on the call.</p>
  <div style="text-align:center;margin:16px 0 4px;">
    <a href="${addCalPrefill(benMigrationCalUrl, { name, email, metadata: { rancherId: id } })}" style="display:inline-block;padding:14px 32px;background:#FFFFFF;color:#0E0E0E;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;border:1px solid #0E0E0E;">Book 15 min →</a>
  </div>
</div>

<p style="font-size:14px;color:#6B4F3F;">Hit reply with any questions — I read every email.</p>

<p style="font-size:14px;color:#6B4F3F;">— Ben, BuyHalfCow</p>
</body></html>`;

    let sendOk = true;
    let sendErr = '';
    try {
      const r: any = await sendEmail({
        to: email,
        subject,
        html,
        // T2 (2026-06-10): tag templateName so frequency-cap whitelist
        // bypasses the 3/wk cap. Migration invite is revenue-critical
        // (closes legacy → tier_v2 transition).
        templateName: 'sendV2UpgradeInvite',
        // Tag Reply-To so the rancher's reply lands in the inbound webhook
        // + Conversations table for tracking who has questions vs who acts.
        _replyContext: { type: 'rnc', recordId: id },
      } as any);
      if (r && r.suppressed) { sendOk = false; sendErr = r.reason ?? 'suppressed'; }
    } catch (e: any) {
      sendOk = false;
      sendErr = e?.message || 'unknown';
    }

    if (!sendOk) {
      console.error('Send v2 upgrade invite failed:', sendErr);
      return NextResponse.json({ error: 'Email send failed', detail: sendErr }, { status: 502 });
    }

    // Stamp invite send + migration deadline + status so the adoption funnel
    // dashboard + migration-deadline crons have everything they need.
    try {
      await updateRecord(TABLES.RANCHERS, id, {
        'V2 Upgrade Invite Sent At': new Date().toISOString(),
        'Migration Deadline': deadline.toISOString(),
        'Migration Status': 'invited',
      });
    } catch (e: any) {
      // Field may not exist yet — non-fatal. Telemetry only.
      console.warn('Could not stamp migration fields:', e?.message);
    }

    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🚀 <b>V2 upgrade invite sent</b>\n\n🤠 ${name}\n📧 ${email}\nState: ${rancher['State'] || '?'}\nCurrent: legacy\nLink valid 60d.`
      );
    } catch {}

    return NextResponse.json({ success: true, sentTo: email, setupUrl });
  } catch (error: any) {
    console.error('send-v2-upgrade error:', error);
    return NextResponse.json({ error: 'Could not send upgrade invite' }, { status: 500 });
  }
}
