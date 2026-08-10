// lib/cockpitDialList.ts
//
// BAND — the /admin/today cockpit's ONE merged, supply-gated queue.
//
// Wave 1B built the original three-source merge (buyers, stuck ranchers,
// recruit signals). Cockpit CRM-parity (docs/ADAPTIVE-MARKETING-DESIGN.md
// §3.5 C2) fuses in the two queues that were computed but never rendered
// here, plus the NBA engine's one-liners:
//   • lib/followUpQueue.selectDueFollowUps   — `promise` rows (Ben's own
//     commitments coming due)
//   • lib/closeQueue.rankCloseQueue          — `deal` rows (open referrals
//     ranked by revenue-per-call)
//   • lib/nextBestAction.computeNBA          — annotates matching rows with
//     the engine's action verb; unmatched priority-1/2 items (a Cal call in
//     40 minutes, a fresh wholesale inquiry) surface as `action` rows.
// No new ranker: each source keeps its own authoritative internal order and
// this module only assigns band priorities, dedupes, and gates.
//
// THE SUPPLY GATE (unchanged): a buyer in a state with no operational rancher
// is NOT a dial — those collapse into one "recruit supply in <state>" signal
// row per state. Buyers with no parseable state stay dialable.
//
// THE WRITE-BACK GATES (C1, active only when `now` is passed): the outcome
// endpoint stamps records, and this list is where those stamps become
// visible reality —
//   • a buyer whose 'Next Follow Up At' is in the FUTURE was deliberately
//     deferred (skip / talked-follow-up-in-N) → off the list until due,
//     when the promise lane resurfaces them;
//   • a deposit-opened buyer whose referral was chased/dismissed within 24h
//     → off the list today (the tap already happened);
//   • a stuck rancher touched within 48h (dial outcome or an actual reply)
//     → off the list while the touch is fresh.
// Without `now` (legacy callers, tests) no gate applies.
//
// MERGE PRIORITY (documented so the order is explainable in one line):
//   97        NBA priority-1 action        — a Cal call starting inside the
//                                            hour outranks every dial
//   95        buyer asked for a call       — inbound beats every outbound guess
//   30+0.6·s  stuck rancher (score s)      — 30..90; supply is the constraint
//   85        promised follow-up due       — a promise Ben made, below inbound
//                                            asks, above every outbound guess
//   75        buyer opened checkout, unpaid — money was on screen
//   25+0.5·s  open deal (closeQueue score) — 25..75; an Awaiting-Payment deal
//                                            tops out level with deposit-opened
//   72        NBA priority-2 action        — chases/sends the engine flags
//   35+min(n,40) recruit-supply signal     — n gated buyers in that state
//   45        buyer qualified, cut on file — warm, unblocked
//   40        NBA priority-3 action
//   15        buyer, no fresh signal
//
// DEDUPE (one person ≠ two rows): consumer ids and referral ids are tracked
// across sources; a later row that collides with an earlier one is folded in
// (the earlier row takes the higher priority + a why suffix) instead of
// duplicating. NBA items that match an existing row annotate it instead of
// adding an action row.
//
// PURE: no I/O, no Date.now() (callers pass `now`/`today`), no input mutation.

import { normalizeState } from './states';
import type { RankedDialCandidate } from './callbackQueue';
import type { RankedStuckRancherRow } from './stuckRancherQueue';
import type { DueFollowUp } from './followUpQueue';
import { followUpContextLine, toFollowUpYmd } from './followUpQueue';
import type { RankedCloseQueueRow } from './closeQueue';
import type { NBAItem } from './nextBestAction';

export const DEFAULT_COCKPIT_DIAL_LIMIT = 10;

/** C1 gates — how long an outcome tap keeps a row off the list. */
export const REFERRAL_CHASE_EXCLUDE_HOURS = 24;
export const RANCHER_TOUCH_EXCLUDE_HOURS = 48;

export type CockpitDialKind =
  | 'buyer'
  | 'rancher'
  | 'recruit'
  | 'promise'
  | 'deal'
  | 'action';

/** Which record the C1 outcome endpoint stamps for this row. */
export type CockpitOutcomeKind = 'buyer' | 'promise' | 'deal' | 'rancher';

export interface CockpitDialRow {
  kind: CockpitDialKind;
  /** Consumers/Ranchers/Referrals record id; `recruit:<ST>` / `nba:<n>` for signal rows. */
  id: string;
  /** Runtime display name — NEVER hardcoded (public repo). */
  name: string;
  state: string;
  /** One-line why-now for the row. */
  why: string;
  phone: string;
  priority: number;
  /** recruit rows: how many gated buyers are waiting behind the signal. */
  buyersBehind?: number;
  /** rancher rows: the concrete next step to say on the phone. */
  nextStep?: string;
  /** NBA one-liner (the engine's action verb) when it has an opinion here. */
  nba?: string;
  /** C1 — which kind of record the outcome endpoint stamps. Absent = no buttons. */
  outcomeKind?: CockpitOutcomeKind;
  /** buyer rows from the deposit-opened tier: the referral to chase-stamp. */
  referralId?: string;
}

