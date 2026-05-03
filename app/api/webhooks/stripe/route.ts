import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import {
  updateRecord,
  createRecord,
  getAllRecords,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { sendBrandListingConfirmation, sendFoundingHerdWelcome } from '@/lib/email';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Map metadata.tier (sent by Stripe Payment Link / Checkout) → Founder Tier
// singleSelect value in Airtable + the dollar amount we record on the row.
// `monthly` and `annual` collapse to the same Founder Tier (Herd / Outlaw /
// Steward) — the price separation lives in Stripe, not on our table.
const TIER_MAP: Record<
  string,
  { tier: 'Herd' | 'Outlaw' | 'Steward' | 'Founding 100' | 'Title Founder'; numbered: boolean }
> = {
  'herd-monthly': { tier: 'Herd', numbered: false },
  'herd-annual': { tier: 'Herd', numbered: false },
  'outlaw-monthly': { tier: 'Outlaw', numbered: false },
  'outlaw-annual': { tier: 'Outlaw', numbered: false },
  'steward-monthly': { tier: 'Steward', numbered: false },
  'steward-annual': { tier: 'Steward', numbered: false },
  'founding-100': { tier: 'Founding 100', numbered: true },
  'title-founder': { tier: 'Title Founder', numbered: true },
  // Verification mode — $1 test charge from /founders when FOUNDERS_TEST_MODE=true.
  // Treated as a one-time founder-lifetime so we exercise the full path.
  'test-1': { tier: 'Founding 100', numbered: true },
};

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig || !WEBHOOK_SECRET) {
    console.error('Missing Stripe signature or webhook secret');
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // ------------------------------------------------------------------
  // Convert legacy flat-if to switch so we can add multiple event types
  // (founder churn + invoice failures) without nesting.
  // ------------------------------------------------------------------
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as any;
      const metaType = session.metadata?.type;

      if (metaType === 'brand-listing') {
        // ── BRAND LISTING (Stage 1) — UNCHANGED ──
        return await handleBrandListingCompleted(session);
      }

      if (metaType === 'founder-subscription' || metaType === 'founder-lifetime') {
        // ── FOUNDING HERD (Project 3) ──
        return await handleFounderCheckoutCompleted(session, metaType);
      }

      // Unknown metadata.type — accept the webhook but no-op.
      return NextResponse.json({ received: true });
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as any;
      try {
        await markSubscriptionCancelled(sub.id);
      } catch (e) {
        console.error('Error handling subscription.deleted:', e);
      }
      return NextResponse.json({ received: true });
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as any;
      try {
        await alertInvoicePaymentFailed(invoice);
      } catch (e) {
        console.error('Error handling invoice.payment_failed:', e);
      }
      return NextResponse.json({ received: true });
    }

    default:
      // Ignore unhandled event types — Stripe sends many we don't care about.
      return NextResponse.json({ received: true });
  }
}

