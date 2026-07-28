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

import { netEarningsFor, referralRail } from './commission';

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
  /** RAIL-PER-ROW (audit fix #3): 'Deposit Paid At' — present ⇒ this row rode
   *  the tier_v2 deposit rail (net = full sale); blank ⇒ legacy/off-rail (net
   *  = sale − commission). Optional so older callers still compile. */
  depositPaidAt?: string;
  /** Wave C (2026-07-14): row source — 'share' (Referral, the default) or
   *  'product' (Rancher Orders). Product orders never create a Referral, so
   *  without them the "export for taxes" file was materially incomplete for
   *  jerky/box-heavy ranchers. Optional so existing callers are unchanged. */
  kind?: 'share' | 'product';
  /** Wave C: exact net for rows whose payout is already known (product rows
   *  carry the settlement-stamped Rancher Payout). When set, it wins over the
   *  referral-rail net computation — product orders never rode either rail. */
  netOverride?: number;
  /** Money-truth trail (2026-07-28): 'Final Paid Amount' — the settled
   *  final-invoice amount stamped by settleFinalInvoice. Display-only.
   *  undefined ⇒ no final settlement recorded ⇒ the CSV cell stays BLANK
   *  (0.00 would read as a real $0 payment in a tax file). */
  finalPaidAmount?: number;
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

/**
 * Neutralize spreadsheet formula injection. A cell whose text begins with
 * `= + - @`, TAB (0x09), or CR (0x0D) is interpreted as a FORMULA by Excel,
 * Google Sheets, and LibreOffice — e.g. a buyer named `=HYPERLINK("http://evil",...)`
 * or `@SUM(...)` executes when the rancher opens their earnings export. Buyer
 * names + order types are untrusted consumer input landing in a file a human
 * opens, so prefix a single quote to force literal-text rendering (OWASP CSV-
 * injection mitigation). Apply ONLY to free-text cells — machine-generated
 * numbers/dates/ids must not be mangled (a legit "-100.00" stays numeric).
 */
export function csvNeutralizeFormula(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
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
  // Wave C: leading Type column ('share' | 'product') — product orders now
  // ride the same bookkeeping file, and a sheet needs to tell them apart.
  'Type',
  'Referral ID',
  'Buyer',
  'Cut',
  'Sale Amount',
  'Commission',
  'Net to You',
  'Intro Sent',
  'Closed',
  // Money-truth trail (2026-07-28): trailing so existing sheet templates
  // keep their column positions.
  'Final Paid Amount',
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

/**
 * Build the full CSV string (header + rows). Always ends with a trailing
 * newline. `fallbackRail` is used only for rows that carry no depositPaidAt
 * info (older callers) — when a row has depositPaidAt, the rail is decided
 * PER ROW so a migrated rancher's legacy history isn't overstated (audit #3).
 */
export function buildEarningsCsv(rows: EarningsRow[], fallbackRail: string = 'legacy'): string {
  const lines: string[] = [];
  lines.push(EARNINGS_CSV_HEADERS.map(csvEscape).join(','));
  for (const r of rows) {
    // Wave C: a known payout (product rows) wins outright — product orders
    // never rode a referral rail, their net is the settlement-stamped payout.
    // RAIL-PER-ROW "Net to You" otherwise: a deposit-paid row nets 100% of the
    // sale (commission skimmed at deposit); a legacy/off-rail row nets it out.
    // Row rail wins over the caller's fallback whenever depositPaidAt is known.
    let net: number;
    if (typeof r.netOverride === 'number' && isFinite(r.netOverride)) {
      net = r.netOverride;
    } else {
      const rowRail =
        r.depositPaidAt !== undefined
          ? referralRail({ deposit_paid_at: r.depositPaidAt })
          : fallbackRail;
      net = netEarningsFor(rowRail, Number(r.saleAmount) || 0, Number(r.commissionDue) || 0);
    }
    lines.push([
      csvEscape(r.kind || 'share'),
      csvEscape(r.id),
      csvEscape(csvNeutralizeFormula(r.buyerName)),
      csvEscape(csvNeutralizeFormula(r.orderType)),
      csvEscape(money(r.saleAmount)),
      csvEscape(money(r.commissionDue)),
      csvEscape(money(net)),
      csvEscape(dateOnly(r.introSentAt)),
      csvEscape(dateOnly(r.closedAt)),
      csvEscape(
        typeof r.finalPaidAmount === 'number' && isFinite(r.finalPaidAmount)
          ? money(r.finalPaidAmount)
          : '',
      ),
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
