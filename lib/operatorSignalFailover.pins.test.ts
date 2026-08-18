// F13 + F27 (Wave 1 rails, 2026-08-18) — OPERATOR SIGNAL FAILOVER pins.
//
// F13: ~8 money-critical operator alerts used to ride raw sendTelegramMessage
// with NO failover — if Telegram was down, Ben never learned about orphan
// sessions, commission payments (including the AIRTABLE-WRITE-FAILED
// manual-fix variant), deposit balks, or refunds. Each was converted to
// sendOperatorSignal (loud class for action-required, normal for
// celebrations) with a per-event dedupe key. These pins stop a refactor from
// silently reverting any site to the raw wire.
//
// The converted sites are I/O-bound webhook/settlement code that cannot be
// unit-run, so this uses the repo's source-shape pin technique (same as
// lib/brokerSettlement.test.ts §10 and lib/fulfillmentPushRunner.test.ts):
// read the source, extract every sendOperatorSignal({...}) block, and assert
// the money alerts live inside one with the right urgency + dedupe key.
//
// F27: vercel.json cron stagger — campaign-autopilot and rancher-followup
// shared '10 15 * * *' (exact collision, both scanning/writing the same
// Airtable base at the same second against the 5 req/s ceiling). Autopilot
// moved; the duplicate-schedule test below stops the next exact collision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

const SRC = {
  brokerCheckout: read('app/api/checkout/broker/route.ts'),
  stripe: read('app/api/webhooks/stripe/route.ts'),
  stripeConnect: read('app/api/webhooks/stripe-connect/route.ts'),
  stripeSettlement: read('lib/stripeSettlement.ts'),
  brokerSettlement: read('lib/brokerSettlement.ts'),
} as const;

/** Every `sendOperatorSignal({ ... })` argument block in `src`, brace-balanced. */
function signalBlocks(src: string): string[] {
  const out: string[] = [];
  const needle = 'sendOperatorSignal({';
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at < 0) break;
    let i = at + needle.length - 1; // at the opening '{'
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(at, i + 1));
    from = i;
  }
  return out;
}

/** The one signal block whose text contains `signature` — asserts exactly one. */
function blockFor(src: string, signature: string, label: string): string {
  const hits = signalBlocks(src).filter((b) => b.includes(signature));
  assert.equal(
    hits.length,
    1,
    `${label}: expected exactly ONE sendOperatorSignal block containing ${JSON.stringify(signature)}, found ${hits.length} — was the site reverted to raw sendTelegramMessage?`,
  );
  return hits[0];
}

/** Count of RAW `sendTelegramMessage(` call sites (import destructures don't match). */
function rawTelegramCalls(src: string): number {
  return src.split('sendTelegramMessage(').length - 1;
}

// ---------------------------------------------------------------------------
// F13 §1 — the ACTION-REQUIRED set rides LOUD with a per-event dedupe key.
// Loud is what arms the SMS/email fallback in lib/operatorSignal when the
// Telegram wire fails — 'normal' would die silently with Telegram.
// ---------------------------------------------------------------------------

const LOUD_SITES: Array<{ src: keyof typeof SRC; sig: string; dedupe: string; label: string }> = [
  {
    src: 'brokerCheckout',
    sig: 'ORPHAN BROKER SESSION',
    dedupe: 'broker-orphan-session:',
    label: 'checkout/broker orphan session (ledger write + expire both failed)',
  },
  {
    src: 'stripe',
    sig: 'DEPOSIT FAILED — ',
    dedupe: 'deposit-failed:',
    label: 'stripe webhook payment_intent.payment_failed balk',
  },
  {
    src: 'stripe',
    sig: 'DEPOSIT NEEDS AUTH',
    dedupe: 'deposit-needs-auth:',
    label: 'stripe webhook requires_action (3DS) balk',
  },
  {
    src: 'stripe',
    sig: 'ACH/BANK PAYMENT FAILED',
    dedupe: 'async-payment-failed:',
    label: 'stripe webhook async_payment_failed',
  },
  {
    src: 'stripe',
    sig: 'Deposit refunded — PI',
    dedupe: 'deposit-refunded:',
    label: 'stripe webhook charge.refunded (recorded refund)',
  },
  {
    src: 'stripeConnect',
    sig: 'Deposit refunded — PI',
    dedupe: 'deposit-refunded:',
    label: 'stripe-connect webhook charge.refunded (recorded refund)',
  },
  {
    src: 'stripe',
    sig: 'BRAND CANCELLED — ',
    dedupe: 'brand-sub-deleted:',
    label: 'stripe webhook brand subscription deleted (terminal churn)',
  },
];

