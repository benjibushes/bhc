// lib/ranchStandDigest.test.ts — P3′ Ranch Stand Digest (pure selectors +
// renderer). node:test, zero network deps — mirrors routingSegment.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_MARKER,
  DIGEST_CADENCE_DAYS,
  NEW_ARRIVALS_WINDOW_DAYS,
  THIN_MONTH_MIN_NEW,
  RANCH_STORIES,
  ranchStoryForMonth,
  toDigestProduct,
  selectNewArrivals,
  isThinMonth,
  selectShelfHighlights,
  latestCloseFromRefs,
  tierForDayOfMonth,
  engagementMs,
  createdMs,
  lastDigestMs,
  buildDigestMarkerLine,
  classifyDigestRecipient,
  assignTiers,
  renderRanchStandDigest,
  type DigestTarget,
  activeSprintConsumerIds,
} from './ranchStandDigest';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-01T15:00:00.000Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS).toISOString();

// ── product rows ──────────────────────────────────────────────────────

function sellableRow(over: Record<string, unknown> = {}): any {
  return {
    id: 'recPPPPPPPPPPPP01',
    _createdTime: daysAgo(10),
    'Product Name': 'ground beef box',
    'Rancher Name': 'silverline',
    Category: 'Ground Box',
    'Display Price': 95,
    'Rancher Base': 80,
    Active: true,
    ...over,
  };
}

test('toDigestProduct: sellable row maps; unsellable returns null', () => {
  const p = toDigestProduct(sellableRow());
  assert.ok(p);
  assert.equal(p!.name, 'ground beef box');
  assert.equal(p!.price, 95);
  assert.ok(p!.createdTimeMs > 0);
  // Inactive → not sellable (isSellableRow reused verbatim).
  assert.equal(toDigestProduct(sellableRow({ Active: false })), null);
  // Negative-margin row must never be marketed (base > price).
  assert.equal(toDigestProduct(sellableRow({ 'Rancher Base': 200 })), null);
  // Local-pickup rows (Ships Nationwide === false) never reach the digest.
  assert.equal(toDigestProduct(sellableRow({ 'Ships Nationwide': false })), null);
  // Sold out never listed.
  assert.equal(toDigestProduct(sellableRow({ 'Orders Left': 0 })), null);
});

test('selectNewArrivals: window filter + newest first + cap', () => {
  const rows = [
    sellableRow({ id: 'recAAAAAAAAAAAA01', _createdTime: daysAgo(5), 'Product Name': 'five' }),
    sellableRow({ id: 'recAAAAAAAAAAAA02', _createdTime: daysAgo(2), 'Product Name': 'two' }),
    sellableRow({ id: 'recAAAAAAAAAAAA03', _createdTime: daysAgo(NEW_ARRIVALS_WINDOW_DAYS + 5), 'Product Name': 'old' }),
    sellableRow({ id: 'recAAAAAAAAAAAA04', _createdTime: daysAgo(1), Active: false, 'Product Name': 'dead' }),
    sellableRow({ id: 'recAAAAAAAAAAAA05', _createdTime: '', 'Product Name': 'no-stamp' }),
  ];
  const picks = selectNewArrivals(rows, NOW);
  assert.deepEqual(picks.map((p) => p.name), ['two', 'five']);
});

test('isThinMonth: <3 new products is thin, >=3 is not', () => {
  const p = toDigestProduct(sellableRow())!;
  assert.equal(isThinMonth([]), true);
  assert.equal(isThinMonth([p, p]), true);
  assert.equal(isThinMonth([p, p, p]), false);
  assert.equal(THIN_MONTH_MIN_NEW, 3);
});

test('selectShelfHighlights: cheapest-first with category variety, merch excluded', () => {
  const rows = [
    sellableRow({ id: 'recBBBBBBBBBBBB01', 'Product Name': 'jerky', Category: 'Jerky', 'Display Price': 24, 'Rancher Base': 15 }),
    sellableRow({ id: 'recBBBBBBBBBBBB02', 'Product Name': 'jerky-2', Category: 'Jerky', 'Display Price': 29, 'Rancher Base': 15 }),
    sellableRow({ id: 'recBBBBBBBBBBBB03', 'Product Name': 'ground', Category: 'Ground Box', 'Display Price': 95, 'Rancher Base': 80 }),
    sellableRow({ id: 'recBBBBBBBBBBBB04', 'Product Name': 'hat', Category: 'Merch', 'Display Price': 30, 'Rancher Base': 20 }),
    sellableRow({ id: 'recBBBBBBBBBBBB05', 'Product Name': 'sampler', Category: 'Sampler Box', 'Display Price': 149, 'Rancher Base': 120 }),
  ];
  const picks = selectShelfHighlights(rows, { cap: 4 });
  // One per category first (cheapest within), then backfill by price; no hat.
  assert.deepEqual(picks.map((p) => p.name), ['jerky', 'ground', 'sampler', 'jerky-2']);
});

