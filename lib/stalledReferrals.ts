import { getAllRecords, TABLES } from './airtable';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALLED_DAYS = 5;

export interface StalledReferralOpts {
  /** Minimum days since last activity. Defaults to 5. */
  staleDays?: number;
  /** Optional: pre-fetched referrals array (skips Airtable read). */
  referrals?: any[];
}

/**
 * Canonical "stalled referral" definition. A referral is stalled when:
 *   - Status is Intro Sent or Rancher Contacted (open + the rancher should
 *     have replied by now)
 *   - Last Rancher Activity At is empty OR older than `staleDays` days ago
 *   - Intro Sent At is older than `staleDays` days ago (sanity: never flag
 *     a brand-new intro before the rancher has had time to respond)
 *
 * Use this from any new code that needs a stalled-referral list. Existing
 * crons (referral-chasup, rancher-followup, nightly-rancher-audit) keep
 * their inline computations until a dedicated refactor pass aligns them —
 * each has subtle additional filters (Last Chased At cooldown, max chase
 * count, etc.) that aren't safe to fold in without a careful review.
 */
export async function getStalledReferrals(
  opts: StalledReferralOpts = {},
): Promise<any[]> {
  const staleDays = opts.staleDays ?? DEFAULT_STALLED_DAYS;
  const refs = opts.referrals ?? ((await getAllRecords(TABLES.REFERRALS)) as any[]);
  const cutoff = Date.now() - staleDays * DAY_MS;

  return refs.filter((r: any) => {
    const status = (r['Status'] || '').toString();
    if (status !== 'Intro Sent' && status !== 'Rancher Contacted') return false;
    const introAt = r['Intro Sent At'] ? new Date(r['Intro Sent At']).getTime() : 0;
    if (!introAt || Number.isNaN(introAt)) return false;
    if (introAt > cutoff) return false; // intro too recent
    const lastR = r['Last Rancher Activity At']
      ? new Date(r['Last Rancher Activity At']).getTime()
      : 0;
    if (lastR && lastR > cutoff) return false; // rancher engaged within window
    return true;
  });
}

/**
 * Groups stalled referrals by rancher id. Useful for digest output (one
 * card per rancher rather than one row per stalled referral).
 */
export function groupStalledByRancher(stalled: any[]): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const r of stalled) {
    const rancherIds: string[] = r['Rancher'] || r['Suggested Rancher'] || [];
    const rid = Array.isArray(rancherIds) ? rancherIds[0] : null;
    if (!rid) continue;
    const arr = out.get(rid) || [];
    arr.push(r);
    out.set(rid, arr);
  }
  return out;
}
