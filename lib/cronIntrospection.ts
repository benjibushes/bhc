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
 *  - email-sequences: the EMAIL_SEQUENCES_ENABLED gate sits INSIDE
 *    withCronRun (moved 2026-07-15 — it used to return before it, writing
 *    ZERO Cron Runs rows for 36 days and reading as a dead cron). A daily
 *    'skipped: engine off' row is written while the engine is dark, same
 *    pattern as demand-router, so a missing row now means a REAL missed run.
 */
export const EXPECTED_CRONS_24H = [
  // stale capacity-hold expiry — frees dead-intro slots before the 14:30
  // stuck-buyer-recovery pass routes them (dark until STALE_HOLD_EXPIRY_ENABLED).
  'referral-stale-expiry',
  'nurture-drip',
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
  'deposit-link-refresh',
  'email-canary',
  'product-settlement-net',
  'product-fulfillment-sla',
  'email-sequences',
  'final-invoice-dunning',
  // 48h first-touch SLA nudge + 96h escalation (close-the-loop 2026-07-15) —
  // always-on daily; the SMS leg is ENABLE_SMS-gated inside the handler so a
  // Cron Runs row is written either way.
  'first-touch-sla',
  'fulfillment-chase',
  'healthcheck',
  'migration-deadline',
  'nightly-rancher-audit',
  'onboarding-stuck',
  // "setup link may not have landed" sweep — env-gated (SETUP_LINK_UNDELIVERED_
  // ENABLED) but the gate is INSIDE realHandler, so a Cron Runs row is written
  // hourly either way (same as demand-router / stripe-reconcile). EXPECTED, not
  // EXCLUDED.
  'setup-link-undelivered',
  'deposit-request-nudge',
  'deposit-watchdog',
  'fulfillment-push-net',
  'shopify-catalog-sync',
  'orphan-checkout-reaper',
  'qualified-no-action',
  'referral-record-id-backfill',
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
  // nightly Stripe↔Airtable truth sync (subscriptions + Connect status) —
  // dry-run by default, so a daily Cron Runs row is written either way.
  'stripe-reconcile',
  'synthetic-e2e',
  'testimonial-collection',
  // closed-lost recovery rails (Loss Reason → re-engage/downsell/nurture) —
  // dry-run by default (LOSS_RECOVERY_ENABLED), writes a Cron Runs row daily.
  'loss-recovery',
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
  'product-stock-checkin':
    'monthly (1st, 16:00 UTC) — a 24h expectation would false-alarm ~29 days a month; ' +
    'also dark-by-default (PRODUCT_STOCK_CHECKIN_ENABLED gate returns before withCronRun)',
  'weekly-scorecard':
    'weekly (Mondays 14:00 UTC) — a 24h expectation would false-alarm six days a week by design.',
  'log-retention':
    'dark-by-default: the LOG_RETENTION_ENABLED gate returns BEFORE withCronRun, so no ' +
    'Cron Runs row exists while dark and the watchdog would alarm daily by design. ' +
    "MOVE to EXPECTED_CRONS_24H when the flag goes live (dry-run/'true' both write rows).",
  'product-review-ask':
    'dark-by-default: the PRODUCT_REVIEW_ASK_ENABLED gate returns BEFORE withCronRun, so no ' +
    'Cron Runs row exists while dark and the watchdog would alarm daily by design. ' +
    "MOVE to EXPECTED_CRONS_24H when the flag goes live (dry-run/'true' both write rows).",
  'backer-monthly-letter':
    'monthly (1st, 14:00 UTC) — a 24h expectation would false-alarm ~29 days a month',
  'rancher-reactivation':
    'weekday-only (Mon–Fri 15:30 UTC) — a 24h expectation would false-alarm every Sun/Mon',
  'waiting-activation':
    "dark-by-default: the WAITING_ACTIVATION_ENABLED gate returns BEFORE withCronRun, so no " +
    "Cron Runs row exists while dark and the watchdog would alarm daily by design. " +
    "'dry-run' and 'true' modes DO write Cron Runs rows — MOVE to EXPECTED_CRONS_24H when " +
    "the flag goes live (or move its gate inside realHandler like demand-router's).",
  'replenishment':
    "dark-by-default: same three-state REPLENISHMENT_ENABLED contract as waiting-activation " +
    "(gate before withCronRun → no Cron Runs row while dark). MOVE to EXPECTED_CRONS_24H " +
    "when the flag goes live.",
  'product-recovery':
    "dark-by-default: same three-state PRODUCT_RECOVERY_ENABLED contract as replenishment " +
    "(gate before withCronRun → no Cron Runs row while dark). MOVE to EXPECTED_CRONS_24H " +
    "when the flag goes live.",
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
 * THE dead-man's-switch decision, extracted pure (2026-07-02) so it has two
 * consumers instead of one:
 *   - buildCronStatusCard (pull — Telegram /cronstatus)
 *   - daily-health-digest (push — loud sendOperatorSignal when a money
 *     safety-net cron writes NO row; previously the digest only inspected
 *     rows that EXIST, so a silently-unscheduled cron was invisible. In-repo
 *     precedent: Vercel skipped commission-invoices for 60+ days — 0 rows,
 *     0 alerts.)
 *
 * Returns every EXPECTED_CRONS_24H entry whose latest run is absent from
 * `latestRuns` OR older than `windowMs` before `nowISO` (present-but-old —
 * matters when the caller fetched with a wider sinceMs). An unparseable
 * startedAt counts as missing: the watchdog must never call garbage healthy.
 * EXCLUDED_CRONS_24H entries are never returned (they aren't in EXPECTED).
 */
export function missingExpectedCrons(
  latestRuns: ReadonlyMap<string, CronRunSummary>,
  nowISO: string,
  windowMs = 24 * 60 * 60 * 1000,
): string[] {
  const cutoffMs = new Date(nowISO).getTime() - windowMs;
  return EXPECTED_CRONS_24H.filter((name) => {
    const run = latestRuns.get(name);
    if (!run) return true;
    const startedMs = new Date(run.startedAt).getTime();
    return !Number.isFinite(startedMs) || startedMs < cutoffMs;
  });
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
  const sortedNames = Array.from(latest.keys()).sort();
  for (const name of sortedNames) {
    const r = latest.get(name)!;
    const ago = humanAgo(Date.now() - new Date(r.startedAt).getTime());
    const notesShort = r.notes.length > 70 ? r.notes.slice(0, 67) + '...' : r.notes;
    lines.push(
      `${iconFor(r.status)} <code>${name}</code> · ${r.recordsTouched} · ${ago} · ${notesShort}`,
    );
  }

  // Same decision the daily-health-digest dead-man's switch pushes through
  // sendOperatorSignal — one helper, two consumers. windowMs mirrors sinceMs
  // so a wider card window never age-flags rows it deliberately fetched.
  const missing = missingExpectedCrons(latest, new Date().toISOString(), sinceMs);
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
