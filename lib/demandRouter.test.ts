import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coastForState,
  rancherForCoast,
  rancherForState,
  classifyTier,
  hasActiveReferral,
  suppressionReason,
  decideWave,
  shouldSunset,
  sizeBatch,
  inviteCapacity,
  newInviteBudget,
  countOutstandingInvites,
  openSlotsFor,
  buildCampaignPlan,
  renderMessage,
  rancherPageUrl,
  FOODSTEAD,
  SILVERLINE,
  WAVE_GAP_DAYS,
  DAY_MS,
  type CampaignBuyer,
  type Coast,
} from './demandRouter';

const NOW = Date.parse('2026-06-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY_MS).toISOString();

// ─── coast → rancher mapping ─────────────────────────────────────────────

test('WEST states route to Foodstead', () => {
  for (const s of ['CA', 'WA', 'NV', 'AZ', 'ID', 'UT', 'MT', 'WY', 'CO', 'NM', 'AK', 'HI']) {
    assert.equal(coastForState(s), 'WEST', `${s} should be WEST`);
    assert.equal(rancherForState(s)!.id, FOODSTEAD.id, `${s} → Foodstead`);
  }
});

test('EAST states route to Silverline', () => {
  for (const s of ['NY', 'NJ', 'PA', 'MA', 'CT', 'RI', 'VT', 'NH', 'ME', 'MD', 'DE', 'VA', 'NC', 'SC', 'GA', 'FL', 'WV', 'DC']) {
    assert.equal(coastForState(s), 'EAST', `${s} should be EAST`);
    assert.equal(rancherForState(s)!.id, SILVERLINE.id, `${s} → Silverline`);
  }
});

test('CENTRAL (the rest) routes to Silverline', () => {
  for (const s of ['TX', 'IL', 'OH', 'TN', 'MO', 'KS', 'OK', 'MN', 'MI', 'IN', 'IA', 'WI', 'NE', 'ND', 'SD', 'KY', 'AR', 'LA', 'MS', 'AL']) {
    assert.equal(coastForState(s), 'CENTRAL', `${s} should be CENTRAL`);
    assert.equal(rancherForState(s)!.id, SILVERLINE.id, `${s} → Silverline (East+Central)`);
  }
});

test('coast accepts full state names + lowercase (normalizeState)', () => {
  assert.equal(coastForState('California'), 'WEST');
  assert.equal(coastForState('montana'), 'WEST');
  assert.equal(coastForState('Florida'), 'EAST');
  assert.equal(coastForState('Texas'), 'CENTRAL');
});

test('unroutable / blank state → null coast', () => {
  assert.equal(coastForState(''), null);
  assert.equal(coastForState(undefined), null);
  assert.equal(coastForState('Ontario'), null);
  assert.equal(rancherForState('xx'), null);
});

test('rancherForCoast: WEST→Foodstead, EAST/CENTRAL→Silverline', () => {
  assert.equal(rancherForCoast('WEST').slug, 'foodstead');
  assert.equal(rancherForCoast('EAST').slug, 'silverline-cattle-co-mo');
  assert.equal(rancherForCoast('CENTRAL').slug, 'silverline-cattle-co-mo');
});

// ─── tier ordering ───────────────────────────────────────────────────────

test('stranded-qualified: Qualified At + score>=75 + no active referral', () => {
  assert.equal(
    classifyTier({ 'Qualified At': daysAgo(30), 'Qualification Score': 90 }),
    'stranded-qualified',
  );
});

test('a qualified buyer WITH an active referral is NOT stranded (it is in-deal → hot at best)', () => {
  const t = classifyTier({
    'Qualified At': daysAgo(30),
    'Qualification Score': 90,
    'Referral Status': 'Negotiation',
    'Ready to Buy': true,
  });
  assert.notEqual(t, 'stranded-qualified');
  assert.equal(t, 'hot');
});

test('hot: Ready to Buy OR Warmup Engaged', () => {
  assert.equal(classifyTier({ 'Ready to Buy': true }), 'hot');
  assert.equal(classifyTier({ 'Warmup Engaged At': daysAgo(10) }), 'hot');
});

test('warm: intent signal but no quiz / no explicit intent', () => {
  assert.equal(classifyTier({ 'Intent Score': 60 }), 'warm');
  assert.equal(classifyTier({ 'Intent Classification': 'High' }), 'warm');
});

test('no tier: zero intent signal → not contacted this round', () => {
  assert.equal(classifyTier({ 'Intent Score': 0 }), null);
  assert.equal(classifyTier({}), null);
});

test('tier ordering rank: stranded < hot < warm (in plan sort)', () => {
  // Build three buyers, equal everything else, distinct tiers + same coast.
  const buyers: CampaignBuyer[] = [
    { id: 'recWARM', fields: { Email: 'w@x.com', State: 'CA', 'Intent Score': 50, Created: daysAgo(20) } },
    { id: 'recHOT', fields: { Email: 'h@x.com', State: 'CA', 'Ready to Buy': true, Created: daysAgo(20) } },
    { id: 'recSTR', fields: { Email: 's@x.com', State: 'CA', 'Qualified At': daysAgo(20), 'Qualification Score': 80, Created: daysAgo(20) } },
  ];
  const plan = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 10, eastCentral: 0 } });
  assert.deepEqual(
    plan.sends.map((s) => s.buyerId),
    ['recSTR', 'recHOT', 'recWARM'],
    'stranded first, then hot, then warm',
  );
});

