// app/api/cron/waiting-activation/route.ts
//
// Area A3 (2026-07-01): WAITING-buyer re-activation — the volume lever.
//
// ~2,000 signed-up buyers sit at `Buyer Stage = WAITING` in Consumers forever.
// Routing is PULL — only quiz-qualified buyers (score >= 75 via /api/qualify)
// ever reach matching — so WAITING demand never routes to ANY rancher. Daily,
// this cron invites the oldest WAITING buyers back to the EXISTING /access
// flow to finish qualification. It does NOT touch money-path, matching, or
// qualification logic — it only sends the invitation.
//
// ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
// Env `WAITING_ACTIVATION_ENABLED` must be EXACTLY the string 'true' or the
// cron returns { skipped: 'disabled' } before reading or writing ANYTHING
// (no Airtable reads, no Cron Runs row). The founder flips the env var in
// Vercel to fire it. Optional knobs:
//   WAITING_NUDGE_COOLDOWN_DAYS  — min days between nudges per buyer (default 14)
//   WAITING_NUDGE_MAX_PER_RUN    — batch cap per daily run (default 50)
//
// Selection lives in lib/waitingActivation (pure + unit-tested): Buyer
// Stage=WAITING, has Email, not Unsubscribed/Bounced/Complained, < 3 lifetime
// nudges, outside the cooldown, oldest signup first, capped per run.
//
// Dedupe stamps: `Waiting Nudge Last Sent At` + `Waiting Nudge Count` on
// Consumers, written CLAIM-BEFORE-SEND (same ordering as abandoned-quiz-nudge
// and deposit-accept-sla: a crash between stamp and send burns one touch; a
// double-send is worse). updateRecord already writes with typecast:true, but
// typecast does NOT create missing FIELDS — updateRecord silently strips
// unknown field names instead. So after the first stamp we VERIFY it
// persisted; if the fields don't exist yet the run aborts before any send
// (fail-loud, no dedupe = no sends). Founder must add both fields to
// Consumers: "Waiting Nudge Last Sent At" (date w/ time) + "Waiting Nudge
// Count" (number).
//
// Channels: email via lib/email sendWaitingActivationNudge (guardedSend →
// frequency cap + suppression list + CAN-SPAM footer). SMS only through
// sendSMSToConsumer (TCPA gate: SMS Opt-In === true AND not Unsubscribed)
// and only inside the buyer's local SMS window (isSmsWindow — quiet hours).
//
// Auth + logging: requireCron (fail-closed Bearer check) + withCronRun
// ('Cron Runs' row per run) — the repo's current cron conventions.

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendWaitingActivationNudge } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { isSmsWindow } from '@/lib/sendWindow';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { selectWaitingBuyersForNudge } from '@/lib/waitingActivation';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const DEFAULT_COOLDOWN_DAYS = 14;
const DEFAULT_MAX_PER_RUN = 50;

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

  const nowISO = new Date().toISOString();
  const cooldownDays = Number(process.env.WAITING_NUDGE_COOLDOWN_DAYS) || DEFAULT_COOLDOWN_DAYS;
  const batchCap = Number(process.env.WAITING_NUDGE_MAX_PER_RUN) || DEFAULT_MAX_PER_RUN;

  // Filtered read — Buyer Stage + Email + the suppression trio are all
  // long-standing Consumers fields, safe to reference in a formula. The
  // nudge-stamp fields are deliberately NOT in the formula: they may not
  // exist yet, and an unknown field name errors the whole Airtable query
  // (the deposit-accept-sla {Refunded At} lesson). Cooldown + lifetime cap
  // are enforced JS-side by the selector.
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.CONSUMERS,
      `AND({Buyer Stage}="WAITING", NOT({Email}=""), {Unsubscribed}!=1, {Bounced}!=1, {Complained}!=1)`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'error',
      recordsTouched: 0,
      notes: `consumers query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
    };
  }

  const selected = selectWaitingBuyersForNudge(candidates, { nowISO, cooldownDays, batchCap });

  let emailsSent = 0;
  let smsSent = 0;
  let smsDeferredWindow = 0;
  let emailSuppressed = 0;
  const errors: string[] = [];

  for (const c of selected) {
    try {
      const email = String(c['Email'] || '').trim().toLowerCase();
      const firstName = String(c['Full Name'] || '').split(' ')[0] || 'there';
      const state = String(c['State'] || '').trim();
      const priorCount = Number(c['Waiting Nudge Count']) || 0;

      // CLAIM BEFORE SEND — stamp the dedupe first so a crash after the send
      // can't double-nudge on the next daily run.
      const updated: any = await updateRecord(TABLES.CONSUMERS, c.id, {
        'Waiting Nudge Last Sent At': new Date().toISOString(),
        'Waiting Nudge Count': priorCount + 1,
      });

      // updateRecord strips unknown fields rather than failing — if the stamp
      // didn't persist, the schema is missing the fields and EVERY send this
      // run would be un-deduped. Abort before any (further) send.
      if (!updated || !updated['Waiting Nudge Last Sent At']) {
        return {
          status: 'error',
          recordsTouched: emailsSent,
          notes:
            `ABORT: nudge stamp did not persist for ${c.id} — add "Waiting Nudge Last Sent At" ` +
            `(date w/ time) + "Waiting Nudge Count" (number) to Consumers. ` +
            `selected=${selected.length} sentBeforeAbort=${emailsSent}`,
        };
      }

      // Email nudge — guardedSend inside handles frequency cap + the global
      // suppression list; a suppressed recipient returns success:false.
      const res = await sendWaitingActivationNudge({
        firstName,
        email,
        state: state || undefined,
        resumeUrl: `${SITE_URL}/access?resume=1&utm_source=email&utm_medium=drip&utm_campaign=waiting-activation`,
      });
      if (res.success) emailsSent++;
      else emailSuppressed++;

      // SMS — best-effort bonus channel. sendSMSToConsumer enforces the TCPA
      // gate (SMS Opt-In === true AND Unsubscribed !== true, phone present);
      // isSmsWindow enforces local quiet hours. Outside the window we simply
      // skip — the email already carried the message.
      if (isSmsWindow(state, Date.now())) {
        const smsUrl = `${SITE_URL}/access?resume=1`;
        const ok = await sendSMSToConsumer({
          consumer: c,
          body: `You started reserving a beef share — local ranchers have open slots. Finish in 2 min: ${smsUrl} Reply STOP to opt out.`,
          reason: 'waiting-activation nudge',
        });
        if (ok) smsSent++;
      } else {
        smsDeferredWindow++;
      }

      await new Promise((r) => setTimeout(r, 500)); // pace (Resend + Airtable)
    } catch (e: any) {
      errors.push(`${c.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  if (selected.length > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `waiting-activation: ${emailsSent} email nudge${emailsSent === 1 ? '' : 's'} sent`,
      detail:
        `WAITING pool: ${candidates.length} · selected: ${selected.length} · ` +
        `email sent: ${emailsSent} · email suppressed: ${emailSuppressed} · ` +
        `SMS sent: ${smsSent} · SMS held (quiet hours): ${smsDeferredWindow} · errors: ${errors.length}`,
      dedupeKey: 'waiting-activation-summary',
    }).catch(() => {});
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: emailsSent,
    notes:
      `pool=${candidates.length} selected=${selected.length} emailSent=${emailsSent} ` +
      `emailSuppressed=${emailSuppressed} sms=${smsSent} smsHeld=${smsDeferredWindow} ` +
      `cooldownDays=${cooldownDays} cap=${batchCap} errs=${errors.length}` +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
    skipReasonBreakdown: {
      ...(emailSuppressed ? { 'email-suppressed': emailSuppressed } : {}),
      ...(smsDeferredWindow ? { 'sms-quiet-hours': smsDeferredWindow } : {}),
    },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  // DARK-BY-DEFAULT GATE — before withCronRun so a disabled cron performs
  // ZERO reads/writes (not even a Cron Runs row). Flip WAITING_ACTIVATION_ENABLED
  // to exactly 'true' in Vercel env to go live.
  if (process.env.WAITING_ACTIVATION_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('waiting-activation', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
