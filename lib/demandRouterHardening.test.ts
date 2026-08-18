import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWave,
  buildCampaignPlan,
  buildCampaignPools,
  defaultPairServedStates,
  brokerReservePageUrl,
  FOODSTEAD,
  SILVERLINE,
  type CampaignBuyer,
  type CampaignPoolInput,
} from './demandRouter';

// Wave 1 rails hardening (2026-08-18) — F8 (AZ never in the default WEST
// pool's reach), F9 (autopilot-claimed buyers are not immediately
// Msg1-eligible), F19 (broker reserve CTA helper).
//
// Repo is PUBLIC: counts + synthetic emails only, no real buyer data.

const NOW = new Date('2026-08-18T15:00:00Z').getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

// ── F9 — decideWave cross-rail cooldown on the EMPTY-STAGE (Msg1) branch ───

test('F9: empty stage + fresh autopilot claim (Campaign Last Sent At, no Stage) ⇒ cooldown, NOT Msg1', () => {
  assert.deepEqual(
    decideWave({ 'Campaign Last Sent At': hoursAgo(2) }, NOW),
    { send: false, reason: 'cooldown' },
  );
});

test('F9: empty stage + ANY rail touch within 24h ⇒ cooldown (nurture / sequences / warmup)', () => {
  for (const f of ['Nurture Touched At', 'Sequence Sent At', 'Warmup Sent At']) {
    assert.deepEqual(
      decideWave({ [f]: hoursAgo(3) }, NOW),
      { send: false, reason: 'cooldown' },
      `${f} within 24h must block Msg1`,
    );
  }
});

test('F9: empty stage + touch older than 24h ⇒ Msg1 unlocks (arc still starts)', () => {
  assert.deepEqual(decideWave({ 'Campaign Last Sent At': hoursAgo(25) }, NOW), {
    send: true,
    wave: 'Msg1',
  });
});

test('F9: never-touched buyer still gets Msg1 (pre-existing pin preserved)', () => {
  assert.deepEqual(decideWave({}, NOW), { send: true, wave: 'Msg1' });
});

test('F9: chase stamps are exempt — a nudged buyer is still Msg1-eligible', () => {
  assert.deepEqual(
    decideWave({ 'Waiting Nudge Last Sent At': hoursAgo(1), 'Ready Nudge Last Sent At': hoursAgo(2) }, NOW),
    { send: true, wave: 'Msg1' },
  );
});

test('F9: wave-gap progression is untouched (Msg2/Msg3 keyed on the arc stamps alone)', () => {
  assert.deepEqual(
    decideWave({ 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(3) }, NOW),
    { send: true, wave: 'Msg2' },
  );
});

// ── F8 — defaultPairServedStates (state-aware default pools) ───────────────

const stateOwners = new Map([
  ['AZ', { id: 'recGilaBrokerXYZ01', slug: 'gila-river', name: 'Gila River' }],
  ['MT', { id: FOODSTEAD.id, slug: FOODSTEAD.slug, name: FOODSTEAD.name }],
]);

test('F8: a state with a DIFFERENT operational state-table owner is excluded from the default pair reach', () => {
  const reach = defaultPairServedStates(new Set(['MT', 'ID', 'WA', 'AZ']), FOODSTEAD.id, stateOwners);
  assert.ok(!reach.has('AZ'), 'AZ is owned by its state rancher — never the MT default pool');
});

test('F8: the rancher keeps states it OWNS itself and states with no owner', () => {
  const reach = defaultPairServedStates(new Set(['MT', 'ID', 'WA', 'AZ']), FOODSTEAD.id, stateOwners);
  assert.ok(reach.has('MT'), 'self-owned state stays');
  assert.ok(reach.has('ID') && reach.has('WA'), 'unowned states stay');
  assert.deepEqual([...reach].sort(), ['ID', 'MT', 'WA']);
});

test('F8: reach never exceeds the rancher own Routing States (no nationwide-for-free)', () => {
  const reach = defaultPairServedStates(new Set(['MT', 'ID', 'WA']), FOODSTEAD.id, stateOwners);
  assert.ok(!reach.has('CA') && !reach.has('AZ') && !reach.has('NV'));
});

// ── F8 — end-to-end planner: AZ hot buyer never routed to the MT pool ──────

function azHotBuyer(id: string): CampaignBuyer {
  return {
    id,
    fields: {
      Email: `${id}@x.com`,
      State: 'AZ',
      'Ready to Buy': true,
      Created: daysAgo(20),
    },
  };
}

test('F8: planner with a Routing-States-gated default WEST pool holds AZ buyers back (no MT deposit push)', () => {
  const slots: Array<CampaignPoolInput | null> = [
    // The default WEST rancher with its REAL served set (MT/ID/WA) — the F8
    // shape readCapacity now produces instead of servedStates: null.
    { target: { ...FOODSTEAD }, openSlots: 5, servedStates: new Set(['MT', 'ID', 'WA']) },
    { target: { ...SILVERLINE }, openSlots: 5, servedStates: new Set(['MO']) },
  ];
  const plan = buildCampaignPlan([azHotBuyer('recAz1'), azHotBuyer('recAz2')], {
    now: NOW,
    pools: buildCampaignPools(slots),
  });
  assert.equal(plan.sends.length, 0, 'no AZ buyer may receive a Montana deposit push');
  assert.equal(plan.skippedNoRancher.west, 2, 'AZ buyers are held back untouched (roll forward)');
  assert.equal(plan.waitlist.length, 0, 'held back, not waitlisted — their state rancher owns them');
});

// ── F19 — broker reserve CTA helper ────────────────────────────────────────

test('F19: brokerReservePageUrl is the ranch own reserve surface, never /r/d', () => {
  const url = brokerReservePageUrl('https://www.buyhalfcow.com/', { slug: 'gila-river' });
  assert.equal(url, 'https://www.buyhalfcow.com/ranchers/gila-river#reserve');
  assert.ok(!url.includes('/r/d/'), 'a Connect-only /r/d token bounces at broker redemption');
});

test('F19: brokerReservePageUrl escapes the slug', () => {
  const url = brokerReservePageUrl('https://www.buyhalfcow.com', { slug: 'a b' });
  assert.equal(url, 'https://www.buyhalfcow.com/ranchers/a%20b#reserve');
});
