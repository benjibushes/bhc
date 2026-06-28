import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countRecentDeposits,
  socialProofLine,
  fillSocialProof,
  buildCampaignPlan,
  SOCIAL_PROOF_MIN,
  SOCIAL_PROOF_DAYS,
  isSmsRecoveryEligible,
  renderSmsRecovery,
  renderMessage,
  DEFAULT_SMS_RECOVERY_HOURS,
  FOODSTEAD,
  SILVERLINE,
  DAY_MS,
  type CampaignBuyer,
} from './demandRouter';

const NOW = Date.parse('2026-06-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY_MS).toISOString();
const hoursAgo = (n: number) => new Date(NOW - n * 60 * 60 * 1000).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// UPGRADE B — live social proof
// ═══════════════════════════════════════════════════════════════════════════

test('countRecentDeposits: counts only deposits paid within the window', () => {
  const refs = [
    { 'Deposit Paid At': daysAgo(1) }, // in
    { 'Deposit Paid At': daysAgo(3) }, // in
    { 'Deposit Paid At': daysAgo(6) }, // in (within 7)
    { 'Deposit Paid At': daysAgo(8) }, // out (older than 7)
    { 'Deposit Paid At': '' }, // out (blank)
    {}, // out (no field)
    { 'Deposit Paid At': 'not-a-date' }, // out (garbage)
  ];
  assert.equal(countRecentDeposits(refs, NOW, { days: SOCIAL_PROOF_DAYS }), 3);
});

test('countRecentDeposits: ignores future-dated timestamps (clock skew guard)', () => {
  const refs = [
    { 'Deposit Paid At': daysAgo(1) },
    { 'Deposit Paid At': new Date(NOW + 2 * DAY_MS).toISOString() }, // future → ignored
  ];
  assert.equal(countRecentDeposits(refs, NOW), 1);
});

test('countRecentDeposits: per-rancher scoping via linked Rancher ids', () => {
  const refs = [
    { 'Deposit Paid At': daysAgo(1), Rancher: [FOODSTEAD.id] },
    { 'Deposit Paid At': daysAgo(2), Rancher: [FOODSTEAD.id] },
    { 'Deposit Paid At': daysAgo(2), Rancher: [SILVERLINE.id] },
    { 'Deposit Paid At': daysAgo(2), 'Suggested Rancher': [FOODSTEAD.id] }, // also counts
    { 'Deposit Paid At': daysAgo(2) }, // no rancher → excluded when scoped
  ];
  assert.equal(countRecentDeposits(refs, NOW, { rancherId: FOODSTEAD.id }), 3);
  assert.equal(countRecentDeposits(refs, NOW, { rancherId: SILVERLINE.id }), 1);
  assert.equal(countRecentDeposits(refs, NOW), 5, 'overall counts all five');
});

test('countRecentDeposits: empty/garbage input → 0 (no throw)', () => {
  assert.equal(countRecentDeposits([], NOW), 0);
  assert.equal(countRecentDeposits(undefined as any, NOW), 0);
});

test('socialProofLine: formats at/above the floor, pluralizes', () => {
  assert.equal(socialProofLine(3), '3 families reserved their share this week.');
  assert.equal(socialProofLine(12), '12 families reserved their share this week.');
});

test('socialProofLine: OMIT path — below floor returns empty string (never "0 families")', () => {
  assert.equal(socialProofLine(0), '');
  assert.equal(socialProofLine(1), '');
  assert.equal(socialProofLine(2), '');
  assert.equal(socialProofLine(SOCIAL_PROOF_MIN - 1), '');
});

test('socialProofLine: custom min threshold respected', () => {
  assert.equal(socialProofLine(1, { min: 1 }), '1 family reserved their share this week.');
  assert.equal(socialProofLine(5, { min: 10 }), '');
});

test('socialProofLine: clamps negatives/garbage to 0 → omit', () => {
  assert.equal(socialProofLine(-5), '');
  assert.equal(socialProofLine(NaN as any), '');
});

// ── social proof injected into Msg2/Msg3 copy, omitted cleanly ──────────────

const baseCtx = {
  firstName: 'Sam',
  state: 'CA',
  rancher: { ...FOODSTEAD },
  link: 'https://buyhalfcow.com/r/d/tok',
};

test('Msg2 renders the social-proof line when present', () => {
  const m = renderMessage('Msg2', { ...baseCtx, socialProof: '7 families reserved their share this week.' });
  assert.match(m.text, /7 families reserved their share this week\./);
  assert.match(m.html, /7 families reserved their share this week\./);
});

test('Msg2 OMITS the line cleanly when socialProof is empty (no blank gap, no token)', () => {
  const m = renderMessage('Msg2', { ...baseCtx, socialProof: '' });
  assert.doesNotMatch(m.text, /\{socialProof\}/, 'token fully removed');
  assert.doesNotMatch(m.text, /families reserved/);
  // No triple-newline gap left behind where the line + its blank line were.
  assert.doesNotMatch(m.text, /\n\n\n/, 'no empty paragraph left by the omit');
});

test('Msg2 OMIT path when socialProof undefined (defensive)', () => {
  const m = renderMessage('Msg2', baseCtx);
  assert.doesNotMatch(m.text, /\{socialProof\}/);
  assert.doesNotMatch(m.text, /\n\n\n/);
});

test('Msg3 renders / omits the social-proof line the same way', () => {
  const shown = renderMessage('Msg3', { ...baseCtx, socialProof: '4 families reserved their share this week.' });
  assert.match(shown.text, /4 families reserved their share this week\./);
  const omitted = renderMessage('Msg3', { ...baseCtx, socialProof: '' });
  assert.doesNotMatch(omitted.text, /\{socialProof\}/);
  assert.doesNotMatch(omitted.text, /\n\n\n/);
});

test('Msg1 NEVER carries social proof (cold intro stays clean)', () => {
  const m = renderMessage('Msg1', { ...baseCtx, socialProof: '9 families reserved their share this week.' });
  assert.doesNotMatch(m.text, /families reserved/, 'Msg1 has no {socialProof} token');
});

// ═══════════════════════════════════════════════════════════════════════════
// UPGRADE C — SMS recovery (backfill arc): selection
// ═══════════════════════════════════════════════════════════════════════════

const optedInArc = (over: Record<string, unknown> = {}) => ({
  'SMS Opt-In': true,
  Phone: '5551234567',
  'Campaign Stage': 'Msg1 Sent',
  'Campaign Last Sent At': hoursAgo(DEFAULT_SMS_RECOVERY_HOURS + 1),
  ...over,
});

test('SMS recovery eligible: opted-in, emailed ≥8h ago, in-arc, unconverted, not yet recovered', () => {
  assert.equal(isSmsRecoveryEligible(optedInArc(), NOW), true);
});

test('SMS recovery NOT eligible: not opted in (TCPA)', () => {
  assert.equal(isSmsRecoveryEligible(optedInArc({ 'SMS Opt-In': false }), NOW), false);
});

test('SMS recovery NOT eligible: no phone on record', () => {
  assert.equal(isSmsRecoveryEligible(optedInArc({ Phone: '' }), NOW), false);
});

test('SMS recovery NOT eligible: email too recent (< 8h ago)', () => {
  assert.equal(
    isSmsRecoveryEligible(optedInArc({ 'Campaign Last Sent At': hoursAgo(2) }), NOW),
    false,
  );
});

test('SMS recovery NOT eligible: never emailed by the campaign (no arc stage)', () => {
  assert.equal(isSmsRecoveryEligible(optedInArc({ 'Campaign Stage': '' }), NOW), false);
  assert.equal(isSmsRecoveryEligible(optedInArc({ 'Campaign Stage': 'Sunset' }), NOW), false);
});

test('SMS recovery NOT eligible: already SMS-recovered (idempotent)', () => {
  assert.equal(
    isSmsRecoveryEligible(optedInArc({ 'Campaign SMS Recovery Sent At': hoursAgo(1) }), NOW),
    false,
  );
});

test('SMS recovery NOT eligible: sunset', () => {
  assert.equal(
    isSmsRecoveryEligible(optedInArc({ 'Campaign Sunset At': hoursAgo(1) }), NOW),
    false,
  );
});

test('SMS recovery NOT eligible: buyer converted / engaged since the email', () => {
  assert.equal(isSmsRecoveryEligible(optedInArc({ 'Ready to Buy': true }), NOW), false);
  assert.equal(isSmsRecoveryEligible(optedInArc({ 'Referral Status': 'Slot Locked' }), NOW), false);
  assert.equal(isSmsRecoveryEligible(optedInArc({ 'Email Clicks': 2 }), NOW), false);
  assert.equal(isSmsRecoveryEligible(optedInArc({ 'Last Email Clicked At': hoursAgo(3) }), NOW), false);
});

test('SMS recovery honors a custom smsRecoveryHours window', () => {
  // Emailed 5h ago: not eligible at default (8h) but eligible at a 4h override.
  const b = optedInArc({ 'Campaign Last Sent At': hoursAgo(5) });
  assert.equal(isSmsRecoveryEligible(b, NOW), false);
  assert.equal(isSmsRecoveryEligible(b, NOW, { smsRecoveryHours: 4 }), true);
});

test('SMS recovery works at every arc stage (Msg1/2/3 Sent)', () => {
  for (const stage of ['Msg1 Sent', 'Msg2 Sent', 'Msg3 Sent']) {
    assert.equal(isSmsRecoveryEligible(optedInArc({ 'Campaign Stage': stage }), NOW), true, stage);
  }
});

// ── SMS recovery copy: distinct angle + STOP ────────────────────────────────

test('renderSmsRecovery: distinct angle (going fast), carries STOP, fills tokens', () => {
  const sms = renderSmsRecovery({ ...baseCtx });
  assert.match(sms, /going fast/, 'different angle than the email arc');
  assert.match(sms, /reply STOP to opt out/, 'TCPA STOP present');
  assert.match(sms, /Foodstead/);
  assert.match(sms, /shipped to CA/);
  assert.match(sms, /buyhalfcow\.com\/r\/d\/tok/);
});

test('renderSmsRecovery angle differs from the Msg2 email body it follows', () => {
  const sms = renderSmsRecovery({ ...baseCtx });
  const email = renderMessage('Msg2', { ...baseCtx, socialProof: '' }).text;
  // The SMS must not be a verbatim slice of the email (research: ADD new info).
  assert.notEqual(sms.trim(), email.trim());
  assert.doesNotMatch(sms, /quick one/, 'not the Msg2 opener');
});

// ═══════════════════════════════════════════════════════════════════════════
// A2 — social-proof must NOT glue to the next sentence (customer-visible copy)
// ═══════════════════════════════════════════════════════════════════════════

test('A2 fillSocialProof: present → own paragraph, no glue; absent → clean collapse', () => {
  const tmpl = 'line one.\n\n{socialProof}\n\nline three.';
  const present = fillSocialProof(tmpl, '5 families reserved their share this week.');
  assert.equal(present, 'line one.\n\n5 families reserved their share this week.\n\nline three.');
  const absent = fillSocialProof(tmpl, '');
  assert.equal(absent, 'line one.\n\nline three.', 'token + its blank line collapse, single break remains');
});

test('A2 fillSocialProof: never leaves a glued token or an empty paragraph', () => {
  for (const proof of ['', '   ', '9 families reserved their share this week.']) {
    const out = fillSocialProof('a.\n\n{socialProof}\n\nb.', proof);
    assert.doesNotMatch(out, /\{socialProof\}/, 'token always removed');
    assert.doesNotMatch(out, /\n{3,}/, 'no empty paragraph');
    assert.doesNotMatch(out, /\.\S/, 'no sentence glued directly after a period');
  }
});

test('A2 Msg2 with proof: the proof sentence ends with a break before "if you want one"', () => {
  const m = renderMessage('Msg2', { ...baseCtx, socialProof: '7 families reserved their share this week.' });
  // The exact glue regression: "...this week.if you want one:" must NOT appear.
  assert.doesNotMatch(m.text, /this week\.if you want one/);
  assert.match(m.text, /this week\.\n\nif you want one/);
});

test('A2 Msg3 with proof: no glue into the "until your local rancher" sentence', () => {
  const m = renderMessage('Msg3', { ...baseCtx, socialProof: '4 families reserved their share this week.' });
  assert.doesNotMatch(m.text, /this week\.until your local rancher/);
  assert.match(m.text, /this week\.\n\nuntil your local rancher/);
});

// ═══════════════════════════════════════════════════════════════════════════
// A4 — buyers owned by reserve-recovery are excluded from the wave arc
// ═══════════════════════════════════════════════════════════════════════════

const daysAgoCreated = (n: number) => new Date(NOW - n * DAY_MS).toISOString();

test('A4 excludeBuyerIds: an excluded buyer is skipped + tallied under in-reserve-recovery', () => {
  const buyers: CampaignBuyer[] = [
    { id: 'recKeep', fields: { Email: 'k@x.com', State: 'CA', 'Ready to Buy': true, Created: daysAgoCreated(20) } },
    { id: 'recReserve', fields: { Email: 'r@x.com', State: 'CA', 'Ready to Buy': true, Created: daysAgoCreated(20) } },
  ];
  const plan = buildCampaignPlan(buyers, {
    now: NOW,
    capacity: { west: 50, eastCentral: 0 },
    excludeBuyerIds: new Set(['recReserve']),
  });
  assert.deepEqual(plan.sends.map((s) => s.buyerId), ['recKeep'], 'reserve buyer not in the wave arc');
  assert.equal(plan.suppressed['in-reserve-recovery'], 1);
  assert.ok(plan.sends.every((s) => s.buyerId !== 'recReserve'), 'no double-touch');
});

test('A4 exclusion takes precedence over every wave/tier (even a continuation)', () => {
  // A buyer mid-arc (due for Msg2) who is ALSO an open reserve → excluded, no Msg2.
  const buyers: CampaignBuyer[] = [
    {
      id: 'recDue',
      fields: {
        Email: 'd@x.com', State: 'CA', 'Ready to Buy': true,
        'Campaign Stage': 'Msg1 Sent', 'Campaign Last Sent At': daysAgoCreated(4), Created: daysAgoCreated(20),
      },
    },
  ];
  const without = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 50, eastCentral: 0 } });
  assert.equal(without.byWave.Msg2, 1, 'normally this buyer gets Msg2');
  const withExclude = buildCampaignPlan(buyers, {
    now: NOW, capacity: { west: 50, eastCentral: 0 }, excludeBuyerIds: new Set(['recDue']),
  });
  assert.equal(withExclude.sends.length, 0, 'excluded even mid-arc');
  assert.equal(withExclude.suppressed['in-reserve-recovery'], 1);
});

