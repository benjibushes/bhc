import { getAllRecords, TABLES, escapeAirtableValue } from './airtable';

/**
 * Canonical list of crons we expect to run at least once per 24h. Used by
 * /cronstatus to flag missing runs (e.g. when Vercel silently drops a
 * day-of-week or monthly slot — see Hobby-tier guards in
 * rancher-followup / compliance-reminders / commission-invoices).
 *
 * F4 (go-to-market debug 2026-07-01): this listed 19 of 43 scheduled crons —
 * the money safety nets (final-invoice-dunning, deposit-accept-sla,
 * stuck-referral-reaper, orphan-checkout-reaper, capacity-drift-check,
 * demand-router, synthetic-e2e, daily-health-digest, fulfillment-chase, …)
 * were INVISIBLE to the watchdog: any of them could silently stop forever.
 * Now covers every vercel.json cron scheduled at least daily; anything else
 * lives in EXCLUDED_CRONS_24H with a documented reason. Coverage is PINNED to
 * vercel.json by lib/cronIntrospection.test.ts — adding a cron without
 * classifying it here fails the suite, so the list can't silently rot again.
 *
 * Names match withCronRun('<name>', …) which matches the route directory
 * (app/api/cron/<name>/route.ts) for every cron — verified 2026-07-01.
 *
 * Notes on entries that are more than plain daily jobs:
 *  - compliance-reminders / commission-invoices: monthly-flavor but run daily
 *    w/ a date-1 guard, so they DO write a daily Cron Runs row.
 *  - demand-router: dark until CAMPAIGN_ROUTER_ENABLED='true', but the gate
 *    sits INSIDE realHandler — a daily Cron Runs row is written either way,
 *    so the watchdog stays quiet while it's dark and catches a real missed run.
 *  - email-sequences: EMAIL_SEQUENCES_ENABLED gate returns BEFORE withCronRun
 *    (no Cron Runs row while the nurture engine is off) — it predates F4 in
 *    this list and is kept for visibility: the daily "no run" line is a
 *    truthful reminder that the engine is off.
 */
export const EXPECTED_CRONS_24H = [
  'abandoned-quiz-nudge',
  'auto-verify-stale',
  'awaiting-payment-nudge',
  'batch-approve',
  'buyer-pulse',
  'cal-reminder-1h',
  'capacity-drift-check',
  'capacity-liberator',
  'close-detector',
  'commission-invoices',
  'compliance-reminders',
  'daily-audit',
  'daily-digest',
  'daily-health-digest',
  'demand-router',
  'deploy-drift',
  'deposit-accept-sla',
  'email-sequences',
  'final-invoice-dunning',
  'fulfillment-chase',
  'healthcheck',
  'migration-deadline',
  'nightly-rancher-audit',
  'onboarding-stuck',
  'orphan-checkout-reaper',
  'qualified-no-action',
  'rancher-followup',
  'rancher-go-live-sync',
  'rancher-launch-warmup',
  'rancher-onboarding-drip',
  'rancher-trust-promotion',
  'reclassify-buyers',
  'referral-chasup',
  're-warm-cohort',
  'send-scheduled',
  'stuck-buyer-recovery',
  'stuck-referral-reaper',
  'synthetic-e2e',
  'testimonial-collection',
] as const;

/**
 * Crons scheduled in vercel.json that the 24h watchdog deliberately does NOT
 * expect a daily run from. Every entry carries its reason — the coverage test
 * (lib/cronIntrospection.test.ts) requires each scheduled cron to be in
 * exactly one of EXPECTED_CRONS_24H / EXCLUDED_CRONS_24H, so an exclusion can
 * never be silent.
 */
export const EXCLUDED_CRONS_24H: Readonly<Record<string, string>> = {
  'spam-audit':
    'weekly (Sat 14:00 UTC) — a 24h expectation would false-alarm 6 days a week',
  'backer-monthly-letter':
    'monthly (1st, 14:00 UTC) — a 24h expectation would false-alarm ~29 days a month',
  'rancher-reactivation':
    'weekday-only (Mon–Fri 15:30 UTC) — a 24h expectation would false-alarm every Sun/Mon',
  'waiting-activation':
    "dark-by-default: the WAITING_ACTIVATION_ENABLED gate returns BEFORE withCronRun, so no " +
    "Cron Runs row exists while dark and the watchdog would alarm daily by design. " +
    "'dry-run' and 'true' modes DO write Cron Runs rows — MOVE to EXPECTED_CRONS_24H when " +
    "the flag goes live (or move its gate inside realHandler like demand-router's).",
};

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