const PRIORITY = {
  actionP1: 97,
  buyerCallback: 95,
  promiseDue: 85,
  buyerDepositOpened: 75,
  actionP2: 72,
  buyerQualified: 45,
  actionP3: 40,
  buyerOther: 15,
  rancherBase: 30,
  rancherPerScore: 0.6,
  dealBase: 25,
  dealPerScore: 0.5,
  recruitBase: 35,
  recruitPerBuyerCap: 40,
} as const;

function buyerPriority(tier: RankedDialCandidate['tier']): number {
  switch (tier) {
    case 'callback':
      return PRIORITY.buyerCallback;
    case 'deposit-opened':
      return PRIORITY.buyerDepositOpened;
    case 'qualified-no-deal':
      return PRIORITY.buyerQualified;
    default:
      return PRIORITY.buyerOther;
  }
}

function buyerWhy(b: RankedDialCandidate): string {
  const age = b.signalAgeDays != null ? ` (${b.signalAgeDays}d)` : '';
  switch (b.tier) {
    case 'callback':
      return `Asked for a call${age}${b.callbackNote ? ` — “${b.callbackNote.slice(0, 60)}”` : ''}`;
    case 'deposit-opened':
      return `Opened checkout, never paid${age}${b.rancherName ? ` — ${b.rancherName}` : ''}`;
    case 'qualified-no-deal':
      return `Qualified with a cut on file, no live deal${age}`;
    default:
      return `No fresh signal${age}`;
  }
}

const HOUR_MS = 3_600_000;

function withinHours(stamp: string | undefined, now: number, hours: number): boolean {
  if (!stamp) return false;
  const t = Date.parse(String(stamp));
  if (!Number.isFinite(t)) return false;
  return now - t < hours * HOUR_MS;
}

export interface BuildCockpitDialListInput {
  /** Output of rankDialQueue — order within is preserved. */
  buyers: RankedDialCandidate[];
  /** Output of rankStuckRancherQueue().rows — order within is preserved. */
  stuckRanchers: RankedStuckRancherRow[];
  /** Normalized 2-letter codes with an operational rancher (6-gate canon). */
  coveredStates: ReadonlySet<string>;
  limit?: number;
  /** C2 — lib/followUpQueue.selectDueFollowUps output (already due-filtered). */
  followUpsDue?: DueFollowUp[];
  /** C2 — lib/closeQueue.rankCloseQueue output. */
  closeQueue?: RankedCloseQueueRow[];
  /** C2 — lib/nextBestAction.computeNBA output, for one-liners + action rows. */
  nba?: NBAItem[];
  /** Epoch ms — enables the C1 write-back gates. Absent = legacy behavior. */
  now?: number;
  /** Operator 'YYYY-MM-DD' — enables the deferred-buyer gate. */
  today?: string;
}

