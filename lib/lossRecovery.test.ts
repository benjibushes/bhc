import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionForLossReason,
  cutLabelFromOrderType,
  isBuyerContactable,
  isSmsEligible,
  shouldStampRewarm,
  isClosedWithinWindow,
  selectLossRecovery,
  recoveryNoteLine,
  renderReengageSms,
  LOSS_REASON_CHOICES,
  DEFAULT_MAX_PER_RUN,
} from './lossRecovery';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-15T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

// ── fixtures ─────────────────────────────────────────────────────────────────

function buyer(over: Record<string, unknown> = {}) {
  return {
    id: 'recBUYER1',
    'Full Name': 'Amie Buyer',
    Email: 'amie@example.com',
    State: 'TX',
    Phone: '(512) 555-0101',
    ...over,
  } as Record<string, any>;
}

function lostRef(over: Record<string, unknown> = {}) {
  return {
    id: 'recREF1',
    Status: 'Closed Lost',
    'Loss Reason': "Couldn't reach buyer",
    'Closed At': daysAgo(3),
    Buyer: ['recBUYER1'],
    'Order Type': 'Half Beef',
    Notes: 'existing note',
    ...over,
  } as Record<string, any>;
}

function run(
  candidates: any[],
  opts: {
    consumers?: any[];
    activeReferrals?: any[];
    cap?: number;
    windowEnforcedUpstream?: boolean;
    coveredStates?: Set<string>;
  } = {},
) {
  const consumersById = new Map<string, Record<string, any>>();
  for (const c of opts.consumers ?? [buyer()]) consumersById.set(c.id, c);
  return selectLossRecovery({
    candidates,
    activeReferrals: opts.activeReferrals ?? [],
    consumersById,
    nowMs: NOW,
    cap: opts.cap,
    windowEnforcedUpstream: opts.windowEnforcedUpstream ?? false,
    coveredStates: opts.coveredStates,
  });
}

// ── reason → action map ──────────────────────────────────────────────────────

test('reason map: every prod choice maps, byte-for-byte', () => {
  assert.equal(actionForLossReason("Couldn't reach buyer"), 'reengage');
  assert.equal(actionForLossReason('Price too high'), 'downsell');
  assert.equal(actionForLossReason('Timing — buying later'), 'nurture'); // em-dash U+2014
  assert.equal(actionForLossReason('Bought elsewhere'), 'none');
  assert.equal(actionForLossReason('Out of service area'), 'none');
  assert.equal(actionForLossReason('Wrong intent (not a buyer)'), 'none');
  assert.equal(actionForLossReason('Other'), 'none');
  // Exhaustive: no pinned choice may ever fall through to null.
  for (const c of LOSS_REASON_CHOICES) assert.notEqual(actionForLossReason(c), null, c);
});

test('reason map: blank and unknown values return null (no guessing)', () => {
  assert.equal(actionForLossReason(''), null);
  assert.equal(actionForLossReason(undefined), null);
  assert.equal(actionForLossReason('Timing - buying later'), null); // hyphen ≠ em-dash: drift must NOT match
  assert.equal(actionForLossReason('price too high'), null); // case drift
});

test('reason map: Airtable {name} object shape is normalized', () => {
  assert.equal(actionForLossReason({ name: 'Price too high' }), 'downsell');
});

// ── cut label ────────────────────────────────────────────────────────────────

test('cut label: quarter/half/whole parsed, junk falls back', () => {
  assert.equal(cutLabelFromOrderType('Quarter Beef'), 'quarter');
  assert.equal(cutLabelFromOrderType('Half'), 'half');
  assert.equal(cutLabelFromOrderType('WHOLE cow'), 'whole');
  assert.equal(cutLabelFromOrderType('Not Sure'), 'beef share');
  assert.equal(cutLabelFromOrderType(''), 'beef share');
});

// ── contactability / SMS / rewarm gates ─────────────────────────────────────

test('contactable: requires email, rejects checkbox + Status suppression', () => {
  assert.equal(isBuyerContactable(buyer()), true);
  assert.equal(isBuyerContactable(buyer({ Email: '' })), false);
  assert.equal(isBuyerContactable(buyer({ Email: 'not-an-email' })), false);
  assert.equal(isBuyerContactable(buyer({ Unsubscribed: true })), false);
  assert.equal(isBuyerContactable(buyer({ Bounced: true })), false);
  assert.equal(isBuyerContactable(buyer({ Complained: true })), false);
  assert.equal(isBuyerContactable(buyer({ Status: 'Unsubscribed' })), false);
  assert.equal(isBuyerContactable(null), false);
});

