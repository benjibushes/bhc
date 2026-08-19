// lib/campaignDedupeWindow.ts
//
// Can we still trust the "already attempted" set for a bulk campaign?
//
// app/api/cron/send-scheduled dedupes a campaign against Email Sends rows
// tagged with that campaign name. The query used to be UNBOUNDED — every row
// ever — which meant a permanent guarantee ("email each recipient at most once
// per campaign") depended on a delivery LOG never expiring. That coupling is
// one of the two reasons Email Sends sat at a 90-day window and 72% of the
// base's 50,000-record cap.
//
// A campaign's own sends all happen inside its run, so bounding the query at
// the campaign's start loses nothing — PROVIDED the log still reaches back
// that far. When it does not, the dedupe set is silently incomplete and
// recipients already emailed get emailed AGAIN.
//
// For a bulk campaign a stalled send is recoverable and a double blast is not,
// so the answer when we cannot tell is "refuse", never "probably fine". That
// matches the read-error path already in that cron, which skips the tick.
//
// Pure. The cron owns the Airtable read and the operator alert.

export type CampaignDedupeWindow =
  | { ok: true; sinceISO: string }
  | { ok: false; reason: 'unknown-start' | 'older-than-retention' };

/**
 * How far before the campaign start to reach, so a send that landed moments
 * before the start stamp is still counted as attempted. One hour is far wider
 * than any clock skew and far narrower than the retention window.
 */
export const DEDUPE_LOOKBEHIND_MS = 60 * 60 * 1000;

/**
 * @param campaignStartRaw  the campaign's own start stamp (Scheduled For /
 *                          Sent At / Date Sent — whichever the row carries)
 * @param nowMs             current time
 * @param retentionDays     EMAIL_SENDS_RETENTION_DAYS — how far the log reaches
 */
export function campaignDedupeWindow(
  campaignStartRaw: unknown,
  nowMs: number,
  retentionDays: number,
): CampaignDedupeWindow {
  const raw = String(campaignStartRaw ?? '').trim();
  if (!raw) return { ok: false, reason: 'unknown-start' };

  const startMs = new Date(raw).getTime();
  if (!Number.isFinite(startMs)) return { ok: false, reason: 'unknown-start' };

  // A start in the FUTURE is fine — a scheduled campaign that has not run yet
  // has nothing to dedupe against, and the window simply covers everything
  // since. Only the past can fall out of the log.
  const retentionFloorMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  if (startMs < retentionFloorMs) return { ok: false, reason: 'older-than-retention' };

  return { ok: true, sinceISO: new Date(startMs - DEDUPE_LOOKBEHIND_MS).toISOString() };
}