test('hasActiveReferral detects held statuses + MATCHED stage', () => {
  assert.equal(hasActiveReferral({ 'Referral Status': 'Slot Locked' }), true);
  assert.equal(hasActiveReferral({ 'Buyer Stage': 'MATCHED' }), true);
  assert.equal(hasActiveReferral({ 'Referral Status': 'Closed Lost' }), false);
  assert.equal(hasActiveReferral({}), false);
});

// ─── suppression ─────────────────────────────────────────────────────────

test('suppress unsubscribed / bounced / complained', () => {
  assert.equal(suppressionReason({ Email: 'a@x.com', Unsubscribed: true, Created: daysAgo(1) }, NOW), 'unsubscribed');
  assert.equal(suppressionReason({ Email: 'a@x.com', Bounced: true, Created: daysAgo(1) }, NOW), 'bounced');
  assert.equal(suppressionReason({ Email: 'a@x.com', Complained: true, Created: daysAgo(1) }, NOW), 'complained');
});

test('suppress no-email', () => {
  assert.equal(suppressionReason({ Created: daysAgo(1) }, NOW), 'no-email');
});

test('suppress contacted in the last 7 days by a NON-campaign channel', () => {
  assert.equal(
    suppressionReason({ Email: 'a@x.com', Created: daysAgo(1), 'Last Contacted At': daysAgo(3) }, NOW),
    'recent-contact',
  );
});

test('a recent OWN campaign wave does NOT count as recent-contact (wave gaps govern cadence)', () => {
  // Buyer got Msg1 4 days ago. The 7-day recency guard must NOT fire on our own
  // send — otherwise Msg2 (+3d) / Msg3 could never go out. decideWave handles
  // the cooldown idempotently instead.
  assert.equal(
    suppressionReason(
      { Email: 'a@x.com', Created: daysAgo(20), 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(4) },
      NOW,
    ),
    null,
  );
});

test('NOT suppressed when last contact was 8+ days ago', () => {
  assert.equal(
    suppressionReason({ Email: 'a@x.com', 'Last Contacted At': daysAgo(8), Created: daysAgo(40) }, NOW),
    null,
  );
});

test('suppress 18-month-dead (no activity in 18mo, or never any activity)', () => {
  assert.equal(
    suppressionReason({ Email: 'a@x.com', Created: daysAgo(19 * 30) }, NOW),
    '18-month-dead',
  );
  // No activity timestamps at all → treated as dead.
  assert.equal(suppressionReason({ Email: 'a@x.com' }, NOW), '18-month-dead');
});

