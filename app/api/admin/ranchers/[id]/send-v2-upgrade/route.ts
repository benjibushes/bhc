import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { addCalPrefill } from '@/lib/calPrefill';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { requireAdmin } from '@/lib/adminAuth';

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
// Ben's Cal.com migration-call link. Rancher books a 15-min walkthrough
// to ensure flawless tier_v2 transition (subscription pick + Connect KYC
// + per-tier deposits). Embedded in every upgrade invite email so the
// rancher can self-schedule without back-and-forth.
const BEN_MIGRATION_CAL_URL =
  process.env.NEXT_PUBLIC_BEN_MIGRATION_CAL_URL ||
  'https://cal.com/ben-beauchman-1itnsg/15min';
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
      const unauthorized = await requireAdmin(request);
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
    const deadlineLabel = deadline.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    const subject = `${firstName} — quick payout upgrade for ${ranchName} (5-min + optional call)`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;margin:0 0 20px 0;">${firstName}, time to upgrade your payout flow</h1>

<p>Hey ${firstName} — I've been refining the BuyHalfCow funnel and I'm standardizing how everyone handles deposits. Right now you're on the original model where you invoice the customer offline. The new model is better for you, the buyer, and the long-term health of the platform.</p>

<p><strong>What changes for you:</strong></p>
<ul style="color:#2A2A2A;line-height:1.8;">
  <li><strong>Stripe Connect direct charges</strong> — buyers pay deposit on the platform, money lands in YOUR Stripe account same-day. No invoice-then-wait dance.</li>
  <li><strong>Locked-in commitment</strong> — buyers who pay deposit don't ghost. Conversion goes up; rancher time wasted goes down.</li>
  <li><strong>BHC handles final invoice too</strong> — when processing's done, one click in your dashboard fires the final invoice to the buyer (BHC takes 0% on the final).</li>
  <li><strong>Same commission rate</strong> — your existing cut doesn't change. We just collect it once at deposit instead of after the close.</li>
</ul>

<p><strong>Two paths — pick what works for you:</strong></p>

<div style="background:#FFFFFF;border:2px solid #0E0E0E;padding:22px;margin:20px 0;">
  <p style="margin:0 0 6px 0;font-family:Georgia,serif;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#0E0E0E;">Option A — DIY in the wizard (5 min)</p>
  <p style="margin:8px 0;font-size:14px;color:#2A2A2A;">If you're comfortable with Stripe + can paste in your deposit numbers, knock it out solo:</p>
  <ol style="color:#2A2A2A;line-height:1.7;margin:8px 0;padding-left:22px;font-size:14px;">
    <li>Pick subscription tier (Pasture $150 / Ranch $350 / Operator $500 per mo)</li>
    <li>Stripe Connect onboarding (business info + bank account)</li>
    <li>Set per-tier deposits + processing fees</li>
  </ol>
  <div style="text-align:center;margin:16px 0 4px;">
    <a href="${setupUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Start the upgrade →</a>
  </div>
</div>

<div style="background:#FFFFFF;border:2px solid #6B4F3F;padding:22px;margin:20px 0;">
  <p style="margin:0 0 6px 0;font-family:Georgia,serif;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6B4F3F;">Option B — book a 15-min walkthrough with me</p>
  <p style="margin:8px 0;font-size:14px;color:#2A2A2A;">Prefer to do it together so nothing falls through cracks? Grab a slot — I'll screen-share and walk you through every step. Bring your deposit/processing numbers + your bank info handy.</p>
  <div style="text-align:center;margin:16px 0 4px;">
    <a href="${addCalPrefill(BEN_MIGRATION_CAL_URL, { name, email, metadata: { rancherId: id } })}" style="display:inline-block;padding:14px 32px;background:#FFFFFF;color:#0E0E0E;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;border:1px solid #0E0E0E;">Book your 15-min call →</a>
  </div>
</div>

<div style="background:#FFF6E0;border:1px solid #C99A2E;padding:14px 18px;margin:24px 0;">
  <p style="margin:0;font-size:14px;color:#0E0E0E;"><strong>Heads up — deadline ${deadlineLabel}.</strong> After that date, ranchers still on the old model are paused from receiving new leads until they upgrade. Plenty of runway (14 days) to either DIY or book a call.</p>
</div>

<p style="font-size:14px;color:#6B4F3F;"><strong>Why now:</strong> we're about to put real ad spend behind the platform. Standardizing the deposit flow means every buyer sees the same checkout — fewer questions, more closes, faster cash to your account.</p>

<p style="font-size:14px;color:#6B4F3F;">Hit reply with any questions — I read every email.</p>

<p style="font-size:14px;color:#6B4F3F;">— Benjamin, BuyHalfCow</p>
</body></html>`;

    let sendOk = true;
    let sendErr = '';
    try {
      const r: any = await sendEmail({
        to: email,
        subject,
        html,
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