test('A4 empty exclude set → no behavior change (default)', () => {
  const buyers: CampaignBuyer[] = [
    { id: 'recA', fields: { Email: 'a@x.com', State: 'CA', 'Ready to Buy': true, Created: daysAgoCreated(20) } },
  ];
  const a = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 50, eastCentral: 0 } });
  const b = buildCampaignPlan(buyers, { now: NOW, capacity: { west: 50, eastCentral: 0 }, excludeBuyerIds: new Set() });
  assert.deepEqual(a.sends.map((s) => s.buyerId), b.sends.map((s) => s.buyerId));
  assert.equal(b.suppressed['in-reserve-recovery'], 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// A6 — SMS-recovery opt-in must be STRICT === true (match the sender)
// ═══════════════════════════════════════════════════════════════════════════

test('A6 isSmsRecoveryEligible: loose-truthy opt-in is NOT eligible (sender requires === true)', () => {
  const base = {
    Phone: '5551234567',
    'Campaign Stage': 'Msg1 Sent',
    'Campaign Last Sent At': new Date(NOW - (DEFAULT_SMS_RECOVERY_HOURS + 1) * 60 * 60 * 1000).toISOString(),
  };
  // The exact values that would pass a loose asBool() but FAIL the sender's === true.
  assert.equal(isSmsRecoveryEligible({ ...base, 'SMS Opt-In': 'true' }, NOW), false, 'string "true"');
  assert.equal(isSmsRecoveryEligible({ ...base, 'SMS Opt-In': 1 }, NOW), false, 'number 1');
  assert.equal(isSmsRecoveryEligible({ ...base, 'SMS Opt-In': 'yes' }, NOW), false, 'string "yes"');
  // Only a real boolean true passes (matches sendSMSToConsumer).
  assert.equal(isSmsRecoveryEligible({ ...base, 'SMS Opt-In': true }, NOW), true, 'boolean true');
});