test('suppress already-sunset', () => {
  assert.equal(
    suppressionReason({ Email: 'a@x.com', 'Campaign Stage': 'Sunset', Created: daysAgo(1) }, NOW),
    'already-sunset',
  );
  assert.equal(
    suppressionReason({ Email: 'a@x.com', 'Campaign Sunset At': daysAgo(1), Created: daysAgo(1) }, NOW),
    'already-sunset',
  );
});

test('fresh active buyer is NOT suppressed', () => {
  assert.equal(suppressionReason({ Email: 'a@x.com', Created: daysAgo(10), 'Last Email Opened At': daysAgo(10) }, NOW), null);
});

// ─── wave progression + idempotency ──────────────────────────────────────

test('no stage → Msg1 (day 0)', () => {
  assert.deepEqual(decideWave({}, NOW), { send: true, wave: 'Msg1' });
});

test('Msg1 Sent: cooldown before +3d, then Msg2', () => {
  assert.deepEqual(
    decideWave({ 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(2) }, NOW),
    { send: false, reason: 'cooldown' },
  );
  assert.deepEqual(
    decideWave({ 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(3) }, NOW),
    { send: true, wave: 'Msg2' },
  );
});

test('Msg2 Sent: cooldown before +4d, then Msg3', () => {
  assert.deepEqual(
    decideWave({ 'Campaign Stage': 'Msg2 Sent', 'Campaign Last Sent At': daysAgo(3) }, NOW),
    { send: false, reason: 'cooldown' },
  );
  assert.deepEqual(
    decideWave({ 'Campaign Stage': 'Msg2 Sent', 'Campaign Last Sent At': daysAgo(4) }, NOW),
    { send: true, wave: 'Msg3' },
  );
});

test('Msg3 Sent → arc-complete (never a 4th send)', () => {
  assert.deepEqual(
    decideWave({ 'Campaign Stage': 'Msg3 Sent', 'Campaign Last Sent At': daysAgo(30) }, NOW),
    { send: false, reason: 'arc-complete' },
  );
});

test('IDEMPOTENCY: a buyer at Msg1 within cooldown is never re-sent Msg1', () => {
  // Two consecutive runs 1 day apart, both inside the Msg2 gap → no send.
  const buyer = { 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(1) };
  const r1 = decideWave(buyer, NOW);
  const r2 = decideWave(buyer, NOW + DAY_MS); // still < 3d
  assert.equal(r1.send, false);
  assert.equal(r2.send, false);
});

test('full day0→+3→+7 arc advances exactly one wave per gap', () => {
  // day 0: Msg1
  let stage = '';
  let lastSent = 0;
  const stepNow = (n: number) => NOW + n * DAY_MS;
  const apply = (atDay: number) => {
    const d = decideWave({ 'Campaign Stage': stage, 'Campaign Last Sent At': lastSent ? new Date(lastSent).toISOString() : '' }, stepNow(atDay));
    if (d.send) {
      stage = { Msg1: 'Msg1 Sent', Msg2: 'Msg2 Sent', Msg3: 'Msg3 Sent' }[d.wave];
      lastSent = stepNow(atDay);
    }
    return d;
  };
  assert.deepEqual(apply(0), { send: true, wave: 'Msg1' });
  assert.deepEqual(apply(1), { send: false, reason: 'cooldown' }); // too soon
  assert.deepEqual(apply(3), { send: true, wave: 'Msg2' });        // +3
  assert.deepEqual(apply(5), { send: false, reason: 'cooldown' }); // too soon
  assert.deepEqual(apply(7), { send: true, wave: 'Msg3' });        // +4 after Msg2 ≈ day7
  assert.deepEqual(apply(30), { send: false, reason: 'arc-complete' });
});

test('shouldSunset only after Msg3 + cooldown + no engagement', () => {
  assert.equal(shouldSunset({ 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(30) }, NOW), false);
  assert.equal(shouldSunset({ 'Campaign Stage': 'Msg3 Sent', 'Campaign Last Sent At': daysAgo(1) }, NOW), false); // still in cooldown
  assert.equal(shouldSunset({ 'Campaign Stage': 'Msg3 Sent', 'Campaign Last Sent At': daysAgo(10) }, NOW), true);
});

