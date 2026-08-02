// FULFILLMENT PUSH SAFETY NET — retries connector pushes the settle-time
// side effect missed (docs/plans/2026-07-21-shopify-fulfillment-connector.md,
// Task 6).
//
// Failure class it closes: the inline push in settleProductPurchase is
// best-effort — a Shopify throttle/5xx/network blip at settle time leaves
// 'External Push Status' BLANK, and without this sweep the paid order would
// simply never appear in the rancher's store (they'd ship nothing). Also
// picks up orders settled BEFORE the rancher connected their store — connect
// on Tuesday, Monday's paid orders still push.
//
// Batch C — no silent stranding (selection logic pure + tested in
// lib/fulfillmentPushSelect.ts):
//   • M1 — SORT oldest-first, then cap, so the oldest never starve; a
//     window-INDEPENDENT backstop keeps aged blank rows in play so a >3-day
//     outage / >20-order backlog can't strand them forever. A run that has
//     candidates but pushes 0 no longer reports bare 'success' — it goes
//     'partial' and rings the operator LOUD.
//   • Stale-'pushing' recovery — Batch A pre-stamps 'pushing' before the
//     Shopify call; a mid-push crash strands the row there. Re-pushing is SAFE
//     (unique BHC-oid tag + Idempotency-Key dedup), so a stale 'pushing' row is
//     re-attempted like a blank one.
//   • M2 — operator-requested, window-INDEPENDENT retry via
//     'Push Retry Requested At'; cleared after the attempt so it doesn't
//     re-fire every run.
//
// Idempotent: runFulfillmentPush re-checks the gate (already-pushed /
// terminal-skip stamps) every attempt, and push success stamps
// 'External Order Id', so a webhook-vs-cron race can't double-create.
//
// Schedule: every 2h (vercel.json). Cap 20/run — connector calls are serial
// Shopify API hits.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { runFulfillmentPush } from '@/lib/fulfillmentPushRunner';
import {
  selectPushCandidates,
  classifyPushOutcome,
  MAX_PUSH_PER_RUN,
  type PushCandidateOrder,
  type PushOutcome,
} from '@/lib/fulfillmentPushSelect';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { isMaintenanceMode } from '@/lib/maintenance';

export const maxDuration = 120;

interface NetResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

// Build the set of rancher record ids that have a usable fulfillment
// integration, so the selector's backstop won't keep re-sweeping (and
// oldest-first-starving behind) orders for ranchers who never connected a
// store. Fail-OPEN: on any read error we return null and every order is
// treated as "unknown integration" → included, so we never strand a genuinely
// pushable order because the rancher lookup blipped.
async function loadConnectedRancherIds(): Promise<Set<string> | null> {
  try {
    const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
    return new Set(
      ranchers
        .filter((r) => parseIntegration(r?.['Fulfillment Integration']))
        .map((r) => String(r.id)),
    );
  } catch (e: any) {
    console.warn('[fulfillment-push-net] rancher integration load failed (failing open):', e?.message);
    return null;
  }
}

