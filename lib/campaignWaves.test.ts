import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autopilotMode,
  domainWarmupHold,
  decideBudget,
  autoPauseReason,
  formatRunStats,
  parseRunStats,
  extractBounceDates,
  countBounceStampsSince,
  rancherForStateTable,
  isCampaignClaimed,
  demandRouterTouchedWithinDays,
  selectCampaignWaves,
  countDistinctSendDays,
  RAMP_DAILY_CAP,
  RAMP_LIVE_DAYS,
  FULL_DAILY_CAP,
  BOUNCE_PAUSE_THRESHOLD,
  type GuardTelemetry,
  type SelectWavesInput,
  isWaveSellable,
  CAMPAIGN_WAVE_EXCLUDED_SLUGS,
} from './campaignWaves';
import { REQUEST_ONLY_RANCHER_SLUGS } from './requestOnlyRanchers';
import { MAX_BATCH } from './requalifyCampaign';
import { SUNSET_SUPPRESSED_MARKER } from './marketingSunset';
import type { ActiveDealKeys } from './demandRouter';

const NOW = Date.parse('2026-08-10T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const NO_DEALS: ActiveDealKeys = { ids: new Set(), emails: new Set() };

// ── Kill switch — tri-state, FAIL-TO-OFF ────────────────────────────────────

test('autopilotMode: only exact "true" is live, only "dry-run" is shadow', () => {
  assert.equal(autopilotMode('true'), 'live');
  assert.equal(autopilotMode('dry-run'), 'dry-run');
  for (const raw of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'live', 'dryrun']) {
    assert.equal(autopilotMode(raw), 'off', JSON.stringify(raw));
  }
});

// ── Domain warmup hold ──────────────────────────────────────────────────────

test('domainWarmupHold: only when the marketing subdomain is set and not stamped warmed', () => {
  assert.equal(domainWarmupHold({}), false); // apex — no hold
  assert.equal(domainWarmupHold({ MARKETING_SEND_DOMAIN: '' }), false);
  assert.equal(domainWarmupHold({ MARKETING_SEND_DOMAIN: 'updates.buyhalfcow.com' }), true);
  assert.equal(
    domainWarmupHold({ MARKETING_SEND_DOMAIN: 'updates.buyhalfcow.com', MARKETING_DOMAIN_WARMED: 'true' }),
    false,
  );
  // Fail-safe: anything but exact 'true' keeps the hold.
  assert.equal(
    domainWarmupHold({ MARKETING_SEND_DOMAIN: 'updates.buyhalfcow.com', MARKETING_DOMAIN_WARMED: 'TRUE' }),
    true,
  );
});

// ── Budget math ─────────────────────────────────────────────────────────────

test('decideBudget: ramp cap until RAMP_LIVE_DAYS live days, then full', () => {
  for (const d of [0, 1, RAMP_LIVE_DAYS - 1]) {
    const b = decideBudget({ sentToday: 0, priorLiveSendDays: d, domainWarming: false });
    assert.equal(b.ceiling, RAMP_DAILY_CAP, `days=${d}`);
    assert.equal(b.rampActive, true);
    assert.equal(b.rampReason, 'ramp-days');
  }
  const full = decideBudget({ sentToday: 0, priorLiveSendDays: RAMP_LIVE_DAYS, domainWarming: false });
  assert.equal(full.ceiling, FULL_DAILY_CAP);
  assert.equal(full.rampActive, false);
  assert.equal(full.rampReason, null);
});

test('decideBudget: domain warmup holds ramp regardless of live days', () => {
  const b = decideBudget({ sentToday: 0, priorLiveSendDays: 30, domainWarming: true });
  assert.equal(b.ceiling, RAMP_DAILY_CAP);
  assert.equal(b.rampReason, 'domain-warmup');
});