test('shouldSunset is false if the buyer engaged (clicked / ready / in-deal)', () => {
  assert.equal(
    shouldSunset({ 'Campaign Stage': 'Msg3 Sent', 'Campaign Last Sent At': daysAgo(10), 'Email Clicks': 1 }, NOW),
    false,
  );
  assert.equal(
    shouldSunset({ 'Campaign Stage': 'Msg3 Sent', 'Campaign Last Sent At': daysAgo(10), 'Ready to Buy': true }, NOW),
    false,
  );
});

// ─── slot-sizing / capacity gating ───────────────────────────────────────

test('sizeBatch = min(dailyCap, openSlots × buffer)', () => {
  assert.equal(sizeBatch(2, { dailyCap: 25, conversionBuffer: 3 }), 6); // 2×3=6 < 25
  assert.equal(sizeBatch(20, { dailyCap: 25, conversionBuffer: 3 }), 25); // 60 capped to 25
  assert.equal(sizeBatch(0, { dailyCap: 25, conversionBuffer: 3 }), 0); // no slots
  assert.equal(sizeBatch(-5, { dailyCap: 25, conversionBuffer: 3 }), 0); // clamp
});

test('openSlotsFor reads both Max spellings + clamps at 0', () => {
  assert.equal(openSlotsFor({ max: 12, current: 5 }), 7);
  assert.equal(openSlotsFor({ max: 5, current: 9 }), 0); // over capacity → 0, never negative
});

test('CAPACITY GATING: never selects more than openSlots × buffer', () => {
  // 50 hot WEST buyers, only 2 open slots, buffer 3 → at most 6 sends.
  const buyers: CampaignBuyer[] = Array.from({ length: 50 }, (_, i) => ({
    id: `recW${String(i).padStart(3, '0')}`,
    fields: { Email: `w${i}@x.com`, State: 'CA', 'Ready to Buy': true, 'Intent Score': 100 - i, Created: daysAgo(20) },
  }));
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    capacity: { west: 2, eastCentral: 0 },
    dailyCap: 25,
    conversionBuffer: 3,
  });
  assert.equal(plan.sends.length, 6, 'exactly openSlots×buffer = 6');
  assert.ok(plan.sends.length <= 2 * 3, 'cannot exceed slots×buffer');
  // The other 44 HOT buyers become state-waitlist (not sent).
  assert.equal(plan.waitlist.length, 44);
  assert.equal(plan.waitlistByState['CA'], 44);
});

test('CAPACITY GATING: zero open slots → zero sends, all hot → waitlist', () => {
  const buyers: CampaignBuyer[] = Array.from({ length: 5 }, (_, i) => ({
    id: `recE${i}`,
    fields: { Email: `e${i}@x.com`, State: 'FL', 'Ready to Buy': true, Created: daysAgo(20) },
  }));
  const plan = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 0, eastCentral: 0 } });
  assert.equal(plan.sends.length, 0, 'no slots → no sends');
  assert.equal(plan.waitlist.length, 5);
  assert.equal(plan.capacity.eastCentral.planned, 0);
});

test('CAPACITY GATING: daily cap caps even with huge capacity', () => {
  const buyers: CampaignBuyer[] = Array.from({ length: 100 }, (_, i) => ({
    id: `recW${String(i).padStart(3, '0')}`,
    fields: { Email: `w${i}@x.com`, State: 'CA', 'Ready to Buy': true, 'Intent Score': 100, Created: daysAgo(20) },
  }));
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    capacity: { west: 1000, eastCentral: 0 },
    dailyCap: 10,
    conversionBuffer: 3,
  });
  assert.equal(plan.sends.length, 10, 'daily cap wins');
});