async function realHandler(_request: Request): Promise<NetResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // Fetch ALL New orders (same population the product-fulfillment-sla cron
  // already scans) and do ALL age/window/retry selection in pure, tested JS —
  // the old IS_AFTER window let aged orders fall out of the query permanently.
  let newOrders: any[];
  try {
    newOrders = (await getAllRecords(TABLES.RANCHER_ORDERS, `{Status} = "New"`)) as any[];
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `query failed: ${String(e?.message || 'unknown').slice(0, 200)}`,
    };
  }

  const connected = await loadConnectedRancherIds();
  const hasIntegration = (rancherRecordId: string): boolean | undefined =>
    connected ? connected.has(rancherRecordId) : undefined; // null → unknown (fail open)

  const nowIso = new Date().toISOString();
  const candidates: PushCandidateOrder[] = newOrders.map((o) => ({
    id: String(o.id),
    status: String(o['Status'] || ''),
    externalPushStatus: String(o['External Push Status'] || ''),
    externalPushedAt: String(o['External Pushed At'] || ''),
    orderedAt: String(o['Ordered At'] || ''),
    pushRetryRequestedAt: String(o['Push Retry Requested At'] || ''),
    externalOrderId: String(o['External Order Id'] || ''),
    hasIntegration: hasIntegration(String(o['Rancher Record ID'] || '')),
  }));

  const sel = selectPushCandidates(candidates, nowIso);

  // Push each selected row, then re-read to tally the honest outcome.
  const outcomes: Record<PushOutcome, number> = { pushed: 0, skipped: 0, failed: 0, retryable: 0 };
  for (const id of sel.toPush) {
    await runFulfillmentPush(id);
    const after = await getRecordById(TABLES.RANCHER_ORDERS, id).catch(() => null);
    let outcome = classifyPushOutcome(String(after?.['External Push Status'] || ''));
    // 2026-08-02 (first-shop-order false alarm): within the 3-day grace the
    // sweep deliberately attempts KNOWN-no-integration ranchers (late-connect
    // cover), the runner correctly refuses and leaves status blank — but blank
    // classified as 'retryable', so a manual-fulfillment rancher's order rang
    // the zero-progress alarm every 2h for 3 days. A known-no-integration
    // refusal is a SKIP (the SLA cron owns manual fulfillment), not stuck work.
    if (
      outcome === 'retryable' &&
      hasIntegration(String(after?.['Rancher Record ID'] || '')) === false
    ) {
      outcome = 'skipped';
    }
    outcomes[outcome] += 1;
  }

  // M2: clear 'Push Retry Requested At' after the attempt (and on moot rows) so
  // the operator's request doesn't re-fire every run. Deferred retry rows keep
  // their flag (the selector excludes them from clearRetryIds).
  let retryCleared = 0;
  for (const id of sel.clearRetryIds) {
    const ok = await updateRecord(TABLES.RANCHER_ORDERS, id, { 'Push Retry Requested At': null })
      .then(() => true)
      .catch(() => false);
    if (ok) retryCleared += 1;
  }

  const pushed = outcomes.pushed;
  const attempted = sel.toPush.length;

  // M1(c): a run with real work that pushed 0 must NOT report bare 'success'.
  // Ring the operator LOUD when nothing moved forward despite failed/retryable
  // work (a clean all-skipped run is genuinely fine, so don't cry wolf there).
  const stuck = outcomes.failed + outcomes.retryable;
  if (pushed === 0 && stuck > 0) {
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'system-error',
      summary: `Fulfillment push made NO progress: 0/${attempted} pushed`,
      detail:
        `The fulfillment-push-net sweep attempted ${attempted} paid order(s) and pushed NONE ` +
        `(${outcomes.failed} failed, ${outcomes.retryable} still retryable, ${outcomes.skipped} skipped). ` +
        `Shopify/token/connector is likely down — paid orders are NOT reaching ranchers' stores. ` +
        `Check the connector health and the most recent 'failed:*' orders.`,
      dedupeKey: 'fulfillment-push-net-zero-progress',
      dedupeWindowMs: 60 * 60 * 1000, // re-screams each 2h run while broken
    }).catch(() => {});
  }

  // Status reflects reality: unfinished work (retryable/failed/deferred) → partial.
  const status: NetResult['status'] =
    outcomes.retryable > 0 || outcomes.failed > 0 || sel.deferred > 0 ? 'partial' : 'success';

  const notes =
    `${newOrders.length} New; ${sel.totalEligible} eligible (cap ${MAX_PUSH_PER_RUN}), ` +
    `attempted ${attempted} → ${pushed} pushed, ${outcomes.skipped} skipped, ` +
    `${outcomes.failed} failed, ${outcomes.retryable} retryable; deferred ${sel.deferred}` +
    (retryCleared ? `; ${retryCleared} retry-flag(s) cleared` : '');

  return {
    status,
    recordsTouched: pushed,
    notes,
    skipReasonBreakdown: sel.sourceCounts as Record<string, number>,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('fulfillment-push-net', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
