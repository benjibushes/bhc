// lib/demandRouterPools.test.ts
//
// N-RANCHER POOL MODEL + cross-rail cooldown tests (audit 2026-07-22).
// Covers: buildCampaignPools predicates (positional back-compat + Routing-
// States gate), legacy-vs-pools selection equivalence for the classic pair,
// per-rancher budgets with capacity fall-through, the TRUE daily cap (Msg1s
// already sent today), continuation routing via the stamped Campaign Rancher,
// and the demand-router side of the cross-rail cooldown.
// Runner: npx tsx --test lib/demandRouterPools.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCampaignPlan,
  buildCampaignPools,
  campaignRancherForBuyer,
  stampedCampaignRancherId,
  startOfUtcDayMs,
  suppressionReason,
  lastActivityMs,
  FOODSTEAD,
  SILVERLINE,
  DAY_MS,
  type CampaignBuyer,
  type CampaignPoolInput,
  type RancherTarget,
} from './demandRouter';

const NOW = Date.parse('2026-07-22T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY_MS).toISOString();
const hoursAgo = (n: number) => new Date(NOW - n * 60 * 60 * 1000).toISOString();

// A regional (NON-default) campaign rancher — Routing States NE/CO/KS.
const CHAMPION: RancherTarget = {
  id: 'recCHAMPION000001',
  slug: 'champion-valley',
  name: 'Champion Valley',
  ranchState: 'Nebraska',
};

const slot = (
  target: RancherTarget,
  openSlots: number,
  servedStates: ReadonlySet<string> | null,
): CampaignPoolInput => ({ target, openSlots, servedStates });

function hotBuyer(id: string, state: string, extra: Record<string, unknown> = {}): CampaignBuyer {
  return {
    id,
    fields: {
      Email: `${id}@x.com`,
      State: state,
      'Ready to Buy': true,
      'Intent Score': 50,
      Created: daysAgo(20),
      ...extra,
    },
  };
}

// ── buildCampaignPools: predicates ───────────────────────────────────────────

test('pools (2 slots, curated pair): legacy coast split, nationwide inside the coast', () => {
  const pools = buildCampaignPools([
    slot(FOODSTEAD, 2, null),
    slot(SILVERLINE, 2, null),
  ]);
  assert.equal(pools.length, 2);
  assert.equal(pools[0].serves('CA'), true, 'WEST pool serves CA');
  assert.equal(pools[0].serves('FL'), false, 'WEST pool never serves EAST');
  assert.equal(pools[1].serves('FL'), true, 'EC pool serves EAST');
  assert.equal(pools[1].serves('TX'), true, 'EC pool serves CENTRAL');
  assert.equal(pools[1].serves('CA'), false, 'EC pool never serves WEST');
});

test('pools (2 slots): a REGIONAL rancher in the EAST+CENTRAL slot only serves its Routing States (finding 1)', () => {
  const pools = buildCampaignPools([
    slot(FOODSTEAD, 2, null),
    slot(CHAMPION, 2, new Set(['NE', 'KS'])), // CO omitted: it's a WEST state anyway
  ]);
  assert.equal(pools[1].serves('NE'), true);
  assert.equal(pools[1].serves('KS'), true);
  assert.equal(pools[1].serves('FL'), false, 'FL is NOT in Champion Valley coverage');
  assert.equal(pools[1].serves('NY'), false);
});

test('pools: a disabled FIRST slot (null) does not shift the second into WEST', () => {
  const pools = buildCampaignPools([null, slot(SILVERLINE, 2, null)]);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].serves('CA'), false, 'still the EAST+CENTRAL pool');
  assert.equal(pools[0].serves('FL'), true);
});

test('pools (3+ slots): routing is purely by served states, in configured order', () => {
  const pools = buildCampaignPools([
    slot(FOODSTEAD, 2, null),
    slot(SILVERLINE, 2, null),
    slot(CHAMPION, 2, new Set(['NE', 'KS'])),
  ]);
  assert.equal(pools.length, 3);
  // Nationwide pools serve everything; Champion only its states.
  assert.equal(pools[0].serves('FL'), true, 'no coast split in 3+ mode');
  assert.equal(pools[2].serves('NE'), true);
  assert.equal(pools[2].serves('FL'), false);
});