test('WEST + EAST/CENTRAL pools are gated independently', () => {
  const buyers: CampaignBuyer[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `recW${i}`, fields: { Email: `w${i}@x.com`, State: 'CA', 'Ready to Buy': true, Created: daysAgo(20) } })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `recE${i}`, fields: { Email: `e${i}@x.com`, State: 'FL', 'Ready to Buy': true, Created: daysAgo(20) } })),
  ];
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    capacity: { west: 1, eastCentral: 2 }, // west 1×3=3, east 2×3=6
    dailyCap: 25,
    conversionBuffer: 3,
  });
  assert.equal(plan.capacity.west.planned, 3);
  assert.equal(plan.capacity.eastCentral.planned, 6);
  assert.equal(plan.sends.filter((s) => s.coast === 'WEST').length, 3);
  assert.equal(plan.sends.filter((s) => s.coast !== 'WEST').length, 6);
});

// ─── dry-run plan: zero sends/stamps proof ───────────────────────────────
// buildCampaignPlan is pure — it returns a plan and MUTATES NOTHING. This is
// the structural guarantee that a dry-run produces a plan but writes nothing.

test('buildCampaignPlan is pure: input buyer objects are not mutated', () => {
  const fields = { Email: 'a@x.com', State: 'CA', 'Ready to Buy': true, Created: daysAgo(20) };
  const snapshot = JSON.stringify(fields);
  const buyers: CampaignBuyer[] = [{ id: 'recA', fields }];
  const plan = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 5, eastCentral: 0 } });
  assert.equal(JSON.stringify(fields), snapshot, 'no field was stamped/mutated by planning');
  assert.equal(plan.sends.length, 1);
  // The plan describes the send but no Campaign Stage was written to the buyer.
  assert.equal((fields as any)['Campaign Stage'], undefined);
});

test('plan separates suppressed / waitlist / sunset / sends with correct tallies', () => {
  const buyers: CampaignBuyer[] = [
    { id: 'recSend', fields: { Email: 's@x.com', State: 'CA', 'Ready to Buy': true, Created: daysAgo(20) } },
    { id: 'recUnsub', fields: { Email: 'u@x.com', State: 'CA', Unsubscribed: true, Created: daysAgo(1) } },
    { id: 'recDead', fields: { Email: 'd@x.com', State: 'CA', 'Ready to Buy': true, Created: daysAgo(600) } },
    { id: 'recSunset', fields: { Email: 'x@x.com', State: 'CA', 'Campaign Stage': 'Msg3 Sent', 'Campaign Last Sent At': daysAgo(10), Created: daysAgo(20) } },
  ];
  const plan = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 10, eastCentral: 0 } });
  assert.deepEqual(plan.sends.map((s) => s.buyerId), ['recSend']);
  assert.equal(plan.suppressed.unsubscribed, 1);
  assert.equal(plan.suppressed['18-month-dead'], 1);
  assert.deepEqual(plan.sunset.map((s) => s.buyerId), ['recSunset']);
});

test('the dry-run plan and a (hypothetical) live run select IDENTICAL buyers', () => {
  // Determinism check: same inputs → same plan, twice.
  const buyers: CampaignBuyer[] = Array.from({ length: 30 }, (_, i) => ({
    id: `rec${String(i).padStart(3, '0')}`,
    fields: { Email: `b${i}@x.com`, State: i % 2 ? 'CA' : 'FL', 'Intent Score': (i * 7) % 100, 'Ready to Buy': i % 3 === 0, Created: daysAgo(20) },
  }));
  const opts = { now: NOW, capacity: { west: 3, eastCentral: 3 }, dailyCap: 25, conversionBuffer: 3 } as const;
  const a = buildCampaignPlan(buyers, opts);
  const b = buildCampaignPlan(buyers, opts);
  assert.deepEqual(a.sends.map((s) => s.buyerId), b.sends.map((s) => s.buyerId));
  assert.deepEqual(a.waitlist.map((w) => w.buyerId), b.waitlist.map((w) => w.buyerId));
});

// ─── message rendering ───────────────────────────────────────────────────