// ============================================================================
// Brand listing handler — the original Stage 1 flow, isolated unchanged.
// ============================================================================
async function handleBrandListingCompleted(session: any) {
  const { brandId, brandName } = session.metadata || {};
  if (!brandId) return NextResponse.json({ received: true });

  try {
    await updateRecord(TABLES.BRANDS, brandId, {
      'Payment Status': 'Paid',
      'Featured': true,
      'Stripe Session ID': session.id,
      'Paid At': new Date().toISOString(),
      'Amount Paid': (session.amount_total || 0) / 100,
    });

    if (session.customer_email) {
      await sendBrandListingConfirmation({
        brandName: brandName || 'Your Brand',
        email: session.customer_email,
        amountPaid: `$${((session.amount_total || 0) / 100).toFixed(0)}`,
      });
    }

    try {
      const { sendTelegramUpdate } = await import('@/lib/telegram');
      await sendTelegramUpdate(
        `💰 <b>Brand Payment Received</b>\n\n` +
          `🏷️ <b>${brandName}</b>\n` +
          `📧 ${session.customer_email}\n` +
          `💵 $${((session.amount_total || 0) / 100).toFixed(0)}\n\n` +
          `✅ Brand is now LIVE and featured to all members.`
      );
    } catch (e) {
      console.error('Telegram brand payment notification error:', e);
    }

    console.log(`Brand ${brandId} payment completed — now featured`);
  } catch (error) {
    console.error('Error processing brand payment webhook:', error);
    return NextResponse.json({ error: 'Processing error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// ============================================================================
// Founding Herd handler — subscription + lifetime tiers.
// ============================================================================
//
// Idempotency model — single biggest launch-day defense:
//   1. Look up Consumers by `Stripe Session ID`. If a row already has it set,
//      we already processed this event — return 200 and skip everything.
//   2. Pre-compute the Founder Number (Founding 100 / Title Founder only) from
//      a live Airtable count.
//   3. Upsert the Consumer row (match by email if it exists; otherwise create).
//      Setting `Stripe Session ID` here is the lock — a second concurrent
//      delivery falls into branch (1) on its own write loop.
//   4. Send tier-aware welcome email. If `Founder Welcome Sent At` is already
//      populated, we skip the send (defense-in-depth against retries that
//      somehow bypassed the session lock).
//   5. Telegram alert.
//   6. Set `Founder Welcome Sent At` LAST so the email never double-fires.
async function handleFounderCheckoutCompleted(session: any, metaType: string) {
  const sessionId: string = session.id;
  const tierKey: string = (session.metadata?.tier || '').toString().toLowerCase();
  const mapped = TIER_MAP[tierKey];

  if (!mapped) {
    console.warn(`Founder webhook: unknown tier metadata '${tierKey}', skipping.`);
    return NextResponse.json({ received: true });
  }

  // Email — Stripe Payment Links return on `customer_details.email`; Checkout
  // sessions surface it on `customer_email`. Fall back to the latter for safety.
  const email: string =
    (session.customer_details?.email || session.customer_email || '').toString().trim();

  if (!email) {
    console.error('Founder webhook: no email on session', sessionId);
    return NextResponse.json({ received: true });
  }

  // ── 1. IDEMPOTENCY CHECK (5 LOC, mandatory) ──
  // If any Consumer already has this Stripe Session ID, this event is a retry.
  const existing = await getAllRecords(
    TABLES.CONSUMERS,
    `{Stripe Session ID} = "${escapeAirtableValue(sessionId)}"`
  );
  if (existing.length > 0) {
    console.log(`Founder webhook: session ${sessionId} already processed — skipping.`);
    return NextResponse.json({ received: true, idempotent: true });
  }

  const customerId: string = session.customer || '';
  const subscriptionId: string = session.subscription || '';
  const amountPaidCents: number = session.amount_total || 0;
  const amountPaid = amountPaidCents / 100;
  const nowIso = new Date().toISOString();
  const firstName = (
    session.customer_details?.name ||
    session.metadata?.firstName ||
    ''
  )
    .toString()
    .split(' ')[0] || 'there';

  // ── 2. Founder Number (Founding 100 / Title Founder only) ──
  let founderNumber: number | undefined;
  if (mapped.numbered) {
    try {
      const sameTier = await getAllRecords(
        TABLES.CONSUMERS,
        `{Founder Tier} = "${escapeAirtableValue(mapped.tier)}"`
      );
      founderNumber = sameTier.length + 1;
    } catch (e) {
      console.error('Founder Number count failed:', e);
    }
  }

  // ── 3. Upsert Consumer row ──
  // Match by email so a Founder who's also a buyer keeps one row. NEVER
  // touch Buyer Stage / Buyer Stage Updated At — the two state machines are
  // orthogonal per Stage 1 changelog Section 2.
  const founderFields: any = {
    'Founder Tier': mapped.tier,
    'Stripe Session ID': sessionId,
    'Subscribed At': nowIso,
    'Tier Amount Paid': amountPaid,
    'Backer Type': session.metadata?.backerType === 'Brand' ? 'Brand' : 'Individual',
  };
  if (customerId) founderFields['Stripe Customer ID'] = customerId;
  if (subscriptionId) {
    founderFields['Stripe Subscription ID'] = subscriptionId;
    founderFields['Subscription Status'] = 'active';
  }
  if (typeof founderNumber === 'number') founderFields['Founder Number'] = founderNumber;
  // Wall opt-in ships from the Stripe custom field if collected; otherwise
  // default-true for paid tiers above Herd (the spec's display-by-default rule).
  const wallOptInRaw = (session.metadata?.wallOptIn || '').toString().toLowerCase();
  founderFields['Wall Opt-In'] =
    wallOptInRaw === 'true' || wallOptInRaw === 'yes' || mapped.tier !== 'Herd';

  let consumerId: string;
  let alreadyHadWelcome = false;
  try {
    const byEmail = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(email.toLowerCase())}"`
    );
    if (byEmail.length > 0) {
      const row: any = byEmail[0];
      consumerId = row.id;
      alreadyHadWelcome = !!row['Founder Welcome Sent At'];
      await updateRecord(TABLES.CONSUMERS, consumerId, founderFields);
    } else {
      // Use the customer's full name from Stripe if Stripe gave us one, else
      // fall back to the firstName-only string. `Full Name` is the real
      // Consumers field — there is no `First Name` column.
      const fullName = (
        session.customer_details?.name ||
        session.metadata?.fullName ||
        firstName
      ).toString();
      const created = await createRecord(TABLES.CONSUMERS, {
        ...founderFields,
        Email: email,
        'Full Name': fullName,
        Source: 'founders-page',
        Status: 'Approved',
      });
      consumerId = (created as any).id;
    }
  } catch (e) {
    console.error('Founder upsert failed:', e);
    return NextResponse.json({ error: 'Upsert failed' }, { status: 500 });
  }

  // ── 4. Welcome email (skip if already sent — defense in depth) ──
  if (!alreadyHadWelcome) {
    try {
      await sendFoundingHerdWelcome({
        tier: mapped.tier,
        firstName,
        email,
        founderNumber,
        amountPaid,
      });
    } catch (e) {
      console.error('Founder welcome email failed:', e);
      // fall through — Telegram still fires
    }
  }

  // ── 5. Telegram alert with action buttons ──
  try {
    const { sendTelegramFounderBacker } = await import('@/lib/telegram');
    await sendTelegramFounderBacker({
      email,
      name: firstName,
      tier: mapped.tier,
      founderNumber,
      amountCents: Math.round(amountPaid * 100),
      isLifetime: metaType === 'founder-lifetime',
      consumerId,
    });
  } catch (e) {
    console.error('Telegram founder notification error:', e);
  }

  // ── 6. Set Founder Welcome Sent At LAST (idempotency for email retries) ──
  if (!alreadyHadWelcome) {
    try {
      await updateRecord(TABLES.CONSUMERS, consumerId, {
        'Founder Welcome Sent At': new Date().toISOString(),
      });
    } catch (e) {
      console.error('Failed to set Founder Welcome Sent At:', e);
    }
  }

  return NextResponse.json({ received: true, founderNumber });
}

// ============================================================================
// Subscription churn — flips status to cancelled, alerts Ben.
// ============================================================================
async function markSubscriptionCancelled(subscriptionId: string) {
  if (!subscriptionId) return;
  const matches = await getAllRecords(
    TABLES.CONSUMERS,
    `{Stripe Subscription ID} = "${escapeAirtableValue(subscriptionId)}"`
  );
  if (matches.length === 0) return;
  const row: any = matches[0];
  try {
    await updateRecord(TABLES.CONSUMERS, row.id, {
      'Subscription Status': 'cancelled',
    });
  } catch (e) {
    console.error('Failed to mark subscription cancelled:', e);
  }
  try {
    const { sendTelegramSubscriptionCancelled } = await import('@/lib/telegram');
    await sendTelegramSubscriptionCancelled({
      email: (row['Email'] as string) || '(no email)',
      name: (row['Full Name'] as string) || (row['First Name'] as string) || '',
      tier: (row['Founder Tier'] as string) || '(no tier)',
      consumerId: row.id,
    });
  } catch (e) {
    console.error('Telegram churn notification error:', e);
  }
}

// ============================================================================
// Invoice payment_failed — Telegram only (no DB write yet — past_due is set
// by Stripe on the subscription object, which fires its own update event we
// can wire later if needed).
// ============================================================================
async function alertInvoicePaymentFailed(invoice: any) {
  try {
    const { sendTelegramInvoiceFailed } = await import('@/lib/telegram');
    // Best-effort tier lookup via subscription ID. If miss, blank fine.
    let tier = '(unknown tier)';
    if (invoice.subscription) {
      try {
        const matches = await getAllRecords(
          TABLES.CONSUMERS,
          `{Stripe Subscription ID} = "${escapeAirtableValue(invoice.subscription)}"`
        );
        if (matches.length > 0) {
          tier = ((matches[0] as any)['Founder Tier'] as string) || tier;
        }
      } catch {}
    }
    await sendTelegramInvoiceFailed({
      email: invoice.customer_email || '(no email)',
      name: invoice.customer_name || '',
      tier,
      amountCents: invoice.amount_due || 0,
    });
  } catch (e) {
    console.error('Telegram invoice-failed notification error:', e);
  }

  // Best-effort flip Subscription Status → past_due on the matching row.
  if (invoice.subscription) {
    try {
      const matches = await getAllRecords(
        TABLES.CONSUMERS,
        `{Stripe Subscription ID} = "${escapeAirtableValue(invoice.subscription)}"`
      );
      if (matches.length > 0) {
        await updateRecord(TABLES.CONSUMERS, (matches[0] as any).id, {
          'Subscription Status': 'past_due',
        });
      }
    } catch (e) {
      console.error('Failed to mark past_due:', e);
    }
  }
}