test('decideBudget: remaining = ceiling − sentToday, clamped at 0', () => {
  assert.equal(decideBudget({ sentToday: 10, priorLiveSendDays: 9, domainWarming: false }).remaining, FULL_DAILY_CAP - 10);
  assert.equal(decideBudget({ sentToday: FULL_DAILY_CAP, priorLiveSendDays: 9, domainWarming: false }).remaining, 0);
  assert.equal(decideBudget({ sentToday: 999, priorLiveSendDays: 9, domainWarming: false }).remaining, 0);
  assert.equal(decideBudget({ sentToday: 25, priorLiveSendDays: 0, domainWarming: false }).remaining, RAMP_DAILY_CAP - 25);
});

// ── Auto-pause gates (fail-closed) ──────────────────────────────────────────

const HEALTHY: GuardTelemetry = { complaints7d: 0, bounces24h: 0, priorRun: 'none' };

test('autoPauseReason: healthy telemetry does not pause', () => {
  assert.equal(autoPauseReason(HEALTHY), null);
  assert.equal(
    autoPauseReason({ complaints7d: 2, bounces24h: BOUNCE_PAUSE_THRESHOLD, priorRun: { attempted: 100, failed: 10 } }),
    null,
    'complaints below threshold, bounces AT threshold, failure rate AT 10% — all pass',
  );
});

test('autoPauseReason: complaints ≥3/7d pauses', () => {
  assert.match(String(autoPauseReason({ ...HEALTHY, complaints7d: 3 })), /complaints 3/);
});

test('autoPauseReason: >5 hard bounces/24h pauses', () => {
  assert.match(String(autoPauseReason({ ...HEALTHY, bounces24h: 6 })), /bounces 6/);
  assert.equal(autoPauseReason({ ...HEALTHY, bounces24h: 5 }), null);
});

test('autoPauseReason: prior-run failure >10% pauses only with ≥10 attempts', () => {
  assert.match(
    String(autoPauseReason({ ...HEALTHY, priorRun: { attempted: 20, failed: 3 } })),
    /failure rate 15%/,
  );
  // Below the attempt floor a bad ratio cannot wedge the rail shut.
  assert.equal(autoPauseReason({ ...HEALTHY, priorRun: { attempted: 2, failed: 1 } }), null);
  // Exactly 10% passes (the gate is strictly greater).
  assert.equal(autoPauseReason({ ...HEALTHY, priorRun: { attempted: 10, failed: 1 } }), null);
});

test('autoPauseReason: ANY telemetry read failure is an alarm (fail closed)', () => {
  assert.match(String(autoPauseReason({ ...HEALTHY, complaints7d: null })), /fail closed/);
  assert.match(String(autoPauseReason({ ...HEALTHY, bounces24h: null })), /fail closed/);
  assert.match(String(autoPauseReason({ ...HEALTHY, priorRun: null })), /fail closed/);
});

// ── Run-stats token ─────────────────────────────────────────────────────────

test('run stats: format → parse round-trips; garbage parses to null', () => {
  const s = { attempted: 42, sent: 40, suppressed: 1, failed: 1 };
  const notes = `LIVE ceiling=120 ${formatRunStats(s)} skips: claimed=900`;
  assert.deepEqual(parseRunStats(notes), s);
  assert.equal(parseRunStats('DRY-RUN would send 12'), null);
  assert.equal(parseRunStats(undefined), null);
  assert.equal(parseRunStats(''), null);
});

// ── Bounce stamp counting ───────────────────────────────────────────────────

test('bounce stamps: matches webhook lines, ignores complaints, dedupes same-day', () => {
  const notes =
    'signed up via IG\n' +
    '[Auto-unsub 2026-08-09] bounced\n' +
    '[Auto-unsub 2026-08-09] bounced\n' + // webhook redelivery — counts once
    '[Auto-unsub 2026-08-01] bounced\n' +
    '[Auto-unsub 2026-08-10] spam complaint';
  assert.deepEqual(extractBounceDates(notes), ['2026-08-09', '2026-08-09', '2026-08-01']);
  const since = Date.parse('2026-08-09T00:00:00Z');
  assert.equal(countBounceStampsSince([{ Notes: notes }], since), 1);
  assert.equal(countBounceStampsSince([{ Notes: notes }], Date.parse('2026-08-01T00:00:00Z')), 2);
  assert.equal(countBounceStampsSince([{}, { Notes: null }], 0), 0);
});