test('renderMessage fills tokens + Msg2 has an SMS variant with STOP', () => {
  const ctx = {
    firstName: 'Sam',
    state: 'CA',
    rancher: { ...FOODSTEAD },
    link: 'https://buyhalfcow.com/ranchers/foodstead',
  };
  const m1 = renderMessage('Msg1', ctx);
  assert.match(m1.subject, /ships to CA/);
  assert.match(m1.text, /hey Sam,/);
  assert.match(m1.text, /Foodstead/);
  assert.match(m1.text, /Montana/);
  assert.match(m1.text, /buyhalfcow\.com\/ranchers\/foodstead/);
  assert.equal(m1.sms, null, 'Msg1 has no SMS variant');

  const m2 = renderMessage('Msg2', ctx);
  assert.ok(m2.sms, 'Msg2 has an SMS variant');
  assert.match(m2.sms!, /reply STOP to opt out/);
  assert.match(m2.sms!, /Foodstead/);

  const m3 = renderMessage('Msg3', ctx);
  assert.match(m3.text, /start of something big/);
});

test('SMS only planned for opted-in buyers on an SMS wave (TCPA)', () => {
  const buyers: CampaignBuyer[] = [
    // Opted-in, but Msg1 has no SMS variant → sms:false
    { id: 'recOptInMsg1', fields: { Email: 'a@x.com', State: 'CA', 'Ready to Buy': true, 'SMS Opt-In': true, Phone: '5551234567', Created: daysAgo(20) } },
    // Opted-in + at Msg2 stage with cooldown elapsed → sms:true
    { id: 'recOptInMsg2', fields: { Email: 'b@x.com', State: 'CA', 'Ready to Buy': true, 'SMS Opt-In': true, Phone: '5551234567', 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(4), Created: daysAgo(20) } },
    // NOT opted-in at Msg2 → sms:false even on the SMS wave
    { id: 'recNoOptMsg2', fields: { Email: 'c@x.com', State: 'CA', 'Ready to Buy': true, 'SMS Opt-In': false, Phone: '5551234567', 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgo(4), Created: daysAgo(20) } },
  ];
  const plan = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 50, eastCentral: 0 } });
  const byId = Object.fromEntries(plan.sends.map((s) => [s.buyerId, s]));
  assert.equal(byId['recOptInMsg1'].sms, false, 'Msg1 wave → no SMS even if opted in');
  assert.equal(byId['recOptInMsg2'].sms, true, 'opted-in + Msg2 → SMS planned');
  assert.equal(byId['recNoOptMsg2'].sms, false, 'not opted in → never SMS (TCPA)');
});

test('rancherPageUrl builds the fallback link', () => {
  assert.equal(rancherPageUrl('https://buyhalfcow.com/', SILVERLINE), 'https://buyhalfcow.com/ranchers/silverline-cattle-co-mo');
  assert.equal(rancherPageUrl('https://buyhalfcow.com', FOODSTEAD), 'https://buyhalfcow.com/ranchers/foodstead');
});

// ─── wave gap constants sanity (day0 / +3 / +7) ──────────────────────────

test('wave gaps encode day0→+3→+7', () => {
  assert.equal(WAVE_GAP_DAYS.Msg2, 3);
  assert.equal(WAVE_GAP_DAYS.Msg2 + WAVE_GAP_DAYS.Msg3, 7);
});

// ─── CUMULATIVE INVITE CAP (the over-invite fix) ─────────────────────────────
// A Msg1 invite does NOT consume an open slot. A per-RUN ceiling resets every
// hourly run → ~24× over-invite. These tests pin the cumulative invariant:
// the invited-but-unconverted population can never exceed openSlots × buffer,
// no matter how many runs execute with zero conversions.

test('inviteCapacity = openSlots × buffer (the absolute ceiling, not per-run)', () => {
  assert.equal(inviteCapacity(2, { conversionBuffer: 3 }), 6);
  assert.equal(inviteCapacity(0, { conversionBuffer: 3 }), 0);
  assert.equal(inviteCapacity(-1, { conversionBuffer: 3 }), 0);
});

