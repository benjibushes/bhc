// META_CLOSE_PURCHASE_ENABLED must be the ONE authority on whether a
// Closed-Won `Purchase` reaches Meta.
//
// WHAT THESE PROTECT. There used to be two close-Purchase fire sites:
//   • the ATTRIBUTED one (lib/contracts/rancher → fireClosePurchaseIfEnabled),
//     gated `if (!closePurchaseEnabled()) return;`, and
//   • a LEGACY unattributed one inside settleFinalInvoice, gated on the
//     NEGATION — `!closePurchaseEnabled() && shouldFireClosePurchase(...)`.
// The negation was a mutual-exclusion guard (only one of the two may fire),
// not a polarity slip — but its consequence was that NO setting of the flag
// ever made the close Purchase dark. Off shipped the legacy fire; on shipped
// the attributed one. A flag whose documented contract is "OFF (default): no
// new data leaves for Meta" has to have an off position, and this one is the
// gate the privacy-policy precondition hangs on. The event it was shipping
// carries `value` = the FULL share price (~$2,999) on a final-invoice close
// where BHC's own incremental take was $0 — the single worst number in the
// account to teach value-based bidding.
//
// The legacy site is gone. These pins hold the contract that replaced it:
//   flag off → nothing reaches graph.facebook.com, from EITHER entry point;
//   flag on  → exactly one attributed Purchase, carrying the sale amount;
//   and settleFinalInvoice never regrows a Purchase of its own.
//
// Env is assigned before the (lazy) module load on purpose: lib/metaCapi reads
// META_PIXEL_ID / META_CAPI_ACCESS_TOKEN at module scope and fireCapi
// short-circuits without them — so a test that imported first would pass no
// matter what the gate did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DEMO_MODE = 'true';
process.env.META_PIXEL_ID = 'pin-pixel-id';
process.env.META_CAPI_ACCESS_TOKEN = 'pin-access-token';
delete process.env.META_CLOSE_PURCHASE_ENABLED;
delete process.env.META_DEPOSIT_PURCHASE_ENABLED;

/** Every payload that would have gone over the wire to Meta. */
const capiPayloads: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url?.url || url);
  if (u.includes('graph.facebook.com')) {
    try {
      capiPayloads.push(JSON.parse(String(init?.body || '{}')));
    } catch {
      capiPayloads.push({ unparseable: true });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
}) as any;

// Lazy, memoised module load. tsx transpiles these tests to CJS, so top-level
// await is unavailable — but the loader still runs AFTER the env assignments
// above, which is the property that matters.
type Mods = {
  fireClosePurchaseIfEnabled: (typeof import('./rancher'))['fireClosePurchaseIfEnabled'];
  settleFinalInvoice: (typeof import('../stripeSettlement'))['settleFinalInvoice'];
  TABLES: (typeof import('../airtable'))['TABLES'];
  demoCreate: (typeof import('../demo/demoStore'))['demoCreate'];
};
let mods: Mods | null = null;

async function load(): Promise<Mods> {
  if (!mods) {
    const [rancher, settlement, airtable, demo] = await Promise.all([
      import('./rancher'),
      import('../stripeSettlement'),
      import('../airtable'),
      import('../demo/demoStore'),
    ]);
    mods = {
      fireClosePurchaseIfEnabled: rancher.fireClosePurchaseIfEnabled,
      settleFinalInvoice: settlement.settleFinalInvoice,
      TABLES: airtable.TABLES,
      demoCreate: demo.demoCreate,
    };
  }
  return mods;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const settlementSrc = readFileSync(path.join(HERE, '..', 'stripeSettlement.ts'), 'utf8');

const SALE_AMOUNT = 2999;
const DEPOSIT_AMOUNT = 750;
const FINAL_CENTS = (SALE_AMOUNT - DEPOSIT_AMOUNT) * 100;

let seq = 0;
/** A legacy no-deposit-Purchase close: the one shape whose sole conversion
 *  moment IS the close, so nothing else can be masking the gate. */
function seedClose(m: Mods): { referralId: string; rancherId: string; buyerId: string } {
  seq++;
  const { TABLES, demoCreate } = m;
  const buyer = demoCreate(TABLES.CONSUMERS, {
    Email: `close-pin-${seq}@example.com`,
    'Full Name': 'Close Pin Buyer',
    State: 'MT',
  });
  const rancher = demoCreate(TABLES.RANCHERS, {
    'Ranch Name': `Close Pin Ranch ${seq}`,
    Slug: `close-pin-ranch-${seq}`,
    State: 'MT',
  });
  const referral = demoCreate(TABLES.REFERRALS, {
    Status: 'Negotiation',
    'Total Sale Amount': SALE_AMOUNT,
    'Deposit Amount': DEPOSIT_AMOUNT,
    // No 'Deposit Paid At' and no broker 'Match Type': neither dedup guard
    // fires, so the gate under test is the only thing that can stop a fire.
    Buyer: [buyer.id],
    Rancher: [rancher.id],
  });
  return { referralId: referral.id, rancherId: rancher.id, buyerId: buyer.id };
}

/** The CAPI fires are detached; give them room to reach fetch. */
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (capiPayloads.length > 0) return;
  }
}