test('selectShelfHighlights: excludeIds prevents repeating new arrivals', () => {
  const rows = [
    sellableRow({ id: 'recBBBBBBBBBBBB06', 'Product Name': 'a', 'Display Price': 20, 'Rancher Base': 10 }),
    sellableRow({ id: 'recBBBBBBBBBBBB07', 'Product Name': 'b', Category: 'Jerky', 'Display Price': 30, 'Rancher Base': 10 }),
  ];
  const picks = selectShelfHighlights(rows, { excludeIds: new Set(['recBBBBBBBBBBBB06']) });
  assert.deepEqual(picks.map((p) => p.name), ['b']);
});

// ── latest close ──────────────────────────────────────────────────────

test('latestCloseFromRefs: newest real sale wins; first name + state only', () => {
  const close = latestCloseFromRefs([
    { 'Buyer Name': 'Sarah Kowalski', 'Order Type': 'Half', 'Buyer State': 'tx', 'Sale Amount': 2100, 'Closed At': daysAgo(9) },
    { 'Buyer Name': 'Old Deal', 'Order Type': 'Quarter', 'Buyer State': 'MT', 'Sale Amount': 900, 'Closed At': daysAgo(40) },
    { 'Buyer Name': 'Zero Dollar', 'Order Type': 'Whole', 'Buyer State': 'CA', 'Sale Amount': 0, 'Closed At': daysAgo(1) },
  ]);
  assert.ok(close);
  assert.equal(close!.firstName, 'Sarah'); // never the full name
  assert.equal(close!.orderLabel, 'half cow');
  assert.equal(close!.buyerState, 'TX');
});

test('latestCloseFromRefs: nothing qualifying → null (never fabricated)', () => {
  assert.equal(latestCloseFromRefs([]), null);
  assert.equal(latestCloseFromRefs([{ 'Buyer Name': 'X', 'Sale Amount': 0 }]), null);
});

// ── stories ───────────────────────────────────────────────────────────

test('ranch stories: 3 rotations, cycle by month, brand-voice clean', () => {
  assert.equal(RANCH_STORIES.length, 3);
  assert.equal(ranchStoryForMonth(0), RANCH_STORIES[0]);
  assert.equal(ranchStoryForMonth(4), RANCH_STORIES[1]);
  assert.equal(ranchStoryForMonth(11), RANCH_STORIES[2]);
  assert.equal(ranchStoryForMonth(12), RANCH_STORIES[0]);
  // NO-words (docs/BHC.md) must never appear in shipped copy.
  const noWords = /synergy|disrupt|ecosystem|stakeholder|curate|journey|revolutionary|powered by|best-in-class|seamless|holistic/i;
  for (const s of RANCH_STORIES) {
    assert.ok(!noWords.test(s.title + ' ' + s.body), `NO-word in story: ${s.title}`);
    // Lowercase voice — titles never start with a capital.
    assert.equal(s.title, s.title.toLowerCase());
  }
});

// ── send window + engagement ──────────────────────────────────────────

test('tierForDayOfMonth: days 1-4 map to tiers, everything else null', () => {
  assert.equal(tierForDayOfMonth(1), 1);
  assert.equal(tierForDayOfMonth(4), 4);
  assert.equal(tierForDayOfMonth(5), null);
  assert.equal(tierForDayOfMonth(28), null);
  assert.equal(tierForDayOfMonth(0), null);
});

test('engagementMs: max across click/open/quiz stamps; 0 when none', () => {
  assert.equal(engagementMs({}), 0);
  const t = engagementMs({
    'Last Email Opened At': daysAgo(30),
    'Last Email Clicked At': daysAgo(10),
    'Qualified At': daysAgo(200),
  });
  assert.equal(t, new Date(daysAgo(10)).getTime());
  // Quiz-activity stamps count as engagement on their own.
  assert.ok(engagementMs({ 'Funnel Completed At': daysAgo(50) }) > 0);
  assert.ok(engagementMs({ 'Warmup Engaged At': daysAgo(50) }) > 0);
});

test('createdMs: Created > Created At > _createdTime fallback', () => {
  assert.equal(createdMs({ Created: daysAgo(9), _createdTime: daysAgo(99) }), new Date(daysAgo(9)).getTime());
  assert.equal(createdMs({ _createdTime: daysAgo(99) }), new Date(daysAgo(99)).getTime());
  assert.equal(createdMs({}), 0);
});