// ── legacy equivalence (back-compat: 1-2 ids behave as today) ────────────────

test('classic pair: pools plan selects the SAME buyers/waves/ranchers as the legacy plan', () => {
  const buyers: CampaignBuyer[] = [
    hotBuyer('recW1', 'CA'),
    hotBuyer('recW2', 'WA'),
    hotBuyer('recE1', 'FL'),
    hotBuyer('recC1', 'TX'),
    // continuation mid-arc (Msg1 4 days ago → Msg2 due)
    hotBuyer('recCont1', 'NY', {
      'Campaign Stage': 'Msg1 Sent',
      'Campaign Last Sent At': daysAgo(4),
    }),
    // warm buyer
    { id: 'recWarm1', fields: { Email: 'warm@x.com', State: 'GA', 'Intent Score': 2, Created: daysAgo(20) } },
    // suppressed (unsubscribed)
    { id: 'recSup1', fields: { Email: 'sup@x.com', State: 'CA', Unsubscribed: true, 'Ready to Buy': true, Created: daysAgo(20) } },
  ];
  const legacy = buildCampaignPlan(buyers, {
    now: NOW,
    capacity: { west: 2, eastCentral: 2 },
    dailyCap: 25,
    conversionBuffer: 3,
  });
  const withPools = buildCampaignPlan(buyers, {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 3,
    pools: buildCampaignPools([slot(FOODSTEAD, 2, null), slot(SILVERLINE, 2, null)]),
  });
  const key = (s: { buyerId: string; wave: string; rancher: { id: string } }) =>
    `${s.buyerId}:${s.wave}:${s.rancher.id}`;
  assert.deepEqual(
    withPools.sends.map(key).sort(),
    legacy.sends.map(key).sort(),
    'identical selection set',
  );
  assert.deepEqual(
    withPools.waitlist.map((w) => w.buyerId).sort(),
    legacy.waitlist.map((w) => w.buyerId).sort(),
  );
  assert.deepEqual(withPools.suppressed, legacy.suppressed);
});

// ── Routing-States gate on sends (finding 1) ─────────────────────────────────

test('a regional rancher in the EC slot NEVER gets out-of-coverage buyers — they are held back, not sent', () => {
  const buyers = [hotBuyer('recFL1', 'FL'), hotBuyer('recNE1', 'NE')];
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 3,
    pools: buildCampaignPools([
      slot(FOODSTEAD, 2, null),
      slot(CHAMPION, 2, new Set(['NE', 'KS'])),
    ]),
  });
  assert.equal(plan.sends.length, 1, 'only the NE buyer sends');
  assert.equal(plan.sends[0].buyerId, 'recNE1');
  assert.equal(plan.sends[0].rancher.id, CHAMPION.id);
  assert.equal(plan.skippedNoRancher.eastCentral, 1, 'FL buyer held back (no serving pool)');
  assert.equal(plan.waitlist.length, 0, 'held back ≠ waitlisted');
});

// ── N-rancher fan-out + capacity fall-through (finding 2) ────────────────────

test('3+ ranchers: the third pool receives buyers in its states (no more 2-slot cap)', () => {
  const buyers = [hotBuyer('recNE1', 'NE'), hotBuyer('recKS1', 'KS'), hotBuyer('recFL1', 'FL')];
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 3,
    pools: buildCampaignPools([
      slot(CHAMPION, 2, new Set(['NE', 'KS'])),
      slot(SILVERLINE, 2, new Set(['FL'])),
      slot(FOODSTEAD, 2, null),
    ]),
  });
  const byRancher = (id: string) => plan.sends.filter((s) => s.rancher.id === id).length;
  assert.equal(byRancher(CHAMPION.id), 2, 'Champion takes NE+KS');
  assert.equal(byRancher(SILVERLINE.id), 1, 'Silverline takes FL');
  assert.equal(plan.poolCapacity?.length, 3);
});

