// app/api/cron/deposit-watchdog/route.ts
//
// MONEY-TRUTH invariant 1b — the deposit HALF-STATE watchdog. Hourly.
//
// Detects referrals that flipped to Status='Awaiting Payment' but where the
// buyer was NEVER sent a deposit invite ('Deposit Invite Sent At' blank),
// >2h old. Every send rail stamps that field on a successful buyer email;
// blank means the buyer is silently waiting on a link nobody sent — a lost
// sale in progress that no other net catches (deposit-request-nudge only
// chases SENT-but-unpaid invites).
//
// Selection is pure + unit-tested (lib/depositWatchdog): Awaiting Payment ·
// Deposit Paid At blank (paid deals KEEP Status='Awaiting Payment' — without
// this the watchdog cries about money already collected) · invite stamp
// blank · age >2h anchored on Deposit Requested At, falling back to record
// createdTime (unparseable ⇒ skip, never alert on unknown age) · 24h
// re-alert cooldown via 'Deposit Watchdog Alerted At'.
//
// CLAIM-BEFORE-ALERT: the cooldown stamp is written BEFORE the operator
// signal, then verified — if the stamp didn't persist (field missing →
// updateRecord silently strips), the run ABORTS before any further alert:
// no cooldown = no alerts (the deposit-request-nudge pattern). The field
// 'Deposit Watchdog Alerted At' exists (fldf6Xo5xl2ktaykM, created
// 2026-07-21); the abort guard is the safety net if it ever vanishes.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { selectWatchdogTargets, watchdogAnchorMs, watchdogSkipReason } from '@/lib/depositWatchdog';

export const maxDuration = 120;

const BATCH_CAP = 10; // alerts per run — a backlog drains over a few hours, not one blast

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const now = new Date();

  // Simple formula + JS-side re-check (the final-invoice-dunning fetch
  // pattern): the formula is only an I/O optimization; the pure selector
  // re-verifies every clause.
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(TABLES.REFERRALS, '{Status} = "Awaiting Payment"')) as any[];
  } catch (e: any) {
    return { status: 'error', recordsTouched: 0, notes: `referrals read failed: ${e?.message?.slice(0, 160)}` };
  }

  // Skip-reason breakdown over the whole candidate pool — the operator can
  // see WHY the Awaiting Payment set isn't (or is) alerting.
  const skipReasonBreakdown: Record<string, number> = {};
  for (const r of candidates) {
    const reason = watchdogSkipReason(r, now.getTime()) ?? 'eligible';
    skipReasonBreakdown[reason] = (skipReasonBreakdown[reason] || 0) + 1;
  }

  const targets = selectWatchdogTargets(candidates, { now }).slice(0, BATCH_CAP);

  let alerted = 0;
  const errors: string[] = [];

  for (const r of targets) {
    try {
      // ── CLAIM BEFORE ALERT + verify-persist (fields-missing abort) ──────
      const updated: any = await updateRecord(TABLES.REFERRALS, r.id, {
        'Deposit Watchdog Alerted At': new Date().toISOString(),
      });
      if (!updated || !updated['Deposit Watchdog Alerted At']) {
        return {
          status: 'error',
          recordsTouched: alerted,
          notes:
            `ABORT: watchdog stamp did not persist for ${r.id} — verify "Deposit Watchdog Alerted At" ` +
            `(dateTime) exists on Referrals. alertedBeforeAbort=${alerted}`,
          skipReasonBreakdown,
        };
      }

      const buyerName = String(r['Buyer Name'] || '').trim() || 'buyer';
      const buyerEmail = String(r['Buyer Email'] || '').trim() || '(no email on referral)';

      // Rancher context — best-effort, copy degrades gracefully.
      let rancherName = String(r['Suggested Rancher Name'] || '').trim();
      const rancherId: string = ((r['Rancher'] || []) as string[])[0] || '';
      if (!rancherName && rancherId) {
        try {
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          rancherName = String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || '').trim();
        } catch { /* best-effort */ }
      }

      const anchorMs = watchdogAnchorMs(r) ?? now.getTime();
      const ageHours = Math.max(0, Math.floor((now.getTime() - anchorMs) / (60 * 60 * 1000)));

      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'payout',
        summary: `Deposit invite NEVER SENT — ${buyerName} waiting ${ageHours}h`,
        detail:
          `${buyerEmail} · rancher=${rancherName || '?'} · referral=${r.id} · age=${ageHours}h\n` +
          `Awaiting Payment with no invite — send the deposit link`,
        refs: [
          { type: 'referral', id: String(r.id) },
          ...(rancherId ? [{ type: 'rancher' as const, id: rancherId, label: rancherName || undefined }] : []),
        ],
        dedupeKey: `deposit-watchdog-${r.id}`,
        dedupeWindowMs: 24 * 60 * 60 * 1000,
      });
      alerted++;

      await new Promise((res) => setTimeout(res, 300)); // pace Airtable + Telegram
    } catch (e: any) {
      errors.push(`${r.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: alerted,
    notes:
      `candidates=${candidates.length} targets=${targets.length} alerted=${alerted} errs=${errors.length}` +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
    skipReasonBreakdown,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('deposit-watchdog', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
