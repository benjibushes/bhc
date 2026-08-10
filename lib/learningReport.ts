// lib/learningReport.ts
//
// PURE computation for the GATED WEEKLY LEARNING REPORT
// (docs/ADAPTIVE-MARKETING-DESIGN.md §PR 3 — the founder-protection layer).
// The cron (app/api/cron/learning-report) injects Email Sends rows + cron-run
// telemetry; everything here is deterministic and side-effect free.
//
// NULL-CAPABLE BY DESIGN. At current volume the honest output of almost every
// section is "not enough data" — and that ships as-is. The content rules from
// the design doc are HARD GATES here, not style notes:
//
//   1. Counts, never bare rates: every finding is raw x/n with a Wilson 95%
//      CI; a bare point-percentage is FORBIDDEN below n=50 (PERCENT_MIN_N).
//   2. Evidence gate: no comparison enters the findings list under 10 outcome
//      events (MIN_OUTCOME_EVENTS). Below the gate the output is explicitly
//      "insufficient data: n=X of Y needed" and NO p-value is computed —
//      a p-value on 4 clicks dressed as a conclusion is the failure mode
//      this file exists to prevent.
//   3. A null report is a normal report. "Nothing passed the gate this week"
//      renders as a first-class result, never as an error.
//   4. Replication ledger: last week's top finding gets a mandatory follow-up
//      verdict (held / reversed / insufficient) computed on the NEW week's
//      data only (current cumulative minus the counts frozen in last week's
//      ledger token — overlapping data cannot "replicate" itself).
//   5. Every challenger states the n/arm required to judge it at the
//      prespecified +20% relative lift. At current volume that line reads
//      "~Nx more data needed" — that IS the decision information.
//
// CLICK-ONLY DECISIONS (design doc §1, permanent): Apple MPP prefetch fires
// minutes-to-hours after delivery, so opens are structurally untrustworthy.
// Opens are REPORTED for context, always labeled unreliable, and never enter
// a test, a gate, or a verdict.
//
// The prespecified test (deferred from PR 2's record to this PR): ONE
// two-sided Fisher's exact test per campaign template, α = 0.05, over
// clicked/sent per variant arm. The Variant stamp is deterministic per
// (consumerId, templateName) — lib/campaignVariants — so each template's
// wave is its own randomized experiment.
//
// PUBLIC-REPO / PII RULE: nothing in this module ever emits an email address
// or a buyer name. Inputs carry template names, variant letters, state codes,
// and counts; renderLearningReport output is counts only.

// ── Gates & prespecified constants (design doc §PR 3 + §1) ──────────────────

/** Evidence gate: a comparison needs at least this many outcome events
 * (clicks, both arms combined) before ANY test statistic is computed. */
export const MIN_OUTCOME_EVENTS = 10;
/** Bare point-percentages are forbidden below this n (counts + CI only). */
export const PERCENT_MIN_N = 50;
/** Prespecified significance level for the per-template Fisher's exact test. */
export const ALPHA = 0.05;
/** Prespecified minimum detectable effect: +20% relative lift on clicks. */
export const PRESPECIFIED_RELATIVE_LIFT = 0.2;
/** Power used for the required-n line (standard 0.8). */
export const REQUIRED_N_POWER = 0.8;

// Volume triggers for the KILLED knobs (design doc §1 — restated in every
// report so Ben sees exactly which learning mechanisms are still locked and
// how far away each unlock is).
export const BANDIT_SENDS_PER_DAY = 1000;
export const BANDIT_ELIGIBLE_POOL = 10_000;
export const SEND_HOUR_RECIPIENTS = 500;
export const SEND_HOUR_MIN_LIFETIME_CLICKS = 10;
export const STATE_CUT_MIN_OUTCOMES = 25;

// ── Statistics primitives ───────────────────────────────────────────────────

const _logFactCache: number[] = [0, 0];

/** ln(n!) — exact accumulation, cached. Safe for the table sizes a 120/day
 * send ceiling can ever produce. */
export function logFactorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`logFactorial: bad n=${n}`);
  for (let i = _logFactCache.length; i <= n; i++) {
    _logFactCache[i] = _logFactCache[i - 1] + Math.log(i);
  }
  return _logFactCache[n];
}