// ── digest marker / cadence cap ───────────────────────────────────────

test('lastDigestMs: latest dated stamp wins; absent/malformed → 0', () => {
  assert.equal(lastDigestMs(''), 0);
  assert.equal(lastDigestMs('[WAITLIST 2026-07-01] captured'), 0);
  assert.equal(lastDigestMs('[RANCH-STAND-DIGEST notadate] junk'), 0);
  const notes = [
    buildDigestMarkerLine('2026-07-01', 'sent', 2),
    '[AREA-OPENED 2026-08-02] area-opened email sent (state-coverage-notify)',
    buildDigestMarkerLine('2026-08-01', 'suppressed', 3),
  ].join('\n');
  assert.equal(lastDigestMs(notes), new Date('2026-08-01T00:00:00.000Z').getTime());
});

test('buildDigestMarkerLine: dated, parseable, carries outcome + tier', () => {
  const line = buildDigestMarkerLine('2026-09-01', 'sent', 1);
  assert.ok(line.startsWith(DIGEST_MARKER));
  assert.ok(line.includes('2026-09-01'));
  assert.ok(line.includes('tier 1'));
  assert.equal(lastDigestMs(line), new Date('2026-09-01T00:00:00.000Z').getTime());
});

// ── recipient classification ──────────────────────────────────────────

function consumer(over: Record<string, unknown> = {}): any {
  return {
    id: 'recCCCCCCCCCCCC01',
    Email: 'jane@example.com',
    'Full Name': 'Jane Miller',
    State: 'FL',
    'Routing Segment': 'STATE_WAITLIST',
    'Last Email Opened At': daysAgo(20),
    Created: daysAgo(300),
    ...over,
  };
}

test('classify: engaged consumer is eligible with normalized target', () => {
  const c = classifyDigestRecipient(consumer(), NOW);
  assert.ok(c.eligible);
  if (c.eligible) {
    assert.equal(c.target.email, 'jane@example.com');
    assert.equal(c.target.firstName, 'Jane');
    assert.equal(c.target.state, 'FL');
    assert.equal(c.target.lane, 'national');
    assert.ok(c.target.engagementMs > 0);
  }
});

test('classify: suppression flags + missing/synthetic email are out', () => {
  assert.deepEqual(classifyDigestRecipient(consumer({ Unsubscribed: true }), NOW), { eligible: false, reason: 'suppressed' });
  assert.deepEqual(classifyDigestRecipient(consumer({ Bounced: true }), NOW), { eligible: false, reason: 'suppressed' });
  assert.deepEqual(classifyDigestRecipient(consumer({ Complained: true }), NOW), { eligible: false, reason: 'suppressed' });
  assert.deepEqual(classifyDigestRecipient(consumer({ Email: '' }), NOW), { eligible: false, reason: 'no-email' });
  assert.deepEqual(classifyDigestRecipient(consumer({ Email: 'probe-audit-1@x.com' }), NOW), { eligible: false, reason: 'synthetic' });
  assert.deepEqual(classifyDigestRecipient(consumer({ Email: 'e2e@example.test' }), NOW), { eligible: false, reason: 'synthetic' });
});

test('classify: deliverability gates — sunset at 180d, hard-out at 12mo, engaged is immune', () => {
  const neverEngaged = { 'Last Email Opened At': undefined };
  // 100d old, zero engagement → still eligible (young list is P3′ audience).
  assert.equal(classifyDigestRecipient(consumer({ ...neverEngaged, Created: daysAgo(100) }), NOW).eligible, true);
  // 181d, zero engagement → P5′ re-permission owns them.
  assert.deepEqual(
    classifyDigestRecipient(consumer({ ...neverEngaged, Created: daysAgo(181) }), NOW),
    { eligible: false, reason: 'skipped-sunset' },
  );
  // 366d, zero engagement → suppressed outright.
  assert.deepEqual(
    classifyDigestRecipient(consumer({ ...neverEngaged, Created: daysAgo(366) }), NOW),
    { eligible: false, reason: 'skipped-neverengaged' },
  );
  // Old record WITH engagement stays in.
  assert.equal(
    classifyDigestRecipient(consumer({ Created: daysAgo(400), 'Last Email Clicked At': daysAgo(50) }), NOW).eligible,
    true,
  );
  // Unreadable age fails OPEN (cannot prove the gate).
  assert.equal(classifyDigestRecipient(consumer({ ...neverEngaged, Created: undefined }), NOW).eligible, true);
});