test('sms eligible: STRICT === true opt-in + phone (matches sendSMSToConsumer)', () => {
  assert.equal(isSmsEligible(buyer({ 'SMS Opt-In': true })), true);
  assert.equal(isSmsEligible(buyer()), false); // no opt-in field
  assert.equal(isSmsEligible(buyer({ 'SMS Opt-In': 'true' })), false); // loose truthy rejected
  assert.equal(isSmsEligible(buyer({ 'SMS Opt-In': true, Phone: '' })), false);
  assert.equal(isSmsEligible(buyer({ 'SMS Opt-In': true, Unsubscribed: true })), false);
});

test('rewarm stamp: mirrors the FULL re-warm-cohort filter, not just engagement', () => {
  // Stampable = a buyer re-warm-cohort would actually pick up in ~60d.
  assert.equal(shouldStampRewarm(buyer({ Status: 'Approved' })), true);
  assert.equal(shouldStampRewarm(buyer({ Status: 'Approved', 'Re-Warm Attempts': 1 })), true);
  // Every leg of the re-warm filter must gate the stamp:
  assert.equal(shouldStampRewarm(buyer({ Status: 'Approved', 'Warmup Engaged At': daysAgo(90) })), false);
  assert.equal(shouldStampRewarm(buyer()), false); // no Status — re-warm requires Approved
  assert.equal(shouldStampRewarm(buyer({ Status: 'Waitlist' })), false);
  assert.equal(shouldStampRewarm(buyer({ Status: 'Approved', 'Ready to Buy': true })), false); // re-warm skips truthy
  assert.equal(shouldStampRewarm(buyer({ Status: 'Approved', 'Ready to Buy': 'Yes' })), false);
  assert.equal(shouldStampRewarm(buyer({ Status: 'Approved', 'Re-Warm Attempts': 2 })), false); // lifetime cap
  assert.equal(shouldStampRewarm(null), false);
});

// ── close window ─────────────────────────────────────────────────────────────

test('window: parseable Closed At decides, in and out', () => {
  assert.equal(isClosedWithinWindow(lostRef({ 'Closed At': daysAgo(13.5) }), NOW, 14, false), true);
  assert.equal(isClosedWithinWindow(lostRef({ 'Closed At': daysAgo(15) }), NOW, 14, false), false);
  // Even when upstream enforced, a stale Closed At is trusted over the formula.
  assert.equal(isClosedWithinWindow(lostRef({ 'Closed At': daysAgo(40) }), NOW, 14, true), false);
});

test('window: missing Closed At trusts upstream formula, else conservative exclude', () => {
  assert.equal(isClosedWithinWindow(lostRef({ 'Closed At': '' }), NOW, 14, true), true);
  assert.equal(isClosedWithinWindow(lostRef({ 'Closed At': '' }), NOW, 14, false), false);
  assert.equal(isClosedWithinWindow(lostRef({ 'Closed At': 'garbage' }), NOW, 14, false), false);
});

// ── selector: reason branches ────────────────────────────────────────────────

test("selector: Couldn't reach buyer → reengage with cut + sms flag", () => {
  const sel = run([lostRef()], { consumers: [buyer({ 'SMS Opt-In': true })] });
  assert.equal(sel.planned.length, 1);
  const c = sel.planned[0];
  assert.equal(c.action, 'reengage');
  assert.equal(c.cut, 'half');
  assert.equal(c.smsEligible, true);
  assert.equal(c.firstName, 'Amie');
  assert.equal(c.email, 'amie@example.com');
  assert.equal(sel.reasonCounts["Couldn't reach buyer"], 1);
});

// ── selector: supply gate (2026-08-02 flip condition) ───────────────────────

test('supply gate: reengage SKIPPED when buyer state has no operational rancher', () => {
  // TX buyer, coverage only in CO — reengage would invite them back into a
  // state with zero supply. Skip, no Recovery Sent At burn (stays eligible).
  const sel = run([lostRef()], { coveredStates: new Set(['CO']) });
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['reengage-no-supply'], 1);
});

