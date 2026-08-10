// lib/learningReport.test.ts — the gated weekly learning report
// (docs/ADAPTIVE-MARKETING-DESIGN.md §PR 3). The tests pin the HARD gates:
// below the evidence threshold there is NO p-value anywhere in the output,
// the null report renders as a normal result, opens never enter a verdict,
// and no rendered line can carry an email address (public-repo PII rule).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHA,
  MIN_OUTCOME_EVENTS,
  PERCENT_MIN_N,
  BANDIT_SENDS_PER_DAY,
  BANDIT_ELIGIBLE_POOL,
  SEND_HOUR_RECIPIENTS,
  STATE_CUT_MIN_OUTCOMES,
  fisherExactTwoSided,
  wilsonCI,
  requiredNPerArm,
  perTemplateArms,
  compareTemplate,
  countsLabel,
  parseEligiblePool,
  countRecipientsWithLifetimeClicks,
  volumeTriggerLines,
  formatLedgerToken,
  parseLedgerToken,
  replicationVerdict,
  buildLearningReport,
  type TemplateArms,
  type LedgerFinding,
  type VolumeInputs,
} from './learningReport';

// ── Fisher's exact — known answers (hand-computable margins) ────────────────
//
// Table [[a,b],[c,d]] with margins 4/4, 4/4, N=8 (the tea-tasting shape):
// C(8,4)=70; P(a=0)=1/70, P(1)=16/70, P(2)=36/70, P(3)=16/70, P(4)=1/70.

test('fisherExactTwoSided: tea-tasting [[3,1],[1,3]] = 34/70', () => {
  const p = fisherExactTwoSided(3, 1, 1, 3);
  assert.ok(Math.abs(p - 34 / 70) < 1e-9, `got ${p}, want ${34 / 70}`);
});

test('fisherExactTwoSided: extreme [[4,0],[0,4]] = 2/70', () => {
  const p = fisherExactTwoSided(4, 0, 0, 4);
  assert.ok(Math.abs(p - 2 / 70) < 1e-9, `got ${p}, want ${2 / 70}`);
});

test('fisherExactTwoSided: identical arms → p = 1', () => {
  assert.equal(fisherExactTwoSided(2, 8, 2, 8), 1);
});

test('fisherExactTwoSided: zero clicks both arms → p = 1 (no information)', () => {
  assert.equal(fisherExactTwoSided(0, 10, 0, 10), 1);
});

test('fisherExactTwoSided: empty table → p = 1', () => {
  assert.equal(fisherExactTwoSided(0, 0, 0, 0), 1);
});

test('fisherExactTwoSided: symmetric under arm swap', () => {
  const p1 = fisherExactTwoSided(3, 45, 9, 39);
  const p2 = fisherExactTwoSided(9, 39, 3, 45);
  assert.ok(Math.abs(p1 - p2) < 1e-12);
});

test('fisherExactTwoSided: probabilities sum to 1 over all tables (internal consistency)', () => {
  // With logObs = max table, the two-sided sum includes every table.
  // [[2,2],[2,2]] is the modal table for margins 4/4,4/4 → p covers all = 1.
  assert.ok(Math.abs(fisherExactTwoSided(2, 2, 2, 2) - 1) < 1e-9);
});

test('fisherExactTwoSided: rejects negative / non-integer cells', () => {
  assert.throws(() => fisherExactTwoSided(-1, 2, 3, 4));
  assert.throws(() => fisherExactTwoSided(1.5, 2, 3, 4));
});

// ── Wilson CI — hand-computable endpoints ───────────────────────────────────

test('wilsonCI: x=0 n=10 → lo=0, hi = z²/(n+z²) ≈ 0.27753', () => {
  const ci = wilsonCI(0, 10)!;
  assert.equal(ci.lo, 0);
  const z2 = 1.959964 ** 2;
  assert.ok(Math.abs(ci.hi - z2 / (10 + z2)) < 1e-9, `hi=${ci.hi}`);
  assert.ok(Math.abs(ci.hi - 0.27753) < 1e-4);
});

test('wilsonCI: x=10 n=10 → hi=1, lo = n/(n+z²) ≈ 0.72247', () => {
  const ci = wilsonCI(10, 10)!;
  assert.equal(ci.hi, 1);
  assert.ok(Math.abs(ci.lo - 0.72247) < 1e-4);
});

test('wilsonCI: x=5 n=10 is symmetric around 0.5', () => {
  const ci = wilsonCI(5, 10)!;
  assert.ok(Math.abs(ci.lo + ci.hi - 1) < 1e-9);
  assert.ok(ci.lo > 0.2 && ci.hi < 0.8);
});