// ── Rancher-for-state policy ────────────────────────────────────────────────

const OPERATIONAL = {
  'Active Status': 'Active',
  'Agreement Signed': true,
  'Onboarding Status': 'Live',
  // Sellability gate (2026-08-12): wave candidates need a priced cut or a
  // payment link; fixtures get a floor-clearing Half so table tests keep
  // exercising the gates they were written for. Dead-end coverage lives in
  // the dedicated isWaveSellable test.
  'Half Price': 2000,
};

function rancher(over: Record<string, unknown>): Record<string, unknown> {
  return { id: `rec${String(over['Slug'])}`.padEnd(17, 'x').slice(0, 17), ...OPERATIONAL, ...over };
}

test('rancherForStateTable: only operational ranchers with slugs enter', () => {
  const t = rancherForStateTable([
    rancher({ Slug: 'live-tx', State: 'TX' }),
    { ...OPERATIONAL, 'Active Status': 'Paused', Slug: 'paused-co', State: 'CO', id: 'rec1' },
    rancher({ Slug: '', State: 'OR', 'Ranch Name': 'No Slug Ranch' }),
  ] as any);
  assert.deepEqual([...t.keys()], ['TX']);
  assert.equal(t.get('TX')!.slug, 'live-tx');
});

test('rancherForStateTable: exclusive-ZIP rancher loses the state to a non-gated one', () => {
  const t = rancherForStateTable([
    rancher({ Slug: 'zip-gated', State: 'TX', 'Service ZIP Prefixes': '77,78' }),
    rancher({ Slug: 'whole-state', State: 'TX' }),
  ] as any);
  assert.equal(t.get('TX')!.slug, 'whole-state');
  // …but takes it when they are the only operational rancher.
  const only = rancherForStateTable([
    rancher({ Slug: 'zip-gated', State: 'TX', 'Service ZIP Prefixes': '77' }),
  ] as any);
  assert.equal(only.get('TX')!.slug, 'zip-gated');
});

test('rancherForStateTable: primary state beats routing-states coverage', () => {
  const t = rancherForStateTable([
    rancher({
      Slug: 'neighbor-ok',
      State: 'OK',
      'Admin Approved Multi-State': true,
      'Routing States': 'TX',
      'Current Active Referrals': 0,
    }),
    rancher({ Slug: 'home-tx', State: 'TX', 'Current Active Referrals': 99 }),
  ] as any);
  assert.equal(t.get('TX')!.slug, 'home-tx');
  assert.equal(t.get('OK')!.slug, 'neighbor-ok');
});

test('rancherForStateTable: load balance then slug break ties deterministically', () => {
  const t = rancherForStateTable([
    rancher({ Slug: 'busy', State: 'CA', 'Current Active Referrals': 5 }),
    rancher({ Slug: 'idle', State: 'CA', 'Current Active Referrals': 1 }),
  ] as any);
  assert.equal(t.get('CA')!.slug, 'idle');
  const tie = rancherForStateTable([
    rancher({ Slug: 'bravo', State: 'CA' }),
    rancher({ Slug: 'alpha', State: 'CA' }),
  ] as any);
  assert.equal(tie.get('CA')!.slug, 'alpha');
});

test('rancherForStateTable: multi-state rancher appears in every served state', () => {
  const t = rancherForStateTable([
    rancher({
      Slug: 'multi',
      State: 'TN',
      'Admin Approved Multi-State': true,
      'Routing States': 'GA, AL',
    }),
  ] as any);
  assert.deepEqual([...t.keys()].sort(), ['AL', 'GA', 'TN']);
});