/** Hypergeometric point probability of the 2×2 table [[a,b],[c,d]]. */
function logHypergeom(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  return (
    logFactorial(a + b) +
    logFactorial(c + d) +
    logFactorial(a + c) +
    logFactorial(b + d) -
    logFactorial(n) -
    logFactorial(a) -
    logFactorial(b) -
    logFactorial(c) -
    logFactorial(d)
  );
}

/**
 * Two-sided Fisher's exact test on the 2×2 table [[a,b],[c,d]] — the sum of
 * probabilities of all tables (same margins) no more likely than the observed
 * one (the standard "sum of small p" definition, with a 1e-7 relative
 * tolerance against float noise, matching R/scipy behavior). Returns p in
 * (0, 1].
 *
 * For the learning report: a = arm-A clicks, b = arm-A non-clicks,
 * c = arm-B clicks, d = arm-B non-clicks.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  for (const v of [a, b, c, d]) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`fisherExactTwoSided: bad cell ${v}`);
  }
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  if (n === 0) return 1;
  const logObs = logHypergeom(a, b, c, d);
  const kMin = Math.max(0, col1 - (n - row1));
  const kMax = Math.min(row1, col1);
  let p = 0;
  for (let k = kMin; k <= kMax; k++) {
    const logP = logHypergeom(k, row1 - k, col1 - k, n - row1 - (col1 - k));
    if (logP <= logObs + 1e-7) p += Math.exp(logP);
  }
  // When every table is included the true sum is EXACTLY 1 — clear the float
  // residue instead of reporting p=0.9999999999999994.
  return p >= 1 - 1e-9 ? 1 : p;
}

export interface WilsonInterval {
  lo: number;
  hi: number;
}

/** Wilson score 95% interval for x successes in n trials. Null when n=0 —
 * an interval over zero trials is not information. */
export function wilsonCI(x: number, n: number, z = 1.959964): WilsonInterval | null {
  if (n <= 0) return null;
  if (x < 0 || x > n) throw new Error(`wilsonCI: x=${x} outside [0, ${n}]`);
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // At the boundaries the Wilson endpoints are EXACTLY 0 / 1 (the algebra
  // cancels); pin them so float residue can't render "CI …–100.0%" as 99.99.
  return {
    lo: x === 0 ? 0 : Math.max(0, center - half),
    hi: x === n ? 1 : Math.min(1, center + half),
  };
}

/**
 * Required n per arm for a two-proportion test (normal approximation) at
 * `alpha` two-sided and `power`, to detect a relative lift over `baseline`.
 * Null when the baseline is 0 (no observed rate → no power math; the report
 * says so in words instead of inventing a number).
 */
export function requiredNPerArm(
  baseline: number,
  relativeLift: number = PRESPECIFIED_RELATIVE_LIFT,
  zAlpha = 1.959964, // α=0.05 two-sided
  zBeta = 0.841621, // power 0.8
): number | null {
  if (!(baseline > 0) || !(relativeLift > 0)) return null;
  const p1 = baseline;
  const p2 = Math.min(1, baseline * (1 + relativeLift));
  const diff = p2 - p1;
  if (diff <= 0) return null;
  const pBar = (p1 + p2) / 2;
  const n =
    Math.pow(
      zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
      2,
    ) / (diff * diff);
  return Math.ceil(n);
}

// ── Email Sends → per-arm counts (the PR 1 join) ────────────────────────────

export interface ArmCounts {
  sends: number;
  delivered: number;
  /** Reported for context only — MPP-inflated, never a decision input. */
  opened: number;
  clicked: number;
}

export interface TemplateArms {
  template: string;
  A: ArmCounts;
  B: ArmCounts;
}

const emptyArm = (): ArmCounts => ({ sends: 0, delivered: 0, opened: 0, clicked: 0 });

export const CAMPAIGN_TEMPLATE_PREFIX = 'campaign_';

