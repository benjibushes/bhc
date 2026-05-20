import { getAllRecords, TABLES, escapeAirtableValue } from './airtable';

/**
 * Canonical list of crons we expect to run at least once per 24h. Used by
 * /cronstatus to flag missing runs (e.g. when Vercel silently drops a
 * day-of-week or monthly slot — see Hobby-tier guards in
 * rancher-followup / compliance-reminders / commission-invoices).
 *
 * Keep in sync with vercel.json. Lone exception: monthly-flavor crons
 * (compliance-reminders, commission-invoices) now run daily w/ a date-1
 * guard so they DO appear here.
 */
export const EXPECTED_CRONS_24H = [
  'batch-approve',
  'buyer-pulse',
  'close-detector',
  'commission-invoices',
  'compliance-reminders',
  'daily-audit',
  'daily-digest',
  'email-sequences',
  'healthcheck',
  'nightly-rancher-audit',
  'onboarding-stuck',
  'rancher-followup',
  'rancher-launch-warmup',
  'rancher-onboarding-drip',
  'rancher-trust-promotion',
  'referral-chasup',
  'send-scheduled',
  'stuck-buyer-recovery',
  're-warm-cohort',
] as const;

export interface CronRunSummary {
  name: string;
  startedAt: string;
  status: string;
  recordsTouched: number;
  notes: string;
}

/**
 * Pull the latest Cron Runs row per cron name within `sinceMs` ago. Returns a
 * map keyed by cron name. Crons that haven't fired in the window are NOT in
 * the map — callers should diff against EXPECTED_CRONS_24H to find misses.
 */
export async function getLatestCronRuns(
  sinceMs = 24 * 60 * 60 * 1000,
): Promise<Map<string, CronRunSummary>> {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = (await getAllRecords(
    TABLES.CRON_RUNS,
    `IS_AFTER({Started At}, "${cutoff}")`,
  )) as any[];

  const byName = new Map<string, CronRunSummary>();
  for (const r of rows) {
    const name = r['Name'];
    if (!name) continue;
    const existing = byName.get(name);
    const startedAt = r['Started At'];
    if (!existing || new Date(startedAt).getTime() > new Date(existing.startedAt).getTime()) {
      byName.set(name, {
        name,
        startedAt,
        status: r['Status'] || '?',
        recordsTouched: Number(r['Records Touched']) || 0,
        notes: (r['Notes'] || '').toString(),
      });
    }
  }
  return byName;
}

/**
 * Renders a Telegram-friendly summary card showing per-cron last-run status
 * + any expected crons that haven't fired in the window.
 */
export async function buildCronStatusCard(sinceMs = 24 * 60 * 60 * 1000): Promise<string> {
  const latest = await getLatestCronRuns(sinceMs);

  const iconFor = (status: string): string => {
    switch (status) {
      case 'success':
        return '✅';
      case 'partial':
        return '🟡';
      case 'paused':
        return '⏸️';
      case 'maintenance-blocked':
        return '🛠';
      case 'error':
        return '❌';
      default:
        return '❓';
    }
  };

  const lines: string[] = [];
  const seen = new Set<string>();
  const sortedNames = Array.from(latest.keys()).sort();
  for (const name of sortedNames) {
    seen.add(name);
    const r = latest.get(name)!;
    const ago = humanAgo(Date.now() - new Date(r.startedAt).getTime());
    const notesShort = r.notes.length > 70 ? r.notes.slice(0, 67) + '...' : r.notes;
    lines.push(
      `${iconFor(r.status)} <code>${name}</code> · ${r.recordsTouched} · ${ago} · ${notesShort}`,
    );
  }

  const missing = EXPECTED_CRONS_24H.filter((c) => !seen.has(c));
  if (missing.length) {
    lines.push('');
    lines.push(`🚨 <b>No run in 24h:</b> ${missing.join(', ')}`);
  }

  return lines.join('\n') || 'No cron runs in last 24h.';
}

function humanAgo(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Pause a cron by creating/updating a Cron Pauses row. Idempotent.
 */
export async function pauseCron(name: string, by: string, reason: string): Promise<void> {
  const { createRecord, updateRecord } = await import('./airtable');
  const existing = (await getAllRecords(
    TABLES.CRON_PAUSES,
    `{Name}="${escapeAirtableValue(name)}"`,
  )) as any[];
  if (existing.length) {
    await updateRecord(TABLES.CRON_PAUSES, existing[0].id, {
      Paused: true,
      'Paused At': new Date().toISOString(),
      'Paused By': by,
      Reason: reason,
    });
    return;
  }
  await createRecord(TABLES.CRON_PAUSES, {
    Name: name,
    Paused: true,
    'Paused At': new Date().toISOString(),
    'Paused By': by,
    Reason: reason,
  });
}

/**
 * Resume a cron. Sets Paused=false (preserves audit trail of who/when last
 * paused). No-op if no row exists.
 */
export async function resumeCron(name: string): Promise<void> {
  const { updateRecord } = await import('./airtable');
  const existing = (await getAllRecords(
    TABLES.CRON_PAUSES,
    `{Name}="${escapeAirtableValue(name)}"`,
  )) as any[];
  for (const row of existing) {
    await updateRecord(TABLES.CRON_PAUSES, row.id, { Paused: false });
  }
}
