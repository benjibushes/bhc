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

import { getAllRecords, getRecordById, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  selectWatchdogTargets,
  watchdogAnchorMs,
  watchdogSkipReason,
  earliestSentDepositInvite,
} from '@/lib/depositWatchdog';
import { selectBalkedReferrals, balkSkipBreakdown, minutesSinceOpen } from '@/lib/depositBalk';

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
  let healed = 0;
  const errors: string[] = [];

  for (const r of targets) {
    try {
      // ── SELF-HEAL BEFORE ALERT (2026-07-22 false-alarm incident) ────────
      // A blank 'Deposit Invite Sent At' is NOT proof the invite never went
      // out — it can be a pre-#410 send (field didn't exist yet) or a send
      // path that forgot to stamp. Email Sends is the ground truth. If a real
      // deposit invite was delivered to this buyer, backfill the stamp from
      // that timestamp and DO NOT alarm — the instrument heals itself instead
      // of crying wolf. Read failure falls through to the alarm (never
      // suppress a genuine one on a transient Airtable error).
      const buyerEmail = String(r['Buyer Email'] || '').trim();
      if (buyerEmail) {
        let sends: any[] = [];
        try {
          sends = (await getAllRecords(
            TABLES.EMAIL_SENDS,
            `AND(LOWER({Recipient Email})="${escapeAirtableValue(buyerEmail.toLowerCase())}", {Status}="sent")`,
          )) as any[];
        } catch {
          /* read failed → fall through to alarm; a real stuck buyer must not be
             silently suppressed by an Airtable hiccup */
        }
        const invitedAt = earliestSentDepositInvite(sends);
        if (invitedAt) {
          try {
            await updateRecord(TABLES.REFERRALS, r.id, { 'Deposit Invite Sent At': invitedAt });
            healed++;
            skipReasonBreakdown['self-healed'] = (skipReasonBreakdown['self-healed'] || 0) + 1;
          } catch (e: any) {
            // Backfill write failed — do NOT alarm (the invite DID go out, so an
            // alarm would be the false positive we're fixing). Next run retries
            // the heal. Record as an error so the run reports 'partial'.
            errors.push(`${r.id}: self-heal write (${e?.message?.slice(0, 60) || 'unknown'})`);
          }
          continue; // invited for real → never alarm
        }
      }

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
      const buyerEmailLabel = buyerEmail || '(no email on referral)';

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
          `${buyerEmailLabel} · rancher=${rancherName || '?'} · referral=${r.id} · age=${ageHours}h\n` +
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

  // ── BALK PASS (2026-08-07, human-in-the-loop slice 1) ─────────────────
  // Buyers who OPENED the deposit page 1–48h ago and didn't pay. Hottest
  // non-converted inventory in the system — one loud ping to Ben per
  // referral, ever ('Balk Alert Sent At' claim-before-alert, same abort
  // semantics as the invite watchdog above). Selection is pure + tested
  // (lib/depositBalk); the formula is only an I/O optimization.
  let balkAlerted = 0;
  const BALK_CAP = 5;
  try {
    const balkRows = (await getAllRecords(
      TABLES.REFERRALS,
      'AND(NOT({Deposit Link Opened At}=""), {Deposit Paid At}="", {Balk Alert Sent At}="")',
    )) as any[];
    const balkCandidates = balkRows.map((r: any) => ({ id: String(r.id), fields: r }));
    const balkBreakdown = balkSkipBreakdown(balkCandidates, now.getTime());
    for (const key of Object.keys(balkBreakdown)) {
      skipReasonBreakdown[`balk:${key}`] = balkBreakdown[key];
    }
    const balks = selectBalkedReferrals(balkCandidates, now.getTime()).slice(0, BALK_CAP);
    for (const b of balks) {
      try {
        // CLAIM BEFORE ALERT + verify-persist — a missing field must abort
        // the pass (no dedupe stamp = a ping loop that trains Ben to ignore
        // the channel).
        const updated: any = await updateRecord(TABLES.REFERRALS, b.id, {
          'Balk Alert Sent At': new Date().toISOString(),
        });
        if (!updated || !updated['Balk Alert Sent At']) {
          errors.push(`${b.id}: balk stamp did not persist — verify "Balk Alert Sent At" exists on Referrals; balk pass aborted`);
          break;
        }

        const r: any = b.fields;
        const buyerName = String(r['Buyer Name'] || '').trim() || 'buyer';
        const buyerEmail = String(r['Buyer Email'] || '').trim();
        const mins = minutesSinceOpen(r, now.getTime());

        // Buyer phone for the one-tap text — best-effort consumer fetch.
        let buyerPhone = '';
        const buyerId: string = ((r['Buyer'] || []) as string[])[0] || '';
        if (buyerId) {
          try {
            const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
            buyerPhone = String(buyer?.['Phone'] || '').trim();
          } catch { /* best-effort */ }
        }

        let rancherName = String(r['Suggested Rancher Name'] || '').trim();
        const rancherId: string = ((r['Rancher'] || []) as string[])[0] || '';
        if (!rancherName && rancherId) {
          try {
            const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
            rancherName = String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || '').trim();
          } catch { /* best-effort */ }
        }

        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'payout',
          summary: `🔥 BALK — ${buyerName} opened the deposit page ${mins}min ago, didn't pay`,
          detail:
            `${buyerEmail || '(no email)'}${buyerPhone ? ` · ${buyerPhone}` : ''} · rancher=${rancherName || '?'} · referral=${b.id}\n` +
            `They saw the money page and flinched — the first hour is worth 21x. ` +
            `${buyerPhone ? `Text them now: sms:${buyerPhone.replace(/[^+\d]/g, '')}` : 'No phone on file — reply to their intro email thread.'}`,
          refs: [
            { type: 'referral', id: b.id },
            ...(rancherId ? [{ type: 'rancher' as const, id: rancherId, label: rancherName || undefined }] : []),
          ],
          dedupeKey: `deposit-balk-${b.id}`,
          dedupeWindowMs: 7 * 24 * 60 * 60 * 1000,
        });
        balkAlerted++;
        await new Promise((res) => setTimeout(res, 300));
      } catch (e: any) {
        errors.push(`${b.id}: balk (${e?.message?.slice(0, 60) || 'unknown'})`);
      }
    }
  } catch (e: any) {
    errors.push(`balk pass read failed: ${e?.message?.slice(0, 80) || 'unknown'}`);
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: alerted + healed + balkAlerted,
    notes:
      `candidates=${candidates.length} targets=${targets.length} alerted=${alerted} ` +
      `self-healed=${healed} balked=${balkAlerted} errs=${errors.length}` +
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