// ── Claim / cross-rail predicates ───────────────────────────────────────────

test('isCampaignClaimed: any claim-namespace field counts, empty means first-touch', () => {
  assert.equal(isCampaignClaimed({}), false);
  assert.equal(isCampaignClaimed({ 'Campaign Last Sent At': '2026-08-01T00:00:00Z' }), true);
  assert.equal(isCampaignClaimed({ 'Campaign Rail': 'requalify' }), true);
  assert.equal(isCampaignClaimed({ 'Campaign Rail': { name: 'autopilot' } }), true);
  assert.equal(isCampaignClaimed({ 'Campaign Stage': 'Msg1 Sent' }), true);
  assert.equal(isCampaignClaimed({ 'Campaign Stage': { name: 'Sunset' } }), true);
  assert.equal(isCampaignClaimed({ 'Campaign Last Sent At': '', 'Campaign Rail': '  ' }), false);
});

test('demandRouterTouchedWithinDays: 7d belt over send + SMS-recovery stamps', () => {
  const recent = new Date(NOW - 2 * DAY).toISOString();
  const old = new Date(NOW - 9 * DAY).toISOString();
  assert.equal(demandRouterTouchedWithinDays({ 'Campaign Last Sent At': recent }, NOW), true);
  assert.equal(demandRouterTouchedWithinDays({ 'Campaign Last Sent At': old }, NOW), false);
  assert.equal(demandRouterTouchedWithinDays({ 'Campaign SMS Recovery Sent At': recent }, NOW), true);
  assert.equal(demandRouterTouchedWithinDays({ 'Campaign SMS Recovery Sent At': old }, NOW), false);
  assert.equal(demandRouterTouchedWithinDays({}, NOW), false);
  assert.equal(demandRouterTouchedWithinDays({ 'Campaign Last Sent At': 'garbage' }, NOW), false);
});

// ── selectCampaignWaves — the whole pipeline ────────────────────────────────

let seq = 0;
function consumer(over: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    id: `recCONS${String(seq).padStart(10, '0')}`,
    Email: `buyer${seq}@example.com`,
    'Full Name': `Buyer ${seq}`,
    State: 'TX',
    ...over,
  };
}

const TX_RANCHER = rancher({ Slug: 'lone-star', State: 'TX', 'Ranch Name': 'Lone Star' });
const CA_RANCHER = rancher({ Slug: 'gold-coast', State: 'CA', 'Ranch Name': 'Gold Coast' });

function plan(over: Partial<SelectWavesInput>): ReturnType<typeof selectCampaignWaves> {
  return selectCampaignWaves({
    consumers: [],
    ranchers: [TX_RANCHER, CA_RANCHER] as any,
    activeDeals: NO_DEALS,
    now: NOW,
    budget: { sentToday: 0, priorLiveSendDays: 9, domainWarming: false },
    ...over,
  });
}

test('select: every skip gate counts its reason; clean buyers are selected', () => {
  const p = plan({
    consumers: [
      consumer({}), // eligible
      consumer({ Email: '' }),
      consumer({ Email: 'not-an-email' }),
      consumer({ Email: 'probe-audit-77@example.test' }),
      consumer({ Unsubscribed: true }),
      consumer({ Bounced: true }),
      consumer({ Complained: true }),
      consumer({ Notes: `${SUNSET_SUPPRESSED_MARKER} 2026-08-01] no engagement` }),
      consumer({ 'Campaign Last Sent At': '2026-07-01T00:00:00Z' }),
      consumer({ 'Campaign SMS Recovery Sent At': new Date(NOW - DAY).toISOString() }),
      consumer({ 'Routing Segment': 'STATE_WAITLIST' }),
      consumer({ 'Routing Segment': 'TERMINAL' }),
      consumer({ State: '' }),
      consumer({ State: 'FL' }), // no FL rancher
    ],
  });
  assert.equal(p.selected, 1);
  assert.equal(p.eligible, 1);
  assert.deepEqual(p.skips, {
    'no-email': 2,
    synthetic: 1,
    'suppressed-flags': 3,
    'sunset-suppressed': 1,
    'already-claimed': 1,
    'cross-rail-7d': 1,
    'lane-national': 1,
    'lane-customer': 1,
    'no-state': 1,
    'state-unserved': 1,
  });
  assert.equal(p.batches.length, 1);
  assert.equal(p.batches[0].rancherSlug, 'lone-star');
  assert.equal(p.batches[0].state, 'TX');
});