test('newInviteBudget subtracts outstanding (cumulative), clamped to dailyCap', () => {
  // ceiling 6, none outstanding → 6 (but daily cap 25 doesn't bind)
  assert.equal(newInviteBudget(2, 0, { dailyCap: 25, conversionBuffer: 3 }), 6);
  // ceiling 6, 4 already outstanding → only 2 new
  assert.equal(newInviteBudget(2, 4, { dailyCap: 25, conversionBuffer: 3 }), 2);
  // ceiling 6, 6 outstanding → 0 (full)
  assert.equal(newInviteBudget(2, 6, { dailyCap: 25, conversionBuffer: 3 }), 0);
  // ceiling 6, 10 outstanding (over) → 0, never negative
  assert.equal(newInviteBudget(2, 10, { dailyCap: 25, conversionBuffer: 3 }), 0);
  // daily cap still paces a cold-start burst: ceiling 60, 0 outstanding, cap 10 → 10
  assert.equal(newInviteBudget(20, 0, { dailyCap: 10, conversionBuffer: 3 }), 10);
});

test('countOutstandingInvites: in-arc, unconverted, non-sunset only — bucketed by coast', () => {
  const coastOf = (f: Record<string, unknown>): Coast | null => coastForState(f['State']);
  const buyers: CampaignBuyer[] = [
    { id: 'a', fields: { State: 'CA', 'Campaign Stage': 'Msg1 Sent' } },                 // WEST, counts
    { id: 'b', fields: { State: 'CA', 'Campaign Stage': 'Msg3 Sent' } },                 // WEST, counts
    { id: 'c', fields: { State: 'FL', 'Campaign Stage': 'Msg2 Sent' } },                 // EAST, counts
    { id: 'd', fields: { State: 'TX', 'Campaign Stage': 'Msg1 Sent' } },                 // CENTRAL→E/C, counts
    { id: 'e', fields: { State: 'CA', 'Campaign Stage': 'Sunset', 'Campaign Sunset At': '2026-06-01T00:00:00Z' } }, // sunset, excluded
    { id: 'f', fields: { State: 'CA', 'Campaign Stage': 'Msg2 Sent', 'Referral Status': 'Slot Locked' } },          // converted, excluded
    { id: 'g', fields: { State: 'CA' } },                                                // never invited, excluded
    { id: 'h', fields: { State: 'ZZ', 'Campaign Stage': 'Msg1 Sent' } },                 // unroutable, excluded
  ];
  const out = countOutstandingInvites(buyers, coastOf);
  assert.equal(out.west, 2, 'a + b');
  assert.equal(out.eastCentral, 2, 'c + d');
});

test('CUMULATIVE CAP: N hourly runs, zero conversions → total Msg1 invites ≤ openSlots×buffer (NOT N×)', () => {
  // 100 fresh HOT WEST buyers, only 2 open slots, buffer 3 → ceiling 6.
  // Simulate 24 hourly runs. Between runs we apply the SAME disposition the live
  // cron writes (stamp Msg1 Sent + last-sent) to every buyer the plan chose —
  // and NO conversions (slots stay at 2). The cumulative budget must drain to 0
  // after the ceiling is hit, so the GRAND TOTAL of distinct Msg1 invites ≤ 6.
  const ceiling = 6;
  const buyers: CampaignBuyer[] = Array.from({ length: 100 }, (_, i) => ({
    id: `recW${String(i).padStart(3, '0')}`,
    fields: { Email: `w${i}@x.com`, State: 'CA', 'Ready to Buy': true, 'Intent Score': 100 - i, Created: new Date(NOW - 20 * DAY_MS).toISOString() } as Record<string, unknown>,
  }));
  const invitedIds = new Set<string>();
  const RUNS = 24;
  for (let run = 0; run < RUNS; run++) {
    const runNow = NOW + run * 60 * 60 * 1000; // hourly
    const plan = buildCampaignPlan(buyers, {
      now: runNow,
      capacity: { west: 2, eastCentral: 0 }, // slots NEVER decrement (no conversions)
      dailyCap: 25,
      conversionBuffer: 3,
    });
    // Every Msg1 send this run is a NEW distinct invite — assert no double-send.
    for (const s of plan.sends) {
      assert.equal(s.wave, 'Msg1', 'only Msg1 in this all-fresh pool');
      assert.equal(invitedIds.has(s.buyerId), false, `buyer ${s.buyerId} invited twice across runs`);
      invitedIds.add(s.buyerId);
      // Apply the live cron's disposition stamp so the NEXT run sees them as
      // outstanding (this is what makes the cumulative term work).
      const b = buyers.find((x) => x.id === s.buyerId)!;
      b.fields['Campaign Stage'] = 'Msg1 Sent';
      b.fields['Campaign Last Sent At'] = new Date(runNow).toISOString();
    }
  }
  assert.ok(
    invitedIds.size <= ceiling,
    `cumulative Msg1 invites (${invitedIds.size}) must be ≤ ceiling ${ceiling}, NOT ${RUNS}× the per-run budget`,
  );
  assert.equal(invitedIds.size, ceiling, 'exactly the ceiling gets invited, then the budget is exhausted');
});

