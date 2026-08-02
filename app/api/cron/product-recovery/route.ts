// app/api/cron/product-recovery/route.ts
//
// PHASE 3 — owned-side product remarketing runner. Talks to product BUYERS
// (Consumers stamped Buyer Stage='PRODUCT_BUYER' by settleProductPurchase) with
// two once-ever nudges: CROSS-SELL to a share (~10d after a buy) and REPEAT /
// reorder (~35d). Anonymous PDP/checkout abandoners are NOT handled here — they
// have no owned email, so they're retargeted on the Meta side via the Phase-2
// pixel events. Pure selection lives in lib/productRecovery (unit-tested).
//
// ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
// Env `PRODUCT_RECOVERY_ENABLED` (same 3-state contract as REPLENISHMENT_ENABLED):
//   unset/other → { skipped: 'disabled' } before ANY read (no Cron Runs row)
//   'dry-run'   → the exact live selection runs read-only; the would-send
//                 plan goes to logs + the Cron Runs note (Wave 1C: no
//                 Telegram while dark). NO sends, NO stamps.
//   'true'      → live sends.
// Optional knob: PRODUCT_RECOVERY_MAX_PER_RUN (default 25).
//
// Idempotency: the stamp is written CLAIM-BEFORE-SEND with a read-back verify —
// if the field doesn't persist (Ben hasn't created it yet, or typecast stripped
// it) the run ABORTS before any further send. One nudge per stamp, ever.
//
// BEN — Airtable Consumers fields required to activate: 'Last Product Bought',
// 'Last Product Bought At', 'Product Buyer Rancher', 'Product Repeat Nudged At'
// (date+time), 'Share Cross-Sell Sent At' (date+time), and a 'PRODUCT_BUYER'
// option on the Buyer Stage single-select.

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  nextProductNudge,
  renderCrossSellEmail,
  renderRepeatEmail,
  PRODUCT_BUYER_STAGE,
  PRODUCT_REPEAT_FIELD,
  PRODUCT_CROSSSELL_FIELD,
  REPEAT_TEMPLATE,
  CROSSSELL_TEMPLATE,
  type ProductBuyerLike,
} from '@/lib/productRecovery';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const DEFAULT_MAX_PER_RUN = 25;

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

function firstNameOf(c: ProductBuyerLike): string {
  return String(c['Full Name'] || '').trim().split(/\s+/)[0] || 'there';
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const dryRun = process.env.PRODUCT_RECOVERY_ENABLED === 'dry-run';
  const batchCap = Number(process.env.PRODUCT_RECOVERY_MAX_PER_RUN) || DEFAULT_MAX_PER_RUN;

  // Filtered read on the stage only. The stamp fields are deliberately NOT in
  // the formula (a missing field errors the whole query — the {Refunded At}
  // lesson); the selector enforces them JS-side, where a missing field simply
  // reads as never-nudged.
  let buyers: any[] = [];
  try {
    buyers = (await getAllRecords(
      TABLES.CONSUMERS,
      `{Buyer Stage} = "${PRODUCT_BUYER_STAGE}"`,
    )) as any[];
  } catch (e: any) {
    return { status: 'error', recordsTouched: 0, notes: `consumers query failed: ${e?.message?.slice(0, 160) || 'unknown'}` };
  }

  // Decide the single next nudge per buyer, cap the run.
  const planned: { c: any; nudge: 'crosssell' | 'repeat' }[] = [];
  for (const c of buyers) {
    const nudge = nextProductNudge(c);
    if (nudge) planned.push({ c, nudge });
    if (planned.length >= batchCap) break;
  }

  if (dryRun) {
    const crossN = planned.filter((p) => p.nudge === 'crosssell').length;
    const repeatN = planned.filter((p) => p.nudge === 'repeat').length;
    // Wave 1C: env-dark plan → log + Cron Runs note only; no Telegram for a
    // rail that's off. Failures page via withCronRun's error/partial alert.
    console.info(
      `[product-recovery] DRY RUN — would nudge ${planned.length} of ${buyers.length} product buyers ` +
        `(cap ${batchCap}; cross-sell ${crossN}, repeat ${repeatN}) — flip PRODUCT_RECOVERY_ENABLED=true to go live`,
    );
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `DRY RUN pool=${buyers.length} would=${planned.length} (cross=${crossN} repeat=${repeatN}) cap=${batchCap} — no sends`,
    };
  }

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const { c, nudge } of planned) {
    try {
      const email = String(c['Email'] || '').trim().toLowerCase();
      if (!email) { skipped++; continue; }

      const stampField = nudge === 'crosssell' ? PRODUCT_CROSSSELL_FIELD : PRODUCT_REPEAT_FIELD;

      // CLAIM BEFORE SEND + read-back verify. A crash between stamp and send
      // burns one touch; a double-send is worse. If the stamp field doesn't
      // persist (missing on the table), ABORT before any further send.
      const updated: any = await updateRecord(TABLES.CONSUMERS, c.id, {
        [stampField]: new Date().toISOString(),
      });
      if (!updated || !updated[stampField]) {
        return {
          status: 'error',
          recordsTouched: sent,
          notes: `ABORT: stamp '${stampField}' did not persist for ${c.id} — verify it exists (date+time) on Consumers. sentBeforeAbort=${sent}`,
        };
      }

      const ctx = {
        firstName: firstNameOf(c),
        product: String(c['Last Product Bought'] || 'your order'),
        rancher: String(c['Product Buyer Rancher'] || 'the ranch'),
        url:
          nudge === 'crosssell'
            ? `${SITE_URL}/map?utm_source=email&utm_medium=drip&utm_campaign=product-crosssell`
            : `${SITE_URL}/shop?utm_source=email&utm_medium=drip&utm_campaign=product-repeat`,
      };
      const rendered = nudge === 'crosssell' ? renderCrossSellEmail(ctx) : renderRepeatEmail(ctx);

      const res = await sendEmail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        templateName: nudge === 'crosssell' ? CROSSSELL_TEMPLATE : REPEAT_TEMPLATE,
      });
      if (res?.success) sent++;
      else skipped++;

      await new Promise((r) => setTimeout(r, 500)); // pace (Resend + Airtable)
    } catch (e: any) {
      errors.push(`${c.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  if (planned.length > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `product-recovery: ${sent} nudge${sent === 1 ? '' : 's'} sent`,
      detail: `pool: ${buyers.length} · planned: ${planned.length} · sent: ${sent} · skipped: ${skipped} · errors: ${errors.length}`,
      dedupeKey: 'product-recovery-summary',
    }).catch(() => {});
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes: `pool=${buyers.length} planned=${planned.length} sent=${sent} skipped=${skipped} cap=${batchCap} errs=${errors.length}` + (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
    skipReasonBreakdown: { ...(skipped ? { 'send-skipped-or-suppressed': skipped } : {}) },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  // DARK-BY-DEFAULT GATE — before withCronRun so a disabled cron performs ZERO
  // reads/writes (not even a Cron Runs row).
  const mode = process.env.PRODUCT_RECOVERY_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('product-recovery', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
