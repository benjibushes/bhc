// lib/pausedCrons.ts
//
// Pure selector for the daily-health-digest "paused crons" bucket
// (runtime audit 2026-07-28). A cron paused via the Cron Pauses table keeps
// writing status='paused' rows, so it never trips the dead-man's switch —
// synthetic-e2e sat paused for 49 days with zero digest visibility. This
// makes every active pause a daily digest line.
//
// Primary source: Cron Pauses rows with Paused=true (authoritative — carries
// Paused At / Reason / Paused By, and survives Cron Runs log retention).
// Fallback: any cron whose recent runs are ALL status='paused' (covers a
// degraded Cron Pauses read). Union deduped by name; pause-table entry wins
// because it has the metadata.

export interface PausedCronEntry {
  name: string;
  /** Whole days since Paused At; null when unknown/unparseable. */
  pausedDays: number | null;
  reason: string;
  by: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function aggregatePausedCrons(args: {
  pauseRows: any[] | null | undefined;
  recentRuns: any[] | null | undefined;
  nowMs: number;
}): PausedCronEntry[] {
  const pauseRows = Array.isArray(args.pauseRows) ? args.pauseRows : [];
  const recentRuns = Array.isArray(args.recentRuns) ? args.recentRuns : [];
  const byName = new Map<string, PausedCronEntry>();

  for (const row of pauseRows) {
    if (row?.['Paused'] !== true) continue;
    const name = String(row['Name'] || '').trim();
    if (!name) continue;
    const pausedAtMs = new Date(String(row['Paused At'] || '')).getTime();
    const pausedDays = Number.isFinite(pausedAtMs)
      ? Math.max(0, Math.floor((args.nowMs - pausedAtMs) / DAY_MS))
      : null;
    byName.set(name, {
      name,
      pausedDays,
      reason: String(row['Reason'] || ''),
      by: String(row['Paused By'] || ''),
    });
  }

  // Fallback from run rows: all-paused names not already covered.
  const runStatuses = new Map<string, { paused: number; other: number }>();
  for (const run of recentRuns) {
    const name = String(run?.['Name'] || '').trim();
    if (!name) continue;
    const bucket = runStatuses.get(name) || { paused: 0, other: 0 };
    if (String(run?.['Status'] || '').toLowerCase() === 'paused') bucket.paused++;
    else bucket.other++;
    runStatuses.set(name, bucket);
  }
  for (const [name, counts] of runStatuses) {
    if (byName.has(name)) continue;
    if (counts.paused > 0 && counts.other === 0) {
      byName.set(name, { name, pausedDays: null, reason: '', by: '' });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