test('classify: cadence cap — a digest stamp younger than 25d skips, older re-admits', () => {
  const recent = consumer({ Notes: buildDigestMarkerLine(new Date(NOW - 10 * DAY_MS).toISOString().slice(0, 10), 'sent', 1) });
  assert.deepEqual(classifyDigestRecipient(recent, NOW), { eligible: false, reason: 'recently-sent' });
  const stale = consumer({ Notes: buildDigestMarkerLine(new Date(NOW - (DIGEST_CADENCE_DAYS + 2) * DAY_MS).toISOString().slice(0, 10), 'sent', 1) });
  assert.equal(classifyDigestRecipient(stale, NOW).eligible, true);
  // A suppressed-outcome stamp burns the month too (cadence consistency).
  const sup = consumer({ Notes: buildDigestMarkerLine(new Date(NOW - 5 * DAY_MS).toISOString().slice(0, 10), 'suppressed', 2) });
  assert.deepEqual(classifyDigestRecipient(sup, NOW), { eligible: false, reason: 'recently-sent' });
});

test('classify: customer + share-ready lanes are included (plan §3), placeholder name dropped', () => {
  const cust = classifyDigestRecipient(consumer({ 'Routing Segment': 'TERMINAL' }), NOW);
  assert.ok(cust.eligible && cust.target.lane === 'customer');
  const share = classifyDigestRecipient(consumer({ 'Routing Segment': 'MATCH_NOW' }), NOW);
  assert.ok(share.eligible && share.target.lane === 'share-ready');
  const wl = classifyDigestRecipient(consumer({ 'Full Name': '(waitlist signup)' }), NOW);
  assert.ok(wl.eligible && wl.target.firstName === '');
});

// ── tiers ─────────────────────────────────────────────────────────────

function target(email: string, engagedDaysAgo: number | null): DigestTarget {
  return {
    consumerId: `rec-${email}`,
    email,
    firstName: '',
    state: '',
    lane: 'national',
    engagementMs: engagedDaysAgo === null ? 0 : NOW - engagedDaysAgo * DAY_MS,
  };
}

test('assignTiers: most recent quartile first, remainder loads early tiers', () => {
  const targets = Array.from({ length: 10 }, (_, i) => target(`u${String(i).padStart(2, '0')}@x.com`, i + 1));
  const tiers = assignTiers(targets);
  assert.deepEqual(tiers.map((t) => t.length), [3, 3, 2, 2]);
  // Tier 1 holds the 3 most recently engaged.
  assert.deepEqual(tiers[0].map((t) => t.email), ['u00@x.com', 'u01@x.com', 'u02@x.com']);
  // Never-engaged (0) sorts last.
  const withCold = assignTiers([target('cold@x.com', null), ...targets.slice(0, 3)]);
  assert.equal(withCold[3][0].email, 'cold@x.com');
});

test('assignTiers: small + empty lists degrade honestly', () => {
  assert.deepEqual(assignTiers([]).map((t) => t.length), [0, 0, 0, 0]);
  const tiers = assignTiers([target('a@x.com', 1), target('b@x.com', 2), target('c@x.com', 3)]);
  assert.deepEqual(tiers.map((t) => t.length), [1, 1, 1, 0]);
});

// ── render ────────────────────────────────────────────────────────────

const RENDER_BASE = {
  firstName: 'Jane',
  recipientState: 'FL',
  servedStates: new Set(['TX', 'MT']),
  newArrivals: [] as any[],
  shelf: [toDigestProduct(sellableRow())!],
  latestClose: { firstName: 'Sarah', orderLabel: 'half cow', buyerState: 'TX' },
  story: RANCH_STORIES[0],
  monthIndex: 8,
  siteUrl: 'https://www.buyhalfcow.com',
};

