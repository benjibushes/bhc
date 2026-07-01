import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import {
  FOUNDING_100_CAP,
  TITLE_FOUNDER_CAP,
  getFounding100PriceCents,
  FOUNDERS_TEST_MODE,
} from '@/lib/secrets';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// /api/founders/checkout
//
// Open endpoint (no JWT). Used for tiers we can't safely run as a Stripe
// Payment Link because we need to enforce a hard cap pre-checkout (Founding
// 100 / Title Founder) or expose a verification-mode $1 tier.
//
// Body: { tier: 'founding-100' | 'title-founder' | 'test-1', email?, firstName? }
//
// The 6 subscription tiers + the regular Title Founder $15k tier ship as
// Payment Links rendered directly on /founders. They land in the same Stripe
// webhook with metadata.type = 'founder-subscription' | 'founder-lifetime' and
// metadata.tier = 'herd-monthly' | etc.
//
// Open endpoint (no JWT): the /founders page is the gate and the cap query is
// the safety net. (Historically mirrored the now-removed brand-listing checkout.)
export async function POST(request: Request) {
  try {
    let parsedBody: any;
    try {
      parsedBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const tier: string = (parsedBody?.tier || '').toString().toLowerCase();
    const email: string | undefined = parsedBody?.email
      ? String(parsedBody.email).trim()
      : undefined;
    const firstName: string | undefined = parsedBody?.firstName
      ? String(parsedBody.firstName).trim()
      : undefined;

    if (!tier) {
      return NextResponse.json({ error: 'Missing tier' }, { status: 400 });
    }

    // Resolve tier → Stripe line item + Airtable Founder Tier label for cap query
    let unitAmount: number;
    let productName: string;
    let productDescription: string;
    let founderTierLabel: 'Founding 100' | 'Title Founder';
    let cap: number;
    let metadataTier: string;

    if (tier === 'founding-100') {
      unitAmount = getFounding100PriceCents();
      productName = 'BuyHalfCow Founding 100';
      productDescription =
        'Founding 100 — one-time backer. Numbered. Wall placement. Direct line to Ben. Lifetime perks.';
      founderTierLabel = 'Founding 100';
      cap = FOUNDING_100_CAP;
      metadataTier = 'founding-100';
    } else if (tier === 'title-founder') {
      unitAmount = 1500000; // $15,000
      productName = 'BuyHalfCow Title Founder';
      productDescription =
        'Title Founder — one-time backer. 10 spots. Top of the wall. Co-build access.';
      founderTierLabel = 'Title Founder';
      cap = TITLE_FOUNDER_CAP;
      metadataTier = 'title-founder';
    } else if (tier === 'test-1' && FOUNDERS_TEST_MODE) {
      // $1 verification tier — only exposed when FOUNDERS_TEST_MODE=true.
      // Bypasses cap; tagged so dashboards can filter it out.
      unitAmount = 100;
      productName = 'BuyHalfCow $1 verification';
      productDescription = 'Internal $1 charge for end-to-end webhook verification.';
      founderTierLabel = 'Founding 100';
      cap = Number.MAX_SAFE_INTEGER;
      metadataTier = 'test-1';
    } else {
      return NextResponse.json(
        { error: `Unsupported tier '${tier}' for /api/founders/checkout` },
        { status: 400 }
      );
    }

    // Pre-checkout cap check — best-effort race protection. The Stripe
    // webhook is the second line of defense (refund overflow if it ever
    // happens; we record the Founder Number from the same query at write
    // time, so worst case is over-by-1 and a manual refund).
    if (metadataTier !== 'test-1') {
      try {
        const sold = await getAllRecords(
          TABLES.CONSUMERS,
          `{Founder Tier} = "${escapeAirtableValue(founderTierLabel)}"`
        );
        if (sold.length >= cap) {
          return NextResponse.json(
            { error: `${founderTierLabel} is sold out (${cap}/${cap}).` },
            { status: 409 }
          );
        }
      } catch (e) {
        // Don't block checkout on a transient Airtable error — webhook will
        // catch + refund if the count was actually at cap.
        console.error('Founders cap check failed (continuing):', e);
      }
    }

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      ...(email ? { customer_email: email } : {}),
      metadata: {
        type: 'founder-lifetime',
        tier: metadataTier,
        ...(firstName ? { firstName } : {}),
        backerType: 'Individual',
      },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: productName, description: productDescription },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      success_url: `${SITE_URL}/founders?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/founders?cancelled=1`,
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
      tax_id_collection: { enabled: true },
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error('Founders checkout error:', error);
    return NextResponse.json(
      { error: error?.message || 'Payment error' },
      { status: 500 }
    );
  }
}