test('select: share-ready segments and blank segments both pass the lane gate', () => {
  const p = plan({
    consumers: [
      consumer({ 'Routing Segment': 'MATCH_NOW' }),
      consumer({ 'Routing Segment': 'INCOMPLETE_PROFILE' }),
      consumer({ 'Routing Segment': { name: 'WARM_LEAD' } }),
      consumer({ 'Routing Segment': '' }),
    ],
  });
  assert.equal(p.selected, 4);
});

test('select: mid-deal buyers are hands-off (by record id AND by email)', () => {
  const a = consumer({});
  const b = consumer({});
  const deals: ActiveDealKeys = {
    ids: new Set([String(a.id)]),
    emails: new Set([String(b.Email).toLowerCase()]),
  };
  const p = plan({ consumers: [a, b, consumer({})], activeDeals: deals });
  assert.equal(p.selected, 1);
  assert.equal(p.skips['mid-deal'], 2);
});

test('select: engagement recency orders the wave, most recent first', () => {
  const cold = consumer({ Email: 'cold@example.com', Created: new Date(NOW - 400 * DAY).toISOString() });
  const warm = consumer({ Email: 'warm@example.com', 'Last Email Clicked At': new Date(NOW - 2 * DAY).toISOString() });
  const mid = consumer({ Email: 'mid@example.com', 'Qualified At': new Date(NOW - 30 * DAY).toISOString() });
  const p = plan({ consumers: [cold, warm, mid] });
  assert.deepEqual(
    p.batches[0].recipients.map((r) => r.email),
    ['warm@example.com', 'mid@example.com', 'cold@example.com'],
  );
});

test('select: budget cut respects the ramp ceiling and counts the tail', () => {
  const consumers = Array.from({ length: 40 }, () => consumer({}));
  const p = plan({
    consumers,
    budget: { sentToday: 0, priorLiveSendDays: 0, domainWarming: false }, // ramp: 30
  });
  assert.equal(p.budget.ceiling, RAMP_DAILY_CAP);
  assert.equal(p.selected, RAMP_DAILY_CAP);
  assert.equal(p.skips['beyond-budget'], 10);
});

test('select: sentToday shrinks the remaining budget', () => {
  const consumers = Array.from({ length: 40 }, () => consumer({}));
  const p = plan({
    consumers,
    budget: { sentToday: 25, priorLiveSendDays: 0, domainWarming: false },
  });
  assert.equal(p.selected, 5);
});

test('select: batches chunk at MAX_BATCH per (rancher, state) group', () => {
  const tx = Array.from({ length: MAX_BATCH + 5 }, () => consumer({}));
  const ca = Array.from({ length: 3 }, () => consumer({ State: 'CA' }));
  const p = plan({
    consumers: [...tx, ...ca],
    budget: { sentToday: 0, priorLiveSendDays: 9, domainWarming: false }, // full: 120
  });
  assert.equal(p.selected, MAX_BATCH + 5 + 3);
  const bySlug = p.batches.map((b) => `${b.rancherSlug}:${b.recipients.length}`);
  assert.deepEqual(bySlug.sort(), [`gold-coast:3`, `lone-star:5`, `lone-star:${MAX_BATCH}`].sort());
  for (const b of p.batches) {
    assert.ok(b.recipients.length <= MAX_BATCH);
    for (const r of b.recipients) assert.equal(r.state, b.state);
  }
});