test('wilsonCI: n=0 → null (an interval over zero trials is not information)', () => {
  assert.equal(wilsonCI(0, 0), null);
});

test('wilsonCI: x outside [0,n] throws', () => {
  assert.throws(() => wilsonCI(11, 10));
  assert.throws(() => wilsonCI(-1, 10));
});

// ── requiredNPerArm — the doc's 8-17k/arm claim, recomputed ─────────────────

test('requiredNPerArm: 5% baseline, +20% relative ≈ 8.1-8.2k/arm (doc lower bound)', () => {
  const n = requiredNPerArm(0.05, 0.2)!;
  assert.ok(n > 8000 && n < 8400, `got ${n}`);
});

test('requiredNPerArm: 2% baseline needs more than 5% baseline (monotone)', () => {
  assert.ok(requiredNPerArm(0.02, 0.2)! > requiredNPerArm(0.05, 0.2)!);
});

test('requiredNPerArm: zero baseline → null (no base rate, no power math)', () => {
  assert.equal(requiredNPerArm(0, 0.2), null);
});

// ── perTemplateArms — the Email Sends join ──────────────────────────────────

function sendRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    'Template Name': 'campaign_autopilot-tx',
    Status: 'sent',
    Variant: 'A',
    'Recipient Email': 'buyer@example.com',
    ...over,
  };
}

test('perTemplateArms: counts sends/delivered/opened/clicked per arm per template', () => {
  const rows = [
    sendRow({ Variant: 'A', 'Delivered At': 'x', 'Opened At': 'x', 'Clicked At': 'x' }),
    sendRow({ Variant: 'A' }),
    sendRow({ Variant: 'B', 'Delivered At': 'x' }),
    sendRow({ Variant: 'B', 'Template Name': 'campaign_requalify-cv', 'Clicked At': 'x', 'Delivered At': 'x' }),
  ];
  const { templates, unattributed } = perTemplateArms(rows);
  assert.equal(unattributed, 0);
  assert.equal(templates.length, 2);
  const tx = templates.find((t) => t.template === 'campaign_autopilot-tx')!;
  assert.deepEqual(tx.A, { sends: 2, delivered: 1, opened: 1, clicked: 1 });
  assert.deepEqual(tx.B, { sends: 1, delivered: 1, opened: 0, clicked: 0 });
  const cv = templates.find((t) => t.template === 'campaign_requalify-cv')!;
  assert.deepEqual(cv.B, { sends: 1, delivered: 1, opened: 0, clicked: 1 });
});

test('perTemplateArms: suppressed/failed rows and non-campaign templates never count', () => {
  const rows = [
    sendRow({ Status: 'suppressed' }),
    sendRow({ Status: 'failed' }),
    sendRow({ 'Template Name': 'nurture_day3' }),
    sendRow({ 'Template Name': 'deposit_link' }),
  ];
  const { templates, unattributed } = perTemplateArms(rows);
  assert.equal(templates.length, 0);
  assert.equal(unattributed, 0);
});

test('perTemplateArms: variant-less campaign sends are counted as unattributed, not silently dropped', () => {
  const rows = [sendRow({ Variant: '' }), sendRow({ Variant: undefined }), sendRow({})];
  const { templates, unattributed } = perTemplateArms(rows.map((r) => ({ ...r, Variant: r.Variant })) );
  assert.equal(unattributed, 2); // '' and undefined; the third row has Variant 'A'
  assert.equal(templates.length, 1);
});

// ── compareTemplate — the evidence gate is HARD ─────────────────────────────

function arms(aClicked: number, aSends: number, bClicked: number, bSends: number): TemplateArms {
  return {
    template: 'campaign_autopilot-tx',
    A: { sends: aSends, delivered: aSends, opened: 0, clicked: aClicked },
    B: { sends: bSends, delivered: bSends, opened: 0, clicked: bClicked },
  };
}

test('compareTemplate: below 10 outcome events → insufficient, and NO p-value exists on that branch', () => {
  const c = compareTemplate(arms(4, 40, 5, 40)); // 9 clicks total
  assert.equal(c.kind, 'insufficient');
  if (c.kind === 'insufficient') {
    assert.equal(c.outcomeEvents, 9);
    assert.equal(c.needed, MIN_OUTCOME_EVENTS);
    assert.ok(!('p' in c), 'insufficient branch must not carry a p-value');
  }
});