/**
 * Join raw Email Sends rows into per-template, per-arm counts. Only rows that
 * are part of the experiment count: Template Name starts with `campaign_`,
 * Status = 'sent', Variant ∈ {A, B}. Rows without a Variant stamp (pre-PR 1
 * sends) are returned as `unattributed` — visible, never silently dropped.
 */
export function perTemplateArms(rows: Array<Record<string, unknown>>): {
  templates: TemplateArms[];
  unattributed: number;
} {
  const byTemplate = new Map<string, TemplateArms>();
  let unattributed = 0;
  for (const r of rows) {
    const template = String(r['Template Name'] || '');
    if (!template.startsWith(CAMPAIGN_TEMPLATE_PREFIX)) continue;
    if (String(r['Status'] || '') !== 'sent') continue;
    const variant = String(r['Variant'] || '');
    if (variant !== 'A' && variant !== 'B') {
      unattributed += 1;
      continue;
    }
    let t = byTemplate.get(template);
    if (!t) {
      t = { template, A: emptyArm(), B: emptyArm() };
      byTemplate.set(template, t);
    }
    const arm = variant === 'A' ? t.A : t.B;
    arm.sends += 1;
    if (String(r['Delivered At'] || '')) arm.delivered += 1;
    if (String(r['Opened At'] || '')) arm.opened += 1;
    if (String(r['Clicked At'] || '')) arm.clicked += 1;
  }
  return {
    templates: [...byTemplate.values()].sort((a, b) => a.template.localeCompare(b.template)),
    unattributed,
  };
}

// ── The prespecified per-template comparison ────────────────────────────────

export type Comparison =
  | {
      kind: 'insufficient';
      template: string;
      outcomeEvents: number;
      needed: number;
      A: ArmCounts;
      B: ArmCounts;
    }
  | {
      kind: 'tested';
      template: string;
      p: number;
      /** p < ALPHA — even then the CIs are the finding, not the star. */
      significant: boolean;
      direction: 'A' | 'B' | 'tie';
      A: ArmCounts;
      B: ArmCounts;
    };

/**
 * The prespecified test for one template, HARD-GATED: below
 * MIN_OUTCOME_EVENTS total clicks the result is explicitly insufficient and
 * carries NO p-value (there is deliberately no field for one on that branch —
 * the type makes "a p-value dressed as a conclusion" unrepresentable).
 * Clicks only; opens never enter.
 */
export function compareTemplate(t: TemplateArms): Comparison {
  const outcomeEvents = t.A.clicked + t.B.clicked;
  if (outcomeEvents < MIN_OUTCOME_EVENTS || t.A.sends === 0 || t.B.sends === 0) {
    return {
      kind: 'insufficient',
      template: t.template,
      outcomeEvents,
      needed: MIN_OUTCOME_EVENTS,
      A: t.A,
      B: t.B,
    };
  }
  const p = fisherExactTwoSided(
    t.A.clicked,
    t.A.sends - t.A.clicked,
    t.B.clicked,
    t.B.sends - t.B.clicked,
  );
  const rateA = t.A.clicked / t.A.sends;
  const rateB = t.B.clicked / t.B.sends;
  return {
    kind: 'tested',
    template: t.template,
    p,
    significant: p < ALPHA,
    direction: rateA === rateB ? 'tie' : rateA > rateB ? 'A' : 'B',
    A: t.A,
    B: t.B,
  };
}

// ── Count formatting (rule 1: counts, never bare rates) ─────────────────────

/**
 * "x/n" always; the point-percentage is appended ONLY at n ≥ PERCENT_MIN_N.
 * The Wilson CI is appended whenever n > 0 (the CI carries the uncertainty —
 * that is the whole point of rule 1).
 */
export function countsLabel(x: number, n: number): string {
  if (n === 0) return '0/0';
  const ci = wilsonCI(x, n)!;
  const ciStr = `CI ${(ci.lo * 100).toFixed(1)}–${(ci.hi * 100).toFixed(1)}%`;
  if (n >= PERCENT_MIN_N) {
    return `${x}/${n} (${((x / n) * 100).toFixed(1)}%, ${ciStr})`;
  }
  return `${x}/${n} (${ciStr})`;
}

// ── Volume-trigger gating (the killed knobs, §1) ────────────────────────────