test('supply gate: reengage sent when buyer state IS covered (normalized)', () => {
  // Full state name on the buyer row still matches the normalized set.
  const sel = run([lostRef()], {
    consumers: [buyer({ State: 'Texas' })],
    coveredStates: new Set(['TX', 'CO']),
  });
  assert.equal(sel.planned.length, 1);
  assert.equal(sel.planned[0].action, 'reengage');
});

test('supply gate: fails closed — empty set skips every reengage', () => {
  const sel = run([lostRef()], { coveredStates: new Set() });
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['reengage-no-supply'], 1);
});

test('supply gate: downsell and nurture are NOT gated (shop ships nationwide; nurture is a stamp)', () => {
  const down = run([lostRef({ 'Loss Reason': 'Price too high' })], {
    coveredStates: new Set(), // zero coverage anywhere
  });
  assert.equal(down.planned.length, 1);
  assert.equal(down.planned[0].action, 'downsell');
  const nur = run([lostRef({ 'Loss Reason': 'Timing — buying later' })], {
    consumers: [buyer({ Status: 'Approved' })],
    coveredStates: new Set(),
  });
  assert.equal(nur.planned.length, 1);
  assert.equal(nur.planned[0].action, 'nurture');
});

test('supply gate: omitted coveredStates leaves reengage ungated (back-compat)', () => {
  const sel = run([lostRef()]);
  assert.equal(sel.planned.length, 1);
  assert.equal(sel.planned[0].action, 'reengage');
});

test('selector: Price too high → downsell (never sms)', () => {
  const sel = run([lostRef({ 'Loss Reason': 'Price too high' })], {
    consumers: [buyer({ 'SMS Opt-In': true })],
  });
  assert.equal(sel.planned[0].action, 'downsell');
  assert.equal(sel.planned[0].smsEligible, false);
});

test('selector: Timing → nurture planned ONLY for re-warm-reachable buyers', () => {
  const sel = run([lostRef({ 'Loss Reason': 'Timing — buying later' })], {
    consumers: [buyer({ Status: 'Approved' })],
  });
  assert.equal(sel.planned.length, 1);
  assert.equal(sel.planned[0].action, 'nurture');
});

test('selector: nurture SKIPPED (no touch, no stamp burn) when re-warm would never wake the buyer', () => {
  // Each of these buyers fails a leg of the re-warm-cohort filter — stamping
  // them would silence a never-warmed buyer forever (rancher-launch-warmup
  // Phase 1 filters NOT({Warmup Sent At})). They must be skips, not touches.
  const nonRewarmable = [
    buyer({ Status: 'Approved', 'Warmup Engaged At': daysAgo(10) }),
    buyer(), // not Approved
    buyer({ Status: 'Approved', 'Ready to Buy': true }),
    buyer({ Status: 'Approved', 'Re-Warm Attempts': 2 }),
  ];
  for (const b of nonRewarmable) {
    const sel = run([lostRef({ 'Loss Reason': 'Timing — buying later' })], { consumers: [b] });
    assert.equal(sel.planned.length, 0);
    assert.equal(sel.skips['nurture-not-rewarmable'], 1);
  }
  // The skip is nurture-specific: the same buyers still get reengage/downsell.
  const sel = run([lostRef({ 'Loss Reason': 'Price too high' })], {
    consumers: [buyer({ 'Ready to Buy': true })],
  });
  assert.equal(sel.planned.length, 1);
  assert.equal(sel.planned[0].action, 'downsell');
});

test('selector: terminal reasons counted but never planned', () => {
  for (const reason of ['Bought elsewhere', 'Out of service area', 'Wrong intent (not a buyer)', 'Other']) {
    const sel = run([lostRef({ 'Loss Reason': reason })]);
    assert.equal(sel.planned.length, 0, reason);
    assert.equal(sel.reasonCounts[reason], 1, reason);
    assert.equal(sel.skips['terminal-reason'], 1, reason);
  }
});

test('selector: empty Loss Reason no-ops gracefully (pre-#396 world)', () => {
  const sel = run([lostRef({ 'Loss Reason': '' }), lostRef({ id: 'recREF2', 'Loss Reason': undefined })]);
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['no-loss-reason'], 2);
  assert.deepEqual(sel.reasonCounts, {});
});

// ── selector: hard gates ─────────────────────────────────────────────────────