test('CONTINUATIONS send OUTSIDE the new-invite budget (arcs complete even at 0 budget)', () => {
  // Ceiling is fully consumed by outstanding invites (6 already at Msg1 Sent,
  // due for Msg2). A fresh Msg1 buyer must NOT send (budget 0 → waitlist), but
  // the 6 continuations MUST send (Msg2) — completing arcs is unbounded.
  const old = new Date(NOW - 20 * DAY_MS).toISOString();
  const dueForMsg2 = new Date(NOW - 4 * DAY_MS).toISOString(); // past the +3 gap
  const buyers: CampaignBuyer[] = [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `recCont${i}`,
      fields: { Email: `cont${i}@x.com`, State: 'CA', 'Ready to Buy': true, 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': dueForMsg2, Created: old } as Record<string, unknown>,
    })),
    { id: 'recFresh', fields: { Email: 'fresh@x.com', State: 'CA', 'Ready to Buy': true, 'Intent Score': 100, Created: old } },
  ];
  const plan = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 2, eastCentral: 0 }, dailyCap: 25, conversionBuffer: 3 });
  // 6 outstanding fills the ceiling of 6 → 0 new budget.
  assert.equal(plan.capacity.west.outstanding, 6);
  assert.equal(plan.capacity.west.newBudget, 0);
  // All 6 continuations send (Msg2); the fresh Msg1 buyer does NOT.
  assert.equal(plan.byWave.Msg2, 6, 'all continuations complete their arc');
  assert.equal(plan.byWave.Msg1, 0, 'no new invite when budget is exhausted');
  assert.ok(plan.sends.every((s) => s.buyerId !== 'recFresh'), 'fresh buyer not invited');
  // The fresh HOT buyer is held as a state-waitlist signal instead.
  assert.ok(plan.waitlist.some((w) => w.buyerId === 'recFresh'));
});

test('a converted outstanding buyer RELEASES invite budget (frees a slot for a new invite)', () => {
  // 6 at Msg1 Sent, but one converted (active referral) → outstanding drops to
  // 5 → 1 new invite becomes available again.
  const old = new Date(NOW - 20 * DAY_MS).toISOString();
  const buyers: CampaignBuyer[] = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `recOut${i}`,
      fields: { Email: `out${i}@x.com`, State: 'CA', 'Ready to Buy': true, 'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': new Date(NOW - 1 * DAY_MS).toISOString(), Created: old } as Record<string, unknown>,
    })),
    // converted — in a deal, no longer an outstanding invite
    { id: 'recConverted', fields: { Email: 'conv@x.com', State: 'CA', 'Campaign Stage': 'Msg1 Sent', 'Referral Status': 'Slot Locked', Created: old } },
    // fresh HOT buyer wants in
    { id: 'recFresh', fields: { Email: 'fresh@x.com', State: 'CA', 'Ready to Buy': true, 'Intent Score': 100, Created: old } },
  ];
  const plan = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 2, eastCentral: 0 }, dailyCap: 25, conversionBuffer: 3 });
  assert.equal(plan.capacity.west.outstanding, 5, 'converted buyer not counted as outstanding invite');
  assert.equal(plan.capacity.west.newBudget, 1, 'ceiling 6 − 5 outstanding = 1 new');
  assert.ok(plan.sends.some((s) => s.buyerId === 'recFresh' && s.wave === 'Msg1'), 'the freed budget admits the fresh buyer');
});