for (const site of LOUD_SITES) {
  test(`F13 loud: ${site.label}`, () => {
    const block = blockFor(SRC[site.src], site.sig, site.label);
    assert.match(block, /urgency:\s*'loud'/, `${site.label}: must ride LOUD (arms the SMS/email fallback)`);
    assert.ok(
      block.includes(`dedupeKey: \`${site.dedupe}`),
      `${site.label}: must carry a per-event dedupe key starting ${JSON.stringify(site.dedupe)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// F13 §2 — the CELEBRATION set rides normal, still with dedupe keys.
// ---------------------------------------------------------------------------

const NORMAL_SITES: Array<{ src: keyof typeof SRC; sig: string; dedupe: string; label: string }> = [
  {
    src: 'stripe',
    sig: 'Reservation hold paid',
    dedupe: 'reservation-hold-paid:',
    label: 'stripe webhook reservation hold paid',
  },
  {
    src: 'stripe',
    sig: 'INVOICE.UPCOMING',
    dedupe: 'invoice-upcoming-unmatched:',
    label: 'stripe webhook invoice.upcoming data drift',
  },
  {
    src: 'stripe',
    sig: 'BRAND PARTNER — ',
    dedupe: 'brand-partner-tier:',
    label: 'stripe webhook brand partner tier purchase',
  },
  {
    // The alert text is composed above the call, so key on the dedupe prefix.
    src: 'stripe',
    sig: 'founder-sub-updated:',
    dedupe: 'founder-sub-updated:',
    label: 'stripe webhook founder subscription updated',
  },
  {
    src: 'stripeSettlement',
    sig: 'DEPOSIT PAID — Rancher',
    dedupe: 'deposit-paid:',
    label: 'stripeSettlement deposit-paid card',
  },
  {
    src: 'stripeSettlement',
    sig: 'FINAL INVOICE PAID',
    dedupe: 'final-invoice-paid:',
    label: 'stripeSettlement final-invoice-paid card',
  },
  {
    src: 'brokerSettlement',
    sig: 'BROKER DEPOSIT PAID',
    dedupe: 'broker-operator-card-',
    label: 'brokerSettlement operator success card',
  },
];

for (const site of NORMAL_SITES) {
  test(`F13 normal: ${site.label}`, () => {
    const block = blockFor(SRC[site.src], site.sig, site.label);
    assert.match(block, /urgency:\s*'normal'/, `${site.label}: celebrations ride normal`);
    assert.ok(
      block.includes(`dedupeKey: \`${site.dedupe}`),
      `${site.label}: must carry a per-event dedupe key starting ${JSON.stringify(site.dedupe)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// F13 §3 — conditional-urgency sites: the manual-fix variant must be LOUD.
// ---------------------------------------------------------------------------

test('F13: COMMISSION PAID escalates to loud on the AIRTABLE-WRITE-FAILED manual-fix variant', () => {
  const block = blockFor(SRC.stripe, 'COMMISSION PAID', 'commission invoice paid');
  assert.match(
    block,
    /urgency:\s*airtableWriteOk\s*\?\s*'normal'\s*:\s*'loud'/,
    'clean celebration = normal, Airtable-write-failed manual fix = loud',
  );
  assert.ok(block.includes('dedupeKey: `commission-paid:'), 'per-invoice dedupe key');
  assert.ok(block.includes('AIRTABLE WRITE FAILED'), 'the manual-fix wording must survive the conversion');
});

test('F13: brand subscription updated — cancel rides loud, other changes normal', () => {
  const block = blockFor(SRC.stripe, 'brand-sub-updated:', 'brand subscription updated');
  assert.match(
    block,
    /urgency:\s*newStatus\s*===\s*'canceled'\s*\?\s*'loud'\s*:\s*'normal'/,
    'cancel is the save-attempt moment — it must arm the fallback',
  );
});

// ---------------------------------------------------------------------------
// F13 §4 — the raw-wire inventory. Any conversion reverted to raw
// sendTelegramMessage changes these counts and fails here by name.
// Remaining raw sites are DELIBERATE (non-money chatter):
//   stripe route:        1 — tier_v2 pricing-model auto-flip info card
//   stripe-connect:      2 — go-live / Connect-active celebrations (no money
//                            moved; state is mirrored in Airtable + admin)
// ---------------------------------------------------------------------------

test('F13: no raw sendTelegramMessage remains on the money files (pinned inventory)', () => {
  assert.equal(rawTelegramCalls(SRC.brokerCheckout), 0, 'checkout/broker: orphan alert must ride operatorSignal');
  assert.equal(rawTelegramCalls(SRC.stripeSettlement), 0, 'stripeSettlement: both money cards must ride operatorSignal');
  assert.equal(rawTelegramCalls(SRC.brokerSettlement), 0, 'brokerSettlement: operator card must ride operatorSignal');
  assert.equal(
    rawTelegramCalls(SRC.stripe),
    1,
    'stripe webhook: only the tier_v2 auto-flip info card may stay raw — a second raw call means a money alert was reverted',
  );
  assert.equal(
    rawTelegramCalls(SRC.stripeConnect),
    2,
    'stripe-connect webhook: only the two go-live celebrations may stay raw — a third means the refund alert was reverted',
  );
  // The one allowed raw site in the stripe webhook is the tier_v2 card, not a money alert.
  assert.ok(
    SRC.stripe.includes('PRICING MODEL → tier_v2'),
    'the allowed raw stripe-webhook site must be the tier_v2 info card',
  );
});

test('F13: brokerSettlement operator card still tells the delivery truth', () => {
  // The card content itself is pinned by lib/brokerSettlement.test.ts; here we
  // pin that the SIGNAL carries the card verbatim as its detail.
  const block = blockFor(SRC.brokerSettlement, 'BROKER DEPOSIT PAID', 'broker operator card');
  assert.ok(
    block.includes('detail: buildBrokerOperatorCard(facts, delivery)'),
    'the card must ride as the signal detail, delivery-truth intact',
  );
});

// ---------------------------------------------------------------------------
// F27 — cron stagger. Exact schedule collisions hammer the shared Airtable
// base (5 req/s ceiling) at the same second. campaign-autopilot vs
// rancher-followup was the live collision ('10 15 * * *'); the general test
// stops the next one.
// ---------------------------------------------------------------------------

const vercelJson = JSON.parse(read('vercel.json'));
const crons: Array<{ path: string; schedule: string }> = vercelJson.crons || [];

// Exact-schedule pairs allowed to coexist, each with the reason it is safe.
const ALLOWED_EXACT_OVERLAP: Array<{ pair: [string, string]; reason: string }> = [
  {
    pair: ['/api/cron/email-sequences', '/api/cron/product-stock-checkin'],
    reason:
      'disjoint writes: email-sequences writes Consumers/Referrals; product-stock-checkin ' +
      'writes NO business tables (read-only scan + rancher emails) — verified 2026-08-18',
  },
];

test('F27: no two crons share an exact schedule (outside the documented allowlist)', () => {
  const bySchedule = new Map<string, string[]>();
  for (const c of crons) {
    bySchedule.set(c.schedule, [...(bySchedule.get(c.schedule) || []), c.path]);
  }
  const offenders: string[] = [];
  for (const [schedule, paths] of bySchedule) {
    if (paths.length < 2) continue;
    const allowed =
      paths.length === 2 &&
      ALLOWED_EXACT_OVERLAP.some(
        ({ pair }) => pair.includes(paths[0]) && pair.includes(paths[1]) && paths[0] !== paths[1],
      );
    if (!allowed) offenders.push(`'${schedule}' ← ${paths.join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `exact cron schedule collision(s) in vercel.json — stagger them (or add to the ` +
      `allowlist with a disjoint-tables reason): ${offenders.join(' | ')}`,
  );
});

test('F27: campaign-autopilot is staggered ≥10 min from rancher-followup (both daily 15:xx)', () => {
  const get = (path: string) => crons.find((c) => c.path === path)?.schedule;
  const followup = get('/api/cron/rancher-followup');
  const autopilot = get('/api/cron/campaign-autopilot');
  assert.equal(followup, '10 15 * * *', 'rancher-followup keeps its armed slot (autopilot is the one that moved)');
  assert.ok(autopilot, 'campaign-autopilot must stay scheduled');
  const m = /^(\d+) (\d+) \* \* \*$/.exec(autopilot!);
  assert.ok(m, `campaign-autopilot must stay a simple daily cron, got '${autopilot}'`);
  const [, minute, hour] = m!;
  const followupMinutes = 15 * 60 + 10;
  const autopilotMinutes = Number(hour) * 60 + Number(minute);
  assert.ok(
    Math.abs(autopilotMinutes - followupMinutes) >= 10,
    `campaign-autopilot ('${autopilot}') must fire ≥10 min clear of rancher-followup ('${followup}')`,
  );
});