test('selector: once-only — Recovery Sent At set excludes forever', () => {
  const sel = run([lostRef({ 'Recovery Sent At': daysAgo(1) })]);
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['already-recovered'], 1);
});

test('selector: 14d window — old close out, fresh close in', () => {
  const sel = run([
    lostRef({ id: 'recOLD', 'Closed At': daysAgo(20) }),
    lostRef({ id: 'recFRESH', Buyer: ['recBUYER2'], 'Closed At': daysAgo(2) }),
  ], { consumers: [buyer(), buyer({ id: 'recBUYER2', Email: 'b2@example.com' })] });
  assert.equal(sel.planned.length, 1);
  assert.equal(sel.planned[0].referralId, 'recFRESH');
  assert.equal(sel.skips['outside-window'], 1);
});

test('selector: suppressed buyer excluded', () => {
  const sel = run([lostRef()], { consumers: [buyer({ Unsubscribed: true })] });
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['buyer-suppressed'], 1);
});

test('selector: buyer with another ACTIVE referral excluded; terminal others do not block', () => {
  const activeElsewhere = { id: 'recACT', Status: 'Intro Sent', Buyer: ['recBUYER1'] };
  const sel = run([lostRef()], { activeReferrals: [activeElsewhere] });
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['active-referral-elsewhere'], 1);

  // A second TERMINAL referral for the same buyer does not block recovery.
  const terminalElsewhere = { id: 'recTERM', Status: 'Closed Lost', Buyer: ['recBUYER1'] };
  const sel2 = run([lostRef()], { activeReferrals: [terminalElsewhere] });
  assert.equal(sel2.planned.length, 1);

  // Orphan Pending Approval (no rancher attached) is NOT active — does not block.
  const orphanPending = { id: 'recPEND', Status: 'Pending Approval', Buyer: ['recBUYER1'] };
  const sel3 = run([lostRef()], { activeReferrals: [orphanPending] });
  assert.equal(sel3.planned.length, 1);
});

test('selector: non-Closed-Lost rows and missing buyers are skipped with counts', () => {
  const sel = run([
    lostRef({ id: 'recWON', Status: 'Closed Won' }),
    lostRef({ id: 'recNOBUYER', Buyer: [] }),
    lostRef({ id: 'recGHOST', Buyer: ['recMISSING'] }),
  ]);
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['not-closed-lost'], 1);
  assert.equal(sel.skips['no-buyer-link'], 1);
  assert.equal(sel.skips['buyer-not-found'], 1);
});

test('selector: one touch per buyer per run (duplicate closed-lost rows)', () => {
  const sel = run([lostRef(), lostRef({ id: 'recREF2' })]);
  assert.equal(sel.planned.length, 1);
  assert.equal(sel.skips['duplicate-buyer'], 1);
});

test('selector: cap enforced and overflow counted', () => {
  const consumers = [];
  const refs = [];
  for (let i = 0; i < 25; i++) {
    consumers.push(buyer({ id: `recB${i}`, Email: `b${i}@example.com` }));
    refs.push(lostRef({ id: `recR${i}`, Buyer: [`recB${i}`] }));
  }
  const sel = run(refs, { consumers, cap: 20 });
  assert.equal(sel.planned.length, 20);
  assert.equal(sel.capped, 5);
  assert.equal(DEFAULT_MAX_PER_RUN, 20);
});

// ── renderers ────────────────────────────────────────────────────────────────

test('note line: dated, action-labeled, no buyer name', () => {
  const line = recoveryNoteLine('downsell', 'Price too high', NOW);
  assert.match(line, /^\[loss-recovery 2026-07-15: Price too high → downsell email\]$/);
  assert.match(recoveryNoteLine('nurture', 'Timing — buying later', NOW), /nurture stamp/);
});

test('sms render: carries cut, link and STOP — and never promises a reply-YES flow', () => {
  const body = renderReengageSms({ firstName: 'Amie', cut: 'half', link: 'https://x.co/member' });
  assert.match(body, /your half/);
  assert.match(body, /https:\/\/x\.co\/member/);
  assert.match(body, /reply STOP to opt out/);
  // The Twilio inbound webhook classifies YES as a START (re-subscribe)
  // keyword — nobody sees it, no call gets set up. The link is the only CTA.
  assert.doesNotMatch(body, /reply yes/i);
});
