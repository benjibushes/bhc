// POST /api/checkout/broker — BROKER RAIL deposit checkout.
//
// The buyer pays a deposit that goes 100% to BuyHalfCow's OWN Stripe account
// and stays there. That deposit IS the commission for brokering the sale. The
// rancher is represented, not onboarded: no Connect, no payout, no invoice.
// See docs/BUSINESS-MODEL.md → "Money model 3" and lib/brokerRail.ts.
//
// Structure and validation idioms mirror app/api/checkout/deposit/route.ts —
// the CSRF origin guard, resolveDepositAuth, buyer-ownership check, terminal-
// status gate, concurrent-create claim, and the record-then-expire orphan
// prevention are all deliberately the same. What is NOT shared is the money:
// no Connect account is read, no application_fee is computed, and nothing is
// routed to a connected account.
//
// GET ?refId=X — the broker checkout page's data load.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createBrokerCheckout, expireBrokerCheckoutSession } from '@/lib/brokerCheckout';
import { recordBrokerDeposit } from '@/lib/contracts/payments';
import {
  assertBrokerEligible,
  brokerBalanceNote,
  brokerFulfillmentSteps,
  brokerAdditionalCosts,
  referralRailForRancher,
  CUT_LABELS,
  type Cut,
} from '@/lib/brokerRail';
import { resolveDepositAuth } from '@/lib/buyerAuth';
import { claimOnce } from '@/lib/rancherCapacity';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { isDepositAlreadyPaid } from '@/lib/depositPaidState';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

/**
 * Resolve the referral's pinned rancher and REFUSE unless the rail is
 * unambiguously 'broker'. Fail-closed by construction: a missing rancher, an
 * unreadable rancher, or a rancher flagged BOTH broker and Connect all refuse.
 */
async function loadBrokerRancher(
  referral: any,
): Promise<{ ok: true; rancherId: string; rancher: any } | { ok: false; res: NextResponse }> {
  const rancherLinks: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
  const rancherId = rancherLinks[0];
  if (!rancherId) {
    return {
      ok: false,
      res: NextResponse.json({ error: 'no_rancher', message: 'No rancher on referral' }, { status: 409 }),
    };
  }
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch {
    // Unreadable rancher = unknown rail. NEVER guess with money.
    return {
      ok: false,
      res: NextResponse.json({ error: 'load_failed' }, { status: 503 }),
    };
  }
  const rail = referralRailForRancher(rancher);
  if (rail === 'ambiguous') {
    console.error(
      `[checkout/broker] AMBIGUOUS RAIL for rancher ${rancherId} — flagged Broker Rail AND carrying a Stripe Connect footprint. Refusing to charge.`,
    );
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'ambiguous_rail', message: 'This ranch is misconfigured — we can\'t take a payment for it. Please contact us.' },
        { status: 409 },
      ),
    };
  }
  if (rail !== 'broker') {
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: 'not_broker_rail',
          message: 'This ranch checks out through our standard flow.',
          redirectUrl: `/checkout/${referral.id}/deposit`,
        },
        { status: 409 },
      ),
    };
  }
  return { ok: true, rancherId, rancher };
}