test('select: duplicate emails collapse to one slot (duplicate-pair factory)', () => {
  const p = plan({
    consumers: [
      consumer({ Email: 'twin@example.com' }),
      consumer({ Email: 'Twin@Example.com ' }), // case/space variants collapse
      consumer({}),
    ],
  });
  assert.equal(p.selected, 2);
  assert.equal(p.skips['duplicate-email'], 1);
});

test('select: stateTable reports the policy for the Cron Runs log', () => {
  const p = plan({ consumers: [] });
  assert.deepEqual(p.stateTable, [
    { state: 'CA', slug: 'gold-coast' },
    { state: 'TX', slug: 'lone-star' },
  ]);
});

// ── countDistinctSendDays ───────────────────────────────────────────────────

test('countDistinctSendDays: distinct UTC days, garbage ignored', () => {
  assert.equal(
    countDistinctSendDays([
      '2026-08-08T15:10:00Z',
      '2026-08-08T15:40:00Z',
      '2026-08-09T15:10:00Z',
      'not-a-date',
      null,
      '',
    ]),
    2,
  );
  assert.equal(countDistinctSendDays([]), 0);
});

test('rancherForStateTable: request-only slugs never appear, even as nationwide fallback', () => {
  // Both fixtures are fully OPERATIONAL and SELLABLE (Agreement Signed + a
  // priced cut) on purpose: without those the whole table comes back empty and
  // this assertion passes for the wrong reason. The ONLY thing keeping the
  // request-only ranch out must be the shared exclusion list.
  const rep = {
    id: 'recRep', Slug: 'rep-provisions', 'Ranch Name': 'Rep Provisions',
    State: 'MO', 'Active Status': { name: 'Active' }, 'Agreement Signed': true,
    'Half Price': 3700, 'Current Active Referrals': 0,
  };
  const local = {
    id: 'recLocal', Slug: 'foodstead', 'Ranch Name': 'Foodstead',
    State: 'MT', 'Active Status': { name: 'Active' }, 'Agreement Signed': true,
    'Half Price': 2100, 'Current Active Referrals': 5,
  };
  const table = rancherForStateTable([rep, local] as any[]);
  // The non-excluded ranch DOES land in the table — proof the fixtures clear
  // every other gate, so the rep-provisions absence below is the rule at work.
  assert.equal(table.get('MT')?.slug, 'foodstead');
  assert.equal(table.has('MO'), false, 'a request-only ranch leaves its own state uncovered');
  for (const [, v] of table) {
    assert.notEqual(v.slug, 'rep-provisions');
  }
});

test('rancherForStateTable exclusion is driven by the SHARED request-only list', () => {
  // The back-compat alias must be the same object as the canonical set, so a
  // slug added in lib/requestOnlyRanchers drops out of BOTH engines at once.
  assert.equal(CAMPAIGN_WAVE_EXCLUDED_SLUGS, REQUEST_ONLY_RANCHER_SLUGS);
  assert.equal(CAMPAIGN_WAVE_EXCLUDED_SLUGS.has('rep-provisions'), true);
});

test('isWaveSellable: priced cut or payment link required; dead-end ranchers excluded from table', () => {
  assert.equal(isWaveSellable({ 'Half Price': 2000 }), true);
  assert.equal(isWaveSellable({ 'Quarter Price': 50 }), false); // below floor
  assert.equal(isWaveSellable({ 'Whole Payment Link': 'https://buy.example/x' }), true);
  assert.equal(isWaveSellable({}), false);
  const deadEnd = {
    id: 'recDead', Slug: 'jcs-shaped', 'Ranch Name': 'Dead End Ranch',
    State: 'NC', 'Active Status': { name: 'Active' }, 'Current Active Referrals': 0,
  };
  const table = rancherForStateTable([deadEnd] as any[]);
  assert.equal(table.size, 0);
});
