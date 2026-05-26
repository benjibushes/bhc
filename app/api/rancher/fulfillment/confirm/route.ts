// Stage-3 Task 9 — rancher fulfillment confirmation endpoint.
//
// Rancher hits "Confirm Fulfillment" on /rancher dashboard after the buyer
// has the beef in hand (pickup / delivery / shipped + arrived). For tier_v2
// deposits the funds already settled at charge time via Connect direct
// charge — this endpoint is a STATUS marker, not a payout trigger. Stripe
// Connect pays the rancher's bank automatically per the connected account's
// payout schedule.
//
// What it does:
//   1. Rancher-session JWT auth
//   2. Validate referral exists + rancher owns it
//   3. Validate a succeeded Payments row exists for this referral
//      (no marking fulfillment for a deal that never collected money)
//   4. Stamp Referrals.Fulfillment Confirmed At = now (idempotent — re-confirm is no-op)
//   5. Fire buyer fulfillment-confirmation email (closes the loop)
//   6. Fire Telegram alert to admin (celebration + audit trail)

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { sendBuyerFulfillmentConfirmation } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYMENTS_TABLE = 'Payments';

export async function POST(req: Request) {
  // ── Auth ──
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bhc-rancher-auth');
  if (!sessionCookie?.value) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  let decoded: any;
  try { decoded = jwt.verify(sessionCookie.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'rancher-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }
  const rancherId = String(decoded.rancherId || '');
  if (!rancherId) {
    return NextResponse.json({ error: 'Session missing rancher id' }, { status: 401 });
  }

  // ── Body ──
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const referralId = String(body?.referralId || '').trim();
  const rancherNote = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!referralId) {
    return NextResponse.json({ error: 'referralId required' }, { status: 400 });
  }

  // ── Ownership ──
  const referral: any = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
  if (!referral) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  const rancherLinks: string[] = (referral['Rancher'] || []) as string[];
  if (!Array.isArray(rancherLinks) || !rancherLinks.includes(rancherId)) {
    return NextResponse.json({ error: 'Referral not assigned to this rancher' }, { status: 403 });
  }

  // ── Idempotency ──
  if (referral['Fulfillment Confirmed At']) {
    return NextResponse.json({
      ok: true,
      alreadyConfirmed: true,
      fulfillmentConfirmedAt: referral['Fulfillment Confirmed At'],
    });
  }

  // ── Payment gate ──
  // Don't allow fulfillment confirm without a settled deposit. Either the
  // tier_v2 path (Payments row Status='succeeded') OR the legacy path
  // (Referrals.Payment Confirmed At set by /confirm-payment) qualifies.
  let paymentVerified = false;
  let paymentTier = '';
  let paymentAmountCents = 0;
  try {
    const safeRefId = referralId.replace(/"/g, '\\"');
    const payments: any[] = await getAllRecords(
      PAYMENTS_TABLE,
      `AND(SEARCH("${safeRefId}", ARRAYJOIN({Referral})), {Status} = "succeeded")`,
    );
    if (payments.length > 0) {
      paymentVerified = true;
      paymentTier = String(payments[0]['Tier'] || '');
      paymentAmountCents = Number(payments[0]['Amount Cents'] || 0);
    }
  } catch (e: any) {
    console.warn('[fulfillment/confirm] Payments lookup failed:', e?.message);
  }
  // Payment verification gate. Logic differs by rancher Pricing Model:
  //   - tier_v2 MUST have a Payments row at Status='succeeded'. Legacy
  //     Payment Confirmed At is rancher-self-attested and would let a
  //     tier_v2 rancher bypass Stripe entirely (free fulfillment confirm
  //     = audit security gap surfaced in 2026-05-25 Audit A).
  //   - legacy ranchers can use either Payments row OR Payment Confirmed
  //     At as before.
  const rancherForGate: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
  const rancherPricingModel = String(rancherForGate?.['Pricing Model'] || 'legacy');
  const isTierV2 = rancherPricingModel === 'tier_v2';
  if (isTierV2) {
    if (!paymentVerified) {
      return NextResponse.json({
        error: 'No settled Stripe deposit on this referral. Buyer must pay via the deposit link first.',
        pricingModel: 'tier_v2',
      }, { status: 409 });
    }
  } else if (!paymentVerified && !referral['Payment Confirmed At']) {
    return NextResponse.json({
      error: 'No settled payment on this referral. Confirm payment first.',
    }, { status: 409 });
  }

  // ── Stamp ──
  const now = new Date().toISOString();
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Fulfillment Confirmed At': now,
    });
  } catch (e: any) {
    console.error('[fulfillment/confirm] Airtable update failed:', e);
    return NextResponse.json({ error: 'Could not record fulfillment. Please try again.' }, { status: 500 });
  }

  // ── Buyer email (best-effort — don't block the response on email infra) ──
  try {
    const buyerLinks: string[] = (referral['Buyer'] || []) as string[];
    const buyerId = Array.isArray(buyerLinks) ? buyerLinks[0] : null;
    const buyer: any = buyerId ? await getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null) : null;
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
    if (buyer?.['Email'] && rancher) {
      const firstName = String(buyer['Full Name'] || '').split(' ')[0] || '';
      await sendBuyerFulfillmentConfirmation({
        email: String(buyer['Email']),
        firstName,
        rancherName: String(rancher['Operator Name'] || rancher['Ranch Name'] || 'your rancher'),
        ranchName: String(rancher['Ranch Name'] || rancher['Operator Name'] || ''),
        orderType: String(referral['Order Type'] || ''),
        rancherNote,
      });
    }
  } catch (e: any) {
    console.warn('[fulfillment/confirm] buyer email failed:', e?.message);
  }

  // ── Telegram alert (best-effort) ──
  try {
    const amountDollars = paymentAmountCents ? `$${(paymentAmountCents / 100).toFixed(2)} ` : '';
    const tierTag = paymentTier ? `${paymentTier} tier · ` : '';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `📦 FULFILLMENT CONFIRMED — ${tierTag}${amountDollars}ref=${referralId.slice(-6)}${rancherNote ? `\n💬 ${rancherNote}` : ''}`,
    );
  } catch (e: any) {
    console.warn('[fulfillment/confirm] telegram alert failed:', e?.message);
  }

  return NextResponse.json({ ok: true, fulfillmentConfirmedAt: now });
}