test('capacity fall-through: first eligible pool exhausted → buyer goes to the NEXT eligible pool', () => {
  const buyers = [hotBuyer('recTX1', 'TX'), hotBuyer('recTX2', 'TX')];
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 1,
    pools: buildCampaignPools([
      slot(SILVERLINE, 1, new Set(['TX'])), // budget 1×1 = 1
      slot(FOODSTEAD, 5, null), // nationwide backstop
      slot(CHAMPION, 5, new Set(['NE'])),
    ]),
  });
  assert.equal(plan.sends.length, 2, 'both TX buyers send');
  const ranchers = plan.sends.map((s) => s.rancher.id).sort();
  assert.deepEqual(ranchers, [FOODSTEAD.id, SILVERLINE.id].sort(), 'second buyer fell through');
});

test('all eligible pools at capacity → hot buyer waitlisted (rancher-at-capacity)', () => {
  const buyers = [hotBuyer('recNE1', 'NE'), hotBuyer('recNE2', 'NE')];
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 1,
    pools: buildCampaignPools([
      slot(CHAMPION, 1, new Set(['NE'])),
      slot(SILVERLINE, 5, new Set(['FL'])), // does not serve NE
      slot(FOODSTEAD, 0, null), // nationwide but zero slots
    ]),
  });
  assert.equal(plan.sends.length, 1);
  assert.equal(plan.waitlist.length, 1);
  assert.equal(plan.waitlist[0].reason, 'rancher-at-capacity');
});

// ── TRUE daily cap (finding 5) ───────────────────────────────────────────────

test('Msg1s already sent TODAY reduce the remaining per-day budget (hourly runs cannot reset the cap)', () => {
  // 10 buyers already got Msg1 earlier today; 40 fresh hot candidates.
  const already: CampaignBuyer[] = Array.from({ length: 10 }, (_, i) =>
    hotBuyer(`recOld${i}`, 'TX', {
      'Campaign Stage': 'Msg1 Sent',
      'Campaign Last Sent At': hoursAgo(3), // this UTC day
      'Campaign Rancher': [SILVERLINE.id],
    }),
  );
  const fresh: CampaignBuyer[] = Array.from({ length: 40 }, (_, i) => hotBuyer(`recNew${i}`, 'TX'));
  const pools = buildCampaignPools([slot(FOODSTEAD, 20, null), slot(SILVERLINE, 20, null)]);
  const plan = buildCampaignPlan([...already, ...fresh], {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 3,
    pools,
  });
  // ceiling 20×3=60, outstanding 10 → 50 remaining; day budget 25−10=15 wins.
  const ec = plan.poolCapacity!.find((p) => p.rancherId === SILVERLINE.id)!;
  assert.equal(ec.sentToday, 10);
  assert.equal(ec.newBudget, 15, 'daily cap minus Msg1s already sent today');
  assert.equal(plan.sends.filter((s) => s.wave === 'Msg1').length, 15);
});

test('Msg1s sent YESTERDAY do not reduce today\'s budget', () => {
  const already: CampaignBuyer[] = Array.from({ length: 10 }, (_, i) =>
    hotBuyer(`recOld${i}`, 'TX', {
      'Campaign Stage': 'Msg1 Sent',
      'Campaign Last Sent At': daysAgo(1.5), // prior UTC day, still in Msg2 cooldown
      'Campaign Rancher': [SILVERLINE.id],
    }),
  );
  const fresh: CampaignBuyer[] = Array.from({ length: 40 }, (_, i) => hotBuyer(`recNew${i}`, 'TX'));
  const plan = buildCampaignPlan([...already, ...fresh], {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 3,
    pools: buildCampaignPools([slot(FOODSTEAD, 20, null), slot(SILVERLINE, 20, null)]),
  });
  const ec = plan.poolCapacity!.find((p) => p.rancherId === SILVERLINE.id)!;
  assert.equal(ec.sentToday, 0);
  assert.equal(ec.newBudget, 25, 'full daily cap available (outstanding 10 < ceiling)');
});

// ── continuation routing (stamped Campaign Rancher) ──────────────────────────

test('continuations follow the STAMPED Campaign Rancher pool', () => {
  const b = hotBuyer('recCont1', 'NE', {
    'Campaign Stage': 'Msg1 Sent',
    'Campaign Last Sent At': daysAgo(4),
    'Campaign Rancher': [CHAMPION.id],
  });
  const plan = buildCampaignPlan([b], {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 3,
    pools: buildCampaignPools([
      slot(FOODSTEAD, 2, null),
      slot(SILVERLINE, 2, null),
      slot(CHAMPION, 2, new Set(['NE', 'KS'])),
    ]),
  });
  assert.equal(plan.sends.length, 1);
  assert.equal(plan.sends[0].wave, 'Msg2');
  assert.equal(plan.sends[0].rancher.id, CHAMPION.id, 'continuation stays with the stamped rancher');
});