function purchases(): any[] {
  return capiPayloads.flatMap((p) =>
    (p?.data || []).filter((e: any) => e.event_name === 'Purchase'),
  );
}

// ── 1. Flag OFF → dark, from BOTH entry points ────────────────────────────

test('settleFinalInvoice sends NOTHING to Meta while the close flag is off', async () => {
  // This is the pin that mattered: the legacy fire lived here and shipped a
  // $2,999-valued Purchase on every final-invoice close, flag or no flag.
  capiPayloads.length = 0;
  delete process.env.META_CLOSE_PURCHASE_ENABLED;
  const m = await load();
  const { referralId, rancherId } = seedClose(m);

  await m.settleFinalInvoice({
    id: `pi_close_pin_off_${seq}`,
    amount: FINAL_CENTS,
    metadata: { referralId, rancherId },
  });
  await drain();

  assert.equal(
    purchases().length,
    0,
    `the close Purchase must be dark while the flag is off — got ${JSON.stringify(purchases()).slice(0, 400)}`,
  );
});

test('fireClosePurchaseIfEnabled sends nothing while the flag is off', async () => {
  capiPayloads.length = 0;
  delete process.env.META_CLOSE_PURCHASE_ENABLED;
  const m = await load();
  const { referralId, buyerId } = seedClose(m);

  m.fireClosePurchaseIfEnabled({
    referralId,
    buyerId,
    saleAmount: SALE_AMOUNT,
    prevStatus: 'Negotiation',
    closedAtIso: new Date().toISOString(),
  });
  await drain();

  assert.equal(capiPayloads.length, 0);
});

test('an explicit "false" is also off (only the exact string "true" enables)', async () => {
  capiPayloads.length = 0;
  process.env.META_CLOSE_PURCHASE_ENABLED = 'false';
  const m = await load();
  const { referralId, rancherId } = seedClose(m);
  await m.settleFinalInvoice({
    id: `pi_close_pin_false_${seq}`,
    amount: FINAL_CENTS,
    metadata: { referralId, rancherId },
  });
  await drain();
  assert.equal(purchases().length, 0);
  delete process.env.META_CLOSE_PURCHASE_ENABLED;
});

// ── 2. Flag ON → exactly one attributed Purchase ──────────────────────────

test('with the flag on, a final-invoice close fires exactly ONE Purchase', async () => {
  capiPayloads.length = 0;
  process.env.META_CLOSE_PURCHASE_ENABLED = 'true';
  const m = await load();
  const { referralId, rancherId } = seedClose(m);

  await m.settleFinalInvoice({
    id: `pi_close_pin_on_${seq}`,
    amount: FINAL_CENTS,
    metadata: { referralId, rancherId },
  });
  await drain();

  const fired = purchases();
  assert.equal(fired.length, 1, 'exactly one Purchase per close — never zero, never two');
  assert.equal(fired[0].custom_data.value, SALE_AMOUNT);
  assert.equal(fired[0].custom_data.content_category, 'closed-won');
  delete process.env.META_CLOSE_PURCHASE_ENABLED;
});

test('a re-close of an already-won deal fires nothing even with the flag on', async () => {
  capiPayloads.length = 0;
  process.env.META_CLOSE_PURCHASE_ENABLED = 'true';
  const m = await load();
  const { referralId, buyerId } = seedClose(m);
  m.fireClosePurchaseIfEnabled({
    referralId,
    buyerId,
    saleAmount: SALE_AMOUNT,
    prevStatus: 'Closed Won', // not a fresh transition
    closedAtIso: new Date().toISOString(),
  });
  await drain();
  assert.equal(capiPayloads.length, 0);
  delete process.env.META_CLOSE_PURCHASE_ENABLED;
});

// ── 3. settleFinalInvoice must never regrow a Purchase of its own ─────────

test('(source pin) settleFinalInvoice holds no close Purchase and no negated flag', () => {
  assert.doesNotMatch(
    settlementSrc,
    /!closePurchaseEnabled\(\)/,
    'a NEGATED close flag means the close Purchase has no off position — the defect this removed',
  );
  assert.doesNotMatch(
    settlementSrc,
    /content_category: 'closed-won'/,
    'the Closed-Won Purchase belongs to the one gated helper in lib/contracts/rancher, nowhere else',
  );
  // The DEPOSIT Purchase in the same file stays — and stays positively gated.
  assert.match(settlementSrc, /if \(depositPurchaseEnabled\(\)\) \{/);
});
