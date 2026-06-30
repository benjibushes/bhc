// lib/earningsCsv.ts
//
// WAVE 3b (2026-06-30) — pure earnings CSV builder for the rancher dashboard
// "export for taxes/bookkeeping" feature. The Earnings view is otherwise
// static cards; this turns closed deals into a downloadable spreadsheet.
//
// PURE — no IO. The route (/api/rancher/earnings/export) loads the rancher's
// referrals, filters to Closed Won, and hands the rows here. Unit-tested for
// CSV escaping (commas, quotes, newlines in buyer names) + date-range filtering
// so a malformed cell can never corrupt the rancher's bookkeeping file.

export interface EarningsRow {
  /** Referral record id — stable key, useful for de-duping in a sheet. */
  id: string;
  buyerName: string;
  orderType: string;
  saleAmount: number;
  commissionDue: number;
  /** Whatever date represents "closed" — Closed At, falling back to created. */
  closedAt: string;
  introSentAt: string;
}

/**
 * RFC-4180 CSV cell escape: wrap in double quotes if the value contains a
 * comma, double-quote, or newline; double any embedded quotes.
 */
export function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Format cents-free dollar number for a spreadsheet (no $, 2dp). */
export function money(n: number): string {
  const v = Number(n);
  return isFinite(v) ? v.toFixed(2) : '0.00';
}

/** ISO/loose date → YYYY-MM-DD (empty string if unparseable/blank). */
export function dateOnly(s: string | undefined | null): string {
  if (!s) return '';
  const d = new Date(String(s));
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export const EARNINGS_CSV_HEADERS = [
  'Referral ID',
  'Buyer',
  'Cut',
  'Sale Amount',
  'Commission',
  'Net to You',
  'Intro Sent',
  'Closed',
] as const;

/**
 * Inclusive date-range filter on the "closed" date. `from`/`to` are YYYY-MM-DD
 * (or any Date-parseable string); either may be omitted for an open bound.
 * Rows with no parseable closed date are INCLUDED only when both bounds are
 * absent (an unbounded export shows everything; a bounded export drops
 * undatable rows so the range is honest).
 */
export function filterByClosedDate(
  rows: EarningsRow[],
  from?: string | null,
  to?: string | null,
): EarningsRow[] {
  const fromMs = from ? Date.parse(`${from}T00:00:00.000Z`) : NaN;
  const toMs = to ? Date.parse(`${to}T23:59:59.999Z`) : NaN;
  const hasFrom = !isNaN(fromMs);
  const hasTo = !isNaN(toMs);
  if (!hasFrom && !hasTo) return rows.slice();

  return rows.filter((r) => {
    const ms = Date.parse(String(r.closedAt));
    if (isNaN(ms)) return false; // undatable row dropped from a bounded export
    if (hasFrom && ms < fromMs) return false;
    if (hasTo && ms > toMs) return false;
    return true;
  });
}

/** Build the full CSV string (header + rows). Always ends with a trailing newline. */
export function buildEarningsCsv(rows: EarningsRow[]): string {
  const lines: string[] = [];
  lines.push(EARNINGS_CSV_HEADERS.map(csvEscape).join(','));
  for (const r of rows) {
    const net = (Number(r.saleAmount) || 0) - (Number(r.commissionDue) || 0);
    lines.push([
      csvEscape(r.id),
      csvEscape(r.buyerName),
      csvEscape(r.orderType),
      csvEscape(money(r.saleAmount)),
      csvEscape(money(r.commissionDue)),
      csvEscape(money(net)),
      csvEscape(dateOnly(r.introSentAt)),
      csvEscape(dateOnly(r.closedAt)),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Suggested download filename, scoped + date-stamped. */
export function earningsCsvFilename(rancherSlugOrId: string, from?: string | null, to?: string | null): string {
  const safe = String(rancherSlugOrId || 'rancher').replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'rancher';
  const range = from || to ? `_${from || 'start'}_to_${to || 'now'}` : '';
  return `buyhalfcow-earnings_${safe}${range}.csv`;
}
