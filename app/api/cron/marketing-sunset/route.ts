// app/api/cron/marketing-sunset/route.ts
//
// P5′ SUNSET (MARKETING-REVAMP-2026-08 §5, Track 1): pressure gets a hard end
// date. Daily, 07:17 UTC (quiet minute — no hourly cron fires at :17, no
// daily neighbor within 30 minutes).
//
// Three legs, all pure-selected in lib/marketingSunset (unit-tested):
//   1. ASK      — 180d+ zero-engagement (clicks + site/quiz activity, NEVER
//                 opens — MPP) marketing-lane consumers who received sends in
//                 that window get ONE plain re-permission email. Cap 25/run.
//   2. SUPPRESS — 30d after the ask with still no engagement → Unsubscribed
//                 (the existing lib/email.ts suppression mechanism: the flag
//                 feeds getSuppressionList, which every guardedSend checks)
//                 + Notes marker. Cap 25/run.
//   3. NO-CONTACT SUPPRESS — created >365d ago, zero engagement stamps EVER,
//                 no purchases → suppressed WITHOUT any email. Cap 50/run.
//
// STAMPS: Notes markers only (the AREA_OPENED_MARKER pattern from
// state-coverage-notify) — creating Airtable fields from code is impossible,
// and 'Campaign Sunset At' belongs to the demand-router arc, so it stays
// untouched. CLAIM-BEFORE-SEND: the [SUNSET-ASK] marker is written and
// verify-persisted BEFORE the email; if the marker doesn't survive the write,
// the leg ABORTS (no dedupe = no sends — the deposit-request-nudge pattern).
//
// ENV — MARKETING_SUNSET_ENABLED, the standard three-state contract
// (nurture-drip pattern), gated INSIDE realHandler so a Cron Runs row is
// written daily even while dark (demand-router pattern → EXPECTED_CRONS_24H):
//   unset/other → skip (dark)   'dry-run' → plan + count, write nothing
//   'true'      → live
//
// PUBLIC-REPO RULE: counts only in notes/signals — never names or emails.

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { invalidateSuppressionCache } from '@/lib/email';
import { sendSunsetRePermission } from '@/lib/emailMinimal';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { JWT_SECRET } from '@/lib/secrets';
import jwt from 'jsonwebtoken';
import {
  selectSunsetActions,
  SUNSET_ASK_MARKER,
  SUNSET_SUPPRESSED_MARKER,
} from '@/lib/marketingSunset';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const mode = process.env.MARKETING_SUNSET_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    // Dark, but a Cron Runs row is still written (EXPECTED_CRONS_24H member).
    return { status: 'success', recordsTouched: 0, notes: 'skipped: MARKETING_SUNSET_ENABLED not set' };
  }
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }
  const dryRun = mode === 'dry-run';
  const nowMs = Date.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);

  let consumers: any[] = [];
  try {
    consumers = (await getAllRecords(TABLES.CONSUMERS)) as any[];
  } catch (e: any) {
    return { status: 'error', recordsTouched: 0, notes: `consumers read failed: ${e?.message?.slice(0, 160)}` };
  }
  // A near-empty read is degraded data, not an empty list — suppressing or
  // asking off a blind read is exactly the mass-operation failure mode the
  // guardrails exist for. Prod has ~2,700 consumer rows.
  if (consumers.length < 50) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `consumers read returned ${consumers.length} rows — degraded/empty; not acting on a blind read`,
    };
  }

  const picked = selectSunsetActions(consumers, nowMs);
  const planNote =
    `pool=${consumers.length} ask=${picked.asks.length} suppress30d=${picked.suppressAsked.length} ` +
    `neverEngaged=${picked.suppressNeverEngaged.length}`;

  if (dryRun) {
    console.info(`[marketing-sunset] DRY RUN — ${planNote} — flip MARKETING_SUNSET_ENABLED=true to go live`);
    return { status: 'success', recordsTouched: 0, notes: `DRY RUN ${planNote} — no writes` };
  }

  let asked = 0;
  let askEaten = 0; // guardedSend suppressed/failed the send AFTER the claim
  let suppressed = 0;
  const errors: string[] = [];
  let aborted = '';

  // ── Leg 1: re-permission ASK (claim marker BEFORE send, verify persist) ──
  for (const c of picked.asks) {
    try {
      const email = String(c['Email'] || '').trim().toLowerCase();
      if (!email) continue;
      const line = `${SUNSET_ASK_MARKER} ${today}] re-permission email sent (marketing-sunset)`;
      const existing = String(c['Notes'] || '');
      const updated: any = await updateRecord(TABLES.CONSUMERS, c.id, {
        Notes: existing ? `${existing}\n${line}` : line,
      });
      if (!updated || !String(updated['Notes'] || '').includes(SUNSET_ASK_MARKER)) {
        // No durable dedupe = a daily re-ask storm. Abort the leg entirely.
        aborted = `ask marker did not persist for a Consumers row — verify Notes is writable`;
        break;
      }
      // 90d token: the 30d grace window plus slack for late clicks — a dead
      // link on the ONE email we promised would keep them on the list is the
      // worst possible outcome for this rail.
      const keepToken = jwt.sign(
        { type: 'sunset-keep', consumerId: c.id, email },
        JWT_SECRET,
        { expiresIn: '90d' },
      );
      const keepUrl = `${SITE_URL}/api/marketing/keep?token=${encodeURIComponent(keepToken)}`;
      // guardedSend returns {success, suppressed} — a claim-then-eaten send
      // burns this consumer's one ask (acceptable: the 30d clock still runs
      // from a stamped ask, same trade the quiz drip documents), but it must
      // be VISIBLE in the run notes, not silently counted as sent.
      const res: any = await sendSunsetRePermission({
        to: email,
        firstName: String(c['Full Name'] || '').trim().split(/\s+/)[0] || 'there',
        keepUrl,
      });
      if (res?.success === false || res?.suppressed) askEaten++;
      else asked++;
      await new Promise((r) => setTimeout(r, 400)); // pace Resend + Airtable
    } catch (e: any) {
      errors.push(`ask ${c.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  // ── Legs 2 + 3: suppression via the existing mechanism (Unsubscribed flag
  // feeds lib/email.ts getSuppressionList — same write the /api/unsubscribe
  // route makes, plus the Notes marker that records WHY) ──
  const toSuppress: Array<{ c: any; why: string }> = [
    ...picked.suppressAsked.map((c) => ({ c, why: 'no reply 30d after re-permission ask' })),
    ...picked.suppressNeverEngaged.map((c) => ({ c, why: '12mo+ never-engaged (no-contact policy)' })),
  ];
  for (const { c, why } of toSuppress) {
    if (aborted) break;
    try {
      const line = `${SUNSET_SUPPRESSED_MARKER} ${today}] suppressed (marketing-sunset): ${why}`;
      const existing = String(c['Notes'] || '');
      const updated: any = await updateRecord(TABLES.CONSUMERS, c.id, {
        Unsubscribed: true,
        'Unsubscribed At': new Date(nowMs).toISOString(),
        Notes: existing ? `${existing}\n${line}` : line,
      });
      if (!updated || updated['Unsubscribed'] !== true) {
        aborted = `Unsubscribed flag did not persist for a Consumers row — suppression leg aborted`;
        break;
      }
      suppressed++;
      await new Promise((r) => setTimeout(r, 250)); // pace Airtable
    } catch (e: any) {
      errors.push(`suppress ${c.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }
  if (suppressed > 0) invalidateSuppressionCache();

  if (aborted) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'system-error',
      summary: 'marketing-sunset ABORTED mid-run — stamp did not persist',
      detail: aborted,
      dedupeKey: 'marketing-sunset-abort',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    }).catch(() => {});
  }
  if (asked > 0 || suppressed > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `marketing-sunset: ${asked} re-permission ask${asked === 1 ? '' : 's'}, ${suppressed} suppressed`,
      detail: `${planNote} sentAsks=${asked} askEaten=${askEaten} suppressed=${suppressed} errs=${errors.length}${aborted ? ' ABORTED' : ''}`,
      dedupeKey: 'marketing-sunset-summary',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  }

  return {
    status: errors.length || aborted ? 'partial' : 'success',
    recordsTouched: asked + suppressed,
    notes:
      `${planNote} sentAsks=${asked} askEaten=${askEaten} suppressed=${suppressed} errs=${errors.length}` +
      (aborted ? ` ABORTED: ${aborted}` : '') +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('marketing-sunset', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