test('compareTemplate: exactly 10 outcome events → tested', () => {
  const c = compareTemplate(arms(5, 40, 5, 40));
  assert.equal(c.kind, 'tested');
});

test('compareTemplate: one empty arm → insufficient even with many clicks (no comparison exists)', () => {
  const c = compareTemplate(arms(20, 100, 0, 0));
  assert.equal(c.kind, 'insufficient');
});

test('compareTemplate: clear separation → significant with direction', () => {
  // A 2/100 vs B 20/100 — Fisher two-sided p well under 0.05.
  const c = compareTemplate(arms(2, 100, 20, 100));
  assert.equal(c.kind, 'tested');
  if (c.kind === 'tested') {
    assert.ok(c.p < ALPHA, `p=${c.p}`);
    assert.equal(c.significant, true);
    assert.equal(c.direction, 'B');
  }
});

test('compareTemplate: balanced arms → inconclusive, the expected result', () => {
  const c = compareTemplate(arms(6, 100, 6, 100));
  assert.equal(c.kind, 'tested');
  if (c.kind === 'tested') {
    assert.equal(c.significant, false);
    assert.equal(c.direction, 'tie');
    assert.equal(c.p, 1);
  }
});

test('compareTemplate: opens NEVER change the verdict (click-only decisions)', () => {
  const base = arms(5, 40, 5, 40);
  const withOpens: TemplateArms = {
    ...base,
    A: { ...base.A, opened: 40 },
    B: { ...base.B, opened: 0 },
  };
  const c1 = compareTemplate(base);
  const c2 = compareTemplate(withOpens);
  assert.equal(c1.kind, 'tested');
  assert.equal(c2.kind, 'tested');
  if (c1.kind === 'tested' && c2.kind === 'tested') {
    assert.equal(c1.p, c2.p);
    assert.equal(c1.direction, c2.direction);
  }
});

// ── countsLabel — rule 1 (counts, never bare rates) ─────────────────────────

test('countsLabel: below n=50 shows x/n + CI, NO point percentage', () => {
  const s = countsLabel(3, 49);
  assert.ok(s.startsWith('3/49'), s);
  assert.ok(s.includes('CI '), s);
  assert.ok(!/\d+\.\d+%,/.test(s), `point % must be absent below n=${PERCENT_MIN_N}: ${s}`);
});

test('countsLabel: at n=50 the point percentage appears alongside the CI', () => {
  const s = countsLabel(5, 50);
  assert.ok(s.includes('(10.0%'), s);
  assert.ok(s.includes('CI '), s);
});

test('countsLabel: n=0 renders 0/0 with no rate of any kind', () => {
  assert.equal(countsLabel(0, 0), '0/0');
});

// ── volume triggers ─────────────────────────────────────────────────────────

const lowVolume: VolumeInputs = {
  sendsPerDay7d: 12,
  eligiblePool: 218,
  recipientsWith10PlusClicks: 0,
  maxStateClicks: { state: 'TX', clicks: 3 },
};

test('volumeTriggerLines: below thresholds — every knob reads locked with its distance', () => {
  const lines = volumeTriggerLines(lowVolume);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes('locked') && lines[0].includes('12') && lines[0].includes('1,000'));
  assert.ok(lines[0].includes('218') && lines[0].includes('10,000'));
  assert.ok(lines[1].includes('locked') && lines[1].includes('0 recipients') && lines[1].includes('500'));
  assert.ok(lines[2].includes('locked') && lines[2].includes('TX') && lines[2].includes(String(STATE_CUT_MIN_OUTCOMES)));
  assert.ok(lines[3].includes('NEVER'), 'opens line must say NEVER');
});

test('volumeTriggerLines: unknown eligible pool is stated, not defaulted to a number', () => {
  const lines = volumeTriggerLines({ ...lowVolume, eligiblePool: null });
  assert.ok(lines[0].includes('unknown'));
});

test('volumeTriggerLines: at/above thresholds knobs read UNLOCKED but demand a doc + panel', () => {
  const lines = volumeTriggerLines({
    sendsPerDay7d: BANDIT_SENDS_PER_DAY,
    eligiblePool: BANDIT_ELIGIBLE_POOL,
    recipientsWith10PlusClicks: SEND_HOUR_RECIPIENTS + 1,
    maxStateClicks: { state: 'GA', clicks: STATE_CUT_MIN_OUTCOMES },
  });
  assert.ok(lines[0].includes('UNLOCKED') && lines[0].includes('doc + panel'));
  assert.ok(lines[1].includes('UNLOCKED'));
  assert.ok(lines[2].includes('MET') && lines[2].includes('exploration'));
  assert.ok(lines[3].includes('NEVER'), 'opens stays NEVER at any volume');
});

