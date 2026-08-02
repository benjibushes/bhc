// lib/cockpitDialList.ts
//
// BAND 3 of the /admin/today cockpit — ONE merged, supply-gated dial list.
//
// Inputs are the two rankers that already exist and stay authoritative:
//   • lib/callbackQueue.rankDialQueue        — callable BUYERS, tiered
//   • lib/stuckRancherQueue.rankStuckRancherQueue — stuck RANCHERS, scored 0-100
// This module only merges and supply-gates; it re-ranks nothing inside either
// source (relative order within each source is preserved by construction).
//
// THE SUPPLY GATE: a buyer in a state with no operational rancher is NOT a
// dial — there is nobody to route them to, so the call can only end in an
// apology. Those buyers collapse into one "recruit supply in <state>" signal
// row per state (count attached). Buyers with no parseable state stay
// dialable — you can ask a state on the phone; you can't conjure a rancher.
//
// MERGE PRIORITY (documented so the order is explainable in one line):
//   95        buyer asked for a call        — inbound beats everything, always
//   30+0.6·s  stuck rancher (score s)       — 30..90; a top-scored rancher
//                                             (huge demand, one step from
//                                             payable) outranks any outbound
//                                             buyer guess. Supply is the
//                                             constraint (recruiting pivot).
//   75        buyer opened checkout, unpaid — money was on screen
//   35+min(n,40) recruit-supply signal      — n gated buyers in that state
//   45        buyer qualified, cut on file  — warm, unblocked
//   15        buyer, no fresh signal
//
// PURE: no I/O, no Date.now(), no mutation of input.

import { normalizeState } from './states';
import type { RankedDialCandidate } from './callbackQueue';
import type { RankedStuckRancherRow } from './stuckRancherQueue';

export const DEFAULT_COCKPIT_DIAL_LIMIT = 10;

export type CockpitDialKind = 'buyer' | 'rancher' | 'recruit';

export interface CockpitDialRow {
  kind: CockpitDialKind;
  /** Consumers/Ranchers record id; `recruit:<ST>` for signal rows. */
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
}

const PRIORITY = {
  buyerCallback: 95,
  buyerDepositOpened: 75,
  buyerQualified: 45,
  buyerOther: 15,
  rancherBase: 30,
  rancherPerScore: 0.6,
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

export interface BuildCockpitDialListInput {
  /** Output of rankDialQueue — order within is preserved. */
  buyers: RankedDialCandidate[];
  /** Output of rankStuckRancherQueue().rows — order within is preserved. */
  stuckRanchers: RankedStuckRancherRow[];
  /** Normalized 2-letter codes with an operational rancher (6-gate canon). */
  coveredStates: ReadonlySet<string>;
  limit?: number;
}

export function buildCockpitDialList({
  buyers,
  stuckRanchers,
  coveredStates,
  limit = DEFAULT_COCKPIT_DIAL_LIMIT,
}: BuildCockpitDialListInput): CockpitDialRow[] {
  const rows: CockpitDialRow[] = [];

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
    rows.push({
      kind: 'buyer',
      id: b.id,
      name: b.name || '(no name)',
      state: st || String(b.state || '').trim(),
      why: buyerWhy(b),
      phone: String(b.phone || '').trim(),
      priority: buyerPriority(b.tier),
    });
  }

  for (const r of stuckRanchers || []) {
    rows.push({
      kind: 'rancher',
      id: r.id,
      name: r.operatorName || r.ranchName || '(no name)',
      state: r.state,
      why: r.why,
      phone: String(r.phone || '').trim(),
      priority: PRIORITY.rancherBase + PRIORITY.rancherPerScore * (Number(r.score) || 0),
      nextStep: r.missing[0] || '',
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