// ---------------------------------------------------------------------------
// POST — create the Checkout Session
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  // CSRF defense in depth — Origin allowlist on top of the SameSite=lax cookie.
  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const referralId = String(body.referralId || '').trim();
  const cut = String(body.cutSize || body.cut || '').toLowerCase() as Cut;
  if (!referralId) return NextResponse.json({ error: 'referralId required' }, { status: 400 });
  if (!CUT_LABELS[cut]) {
    return NextResponse.json({ error: 'cutSize must be quarter|half|whole' }, { status: 400 });
  }

  // AUTH — member session OR the referral-scoped deposit grant. Identical to
  // the Connect deposit route: resolveDepositAuth pins the grant to THIS
  // referralId, so a forwarded link's grant can't pay a different referral.
  const session = await resolveDepositAuth(req, referralId);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!referral) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  // OWNERSHIP — the authed buyer must own this referral.
  const buyerLinks: string[] = referral['Buyer'] || [];
  if (!buyerLinks.includes(session.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Terminal-status / re-pay guard. Same semantics as the Connect rail: a
  // settled deposit stamps 'Deposit Paid At'; a merely REQUESTED deposit stays
  // payable (the 2026-07-14 bricked-buyer bug).
  const refStatus = String(referral['Status'] || '');
  if (refStatus === 'Closed Won' || refStatus === 'Closed Lost' || isDepositAlreadyPaid(referral)) {
    return NextResponse.json(
      {
        error: 'referral_closed',
        status: refStatus,
        message:
          refStatus === 'Closed Lost'
            ? 'This reservation is closed — contact us to re-route.'
            : 'This reservation is already paid. Check your email for the confirmation.',
      },
      { status: 409 },
    );
  }

  const loaded = await loadBrokerRancher({ ...referral, id: referralId });
  if (!loaded.ok) return loaded.res;
  const { rancherId, rancher } = loaded;

  // THE MONEY GATES — priced, has a deposit, deposit < price, broker rail,
  // and no Connect footprint. All pure + unit tested (lib/brokerRail.test.ts).
  const gate = assertBrokerEligible(rancher, cut);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.code, message: gate.error }, { status: gate.status });
  }
  const { quote } = gate;

  const buyerEmail = String(referral['Buyer Email'] || '').trim();
  if (!buyerEmail) {
    return NextResponse.json({ error: 'Buyer email missing on referral' }, { status: 409 });
  }

  // Serialize concurrent session creates per referral (two tabs, two cuts).
  // 30s TTL matches the Connect rail so a cancel-then-retry buyer isn't walled.
  let claimed = true;
  try {
    claimed = await claimOnce(`broker-create:${referralId}`, 30);
  } catch (e: any) {
    console.warn('[checkout/broker] create claim errored (allowing):', e?.message);
    claimed = true;
  }
  if (!claimed) {
    return NextResponse.json(
      {
        error: 'checkout_in_progress',
        message:
          'Hang on — a checkout for this reservation was just started (maybe in another tab). Use that tab, or give it ~30 seconds and try again.',
      },
      { status: 409 },
    );
  }

  const productLabel = `${quote.cutLabel} — ${rancher['Ranch Name'] || rancher['Operator Name']}`;

  let result;
  try {
    result = await createBrokerCheckout({
      depositCents: quote.depositCents,
      priceCents: quote.priceCents,
      cut,
      buyerEmail,
      referralId,
      buyerId: session.consumerId,
      rancherId,
      productLabel,
      successUrl: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${SITE_URL}/checkout/${referralId}/broker?canceled=1`,
    });
  } catch (e: any) {
    // Log the technical detail server-side ONLY; return a stable machine code
    // and customer-safe copy (never the raw Stripe string).
    console.error('[checkout/broker] Stripe Checkout create failed:', e?.message);
    return NextResponse.json(
      { error: 'checkout_failed', message: 'We could not start your reservation. Your card was not charged.' },
      { status: 500 },
    );
  }

  // Record the pending ledger row BEFORE the buyer can pay. If this fails the
  // buyer must NOT reach Stripe — a paid PI with no Payments row is invisible
  // to settlement (an orphan deposit). Expire the session and fail the request.
  try {
    await recordBrokerDeposit({
      referralId,
      buyerId: session.consumerId,
      rancherId,
      depositCents: quote.depositCents,
      stripePaymentIntentId: result.paymentIntentId,
      stripeCheckoutSessionId: result.sessionId,
      buyerEmail,
    });
  } catch (e: any) {
    console.error('[checkout/broker] recordBrokerDeposit failed — expiring Stripe Session:', e?.message);
    try {
      await expireBrokerCheckoutSession(result.sessionId);
    } catch (expireErr: any) {
      console.error(
        '[checkout/broker] CRITICAL: session expire ALSO failed — orphan risk:',
        expireErr?.message,
        'sessionId:', result.sessionId,
      );
      try {
        const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚨 <b>ORPHAN BROKER SESSION</b>\n\nLedger write + expire both failed.\n\nSession: <code>${result.sessionId}</code>\nReferral: ${referralId}\n\n<i>Expire it in the Stripe Dashboard NOW or the buyer can pay with no record.</i>`,
        );
      } catch {}
    }
    return NextResponse.json({ error: 'Could not record deposit. Please try again.' }, { status: 500 });
  }

  // MONEY TRUTH PERSISTED, not just logged (repo rule #2). Stamp the intent on
  // the referral now, before the buyer pays, so an abandoned broker checkout is
  // still visible as "we asked for this money on this rail". Best-effort: a
  // stamp failure must never block the money path.
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Deposit Requested At': new Date().toISOString(),
      'Deposit Amount': quote.depositCents / 100,
      'Total Sale Amount': quote.priceCents / 100,
      'Order Type': quote.cutLabel,
      'Terms Accepted At': new Date().toISOString(),
    });
  } catch (stampErr: any) {
    console.warn('[checkout/broker] pre-payment referral stamp failed (non-blocking):', stampErr?.message);
  }

  return NextResponse.json({ url: result.url });
}

// ---------------------------------------------------------------------------
// GET ?refId=X — data for the broker checkout page
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const url = new URL(req.url);
  const referralId = url.searchParams.get('refId') || '';
  if (!referralId) return NextResponse.json({ error: 'refId required' }, { status: 400 });

  const session = await resolveDepositAuth(req, referralId);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!referral) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerLinks: string[] = referral['Buyer'] || [];
  if (!buyerLinks.includes(session.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const refStatus = String(referral['Status'] || '');
  if (refStatus === 'Closed Won' || refStatus === 'Closed Lost' || isDepositAlreadyPaid(referral)) {
    return NextResponse.json(
      {
        error: 'referral_closed',
        status: refStatus,
        message: 'This reservation is already paid. Check your email for the confirmation.',
      },
      { status: 409 },
    );
  }

  const loaded = await loadBrokerRancher({ ...referral, id: referralId });
  if (!loaded.ok) return loaded.res;
  const { rancher } = loaded;

  // Per-cut quotes for every cut this ranch can actually sell on this rail.
  const cuts = (['quarter', 'half', 'whole'] as Cut[])
    .map((c) => {
      const g = assertBrokerEligible(rancher, c);
      if (!g.ok) return null;
      return {
        slug: c,
        label: g.quote.cutLabel,
        priceCents: g.quote.priceCents,
        // The buyer-facing number: what the card is charged today.
        dueNowCents: g.quote.depositCents,
        balanceCents: g.quote.balanceCents,
      };
    })
    .filter(Boolean);

  return NextResponse.json({
    rancher: {
      name: String(rancher['Operator Name'] || rancher['Ranch Name'] || ''),
      ranchName: String(rancher['Ranch Name'] || ''),
      state: String(rancher['State'] || ''),
    },
    rail: 'broker',
    balanceNote: brokerBalanceNote(rancher),
    // Fulfillment transparency, projected from the SAME already-fetched rancher
    // record — no second round trip. Both are commonly empty ([] / ''), and the
    // page renders nothing at all in that case.
    fulfillmentSteps: brokerFulfillmentSteps(rancher),
    additionalCosts: brokerAdditionalCosts(rancher),
    cuts,
  });
}
