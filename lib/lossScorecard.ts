// lib/lossScorecard.ts
//
// Pure aggregation for the Monday scorecard's loss-source table (close-the-
// loop 2026-07-15). The Loss Reason field (#396) finally made "why deals die"
// queryable — this rolls the last 28 days of rancher-initiated Closed Lost
// rows into one plain-text block: reason counts, each with its top-3 buyer
// Sources, so Ben can see WHICH acquisition channel feeds each failure mode
// (e.g. "couldn't reach buyer" concentrated in one campaign = a lead-quality
// problem, not a rancher problem).
//
// Rancher-initiated by construction: the ONLY writers of 'Loss Reason' are
// the rancher close surfaces (dashboard Mark Lost modal, pass rail, email
// quick-action) via the pinned lib/lossReasons vocabulary — so "has a Loss
// Reason" IS the rancher-initiated filter.

import { LOSS_REASON_CHOICES, isLossReasonChoice, type LossReason } from './lossReasons';

export interface LossRow {
  lossReason: unknown; // Airtable singleSelect — string or {name}
  source: unknown; // buyer Consumers 'Source'
}

interface ReasonAgg {
  reason: LossReason;
  count: number;
  topSources: Array<{ source: string; count: number }>;
}

const selectValue = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'name' in (v as any)) return String((v as any).name);
  return String(v);
};

/**
 * Aggregate loss rows → per-reason counts + top-3 sources, ordered by count
 * desc then by the pinned vocabulary order. Rows whose reason isn't in the
 * pinned vocabulary are dropped (nothing writes them; a dropped row means
 * schema drift, and inventing a bucket would hide it). Blank source →
 * 'unknown'.
 */
export function aggregateLossReasons(rows: LossRow[], topN = 3): ReasonAgg[] {
  const byReason = new Map<LossReason, Map<string, number>>();
  for (const row of rows) {
    const reason = selectValue(row.lossReason).trim();
    if (!isLossReasonChoice(reason)) continue;
    const source = selectValue(row.source).trim() || 'unknown';
    const sources = byReason.get(reason) || new Map<string, number>();
    sources.set(source, (sources.get(source) || 0) + 1);
    byReason.set(reason, sources);
  }
  const vocabOrder = new Map(LOSS_REASON_CHOICES.map((c, i) => [c, i] as const));
  return [...byReason.entries()]
    .map(([reason, sources]) => {
      const count = [...sources.values()].reduce((s, n) => s + n, 0);
      const topSources = [...sources.entries()]
        .map(([source, n]) => ({ source, count: n }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
        .slice(0, Math.max(0, topN));
      return { reason, count, topSources };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        (vocabOrder.get(a.reason) ?? 99) - (vocabOrder.get(b.reason) ?? 99),
    );
}

/**
 * Telegram lines in the weekly-scorecard house style (' · ' prefix, <b>
 * counts, plain text otherwise). Empty array when there's nothing to say —
 * caller omits the whole section.
 */
export function lossReasonLines(rows: LossRow[]): string[] {
  return aggregateLossReasons(rows).map(({ reason, count, topSources }) => {
    const src = topSources.map((s) => `${s.source} ${s.count}`).join(', ');
    return ` · ${reason}: <b>${count}</b>${src ? ` (${src})` : ''}`;
  });
}