export function buildCockpitDialList({
  buyers,
  stuckRanchers,
  coveredStates,
  limit = DEFAULT_COCKPIT_DIAL_LIMIT,
  followUpsDue,
  closeQueue,
  nba,
  now,
  today,
}: BuildCockpitDialListInput): CockpitDialRow[] {
  const rows: CockpitDialRow[] = [];
  /** consumer/referral record id → its row, for dedupe + NBA annotation. */
  const byConsumerId = new Map<string, CockpitDialRow>();
  const byReferralId = new Map<string, CockpitDialRow>();

  // Recruit-signal aggregation: state → { count, sawCallback }
  const recruit = new Map<string, { count: number; sawCallback: boolean }>();

  for (const b of buyers || []) {
    const st = normalizeState(b.state);
    const covered = !st || coveredStates.has(st);
    if (!covered) {
      const agg = recruit.get(st) || { count: 0, sawCallback: false };
      agg.count += 1;
      if (b.tier === 'callback') agg.sawCallback = true;
      recruit.set(st, agg);
      continue;
    }
    // C1 gate — deliberately deferred (skip / follow-up-in-N wrote a FUTURE
    // date). The promise lane owns them again the day they come due.
    if (today) {
      const due = toFollowUpYmd(b.nextFollowUpAt);
      if (due && due > today) continue;
    }
    // C1 gate — the attached referral was chased/dismissed inside 24h.
    if (now != null && withinHours(b.lastChasedAt, now, REFERRAL_CHASE_EXCLUDE_HOURS)) {
      continue;
    }
    const row: CockpitDialRow = {
      kind: 'buyer',
      id: b.id,
      name: b.name || '(no name)',
      state: st || String(b.state || '').trim(),
      why: buyerWhy(b),
      phone: String(b.phone || '').trim(),
      priority: buyerPriority(b.tier),
      outcomeKind: 'buyer',
      ...(b.referralId ? { referralId: b.referralId } : {}),
    };
    rows.push(row);
    byConsumerId.set(b.id, row);
    if (b.referralId) byReferralId.set(b.referralId, row);
  }

  for (const r of stuckRanchers || []) {
    // C1 gate — touched inside 48h (a dial outcome, or an actual reply that
    // the email thread is already carrying).
    if (now != null && withinHours(r.lastTouchAt, now, RANCHER_TOUCH_EXCLUDE_HOURS)) {
      continue;
    }
    rows.push({
      kind: 'rancher',
      id: r.id,
      name: r.operatorName || r.ranchName || '(no name)',
      state: r.state,
      why: r.why,
      phone: String(r.phone || '').trim(),
      priority: PRIORITY.rancherBase + PRIORITY.rancherPerScore * (Number(r.score) || 0),
      nextStep: r.missing[0] || '',
      outcomeKind: 'rancher',
    });
  }

  // ── C2: promised follow-ups due today (or overdue) ────────────────────────
  for (const f of followUpsDue || []) {
    const existing = byConsumerId.get(f.id);
    const note = followUpContextLine(f.notes, 60);
    const whyBits = `Promised follow-up ${
      f.daysOverdue > 0 ? `${f.daysOverdue}d overdue` : 'due today'
    }${note ? ` — “${note}”` : ''}`;
    if (existing) {
      // Same person already on the list (e.g. they ALSO asked for a call).
      // Fold: keep the stronger priority, note the promise.
      existing.priority = Math.max(existing.priority, PRIORITY.promiseDue);
      existing.why = `${existing.why} · ${whyBits}`;
      continue;
    }
    const st = normalizeState(f.state) || String(f.state || '').trim();
    const row: CockpitDialRow = {
      kind: 'promise',
      id: f.id,
      name: f.name || '(no name)',
      state: st,
      why: whyBits,
      phone: String(f.phone || '').trim(),
      priority: PRIORITY.promiseDue,
      outcomeKind: 'promise',
    };
    rows.push(row);
    byConsumerId.set(f.id, row);
  }

  // ── C2: open-deal call queue ──────────────────────────────────────────────
  for (const d of closeQueue || []) {
    if (byReferralId.has(d.id)) continue; // already listed via deposit-opened
    // C1 gate — chased/dismissed inside 24h. rankCloseQueue already folded the
    // stamp into staleness, but a same-day tap must remove the row entirely.
    if (now != null && withinHours(d.lastChasedAt, now, REFERRAL_CHASE_EXCLUDE_HOURS)) {
      continue;
    }
    const st = normalizeState(d.buyerState) || String(d.buyerState || '').trim();
    const row: CockpitDialRow = {
      kind: 'deal',
      id: d.id,
      name: d.buyerName || d.buyerEmail || '(no name)',
      state: st,
      why: d.why,
      phone: String(d.buyerPhone || '').trim(),
      priority: PRIORITY.dealBase + PRIORITY.dealPerScore * (Number(d.score) || 0),
      outcomeKind: 'deal',
    };
    rows.push(row);
    byReferralId.set(d.id, row);
  }

  // ── C2: NBA one-liners — annotate matches, surface the rest ──────────────
  let nbaIdx = 0;
  for (const item of nba || []) {
    if (item.type === 'recruit') continue; // this list computes its own recruit rows
    const matched =
      (item.entityId && byConsumerId.get(item.entityId)) ||
      (item.entityId && byReferralId.get(item.entityId)) ||
      null;
    if (matched) {
      if (!matched.nba) matched.nba = item.action;
      continue;
    }
    if (item.priority === 3 && item.type === 'send') continue; // warm drips aren't dials
    rows.push({
      kind: 'action',
      id: `nba:${item.entityType}:${item.entityId || nbaIdx++}`,
      name: item.subject,
      state: '',
      why: item.reason,
      phone: '',
      priority:
        item.priority === 1
          ? PRIORITY.actionP1
          : item.priority === 2
            ? PRIORITY.actionP2
            : PRIORITY.actionP3,
      nba: item.action,
    });
  }

  for (const [st, agg] of recruit) {
    rows.push({
      kind: 'recruit',
      id: `recruit:${st}`,
      name: `Recruit supply in ${st}`,
      state: st,
      why: `${agg.count} buyer${agg.count === 1 ? '' : 's'} waiting${
        agg.sawCallback ? ' (incl. a callback request)' : ''
      } and no operational rancher — a dial here has nobody to route to.`,
      phone: '',
      priority: PRIORITY.recruitBase + Math.min(agg.count, PRIORITY.recruitPerBuyerCap),
      buyersBehind: agg.count,
    });
  }

  // Priority desc. Ties keep insertion order (Array.prototype.sort is
  // spec-stable since ES2019), which preserves each source ranker's own
  // within-tier ordering — an id tiebreak here would destroy the careful
  // oldest-first/newest-first work rankDialQueue already did.
  rows.sort((a, b) => b.priority - a.priority);
  return rows.slice(0, Math.max(0, limit));
}
