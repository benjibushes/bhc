// app/api/cron/product-stock-checkin/route.ts
//
// MONTHLY rancher stock check-in (Phase 11, ad-readiness). Ads only compound
// if inventory truth holds — this is the human loop that keeps 'Orders Left'
// honest. On the 1st of each month, every rancher with listed marketplace
// products gets ONE email: here's everything you have listed + how many
// orders are left on each — confirm or fix it in two taps (dashboard →
// Products). Sold-out and unlimited rows are called out explicitly.
//
// ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
// Env `PRODUCT_STOCK_CHECKIN_ENABLED` (same 3-state contract as the rest of
// the owned-side fleet):
//   unset/other → { skipped: 'disabled' } before ANY read (no Cron Runs row)
//   'dry-run'   → live selection read-only; Telegram report of what WOULD send
//   'true'      → live sends (max one email per rancher per run; the cron
//                 fires monthly, so volume is 1/rancher/month by construction)
//
// Idempotent enough by schedule: no stamps needed — the cron runs once a
// month and a duplicate delivery within a run is prevented by the per-rancher
// grouping; a rare double-send of an informational digest is harmless.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stockLabel(left: any): string {
  if (left === undefined || left === null || left === '') return 'unlimited';
  const n = Number(left);
  return n > 0 ? `${n} orders left` : 'SOLD OUT (hidden from the shop)';
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // Date-1 guard. Vercel Hobby tier silently skipped the `0 16 1 * *` monthly
  // schedule (same silent drop that bit commission-invoices for 60+ days).
  // Switched to daily 16 UTC + this guard so the cron actually fires on the
  // 1st + Cron Runs has a row every day proving we DID check.
  const today = new Date();
  if (today.getUTCDate() !== 1) {
    return { status: 'success', recordsTouched: 0, notes: `skipped — not 1st (UTC day=${today.getUTCDate()})` };
  }

  const dryRun = process.env.PRODUCT_STOCK_CHECKIN_ENABLED === 'dry-run';

  let products: any[] = [];
  try {
    products = ((await getAllRecords(TABLES.RANCHER_PRODUCTS)) as any[]).filter(
      (r) => r['Active'] === true,
    );
  } catch (e: any) {
    return { status: 'error', recordsTouched: 0, notes: `products query failed: ${e?.message?.slice(0, 160) || 'unknown'}` };
  }

  // Group by rancher — one digest per rancher, never per product.
  const byRancher = new Map<string, any[]>();
  let orphanRows = 0;
  for (const p of products) {
    const rid = String(p['Rancher Record ID'] || '').trim();
    if (!rid) { orphanRows++; continue; } // counted in notes — never silent
    if (!byRancher.has(rid)) byRancher.set(rid, []);
    byRancher.get(rid)!.push(p);
  }

  // Noise filter: a rancher whose listings are ALL unlimited has no count to
  // confirm — skip the email (the check-in exists to keep NUMBERS honest).
  let allUnlimitedSkipped = 0;
  for (const [rid, list] of [...byRancher.entries()]) {
    const hasCounted = list.some(
      (p) => !(p['Orders Left'] === undefined || p['Orders Left'] === null || p['Orders Left'] === ''),
    );
    if (!hasCounted) {
      byRancher.delete(rid);
      allUnlimitedSkipped++;
    }
  }

  if (dryRun) {
    const lines = [...byRancher.entries()].map(
      ([rid, list]) => `${rid}: ${list.length} listed (${list.map((p) => `${p['Product Name']}=${stockLabel(p['Orders Left'])}`).join(', ')})`,
    );
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `stock check-in DRY RUN: would email ${byRancher.size} rancher(s)`,
      detail: ['PRODUCT STOCK CHECK-IN — DRY RUN (no sends)', ...lines.slice(0, 15)].join('\n'),
      dedupeKey: 'product-stock-checkin-dry-run',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
    return { status: 'success', recordsTouched: 0, notes: `DRY RUN ranchers=${byRancher.size} products=${products.length} — no sends` };
  }

  let sent = 0;
  const errors: string[] = [];

  for (const [rancherId, list] of byRancher) {
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
      const email = String(rancher?.['Email'] || '').trim();
      if (!email) continue;
      const ranchName = escapeHtml(String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'there'));

      const rows = list
        .map(
          (p) => `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #E5E2DC">${escapeHtml(String(p['Product Name'] || ''))}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #E5E2DC;white-space:nowrap">$${Number(p['Display Price'] || 0).toFixed(2)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #E5E2DC;white-space:nowrap"><strong>${escapeHtml(stockLabel(p['Orders Left']))}</strong></td>
          </tr>`,
        )
        .join('');

      await sendEmail({
        to: email,
        subject: 'monthly stock check — are these counts still right?',
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
          <p>hi ${ranchName},</p>
          <p>quick monthly check — here's everything you have listed on the buyhalfcow marketplace and how many orders each can still take:</p>
          <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #A7A29A;font-size:14px;margin:16px 0">
            <tr>
              <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #A7A29A;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6B4F3F">product</th>
              <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #A7A29A;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6B4F3F">price</th>
              <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #A7A29A;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6B4F3F">stock</th>
            </tr>
            ${rows}
          </table>
          <p style="font-size:14px;color:#2A2A2A">still right? you're done — nothing to do. need to update a count (or a price, or add something new)? two taps:</p>
          <p><a href="${SITE_URL}/rancher" style="display:inline-block;padding:12px 24px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-size:14px;font-weight:600">update my products &rarr;</a></p>
          <p style="font-size:12px;color:#5A5752">counts tick down automatically as orders come in, and a product at 0 hides from the shop so you never oversell. "unlimited" means we'll keep taking orders until you set a number.</p>
          <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
        </div>`,
        templateName: 'product_stock_checkin',
      });
      sent++;
      await new Promise((r) => setTimeout(r, 500)); // pace (Resend + Airtable)
    } catch (e: any) {
      errors.push(`${rancherId}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  if (sent > 0 || errors.length > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `stock check-in: ${sent} rancher digest${sent === 1 ? '' : 's'} sent`,
      detail: `ranchers with listings: ${byRancher.size} · sent: ${sent} · errors: ${errors.length}`,
      dedupeKey: 'product-stock-checkin-summary',
    }).catch(() => {});
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes:
      `ranchers=${byRancher.size} products=${products.length} sent=${sent} errs=${errors.length}` +
      ` allUnlimitedSkipped=${allUnlimitedSkipped} orphanRows=${orphanRows}` +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  const mode = process.env.PRODUCT_STOCK_CHECKIN_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('product-stock-checkin', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
