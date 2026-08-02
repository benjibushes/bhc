// app/api/cron/product-review-ask/route.ts
//
// PRODUCT review-ask (the trust flywheel, money-map #2). 3-45 days after a
// marketplace order ships, ask the buyer for one rating + one sentence via
// the SAME tokened /reviews/submit rail the share side uses (token carries
// orderId instead of referralId). Reviews land on the PDP + aggregateRating
// JSON-LD — the conversion multiplier for every cold ad click.
//
// ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
// Env `PRODUCT_REVIEW_ASK_ENABLED` (fleet 3-state contract):
//   unset/other → { skipped: 'disabled' } before ANY read (no Cron Runs row)
//   'dry-run'   → live selection read-only; plan goes to logs + Cron Runs
//                 note (Wave 1C: no Telegram while dark), no sends/stamps
//   'true'      → live sends, capped per run
//
// Idempotency: CLAIM-BEFORE-SEND on 'Review Asked At' with read-back abort
// (the product-recovery pattern) — one ask per order, ever. The submit rail
// has its own idempotency (409 after first submission).

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const DEFAULT_MAX_PER_RUN = 25;
const MIN_DAYS = 3; // let the box actually arrive + get eaten a little
const MAX_DAYS = 45; // past this the memory's cold — don't nag

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }
  const dryRun = process.env.PRODUCT_REVIEW_ASK_ENABLED === 'dry-run';
  const cap = Number(process.env.PRODUCT_REVIEW_ASK_MAX_PER_RUN) || DEFAULT_MAX_PER_RUN;

  // Formula keeps to long-standing fields (Status / Shipped At / Buyer Email);
  // the maybe-new stamp fields are checked JS-side (the {Refunded At} lesson).
  let orders: any[] = [];
  try {
    orders = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `AND({Status}="Shipped", NOT({Buyer Email}=""), NOT({Shipped At}=""))`,
    )) as any[];
  } catch (e: any) {
    return { status: 'error', recordsTouched: 0, notes: `orders query failed: ${e?.message?.slice(0, 160) || 'unknown'}` };
  }

  const now = Date.now();
  const eligible = orders.filter((o) => {
    if (o['Review Asked At'] || o['Review Submitted At']) return false;
    const shipped = Date.parse(String(o['Shipped At'] || ''));
    if (!Number.isFinite(shipped)) return false;
    const days = (now - shipped) / 86_400_000;
    return days >= MIN_DAYS && days <= MAX_DAYS;
  });
  const batch = eligible.slice(0, cap);

  if (dryRun) {
    // Wave 1C: env-dark plan → log + Cron Runs note only; no Telegram for a
    // rail that's off. Failures page via withCronRun's error/partial alert.
    console.info(
      `[product-review-ask] DRY RUN — would ask ${batch.length} of ${eligible.length} eligible buyers ` +
        `(shipped ${orders.length}, ${MIN_DAYS}-${MAX_DAYS}d window, cap ${cap}) — flip PRODUCT_REVIEW_ASK_ENABLED=true to go live`,
    );
    return { status: 'success', recordsTouched: 0, notes: `DRY RUN shipped=${orders.length} eligible=${eligible.length} would=${batch.length} — no sends` };
  }

  let sent = 0;
  const errors: string[] = [];
  for (const o of batch) {
    try {
      const email = String(o['Buyer Email'] || '').trim().toLowerCase();
      if (!email) continue;

      // CLAIM BEFORE SEND + read-back verify (abort if the stamp won't persist).
      const updated: any = await updateRecord(TABLES.RANCHER_ORDERS, o.id, {
        'Review Asked At': new Date().toISOString(),
      });
      if (!updated || !updated['Review Asked At']) {
        return {
          status: 'error',
          recordsTouched: sent,
          notes: `ABORT: 'Review Asked At' did not persist for ${o.id} — verify the field exists. sentBeforeAbort=${sent}`,
        };
      }

      const token = jwt.sign({ type: 'review-submit', orderId: o.id }, JWT_SECRET, { expiresIn: '120d' });
      const first = escapeHtml(String(o['Buyer Name'] || '').trim().split(/\s+/)[0] || 'there');
      const product = escapeHtml(String(o['Product Name'] || 'your order'));
      const ranch = escapeHtml(String(o['Rancher Name'] || 'the ranch'));

      const res = await sendEmail({
        to: email,
        subject: `how was the ${String(o['Product Name'] || 'beef')}?`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
          <p>hey ${first},</p>
          <p>your <strong>${product}</strong> from ${ranch} should be well into the rotation by now. quick favor — one rating, one honest sentence. takes 30 seconds and helps the next family find real beef.</p>
          <p style="margin:22px 0"><a href="${SITE_URL}/reviews/submit?token=${encodeURIComponent(token)}" style="display:inline-block;padding:13px 26px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-size:14px;font-weight:600">leave your review &rarr;</a></p>
          <p style="font-size:12.5px;color:#5A5752">we share first name + state only — never your last name or email. and if anything wasn't right, just reply to this email instead and we'll make it right.</p>
          <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
        </div>`,
        templateName: 'product_review_ask',
      });
      if (res?.success) sent++;
      await new Promise((r) => setTimeout(r, 500));
    } catch (e: any) {
      errors.push(`${o.id}: ${e?.message?.slice(0, 60) || 'unknown'}`);
    }
  }

  if (sent > 0 || errors.length > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `product-review-ask: ${sent} ask${sent === 1 ? '' : 's'} sent`,
      detail: `eligible: ${eligible.length} · sent: ${sent} · errors: ${errors.length}`,
      dedupeKey: 'product-review-ask-summary',
    }).catch(() => {});
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes: `shipped=${orders.length} eligible=${eligible.length} sent=${sent} cap=${cap} errs=${errors.length}` + (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  const mode = process.env.PRODUCT_REVIEW_ASK_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('product-review-ask', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