test('parseEligiblePool: reads the autopilot Cron Runs note token', () => {
  assert.equal(
    parseEligiblePool('ceiling=30(ramp) remaining=30 eligible=218 selected=30 batches=1 · skips: none'),
    218,
  );
  assert.equal(parseEligiblePool("disabled: CAMPAIGN_AUTOPILOT_ENABLED is not 'true'"), null);
  assert.equal(parseEligiblePool(undefined), null);
});

test('countRecipientsWithLifetimeClicks: counts clicked rows per recipient', () => {
  const rows = [
    ...Array.from({ length: 10 }, () => ({ 'Recipient Email': 'A@x.com' })),
    ...Array.from({ length: 9 }, () => ({ 'Recipient Email': 'b@x.com' })),
    { 'Recipient Email': '' },
  ];
  assert.equal(countRecipientsWithLifetimeClicks(rows), 1); // only A reaches 10
});

// ── ledger token + replication ──────────────────────────────────────────────

const finding: LedgerFinding = {
  template: 'campaign_autopilot-tx',
  arm: 'B',
  aClicked: 3,
  aSends: 120,
  bClicked: 14,
  bSends: 118,
  p: 0.0061,
};

test('ledger token: format/parse round-trip', () => {
  const parsed = parseLedgerToken(`weekly report sent · ${formatLedgerToken(finding)}`);
  assert.equal(parsed.kind, 'finding');
  if (parsed.kind === 'finding') assert.deepEqual(parsed.finding, { ...finding, p: 0.0061 });
});

test('ledger token: null finding → ledger[none] → parses as explicit none', () => {
  assert.equal(formatLedgerToken(null), 'ledger[none]');
  assert.deepEqual(parseLedgerToken('notes · ledger[none]'), { kind: 'none' });
});

test('ledger token: absent token parses as absent (first run)', () => {
  assert.deepEqual(parseLedgerToken('some unrelated notes'), { kind: 'absent' });
  assert.deepEqual(parseLedgerToken(undefined), { kind: 'absent' });
});

function cumulative(aClicked: number, aSends: number, bClicked: number, bSends: number): TemplateArms {
  return arms(aClicked, aSends, bClicked, bSends);
}

test('replication: held — new-week delta favors the same arm with enough events', () => {
  // Prior B-finding; new data adds A +2/60, B +9/60 → 11 new events, B leads.
  const v = replicationVerdict(finding, cumulative(5, 180, 23, 178));
  assert.equal(v.verdict, 'held');
  assert.ok(v.line.includes('HELD'));
});

test('replication: reversed — new-week delta favors the OTHER arm', () => {
  // New data: A +9/60, B +2/60 → 11 events, A leads → reversal.
  const v = replicationVerdict(finding, cumulative(12, 180, 16, 178));
  assert.equal(v.verdict, 'reversed');
  assert.ok(v.line.includes('REVERSED'));
});

test('replication: insufficient — under 10 new outcome events, stated with the exact counts', () => {
  const v = replicationVerdict(finding, cumulative(4, 180, 17, 178)); // 4 new events
  assert.equal(v.verdict, 'insufficient');
  assert.ok(v.line.includes('4 of 10'));
});

test('replication: count anomaly (cumulative went down) → insufficient, flagged loudly', () => {
  const v = replicationVerdict(finding, cumulative(2, 100, 20, 100));
  assert.equal(v.verdict, 'insufficient');
  assert.ok(v.line.includes('anomaly'));
});

test('replication: template gone → insufficient, never a crash', () => {
  const v = replicationVerdict(finding, undefined);
  assert.equal(v.verdict, 'insufficient');
});

test('replication: evaluates the DELTA, not the overlapping cumulative data', () => {
  // Cumulative still favors B heavily, but the NEW week adds only A-clicks:
  // A +10/50, B +0/50 → must read reversed, proving the delta is what is graded.
  const v = replicationVerdict(finding, cumulative(13, 170, 14, 168));
  assert.equal(v.verdict, 'reversed');
});

// ── buildLearningReport — null paths are first-class ────────────────────────

const nowMs = Date.UTC(2026, 7, 10, 14, 10, 0); // Mon Aug 10 2026

