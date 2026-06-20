import { getAllRecords, TABLES } from './airtable';

// ─────────────────────────────────────────────────────────────────────────
// AD SPEND → ROAS
//
// The analytics route already buckets buyers/closes/commission by Consumer
// `Source`. The only missing half for ROAS is what we *paid* per source.
// This reads the `Ad Spend` table and rolls spend up by Source so the route
// can join it to revenue:  roas = commission / spend,  gmvRoas = sale$ / spend.
//
// Source matching is case-insensitive + trimmed so "Facebook" logged by the
// partner joins the "facebook" Consumer bucket.
// ─────────────────────────────────────────────────────────────────────────

export interface SpendInRange {
  /** lowercased+trimmed source → total $ spent in range */
  bySource: Map<string, number>;
  /** total $ spent across all sources in range */
  total: number;
}

const normSource = (s: any): string => String(s ?? '').trim().toLowerCase();

/**
 * Sum ad spend whose `Date` falls within the range.
 * @param cutoffMs epoch ms; rows with Date >= cutoff are included. 0 = all time.
 */
export async function getSpendInRange(cutoffMs: number): Promise<SpendInRange> {
  const bySource = new Map<string, number>();
  let total = 0;

  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.AD_SPEND)) as any[];
  } catch {
    // Table may not exist in every environment — degrade to zero spend so the
    // analytics page still renders (ROAS columns simply show "—").
    return { bySource, total: 0 };
  }

  for (const r of rows) {
    const amount = Number(r['Amount'] || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    if (cutoffMs > 0) {
      const raw = r['Date'];
      if (!raw) continue; // undated spend can't be range-filtered → exclude
      const t = new Date(raw).getTime();
      if (!Number.isFinite(t) || t < cutoffMs) continue;
    }

    const key = normSource(r['Source']) || 'organic';
    bySource.set(key, (bySource.get(key) || 0) + amount);
    total += amount;
  }

  return { bySource, total };
}
