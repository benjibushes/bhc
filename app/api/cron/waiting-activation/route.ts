// app/api/cron/waiting-activation/route.ts
//
// Area A3 (2026-07-01): WAITING-buyer re-activation — the volume lever.
//
// ~2,000 signed-up buyers sit at `Buyer Stage = WAITING` in Consumers forever.
// Routing is PULL — only quiz-qualified buyers (score >= 75 via /api/qualify)
// ever reach matching — so WAITING demand never routes to ANY rancher. Daily,
// this cron invites the oldest WAITING buyers back to finish qualification.
// It does NOT touch money-path, matching, or qualification logic — it only
// sends the invitation.
//
// STAGE 2 — READY chase (2026-07-22 audit): READY + never-matched buyers hit
// terminal silence (no email at no-match, nurture ends day ~21, nothing ever
// after). A second selector (lib/waitingActivation selectReadyBuyersForChase)
// chases funnel-completers at READY with no live referral, in-supply, after
// nurture ends — same claim-before-send machinery, its own stamp pair + cap.
//
// ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
// Env `WAITING_ACTIVATION_ENABLED`: unset/other → the cron returns
// { skipped: 'disabled' } before reading or writing ANYTHING (no Airtable
// reads, no Cron Runs row). 'dry-run' → the exact live selection runs
// read-only and the would-send plan goes to logs + the Cron Runs note
// (Wave 1C: no Telegram while dark; no sends, no stamps — plus a
// stamp-SCHEMA probe, see below) — the founder eyeballs the note before
// going live. 'true' → live.
// Optional knobs (all honor an explicit 0 — parseNudgeKnob):
//   WAITING_NUDGE_COOLDOWN_DAYS  — min days between nudges per buyer (default 14)
//   WAITING_NUDGE_MAX_PER_RUN    — WAITING batch cap per daily run (default 50)
//   READY_CHASE_MAX_PER_RUN      — READY-chase batch cap per daily run (default 25)
//
// Selection lives in lib/waitingActivation (pure + unit-tested): Buyer
// Stage=WAITING, has Email, not Unsubscribed/Bounced/Complained, no Funnel
// Completed At (held completers stay in nurture), < 3 lifetime nudges,
// outside the cooldown, oldest signup first, capped per run.
//
// Dedupe stamps: `Waiting Nudge Last Sent At` + `Waiting Nudge Count` on
// Consumers (READY chase: `Ready Nudge Last Sent At` + `Ready Nudge Count`),
// written CLAIM-BEFORE-SEND (same ordering as abandoned-quiz-nudge and
// deposit-accept-sla: a crash between stamp and send burns one touch; a
// double-send is worse). updateRecord already writes with typecast:true, but
// typecast does NOT create missing FIELDS — updateRecord silently strips
// unknown field names instead. So after the first stamp we VERIFY BOTH fields
// persisted; if either doesn't exist yet the stage aborts before any send
// (fail-loud, no dedupe = no sends). Founder must add the fields to
// Consumers: "Waiting Nudge Last Sent At" (date w/ time) + "Waiting Nudge
// Count" (number) — and for the READY chase, "Ready Nudge Last Sent At"
// (date w/ time) + "Ready Nudge Count" (number).
//
// Send truth (2026-07-22 audit): the frequency guard is PRE-FLIGHTED before
// stamping (a suppressed buyer keeps their lifetime touch + stays eligible),
// hard Resend failures count as errors (status 'partial' → Telegram alert)
// and refund the touch, and 3 consecutive hard failures abort the run
// (Resend-down circuit breaker). SMS fires only when the email actually went
// out. A per-run Redis lock (claimOnce, TTL = maxDuration) stops an
// overlapping manual curl + schedule from double-sending the same batch.
//
// Channels: email via lib/email sendWaitingActivationNudge /
// sendReadyChaseNudge (guardedSend → suppression list + CAN-SPAM footer;
// both templates are TRANSACTIONAL_WHITELISTed — the DB-state throttle here
// is stronger than the generic 3/week cap). SMS only through
// sendSMSToConsumer (TCPA gate: SMS Opt-In === true AND not Unsubscribed)
// and only inside the buyer's local SMS window (isSmsWindow — quiet hours).
//
// Auth + logging: requireCron (fail-closed Bearer check) + withCronRun
// ('Cron Runs' row per run) — the repo's current cron conventions.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendWaitingActivationNudge, sendReadyChaseNudge } from '@/lib/email';
import { checkFrequencyCap } from '@/lib/emailFrequencyGuard';
import { sendSMSToConsumer } from '@/lib/twilio';
import { smsEnabled } from '@/lib/smsFlag';
import { isSmsWindow } from '@/lib/sendWindow';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { claimOnce } from '@/lib/rancherCapacity';
import { JWT_SECRET } from '@/lib/secrets';
import { normalizeState } from '@/lib/states';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { activeDealReferralsFormula } from '@/lib/cronReadFilters';
import { isActiveDealReferral } from '@/lib/capacityCount';
import {
  buildWaitingDryRunReport,
  formatWaitingDryRunReport,
  parseNudgeKnob,
  selectReadyBuyersForChase,
  selectWaitingBuyersForNudge,
} from '@/lib/waitingActivation';