test('null report: zero templates renders "nothing to test" + null finding + ledger[none]', () => {
  const r = buildLearningReport({
    templates: [],
    unattributed: 0,
    volume: lowVolume,
    prior: { kind: 'absent' },
    nowMs,
  });
  assert.equal(r.topFinding, null);
  assert.ok(r.notes.includes('ledger[none]'));
  const text = r.lines.join('\n');
  assert.ok(text.includes('no variant-stamped campaign sends exist yet'));
  assert.ok(text.includes('none — nothing passed the gate this week'));
  assert.ok(text.includes('first run'));
  assert.ok(text.includes('not computable'), 'required-n must admit there is no base rate');
  assert.ok(text.includes('subject bandit'), 'volume triggers render even in the null report');
});

test('gated report: insufficient templates render "insufficient data: n of 10" and never a p-value', () => {
  const r = buildLearningReport({
    templates: [arms(1, 38, 3, 41)],
    unattributed: 5,
    volume: lowVolume,
    prior: { kind: 'none' },
    nowMs,
  });
  const text = r.lines.join('\n');
  assert.equal(r.topFinding, null);
  assert.ok(text.includes('insufficient data — 4 of 10 outcome events'));
  assert.ok(!text.includes('p='), `no p-value may render below the gate: ${text}`);
  assert.ok(text.includes('5 campaign sends predate variant stamping'));
  assert.ok(text.includes('null report — nothing to replicate'));
});

test('tested-but-inconclusive is NOT a finding (winner\'s curse guard)', () => {
  const r = buildLearningReport({
    templates: [arms(6, 100, 8, 100)], // 14 events, p ~ high
    unattributed: 0,
    volume: lowVolume,
    prior: { kind: 'absent' },
    nowMs,
  });
  assert.equal(r.topFinding, null);
  const text = r.lines.join('\n');
  assert.ok(text.includes('inconclusive'));
  assert.ok(text.includes('none — nothing passed the gate'));
});

test('significant finding: enters findings, becomes the ledger token, states promotion path', () => {
  const r = buildLearningReport({
    templates: [arms(2, 100, 20, 100)],
    unattributed: 0,
    volume: lowVolume,
    prior: { kind: 'absent' },
    nowMs,
  });
  assert.ok(r.topFinding);
  assert.equal(r.topFinding!.arm, 'B');
  assert.ok(r.notes.includes('ledger[template=campaign_autopilot-tx arm=B'));
  const text = r.lines.join('\n');
  assert.ok(text.includes('Ben approves'), 'promotion path must be stated — nothing auto-changes');
});

test('replication line renders when a prior finding exists', () => {
  const r = buildLearningReport({
    templates: [cumulative(5, 180, 23, 178)],
    unattributed: 0,
    volume: lowVolume,
    prior: { kind: 'finding', finding },
    nowMs,
  });
  const text = r.lines.join('\n');
  assert.ok(text.includes('HELD'));
});

test('required-n line: computes from the observed pooled rate and shows the multiplier', () => {
  const r = buildLearningReport({
    templates: [arms(5, 50, 5, 50)], // pooled 10/100 = 10%
    unattributed: 0,
    volume: lowVolume,
    prior: { kind: 'absent' },
    nowMs,
  });
  const text = r.lines.join('\n');
  assert.ok(/~[\d,]+\/arm needed/.test(text), text);
  assert.ok(text.includes('largest arm so far is 50'));
});

test('PII belt: no rendered line ever contains an email address', () => {
  const rows = [
    sendRow({ Variant: 'A', 'Clicked At': 'x', 'Recipient Email': 'real.buyer@gmail.com' }),
    sendRow({ Variant: 'B', 'Recipient Email': 'other.buyer@yahoo.com' }),
  ];
  const { templates, unattributed } = perTemplateArms(rows);
  const r = buildLearningReport({
    templates,
    unattributed,
    volume: lowVolume,
    prior: { kind: 'finding', finding },
    nowMs,
  });
  for (const line of [...r.lines, r.notes]) {
    assert.ok(!/@/.test(line), `email leaked into report line: ${line}`);
  }
});

test('notes: compact, machine-readable, ends with the ledger token', () => {
  const r = buildLearningReport({
    templates: [arms(1, 38, 3, 41)],
    unattributed: 0,
    volume: lowVolume,
    prior: { kind: 'absent' },
    nowMs,
  });
  assert.ok(/templates=1 tested=0 gated=1 findings=0/.test(r.notes), r.notes);
  assert.ok(r.notes.endsWith('ledger[none]'));
  // Round-trip: next Monday's run parses THIS note.
  assert.deepEqual(parseLedgerToken(r.notes), { kind: 'none' });
});