test('continuation whose stamped rancher is gone/dark this run is held back, not re-routed mid-arc', () => {
  const b = hotBuyer('recCont1', 'NE', {
    'Campaign Stage': 'Msg1 Sent',
    'Campaign Last Sent At': daysAgo(4),
    'Campaign Rancher': [CHAMPION.id],
  });
  const plan = buildCampaignPlan([b], {
    now: NOW,
    dailyCap: 25,
    conversionBuffer: 3,
    pools: buildCampaignPools([slot(FOODSTEAD, 2, null), slot(SILVERLINE, 2, null)]),
  });
  assert.equal(plan.sends.length, 0);
  assert.equal(plan.skippedNoRancher.eastCentral, 1, 'held back untouched (no stamp)');
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test('stampedCampaignRancherId reads the linked-record array', () => {
  assert.equal(stampedCampaignRancherId({ 'Campaign Rancher': [CHAMPION.id] }), CHAMPION.id);
  assert.equal(stampedCampaignRancherId({ 'Campaign Rancher': [] }), '');
  assert.equal(stampedCampaignRancherId({}), '');
});

test('campaignRancherForBuyer: stamped + serving wins; stamped non-serving → null; unstamped → first serving', () => {
  const pools = buildCampaignPools([
    slot(FOODSTEAD, 2, null),
    slot(SILVERLINE, 2, null),
    slot(CHAMPION, 2, new Set(['NE', 'KS'])),
  ]);
  assert.equal(
    campaignRancherForBuyer({ State: 'NE', 'Campaign Rancher': [CHAMPION.id] }, pools)?.id,
    CHAMPION.id,
  );
  assert.equal(
    campaignRancherForBuyer({ State: 'FL', 'Campaign Rancher': [CHAMPION.id] }, pools),
    null,
    'stamped rancher does not serve FL → no link',
  );
  assert.equal(
    campaignRancherForBuyer({ State: 'FL' }, pools)?.id,
    FOODSTEAD.id,
    'unstamped → first pool serving the state (3+ mode has no coast split)',
  );
  assert.equal(campaignRancherForBuyer({ State: '' }, pools), null);
});

test('startOfUtcDayMs: midnight UTC of the same day', () => {
  assert.equal(startOfUtcDayMs(NOW), Date.parse('2026-07-22T00:00:00Z'));
  assert.equal(startOfUtcDayMs(Date.parse('2026-07-22T23:59:59Z')), Date.parse('2026-07-22T00:00:00Z'));
});

// ── cross-rail cooldown, demand-router side (finding 3) ──────────────────────

test('a recent Waiting Nudge Last Sent At suppresses the campaign (recent-contact)', () => {
  const f = {
    Email: 'a@x.com',
    State: 'TX',
    'Ready to Buy': true,
    Created: daysAgo(20),
    'Waiting Nudge Last Sent At': daysAgo(2),
  };
  assert.equal(suppressionReason(f, NOW), 'recent-contact');
});

test('a waiting nudge older than 7 days does NOT suppress', () => {
  const f = {
    Email: 'a@x.com',
    State: 'TX',
    'Ready to Buy': true,
    Created: daysAgo(20),
    'Waiting Nudge Last Sent At': daysAgo(8),
  };
  assert.equal(suppressionReason(f, NOW), null);
});

test('a fresh nudge stamp cannot be masked by a STALE Last Contacted At (max wins)', () => {
  const f = {
    Email: 'a@x.com',
    State: 'TX',
    'Ready to Buy': true,
    Created: daysAgo(20),
    'Last Contacted At': daysAgo(30),
    'Waiting Nudge Last Sent At': daysAgo(1),
  };
  assert.equal(suppressionReason(f, NOW), 'recent-contact');
});

test('lastActivityMs counts the waiting-nudge stamp (nudged buyers are not 18-month-dead)', () => {
  const f = { 'Waiting Nudge Last Sent At': daysAgo(10) };
  assert.equal(lastActivityMs(f), Date.parse(daysAgo(10)));
});