// 2026-07-22 audit: 120 was BELOW worst-case runtime at the default 50-batch
// (~2s/buyer of serial Airtable+Resend round-trips + pool scans) — a mid-loop
// kill lost the Cron Runs row and every alert. 300 matches nurture-drip; the
// in-loop RUN_BUDGET_MS below stops cleanly long before either limit.
export const maxDuration = 300;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const DEFAULT_COOLDOWN_DAYS = 14;
const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_READY_CHASE_PER_RUN = 25;
// Stop selecting new sends after this much elapsed time and return 'partial'
// with a truncation note — an Airtable 429 backoff burst must degrade to a
// smaller batch, never to a killed function with no Cron Runs row.
const RUN_BUDGET_MS = 80_000;
// Circuit breaker: N consecutive hard send failures = Resend is down; stop
// burning the batch and alert instead.
const MAX_CONSECUTIVE_SEND_FAILURES = 3;

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

// DRY-RUN SCHEMA PROBE (2026-07-22 audit): dry-run stamps nothing, so the one
// condition that hard-aborts the live path — the stamp fields not existing on
// Consumers — was unobservable until flip day. Probe by writing the stamp pair
// to ONE record: same values when present (no-op), and when the stamp is blank
// an epoch timestamp that is immediately reverted (epoch is always outside any
// cooldown window, so even a failed revert can never block the buyer). If the
// write doesn't echo both fields back, updateRecord stripped them = MISSING.
async function probeStampSchema(
  record: any,
  stampField: string,
  countField: string,
): Promise<string> {
  if (!record) return 'not probed (empty pool)';
  const priorStamp = String(record[stampField] || '').trim();
  const priorCount = Number(record[countField]) || 0;
  try {
    const echoed: any = await updateRecord(TABLES.CONSUMERS, record.id, {
      [stampField]: priorStamp || new Date(0).toISOString(),
      [countField]: priorCount,
    });
    const ok = !!echoed && echoed[stampField] !== undefined && echoed[countField] !== undefined;
    if (!priorStamp) {
      await updateRecord(TABLES.CONSUMERS, record.id, { [stampField]: null }).catch(() => {});
    }
    return ok
      ? 'OK'
      : `MISSING — add "${stampField}" (date w/ time) + "${countField}" (number) to Consumers before go-live`;
  } catch (e: any) {
    return `probe-failed: ${e?.message?.slice(0, 80) || 'unknown'}`;
  }
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const runStart = Date.now();

  // T2.1 (2026-07-02): 'dry-run' runs the EXACT live selection but sends
  // nothing and stamps nothing — it only reports what WOULD go out, so the
  // founder can eyeball the batch before flipping the env to 'true'. All
  // buyer sends stay founder-gated; this report is the gate's evidence.
  const dryRun = process.env.WAITING_ACTIVATION_ENABLED === 'dry-run';

  // RUN LOCK (2026-07-22 audit): a live run takes minutes and selection is
  // deterministic, so an overlapping invocation (manual curl with CRON_SECRET
  // while the schedule fires — both GET and POST are exported) would read the
  // same candidate pool before either writes a stamp and double-send the
  // identical batch. claimOnce = Redis SET NX EX; TTL = maxDuration so a
  // crashed run self-clears. Fails OPEN on missing/erroring Redis (the
  // per-record claim stamp still bounds the damage to the overlap window).
  if (!dryRun) {
    const lockWon = await claimOnce('waiting-activation-live', maxDuration);
    if (!lockWon) {
      return {
        status: 'success',
        recordsTouched: 0,
        notes: 'run lock held by another live invocation — skipped (overlap guard)',
      };
    }
  }

  const nowISO = new Date().toISOString();
  // parseNudgeKnob (2026-07-22 audit): `Number(env) || DEFAULT` silently
  // turned an explicit 0 ("pause sends, keep the flag") into the default.
  const cooldownDays = parseNudgeKnob(process.env.WAITING_NUDGE_COOLDOWN_DAYS, DEFAULT_COOLDOWN_DAYS);
  const batchCap = parseNudgeKnob(process.env.WAITING_NUDGE_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const readyBatchCap = parseNudgeKnob(process.env.READY_CHASE_MAX_PER_RUN, DEFAULT_READY_CHASE_PER_RUN);

  // Filtered read — Buyer Stage + Email + the suppression trio + Funnel
  // Completed At are all long-standing Consumers fields, safe to reference in
  // a formula. The nudge-stamp fields are deliberately NOT in the formula:
  // they may not exist yet, and an unknown field name errors the whole
  // Airtable query (the deposit-accept-sla {Refunded At} lesson). Cooldown +
  // lifetime cap are enforced JS-side by the selector.
  // {Funnel Completed At}="" (2026-07-22): held not-ready completers finished
  // the funnel — "you never finished the last step" is a false claim for
  // them; they stay in the nurture-drip lane (founder rule, mirrors
  // abandoned-quiz-nudge's 2026-07-15 clause).
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.CONSUMERS,
      `AND({Buyer Stage}="WAITING", NOT({Email}=""), {Funnel Completed At}="", {Unsubscribed}!=1, {Bounced}!=1, {Complained}!=1)`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'error',
      recordsTouched: 0,
      notes: `consumers query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
    };
  }

  // SUPPLY GATE (founder rule 2026-07-16): compute the served-state set from
  // live rancher data every run — never a hardcoded list, so the gate widens
  // by itself the moment a new rancher goes operational. Only buyers in these
  // states get the "finish /qualify" nudge; the rest stay in nurture-drip.
  // A ranchers-read failure FAILS CLOSED (no sends) — a transient Airtable
  // blip must never turn the gate off and blast the unserved-state backlog.
  // Same pass also maps state → an operational rancher's Slug for the READY
  // chase CTA (the in-state rancher page, /map fallback).
  let supplyStates: Set<string>;
  const rancherSlugByState = new Map<string, string>();
  try {
    const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
    supplyStates = new Set<string>();
    for (const r of ranchers) {
      if (!isRancherOperationalForBuyers(r)) continue;
      const slug = String(r['Slug'] || '').trim();
      for (const s of getOperationalServedStates(r)) {
        supplyStates.add(s);
        if (slug && !rancherSlugByState.has(s)) rancherSlugByState.set(s, slug);
      }
    }
  } catch (e: any) {
    return {
      status: 'error',
      recordsTouched: 0,
      notes: `ranchers query failed (supply gate fails closed, no sends): ${e?.message?.slice(0, 200) || 'unknown'}`,
    };
  }
  if (supplyStates.size === 0) {
    return {
      status: 'error',
      recordsTouched: 0,
      notes: 'supply gate: ZERO operational served states — refusing to select (data problem, not a valid empty market)',
    };
  }

  const selected = selectWaitingBuyersForNudge(candidates, { nowISO, cooldownDays, batchCap, supplyStates });

  // READY-chase pool (stage 2): READY funnel-completers with no live referral.
  // A reads failure fails closed for THIS stage only — the WAITING stage
  // still runs (and vice-versa: a WAITING abort is a schema abort that stops
  // everything, which is correct — same table, same founder action).
  let readyCandidates: any[] | null = null;
  const activeBuyerIds = new Set<string>();
  try {
    const [readyRows, refRows] = await Promise.all([
      getAllRecords(
        TABLES.CONSUMERS,
        `AND({Buyer Stage}="READY", NOT({Email}=""), {Unsubscribed}!=1, {Bounced}!=1, {Complained}!=1)`,
      ) as Promise<any[]>,
      getAllRecords(TABLES.REFERRALS, activeDealReferralsFormula()) as Promise<any[]>,
    ]);
    readyCandidates = readyRows;
    for (const ref of refRows) {
      if (!isActiveDealReferral(ref)) continue;
      const buyerLinks: string[] = ref['Buyer'] || [];
      for (const id of buyerLinks) activeBuyerIds.add(id);
    }
  } catch (e: any) {
    console.error('[waiting-activation] READY-chase reads failed (stage skipped):', e?.message);
  }
  const selectedReady = readyCandidates === null
    ? []
    : selectReadyBuyersForChase(readyCandidates, {
        nowISO,
        cooldownDays,
        batchCap: readyBatchCap,
        supplyStates,
        activeBuyerIds,
      });

  if (dryRun) {
    const report = buildWaitingDryRunReport(candidates, selected, { nowISO, cooldownDays, supplyStates });
    const text = formatWaitingDryRunReport(report, { cooldownDays, batchCap });
    // Schema probes — dry-run's job is to prove the LIVE path would work.
    const waitingSchema = await probeStampSchema(
      selected[0] || candidates[0],
      'Waiting Nudge Last Sent At',
      'Waiting Nudge Count',
    );
    const readySchema = await probeStampSchema(
      selectedReady[0] || (readyCandidates || [])[0],
      'Ready Nudge Last Sent At',
      'Ready Nudge Count',
    );
    const readyLine = readyCandidates === null
      ? 'READY chase: reads FAILED — stage would be skipped this run'
      : `READY chase: would nudge ${selectedReady.length} of ${readyCandidates.length} READY buyers (post-nurture, no live referral, cap ${readyBatchCap})`;
    const schemaLine = `Stamp schema — WAITING: ${waitingSchema} · READY: ${readySchema}`;
    // Wave 1C: while the rail is env-dark, the daily would-send plan goes to
    // logs + the Cron Runs note only (the notes below carry every count +
    // both schema probes) — no realtime Telegram for work that will never
    // execute. Failures still page via withCronRun's error/partial alert.
    console.info(
      `[waiting-activation] DRY RUN: would nudge ${report.selectedCount} of ${report.poolSize} WAITING buyers\n` +
        `${text}\n${readyLine}\n${schemaLine}`,
    );
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        `DRY RUN pool=${report.poolSize} wouldNudge=${report.selectedCount} ` +
        `readyPool=${readyCandidates === null ? 'READ-FAILED' : readyCandidates.length} readyWouldNudge=${selectedReady.length} ` +
        `supplyStates=${supplyStates.size} heldNoSupply=${report.droppedNoSupply} ` +
        `smsEligible=${report.smsEligibleCount} cooldownDays=${cooldownDays} cap=${batchCap} readyCap=${readyBatchCap} ` +
        `oldest=${report.oldestSignupDays ?? '—'}d ` +
        `stampSchemaWaiting=${waitingSchema.split(' ')[0]} stampSchemaReady=${readySchema.split(' ')[0]} — no sends, no stamps`,
    };
  }

  let emailsSent = 0;
  let smsSent = 0;
  let smsDeferredWindow = 0;
  let emailSuppressed = 0;
  let emailFailed = 0;
  let readySent = 0;
  let readySuppressed = 0;
  let readyFailed = 0;
  let truncated = false;
  const errors: string[] = [];
  let consecutiveFailures = 0;

  for (const c of selected) {
    if (Date.now() - runStart > RUN_BUDGET_MS) {
      truncated = true;
      break;
    }
    try {
      const email = String(c['Email'] || '').trim().toLowerCase();
      const firstName = String(c['Full Name'] || '').split(' ')[0] || 'there';
      const state = String(c['State'] || '').trim();
      const priorCount = Number(c['Waiting Nudge Count']) || 0;

      // PRE-FLIGHT the frequency guard BEFORE stamping (2026-07-22 audit): a
      // suppressed buyer must NOT burn one of their 3 lifetime touches — they
      // stay eligible for the next run instead.
      const gate = await checkFrequencyCap(email, 'sendWaitingActivationNudge');
      if (!gate.ok) {
        emailSuppressed++;
        continue;
      }

      // CLAIM BEFORE SEND — stamp the dedupe first so a crash after the send
      // can't double-nudge on the next daily run.
      const updated: any = await updateRecord(TABLES.CONSUMERS, c.id, {
        'Waiting Nudge Last Sent At': new Date().toISOString(),
        'Waiting Nudge Count': priorCount + 1,
      });

      // updateRecord strips unknown fields rather than failing — if EITHER
      // stamp didn't persist, the schema is incomplete and EVERY send this
      // run would be un-deduped (a missing Count alone silently voids the
      // 3-nudge lifetime cap forever). Abort before any (further) send.
      if (!updated || !updated['Waiting Nudge Last Sent At'] || Number(updated['Waiting Nudge Count']) !== priorCount + 1) {
        return {
          status: 'error',
          recordsTouched: emailsSent,
          notes:
            `ABORT: nudge stamp did not persist for ${c.id} — add BOTH "Waiting Nudge Last Sent At" ` +
            `(date w/ time) + "Waiting Nudge Count" (number) to Consumers. ` +
            `selected=${selected.length} sentBeforeAbort=${emailsSent}`,
        };
      }

      // Resume link (2026-07-22 audit): /access?resume=1 was fake — /access
      // ignores the param and restarts the funnel at step 1. Buyers with
      // funnel progress (Order Type / Timing captured) get the REAL resume
      // rail: /qualify/<consumerId>?token= with a fresh qualify-access JWT
      // (30d ≥ the 14d cadence, the durable-link lesson — same mint as
      // /api/qualify/resend-link). Legacy waitlist-only signups fall back to
      // /access?state= prefill.
      const hasFunnelProgress = !!(String(c['Order Type'] || '').trim() || String(c['Timing'] || '').trim());
      const stateCode = normalizeState(state);
      const UTM = 'utm_source=email&utm_medium=drip&utm_campaign=waiting-activation';
      let resumeUrl: string;
      if (hasFunnelProgress) {
        const token = jwt.sign(
          { type: 'qualify-access', consumerId: c.id, email },
          JWT_SECRET,
          { expiresIn: '30d' },
        );
        resumeUrl = `${SITE_URL}/qualify/${encodeURIComponent(c.id)}?token=${encodeURIComponent(token)}&${UTM}`;
      } else {
        resumeUrl = `${SITE_URL}/access?${stateCode ? `state=${stateCode}&` : ''}${UTM}`;
      }

      // Email nudge — guardedSend inside handles the suppression list; a
      // suppressed recipient returns success:false + suppressed:true, a hard
      // Resend failure returns success:false + suppressed:false.
      const res = await sendWaitingActivationNudge({
        firstName,
        email,
        state: state || undefined,
        resumeUrl,
      });
      if (res.success) {
        emailsSent++;
        consecutiveFailures = 0;
      } else if (res.suppressed) {
        // Nothing went out — refund the lifetime touch (Last Sent At stays,
        // so a suppressed recipient isn't re-tried daily).
        emailSuppressed++;
        await updateRecord(TABLES.CONSUMERS, c.id, { 'Waiting Nudge Count': priorCount }).catch(() => {});
      } else {
        // HARD failure (dead Resend key, API error) — this is an ERROR, not a
        // suppression: surface it (status 'partial' → Telegram) and refund
        // the touch so an outage can't silently exhaust the lifetime budget.
        emailFailed++;
        errors.push(`${c.id}: email FAILED${res.reason ? ` (${String(res.reason).slice(0, 60)})` : ''}`);
        await updateRecord(TABLES.CONSUMERS, c.id, { 'Waiting Nudge Count': priorCount }).catch(() => {});
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
          errors.push(`ABORT: ${consecutiveFailures} consecutive send failures — Resend likely down, stopping the batch`);
          break;
        }
      }

      // SMS — best-effort bonus channel, only when the email actually went
      // out (2026-07-22: a failed primary must not still fire the bonus).
      // W4 (2026-07-01): gated on the platform-wide ENABLE_SMS flag via the
      // shared smsEnabled(). Inside the flag: sendSMSToConsumer enforces the
      // TCPA gate (SMS Opt-In === true AND Unsubscribed !== true, phone
      // present); isSmsWindow enforces local quiet hours. Outside the window
      // we simply skip — the email already carried the message.
      if (res.success && smsEnabled()) {
        if (isSmsWindow(state, Date.now())) {
          // Short honest URL for SMS (a JWT link is ~200 chars): the /access
          // funnel with the buyer's state prefilled.
          const smsUrl = `${SITE_URL}/access${stateCode ? `?state=${stateCode}` : ''}`;
          const ok = await sendSMSToConsumer({
            consumer: c,
            body: `You started reserving a beef share — local ranchers have open slots. Finish in 2 min: ${smsUrl} Reply STOP to opt out.`,
            reason: 'waiting-activation nudge',
          });
          if (ok) smsSent++;
        } else {
          smsDeferredWindow++;
        }
      }

      await new Promise((r) => setTimeout(r, 500)); // pace (Resend + Airtable)
    } catch (e: any) {
      errors.push(`${c.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        errors.push(`ABORT: ${consecutiveFailures} consecutive send failures — stopping the batch`);
        break;
      }
    }
  }

  // ── STAGE 2: READY chase — same claim-before-send machinery, its own
  // stamp pair + template. A stamp-persist failure aborts THIS stage only
  // (the WAITING stamps already proved out above).
  consecutiveFailures = 0;
  for (const c of selectedReady) {
    if (Date.now() - runStart > RUN_BUDGET_MS) {
      truncated = true;
      break;
    }
    try {
      const email = String(c['Email'] || '').trim().toLowerCase();
      const firstName = String(c['Full Name'] || '').split(' ')[0] || 'there';
      const state = String(c['State'] || '').trim();
      const priorCount = Number(c['Ready Nudge Count']) || 0;

      const gate = await checkFrequencyCap(email, 'sendReadyChaseNudge');
      if (!gate.ok) {
        readySuppressed++;
        continue;
      }

      const updated: any = await updateRecord(TABLES.CONSUMERS, c.id, {
        'Ready Nudge Last Sent At': new Date().toISOString(),
        'Ready Nudge Count': priorCount + 1,
      });
      if (!updated || !updated['Ready Nudge Last Sent At'] || Number(updated['Ready Nudge Count']) !== priorCount + 1) {
        errors.push(
          `READY chase ABORTED: stamp did not persist for ${c.id} — add BOTH "Ready Nudge Last Sent At" ` +
          `(date w/ time) + "Ready Nudge Count" (number) to Consumers. readySelected=${selectedReady.length} readySentBeforeAbort=${readySent}`,
        );
        break;
      }

      // CTA: the in-state operational rancher's page ("a slot opened"), /map
      // fallback — never /access (they already finished the funnel).
      const stateCode = normalizeState(state);
      const slug = stateCode ? rancherSlugByState.get(stateCode) : undefined;
      const READY_UTM = 'utm_source=email&utm_medium=drip&utm_campaign=ready-chase';
      const rancherUrl = slug
        ? `${SITE_URL}/ranchers/${encodeURIComponent(slug)}?${READY_UTM}`
        : `${SITE_URL}/map?${READY_UTM}`;

      const res = await sendReadyChaseNudge({
        firstName,
        email,
        state: state || undefined,
        rancherUrl,
      });
      if (res.success) {
        readySent++;
        consecutiveFailures = 0;
      } else if (res.suppressed) {
        readySuppressed++;
        await updateRecord(TABLES.CONSUMERS, c.id, { 'Ready Nudge Count': priorCount }).catch(() => {});
      } else {
        readyFailed++;
        errors.push(`${c.id}: ready-chase email FAILED${res.reason ? ` (${String(res.reason).slice(0, 60)})` : ''}`);
        await updateRecord(TABLES.CONSUMERS, c.id, { 'Ready Nudge Count': priorCount }).catch(() => {});
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
          errors.push(`ABORT: ${consecutiveFailures} consecutive ready-chase send failures — stopping the batch`);
          break;
        }
      }

      await new Promise((r) => setTimeout(r, 500)); // pace (Resend + Airtable)
    } catch (e: any) {
      errors.push(`${c.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        errors.push(`ABORT: ${consecutiveFailures} consecutive ready-chase failures — stopping the batch`);
        break;
      }
    }
  }

  if (selected.length > 0 || selectedReady.length > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `waiting-activation: ${emailsSent} email nudge${emailsSent === 1 ? '' : 's'} sent, ${readySent} READY chase${readySent === 1 ? '' : 's'}`,
      detail:
        `WAITING pool: ${candidates.length} · selected: ${selected.length} · ` +
        `email sent: ${emailsSent} · email suppressed: ${emailSuppressed} · email failed: ${emailFailed} · ` +
        `SMS sent: ${smsSent} · SMS held (quiet hours): ${smsDeferredWindow} · ` +
        `READY selected: ${selectedReady.length} · ready sent: ${readySent} · ready suppressed: ${readySuppressed} · ready failed: ${readyFailed} · ` +
        `errors: ${errors.length}${truncated ? ' · TRUNCATED (time budget)' : ''}`,
      dedupeKey: 'waiting-activation-summary',
    }).catch(() => {});
  }

  return {
    status: errors.length || truncated ? 'partial' : 'success',
    recordsTouched: emailsSent + readySent,
    notes:
      `pool=${candidates.length} selected=${selected.length} supplyStates=${supplyStates.size} ` +
      `emailSent=${emailsSent} emailSuppressed=${emailSuppressed} emailFailed=${emailFailed} sms=${smsSent} smsHeld=${smsDeferredWindow} ` +
      `readyPool=${readyCandidates === null ? 'READ-FAILED' : readyCandidates.length} readySelected=${selectedReady.length} readySent=${readySent} readySuppressed=${readySuppressed} readyFailed=${readyFailed} ` +
      `cooldownDays=${cooldownDays} cap=${batchCap} readyCap=${readyBatchCap} errs=${errors.length}` +
      (truncated ? ` TRUNCATED at ${Math.round((Date.now() - runStart) / 1000)}s (time budget ${RUN_BUDGET_MS / 1000}s)` : '') +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
    skipReasonBreakdown: {
      ...(emailSuppressed ? { 'email-suppressed': emailSuppressed } : {}),
      ...(emailFailed ? { 'email-failed': emailFailed } : {}),
      ...(smsDeferredWindow ? { 'sms-quiet-hours': smsDeferredWindow } : {}),
      ...(readySuppressed ? { 'ready-suppressed': readySuppressed } : {}),
      ...(readyFailed ? { 'ready-failed': readyFailed } : {}),
      ...(truncated ? { 'time-budget-truncated': 1 } : {}),
    },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  // DARK-BY-DEFAULT GATE — before withCronRun so a disabled cron performs
  // ZERO reads/writes (not even a Cron Runs row). WAITING_ACTIVATION_ENABLED:
  //   unset / anything else → dark (this skip)
  //   'dry-run'             → selection runs read-only; plan goes to logs +
  //                           Cron Runs note (no Telegram while dark),
  //                           NO sends, NO stamps (founder eyeballs the note)
  //   'true'                → live sends
  const mode = process.env.WAITING_ACTIVATION_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('waiting-activation', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