test('render: lowercase month subject, two-block layout, one CTA button', () => {
  const { subject, html } = renderRanchStandDigest(RENDER_BASE);
  assert.equal(subject, 'the ranch stand — september');
  assert.ok(html.includes('ships to you'));
  // FL not served → NO in-your-state block.
  assert.ok(!html.includes('in Florida'));
  // Exactly one CTA button (background:#0E0E0E anchor).
  assert.equal((html.match(/display:inline-block;padding:14px 28px;background:#0E0E0E/g) || []).length, 1);
  assert.ok(html.includes('/shop'));
});

test('render: served state gets the in-your-state block with the shared local-share label', () => {
  const { html } = renderRanchStandDigest({ ...RENDER_BASE, recipientState: 'TX' });
  assert.ok(html.includes('in Texas'));
  assert.ok(html.includes('local share — serves Texas')); // operationTypeEmailLine reuse
  assert.ok(html.includes('/access'));
});

test('render: thin month omits the new-arrivals section but never the shelf', () => {
  const thin = renderRanchStandDigest(RENDER_BASE);
  assert.ok(!thin.html.includes('new on the stand'));
  assert.ok(thin.html.includes('on the shelf'));
  const arrivals = [1, 2, 3].map((i) =>
    toDigestProduct(sellableRow({ id: `recDDDDDDDDDDDD0${i}`, 'Product Name': `arrival-${i}`, _createdTime: daysAgo(i) }))!,
  );
  const full = renderRanchStandDigest({ ...RENDER_BASE, newArrivals: arrivals });
  assert.ok(full.html.includes('new on the stand'));
  assert.ok(full.html.includes('arrival-1'));
});

test('render: operation-type line on product blocks; proof line first-name-only; escaping', () => {
  const frozen = toDigestProduct(sellableRow({ 'Shelf Stable': false }))!;
  const stable = toDigestProduct(sellableRow({ id: 'recEEEEEEEEEEEE01', 'Product Name': 'jerky <b>', Category: 'Jerky', 'Shelf Stable': true, 'Display Price': 24, 'Rancher Base': 12 }))!;
  const { html } = renderRanchStandDigest({ ...RENDER_BASE, shelf: [frozen, stable] });
  assert.ok(html.includes('ships frozen, nationwide'));
  assert.ok(html.includes('ships nationwide'));
  assert.ok(html.includes('jerky &lt;b&gt;')); // rancher-supplied names escaped
  assert.ok(html.includes('latest close: Sarah in TX took a half cow.'));
  assert.ok(!html.includes('Kowalski')); // never a full buyer name
});

test('render: no latest close → no proof line, never fabricated', () => {
  const { html } = renderRanchStandDigest({ ...RENDER_BASE, latestClose: null });
  assert.ok(!html.includes('latest close:'));
});

test('render: rendered copy carries no NO-words or fake urgency', () => {
  const arrivals = [1, 2, 3].map((i) =>
    toDigestProduct(sellableRow({ id: `recFFFFFFFFFFFF0${i}`, _createdTime: daysAgo(i) }))!,
  );
  for (const story of RANCH_STORIES) {
    const { html, subject } = renderRanchStandDigest({ ...RENDER_BASE, newArrivals: arrivals, recipientState: 'TX', story });
    const text = subject + ' ' + html;
    assert.ok(!/synergy|disrupt|ecosystem|stakeholder|seamless|holistic|best-in-class|powered by/i.test(text));
    assert.ok(!/don'?t miss out|last chance|hurry|act now/i.test(text));
    assert.equal(subject, subject.toLowerCase());
  }
});

// ── P7b · sprint defer ──────────────────────────────────────────────────────

test('activeSprintConsumerIds: live unpaid invite within 21d defers its buyer', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const refs = [
    { id: 'r1', 'Deposit Invite Sent At': '2026-08-01T00:00:00Z', Buyer: ['cA'] },
    { id: 'r2', 'Deposit Requested At': '2026-08-05T00:00:00Z', Buyer: ['cB'] },
  ];
  const ids = activeSprintConsumerIds(refs as any, now);
  assert.ok(ids.has('cA') && ids.has('cB'));
});

test('activeSprintConsumerIds: paid, stale, or unstamped rows never defer', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const refs = [
    { id: 'r1', 'Deposit Invite Sent At': '2026-08-01T00:00:00Z', 'Deposit Paid At': '2026-08-02T00:00:00Z', Buyer: ['paid'] },
    { id: 'r2', 'Deposit Invite Sent At': '2026-07-01T00:00:00Z', Buyer: ['stale'] },
    { id: 'r3', Buyer: ['never'] },
    { id: 'r4', 'Deposit Requested At': 'not-a-date', Buyer: ['garbage'] },
  ];
  const ids = activeSprintConsumerIds(refs as any, now);
  assert.equal(ids.size, 0);
});

test('classifyDigestRecipient: sprint-deferred beats eligibility, absent set changes nothing', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const row = { id: 'cA', Email: 'a@example.com', 'Last Email Clicked At': '2026-08-01T00:00:00Z' } as any;
  const deferred = classifyDigestRecipient(row, now, { activeSprintIds: new Set(['cA']) });
  assert.equal(deferred.eligible, false);
  assert.equal((deferred as any).reason, 'sprint-deferred');
  const normal = classifyDigestRecipient(row, now);
  assert.equal(normal.eligible, true);
});