export interface VolumeInputs {
  /** Trailing-7d average of campaign_* sends per day. */
  sendsPerDay7d: number;
  /** Latest autopilot-eligible pool size (parsed from its Cron Runs note);
   * null when the autopilot has not logged one (e.g. still dark). */
  eligiblePool: number | null;
  /** Recipients with ≥ SEND_HOUR_MIN_LIFETIME_CLICKS lifetime clicked sends. */
  recipientsWith10PlusClicks: number;
  /** The state with the most campaign clicks, from the Consumers join. */
  maxStateClicks: { state: string; clicks: number } | null;
}

/** Parse `eligible=N` out of a campaign-autopilot Cron Runs note. */
export function parseEligiblePool(notes: unknown): number | null {
  const m = String(notes ?? '').match(/eligible=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Count recipients with ≥ minClicks clicked send-rows. Keyed on lowercased
 * recipient email INTERNALLY only — the returned value is a count. */
export function countRecipientsWithLifetimeClicks(
  clickedRows: Array<Record<string, unknown>>,
  minClicks = SEND_HOUR_MIN_LIFETIME_CLICKS,
): number {
  const per = new Map<string, number>();
  for (const r of clickedRows) {
    const email = String(r['Recipient Email'] || '').trim().toLowerCase();
    if (!email) continue;
    per.set(email, (per.get(email) || 0) + 1);
  }
  let count = 0;
  for (const n of per.values()) if (n >= minClicks) count += 1;
  return count;
}

/**
 * One line per killed knob: locked/unlocked status + the exact distance to
 * its recorded volume trigger. Restated in EVERY report (design doc §PR 3
 * scope: the gate is on conclusions, and Ben must see which mechanisms are
 * still below unlock volume and how far away they are).
 */
export function volumeTriggerLines(v: VolumeInputs): string[] {
  const lines: string[] = [];

  const sends = Math.round(v.sendsPerDay7d * 10) / 10;
  const banditUnlocked =
    v.sendsPerDay7d >= BANDIT_SENDS_PER_DAY ||
    (v.eligiblePool !== null && v.eligiblePool >= BANDIT_ELIGIBLE_POOL);
  const poolStr =
    v.eligiblePool === null
      ? 'eligible pool unknown (autopilot has not logged a plan)'
      : `eligible pool ${v.eligiblePool.toLocaleString('en-US')} of ≥${BANDIT_ELIGIBLE_POOL.toLocaleString('en-US')}`;
  lines.push(
    ` · subject bandit: ${banditUnlocked ? 'UNLOCKED — needs its own doc + panel before build (L3)' : 'locked'} — ` +
      `${sends} sends/day (7d avg) of ≥${BANDIT_SENDS_PER_DAY.toLocaleString('en-US')} · ${poolStr}`,
  );

  const shUnlocked = v.recipientsWith10PlusClicks > SEND_HOUR_RECIPIENTS;
  lines.push(
    ` · per-recipient send hour: ${shUnlocked ? 'UNLOCKED — needs its own doc + panel before build (L3)' : 'locked'} — ` +
      `${v.recipientsWith10PlusClicks} recipients with ≥${SEND_HOUR_MIN_LIFETIME_CLICKS} lifetime clicks of >${SEND_HOUR_RECIPIENTS} needed`,
  );

  const stateStr = v.maxStateClicks
    ? `top state ${v.maxStateClicks.state}: ${v.maxStateClicks.clicks} clicks`
    : 'no state has any campaign clicks yet';
  const stateUnlocked = (v.maxStateClicks?.clicks ?? 0) >= STATE_CUT_MIN_OUTCOMES;
  lines.push(
    ` · state-level cut preselect: ${
      stateUnlocked
        ? 'volume trigger MET — still requires the 10% random-exploration share (not built) before any preselect'
        : 'locked'
    } — ${stateStr} of ≥${STATE_CUT_MIN_OUTCOMES} needed per state, PLUS a 10% exploration share. Until then: NATIONAL default cut only`,
  );

  lines.push(
    ' · opens as a learning signal: NEVER unlocks — MPP prefetch fires minutes-to-hours after delivery; ' +
      'open counts above are context only and untrustworthy',
  );

  return lines;
}

// ── Replication ledger (rule 4 — the report grades its own homework) ────────

export interface LedgerFinding {
  template: string;
  /** The arm the finding favored. */
  arm: 'A' | 'B';
  aClicked: number;
  aSends: number;
  bClicked: number;
  bSends: number;
  /** The p-value AT the time of the finding (already gate-passed). */
  p: number;
}

export type LedgerParse =
  | { kind: 'finding'; finding: LedgerFinding }
  | { kind: 'none' } // last week explicitly recorded a null report
  | { kind: 'absent' }; // no prior token at all (first run / notes lost)

/** Machine-readable token for the Cron Runs note. Counts only — template
 * names are repo strings, never PII. */
export function formatLedgerToken(f: LedgerFinding | null): string {
  if (!f) return 'ledger[none]';
  return (
    `ledger[template=${f.template} arm=${f.arm} ` +
    `a=${f.aClicked}/${f.aSends} b=${f.bClicked}/${f.bSends} p=${f.p.toFixed(4)}]`
  );
}

const LEDGER_RE =
  /ledger\[template=(\S+) arm=([AB]) a=(\d+)\/(\d+) b=(\d+)\/(\d+) p=([\d.]+)\]/;

export function parseLedgerToken(notes: unknown): LedgerParse {
  const s = String(notes ?? '');
  if (/ledger\[none\]/.test(s)) return { kind: 'none' };
  const m = s.match(LEDGER_RE);
  if (!m) return { kind: 'absent' };
  return {
    kind: 'finding',
    finding: {
      template: m[1],
      arm: m[2] as 'A' | 'B',
      aClicked: Number(m[3]),
      aSends: Number(m[4]),
      bClicked: Number(m[5]),
      bSends: Number(m[6]),
      p: Number(m[7]),
    },
  };
}

export interface ReplicationVerdict {
  verdict: 'held' | 'reversed' | 'insufficient';
  line: string;
}

/**
 * Grade last week's top finding against THIS week's new data only: the delta
 * between current cumulative counts and the counts frozen in the ledger
 * token. Overlapping data cannot replicate itself. Verdicts:
 *   held        — delta has ≥ MIN_OUTCOME_EVENTS clicks and favors the same arm
 *   reversed    — delta has ≥ MIN_OUTCOME_EVENTS clicks and favors the other arm
 *   insufficient — everything else (too little new data, no separation, or a
 *                  count anomaly), stated plainly.
 * The reversal rate over time is the report's own honesty meter.
 */
export function replicationVerdict(
  prior: LedgerFinding,
  current: TemplateArms | undefined,
): ReplicationVerdict {
  const name = prior.template;
  if (!current) {
    return {
      verdict: 'insufficient',
      line: ` · replication of last week's ${name} (${prior.arm}): insufficient — template has no current rows (retired?)`,
    };
  }
  const dA = { clicked: current.A.clicked - prior.aClicked, sends: current.A.sends - prior.aSends };
  const dB = { clicked: current.B.clicked - prior.bClicked, sends: current.B.sends - prior.bSends };
  if (dA.clicked < 0 || dB.clicked < 0 || dA.sends < 0 || dB.sends < 0) {
    return {
      verdict: 'insufficient',
      line: ` · replication of last week's ${name} (${prior.arm}): insufficient — count anomaly (cumulative counts went DOWN; investigate before trusting either week)`,
    };
  }
  const newEvents = dA.clicked + dB.clicked;
  if (newEvents < MIN_OUTCOME_EVENTS || dA.sends === 0 || dB.sends === 0) {
    return {
      verdict: 'insufficient',
      line:
        ` · replication of last week's ${name} (${prior.arm}): insufficient — ` +
        `${newEvents} of ${MIN_OUTCOME_EVENTS} new outcome events needed (new data: A ${dA.clicked}/${dA.sends}, B ${dB.clicked}/${dB.sends})`,
    };
  }
  const rateA = dA.clicked / dA.sends;
  const rateB = dB.clicked / dB.sends;
  const newDirection = rateA === rateB ? 'tie' : rateA > rateB ? 'A' : 'B';
  if (newDirection === 'tie') {
    return {
      verdict: 'insufficient',
      line: ` · replication of last week's ${name} (${prior.arm}): insufficient — new data shows no separation (A ${dA.clicked}/${dA.sends}, B ${dB.clicked}/${dB.sends})`,
    };
  }
  if (newDirection === prior.arm) {
    return {
      verdict: 'held',
      line: ` · replication of last week's ${name} (${prior.arm}): HELD on new data — A ${countsLabel(dA.clicked, dA.sends)}, B ${countsLabel(dB.clicked, dB.sends)}`,
    };
  }
  return {
    verdict: 'reversed',
    line:
      ` · replication of last week's ${name} (${prior.arm}): REVERSED on new data — A ${countsLabel(dA.clicked, dA.sends)}, B ${countsLabel(dB.clicked, dB.sends)}. ` +
      'A reversal is the gate working, not a bug — count it against the report, not the data',
  };
}

// ── Report assembly ─────────────────────────────────────────────────────────

export interface LearningReportInput {
  templates: TemplateArms[];
  /** campaign_* sent rows with no Variant stamp (pre-PR 1) — shown, never dropped. */
  unattributed: number;
  volume: VolumeInputs;
  prior: LedgerParse;
  nowMs: number;
}

export interface LearningReport {
  /** Telegram-HTML lines. Counts only — no emails, no buyer names. */
  lines: string[];
  /** Compact Cron Runs note (ends with the machine-readable ledger token). */
  notes: string;
  /** This week's top finding (null = null report — a normal result). */
  topFinding: LedgerFinding | null;
}

function comparisonLine(c: Comparison): string {
  const opens = `opens A ${c.A.opened} · B ${c.B.opened} (MPP-inflated, not a signal)`;
  if (c.kind === 'insufficient') {
    return (
      ` · ${c.template}: insufficient data — ${c.outcomeEvents} of ${c.needed} outcome events (clicks) needed; no test run. ` +
      `A ${countsLabel(c.A.clicked, c.A.sends)} · B ${countsLabel(c.B.clicked, c.B.sends)} · ${opens}`
    );
  }
  const verdict = c.significant
    ? `p=${c.p.toFixed(4)} &lt; α=${ALPHA} — arm ${c.direction} leads; CIs are the finding`
    : `p=${c.p.toFixed(4)} — inconclusive at α=${ALPHA} (the expected result at this volume)`;
  return (
    ` · ${c.template}: ${verdict}. ` +
    `A ${countsLabel(c.A.clicked, c.A.sends)} · B ${countsLabel(c.B.clicked, c.B.sends)} · ${opens}`
  );
}

/**
 * Assemble the full weekly report. Pure. The null paths are first-class:
 * zero experiments, zero gate-passing findings, and an absent prior ledger
 * all render as plain statements, never as fabricated conclusions.
 */
export function buildLearningReport(input: LearningReportInput): LearningReport {
  const comparisons = input.templates.map(compareTemplate);
  const passed = comparisons
    .filter((c): c is Extract<Comparison, { kind: 'tested' }> => c.kind === 'tested')
    .sort((a, b) => a.p - b.p);
  const gated = comparisons.filter((c) => c.kind === 'insufficient');

  // Top finding = smallest-p SIGNIFICANT result. A tested-but-inconclusive
  // comparison is not a finding — ranking noise and reading the top is
  // winner's curse (rule 2).
  const top = passed.find((c) => c.significant && c.direction !== 'tie') ?? null;
  const topFinding: LedgerFinding | null = top
    ? {
        template: top.template,
        arm: top.direction as 'A' | 'B',
        aClicked: top.A.clicked,
        aSends: top.A.sends,
        bClicked: top.B.clicked,
        bSends: top.B.sends,
        p: top.p,
      }
    : null;

  const weekOf = new Date(input.nowMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });

  const lines: string[] = [];
  lines.push(`🧪 <b>LEARNING REPORT</b> — week of ${weekOf} (clicks only; gated by design)`);
  lines.push('');

  // ── Experiments ──
  lines.push(
    `📐 prespecified test: two-sided Fisher's exact per template, α=${ALPHA}, clicked/sent per arm (cumulative):`,
  );
  if (comparisons.length === 0) {
    lines.push(' · no variant-stamped campaign sends exist yet — nothing to test, and that is the true state');
  } else {
    for (const c of comparisons) lines.push(comparisonLine(c));
  }
  if (input.unattributed > 0) {
    lines.push(
      ` · (${input.unattributed} campaign sends predate variant stamping and are excluded from every arm)`,
    );
  }
  lines.push('');

  // ── Findings (rule 2 + rule 3) ──
  lines.push(`🏆 findings that passed the evidence gate (≥${MIN_OUTCOME_EVENTS} clicks, p&lt;α):`);
  if (topFinding) {
    for (const c of passed.filter((x) => x.significant && x.direction !== 'tie')) {
      lines.push(
        ` · ${c.template}: arm ${c.direction} — A ${countsLabel(c.A.clicked, c.A.sends)} vs B ${countsLabel(c.B.clicked, c.B.sends)}, p=${c.p.toFixed(4)}`,
      );
    }
    lines.push(
      ' → promotion path: nothing changes automatically. Ben approves → challenger lands via PR → judged by the variant stamps.',
    );
  } else {
    lines.push(
      ' · none — nothing passed the gate this week. A null report is a normal report; a synthesis that always finds something is a noise generator.',
    );
  }
  lines.push('');

  // ── Replication ledger (rule 4) ──
  if (input.prior.kind === 'finding') {
    const priorFinding = input.prior.finding;
    lines.push('🔁 replication ledger:');
    lines.push(
      replicationVerdict(
        priorFinding,
        input.templates.find((t) => t.template === priorFinding.template),
      ).line,
    );
  } else if (input.prior.kind === 'none') {
    lines.push('🔁 replication ledger: last week was a null report — nothing to replicate.');
  } else {
    lines.push('🔁 replication ledger: no prior report token found (first run) — the ledger starts this week.');
  }
  lines.push('');

  // ── Required-n (rule 6) ──
  const totalClicks = input.templates.reduce((s, t) => s + t.A.clicked + t.B.clicked, 0);
  const totalSends = input.templates.reduce((s, t) => s + t.A.sends + t.B.sends, 0);
  const baseline = totalSends > 0 ? totalClicks / totalSends : 0;
  const req = requiredNPerArm(baseline);
  const largestArm = input.templates.reduce((m, t) => Math.max(m, t.A.sends, t.B.sends), 0);
  if (req !== null) {
    const mult = largestArm > 0 ? Math.ceil(req / largestArm) : null;
    lines.push(
      `🎯 to judge a +${PRESPECIFIED_RELATIVE_LIFT * 100}% click lift at the observed base rate (${totalClicks}/${totalSends} pooled): ` +
        `~${req.toLocaleString('en-US')}/arm needed; largest arm so far is ${largestArm}` +
        (mult !== null ? ` (~${mult}x more)` : '') +
        `. That gap IS the decision information — not a reason to lower the bar.`,
    );
  } else {
    lines.push(
      `🎯 required n/arm for +${PRESPECIFIED_RELATIVE_LIFT * 100}%: not computable — zero clicks observed (${totalClicks}/${totalSends} pooled), so there is no base rate to power against.`,
    );
  }
  lines.push('');

  // ── Volume triggers (killed knobs, §1) ──
  lines.push('🔒 learning mechanisms still gated on volume (recorded triggers — not re-litigated here):');
  lines.push(...volumeTriggerLines(input.volume));

  // ── Cron Runs note (compact; token LAST so parseLedgerToken finds it) ──
  const token = formatLedgerToken(topFinding);
  const notes =
    `weekly report sent · templates=${comparisons.length} tested=${passed.length} ` +
    `gated=${gated.length} findings=${topFinding ? 1 : 0} unattributed=${input.unattributed} ` +
    `sends7d=${Math.round(input.volume.sendsPerDay7d * 7)} · ${token}`;

  return { lines, notes, topFinding };
}
