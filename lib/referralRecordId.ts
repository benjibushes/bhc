// lib/referralRecordId.ts
//
// Denormalize the linked rancher record id onto the Referral row so the
// /rancher dashboard read filters server-side (filterByFormula on a scalar
// text field) instead of full-scanning the whole Referrals table. Scale-ladder
// item #1 (2026-07-02): every dashboard load was O(all referrals); at ~100
// ranchers this saturates Airtable's 5 req/s base limit.
//
// WHY TEXT, NOT A LOOKUP: the correct Airtable primitive is a Lookup of
// Ranchers → Rancher Record Id, but the API can't create lookups (UI only).
// The lookup's VALUE, however, is exactly RECORD_ID() of the linked rancher —
// which is the record id ALREADY sitting in the Referral's Rancher /
// Suggested Rancher link array. So a plain single-line-text field carrying
// that id filters identically (`{Rancher Record Id} = "recXXX"`), and we can
// derive + write it ourselves with zero cross-table reads.
//
// FRESHNESS: a lookup auto-updates when the link changes; a text field does
// not. Two mechanisms keep it correct:
//   1. stampRancherRecordIds() — call at every Referral CREATE so a fresh lead
//      is filterable the instant it exists (rancher sees it immediately).
//   2. the referral-record-id-backfill cron — a self-healing belt that fixes
//      any row whose stored id drifted from the link (reassign/approve/admin
//      paths that don't go through the stamp). One place, can't-drift.

export const RANCHER_RECORD_ID_FIELD = 'Rancher Record Id';
export const SUGGESTED_RANCHER_RECORD_ID_FIELD = 'Suggested Rancher Record Id';

/** First linked record id from a multipleRecordLinks value, or ''. */
export function firstLinkId(v: unknown): string {
  return Array.isArray(v) && v.length > 0 && v[0] ? String(v[0]) : '';
}

/**
 * Given a Referrals `fields` object being written, return a COPY with the
 * denormalized record-id text fields added/updated from the Rancher /
 * Suggested Rancher links present in that same object. No-ops for a field with
 * no link (waitlist referrals with no rancher yet just don't get stamped).
 * Pure — never reads Airtable.
 */
export function stampRancherRecordIds<T extends Record<string, any>>(fields: T): T {
  const out: Record<string, any> = { ...fields };
  const r = firstLinkId(fields['Rancher']);
  const s = firstLinkId(fields['Suggested Rancher']);
  if (r) out[RANCHER_RECORD_ID_FIELD] = r;
  if (s) out[SUGGESTED_RANCHER_RECORD_ID_FIELD] = s;
  return out as T;
}

/**
 * Belt/self-heal decision for the backfill cron: given a referral ROW (as read
 * from Airtable, with link arrays + the current text values), return the patch
 * needed to bring the text fields in line with the links, or null when the row
 * is already correct / has no link. Stale (link changed under a reassign) and
 * missing both heal to the link value; a link that was CLEARED also clears the
 * stamp so a filtered read can't return a now-unlinked referral.
 */
export function referralRecordIdRepair(
  row: Record<string, any>,
): { 'Rancher Record Id'?: string; 'Suggested Rancher Record Id'?: string } | null {
  const wantR = firstLinkId(row['Rancher']);
  const wantS = firstLinkId(row['Suggested Rancher']);
  const haveR = String(row[RANCHER_RECORD_ID_FIELD] || '');
  const haveS = String(row[SUGGESTED_RANCHER_RECORD_ID_FIELD] || '');
  const patch: Record<string, string> = {};
  if (wantR !== haveR) patch[RANCHER_RECORD_ID_FIELD] = wantR;
  if (wantS !== haveS) patch[SUGGESTED_RANCHER_RECORD_ID_FIELD] = wantS;
  return Object.keys(patch).length ? patch : null;
}
