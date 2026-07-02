// app/api/cron/replenishment/route.ts
//
// T2.3 (2026-07-02): the reorder nudge at the freezer-low moment. A share
// runs out on a schedule (quarter ~4mo, half ~6mo, whole ~10mo); this cron
// finds Closed Won deals whose share is running low and asks the buyer to
// reserve their next one. Repeat revenue on purpose instead of by accident.
//
// ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
// Env `REPLENISHMENT_ENABLED` (same three-state contract as
// WAITING_ACTIVATION_ENABLED):
//   unset/other → { skipped: 'disabled' } before ANY read (no Cron Runs row)
//   'dry-run'   → the exact live selection runs read-only; Telegram report
//                 of what WOULD send. NO sends, NO stamps.
//   'true'      → live sends.
// Optional knob: REPLENISH_MAX_PER_RUN (default 25).
//
// Selection is pure + unit-tested (lib/replenishment): Closed Won, Sale
// Amount > 0, cut-aware age window past close (quarter 120d / half 180d /
// whole 300d, +180d late cap so go-live doesn't blast years-stale buyers),
// never nudged ('Replenishment Nudged At' — ONE nudge per deal ever),
// oldest close first, capped per run. Buyer must be contactable (email +
// not Unsubscribed/Bounced/Complained).
//
// Dedupe stamp is written CLAIM-BEFORE-SEND (crash between stamp and send
// burns one touch; a double-send is worse) with a read-back verify — if the
// field doesn't persist the run aborts before any further send (typecast
// does NOT create missing fields; updateRecord silently strips instead).
// Field exists: 'Replenishment Nudged At' on Referrals (fld3nr0Y4uFpVau1a).
//
// Email only — no SMS on this touch (a reorder ask months after purchase is
// exactly the surface where SMS reads as spam).

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendReplenishmentNudge } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  isReplenishBuyerContactable,
  selectReplenishReferrals,
} from '@/lib/replenishment';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const DEFAULT_MAX_PER_RUN = 25;

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

  const dryRun = process.env.REPLENISHMENT_ENABLED === 'dry-run';
  const nowISO = new Date().toISOString();
  const batchCap = Number(process.env.REPLENISH_MAX_PER_RUN) || DEFAULT_MAX_PER_RUN;

  // Filtered read on long-standing fields only. 'Replenishment Nudged At' is
  // deliberately NOT in the formula (a missing field errors the whole query —
  // the deposit-accept-sla {Refunded At} lesson); the selector enforces it
  // JS-side, where a missing field simply reads as never-nudged.
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Status} = "Closed Won", {Sale Amount} > 0)`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'error',
      recordsTouched: 0,
      notes: `referrals query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
    };
  }

  const selected = selectReplenishReferrals(candidates, { nowISO, batchCap });

  if (dryRun) {
    const sample = selected.slice(0, 10).map((r) => {
      const closed = String(r['Closed At'] || '').slice(0, 10);
      return `${String(r['Order Type'] || '?')} closed ${closed}`;
    });
    const text = [
      'REPLENISHMENT — DRY RUN (no sends, no stamps)',
      `Closed Won pool: ${candidates.length}`,
      `Would nudge this run: ${selected.length} (cap ${batchCap}; buyer suppression still applies at send time)`,
      `Sample: ${sample.join(' · ') || '—'}`,
      'Flip REPLENISHMENT_ENABLED=true in Vercel to go live (one batch per day, one nudge per deal ever).',
    ].join('\n');
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `replenishment DRY RUN: would nudge ${selected.length} of ${candidates.length} Closed Won deals`,
      detail: text,
      dedupeKey: 'replenishment-dry-run',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `DRY RUN pool=${candidates.length} wouldNudge=${selected.length} cap=${batchCap} — no sends, no stamps`,
    };
  }

  let sent = 0;
  let buyerSkipped = 0;
  const errors: string[] = [];

  for (const ref of selected) {
    try {
      const buyerLinks: string[] = (ref['Buyer'] || []) as string[];
      const buyerId = buyerLinks[0] || '';
      const buyer: any = buyerId
        ? await getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null)
        : null;
      if (!isReplenishBuyerContactable(buyer)) {
        buyerSkipped++;
        continue;
      }

      // CLAIM BEFORE SEND + read-back verify (see header).
      const updated: any = await updateRecord(TABLES.REFERRALS, ref.id, {
        'Replenishment Nudged At': new Date().toISOString(),
      });
      if (!updated || !updated['Replenishment Nudged At']) {
        return {
          status: 'error',
          recordsTouched: sent,
          notes:
            `ABORT: nudge stamp did not persist for ${ref.id} — verify 'Replenishment Nudged At' ` +
            `(date w/ time) exists on Referrals. selected=${selected.length} sentBeforeAbort=${sent}`,
        };
      }

      // Ranch name for the "from <ranch>" line — via the Rancher link
      // (Referrals has no denormalized rancher-name field). Best-effort.
      let ranchName = 'your rancher';
      try {
        const rancherId = ((ref['Rancher'] || ref['Suggested Rancher'] || []) as string[])[0];
        if (rancherId) {
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
          ranchName = String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'your rancher');
        }
      } catch {}

      const firstName = String(buyer['Full Name'] || '').split(' ')[0] || 'there';
      const res = await sendReplenishmentNudge({
        firstName,
        email: String(buyer['Email']).trim().toLowerCase(),
        orderTypeLabel: String(ref['Order Type'] || ''),
        ranchName,
        reorderUrl: `${SITE_URL}/member?utm_source=email&utm_medium=drip&utm_campaign=replenishment`,
      });
      if (res.success) sent++;
      else buyerSkipped++;

      await new Promise((r) => setTimeout(r, 500)); // pace (Resend + Airtable)
    } catch (e: any) {
      errors.push(`${ref.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  if (selected.length > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `replenishment: ${sent} reorder nudge${sent === 1 ? '' : 's'} sent`,
      detail:
        `Closed Won pool: ${candidates.length} · selected: ${selected.length} · sent: ${sent} · ` +
        `buyer-skipped (suppressed/missing): ${buyerSkipped} · errors: ${errors.length}`,
      dedupeKey: 'replenishment-summary',
    }).catch(() => {});
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes:
      `pool=${candidates.length} selected=${selected.length} sent=${sent} ` +
      `buyerSkipped=${buyerSkipped} cap=${batchCap} errs=${errors.length}` +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
    skipReasonBreakdown: {
      ...(buyerSkipped ? { 'buyer-suppressed-or-missing': buyerSkipped } : {}),
    },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  // DARK-BY-DEFAULT GATE — before withCronRun so a disabled cron performs
  // ZERO reads/writes (not even a Cron Runs row).
  const mode = process.env.REPLENISHMENT_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('replenishment', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
