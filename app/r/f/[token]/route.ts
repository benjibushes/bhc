// GET /r/f/<token> — durable pay link for a referral's FINAL INVOICE.
//
// Port of /r/p (deposit rail, PR #369) to the final-invoice rail. Before this,
// send-final-invoice emailed the raw Stripe-hosted Checkout Session URL, which
// Stripe expires after ~24h, and the dunning cron re-mailed the SAME stored
// dead URL on every reminder — the Dana incident (2026-07-20): link sent
// Jul 15, expired Jul 16, dunning re-sent it dead Jul 19, buyer stuck trying
// to pay $2,249.
//
// The token pins ONE referral, nothing else. At click time this route re-loads
// the referral, re-runs the money gates, then either reuses the stored Stripe
// session (if still open) or mints a FRESH one — so the emailed link can no
// longer die ahead of the buyer, and every dunning reminder is automatically
// live because it re-sends this same durable URL.
//
// ANY failure → 302 to /ranchers, never a 500 — this is a nav GET from an
// email client. Already-paid referrals land on /member?invoice=paid.

import { NextResponse } from 'next/server';
import { verifyFinalInvoiceLinkToken } from '@/lib/finalInvoiceLink';
import { canSendFinalInvoice } from '@/lib/refundLifecycle';
import { createFinalInvoiceCheckout, getStripeClient } from '@/lib/stripeConnect';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { claimOnce } from '@/lib/rancherCapacity';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function redirectBaseFrom(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return SITE_URL;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const base = redirectBaseFrom(req);
  const safeFallback = () => NextResponse.redirect(`${base}/ranchers`, 302);

  let token = '';
  try {
    ({ token } = await params);
  } catch {
    return safeFallback();
  }

  // Light per-IP limit — mirrors /r/p. This route can mint a Stripe session,
  // so it stays limited even though every mint is amount-pinned server-side.
  const ip = getRequestIp(req);
  const rl = await rateLimit(`r-final-link:${ip}`, { requests: 20, window: '1m' });
  if (!rl.ok) return safeFallback();

  const verified = verifyFinalInvoiceLinkToken(token);
  if (!verified.ok) return safeFallback();
  const { referralId } = verified.payload;

  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    return safeFallback();
  }
  if (!referral) return safeFallback();

  // Already settled → the success page, never a fresh charge. settleFinalInvoice
  // flips Closed Won + stamps Final Paid At; either signal means paid.
  const status = String(referral['Status'] || '').trim();
  if (status === 'Closed Won' || String(referral['Final Paid At'] || '').trim()) {
    return NextResponse.redirect(`${base}/member?invoice=paid`, 302);
  }

  // Same pure gate send-final-invoice runs (C2 refund guard + U18 deposit
  // gate): a Refunded / Closed Lost / undeposited referral's durable link must
  // never produce a payable session.
  const gate = canSendFinalInvoice(referral['Status'], referral['Deposit Paid At']);
  if (!gate.ok) return safeFallback();

  // Amount comes ONLY from the referral's stamped field — never the token.
  const balanceDollars = Number(referral['Final Invoice Amount'] || 0);
  const balanceCents = Math.round(balanceDollars * 100);
  if (!Number.isFinite(balanceCents) || balanceCents <= 0) return safeFallback();

  const buyerEmail = String(referral['Buyer Email'] || '').trim();
  if (!buyerEmail) return safeFallback();

  const linkedRanchers: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
  const rancherId = linkedRanchers[0] || '';
  if (!rancherId) return safeFallback();

  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch {
    return safeFallback();
  }
  const connectAccountId = String(rancher?.['Stripe Connect Account Id'] || '').trim();
  if (!connectAccountId) return safeFallback();

  // STAMP THE OPEN — first click only, fire-and-forget, mirrors /r/p. The
  // deposit rail's 'Deposit Link Opened At' was a dead gauge for weeks and
  // made a healthy funnel undiagnosable; the final-invoice rail starts life
  // with its gauge wired.
  try {
    if (!String(referral['Final Invoice Link Opened At'] || '').trim()) {
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Final Invoice Link Opened At': new Date().toISOString(),
      }).catch(() => {});
    }
  } catch {
    /* never block the buyer */
  }

  // Reuse the stored session if it's still open — avoids minting a session per
  // click and keeps the dunning resolver pointed at the session the buyer
  // actually sees.
  const storedSessionId = String(referral['Final Invoice Checkout Session Id'] || '').trim();
  if (storedSessionId) {
    try {
      const stripe = getStripeClient();
      const session: any = await stripe.checkout.sessions.retrieve(storedSessionId, {
        stripeAccount: connectAccountId,
      });
      if (session?.status === 'open' && session?.url) {
        return NextResponse.redirect(String(session.url), 302);
      }
      if (session?.status === 'complete') {
        // Paid but webhook hasn't flipped the referral yet — success page,
        // never a second charge.
        return NextResponse.redirect(`${base}/member?invoice=paid`, 302);
      }
      // expired → fall through to a fresh mint.
    } catch {
      // resource_missing / transient — fall through to a fresh mint; the
      // create call below is the authoritative failure gate.
    }
  }

  // Serialize the fresh mint per referral — the deposit rail guards its create
  // the same way (claimOnce key deposit-create:<id>). Two SIMULTANEOUS /r/f
  // clicks that both find the stored session gone (expired / never stamped)
  // would otherwise both mint = two open sessions on the LARGEST charge, a
  // double-charge window. On lock-held, another click is minting right now:
  // re-read the freshly-stamped session and reuse it rather than minting a
  // second. Degrades OPEN (mints) when Redis is down — the reuse-at-top block
  // still absorbs the common repeat-click case.
  if (!(await claimOnce(`final-mint:${referralId}`, 20))) {
    try {
      const fresh: any = await getRecordById(TABLES.REFERRALS, referralId);
      const sid = String(fresh?.['Final Invoice Checkout Session Id'] || '').trim();
      if (sid) {
        const stripe = getStripeClient();
        const session: any = await stripe.checkout.sessions.retrieve(sid, {
          stripeAccount: connectAccountId,
        });
        if (session?.status === 'open' && session?.url) {
          return NextResponse.redirect(String(session.url), 302);
        }
        if (session?.status === 'complete') {
          return NextResponse.redirect(`${base}/member?invoice=paid`, 302);
        }
      }
    } catch {
      /* fall through to safe fallback — never mint a second session */
    }
    // Couldn't recover the concurrent session — fail safe rather than mint a
    // second one. The buyer can retry; the winner's session will be stamped.
    return safeFallback();
  }

  // Fresh mint. Varying idempotency key — the fixed send-time key would hand
  // back the same expired session for 24h (see createFinalInvoiceCheckout).
  const orderType = String(referral['Order Type'] || 'Beef').trim();
  const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || 'the ranch').trim();
  const buyerLinkedIds: string[] = Array.isArray(referral['Buyer']) ? referral['Buyer'] : [];
  try {
    const result = await createFinalInvoiceCheckout({
      rancherConnectAccountId: connectAccountId,
      amountCents: balanceCents,
      buyerEmail,
      referralId,
      buyerId: buyerLinkedIds[0] || '',
      rancherId,
      productLabel: `${orderType} Final Balance — ${ranchName}`,
      processingDate: String(referral['Processing Date'] || '') || undefined,
      successUrl: `${SITE_URL}/member?invoice=paid`,
      cancelUrl: `${SITE_URL}/member?invoice=canceled`,
      idempotencyKey: `final-invoice-${referralId}-remint-${Date.now()}`,
    });

    // Stamp the fresh session so the dunning heal-or-skip resolver follows the
    // session the buyer can actually pay. Fire-and-forget: a stamp failure
    // must never block the buyer, and settlement anchors on pi.metadata
    // (webhook), not this field.
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Final Invoice Checkout Session Id': result.sessionId,
      ...(result.paymentIntentId
        ? { 'Final Invoice Payment Intent ID': result.paymentIntentId }
        : {}),
    }).catch(() => {});

    return NextResponse.redirect(result.url, 302);
  } catch (e: any) {
    console.error('[r/f] fresh session mint failed:', e?.message);
    return safeFallback();
  }
}
