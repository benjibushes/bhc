// POST /api/admin/campaigns/shop-drop — "the shop is open" waitlist drop.
//
// THE #1 unmonetized asset (money-map 2026-07-06): ~2,000 buyers sit at
// Buyer Stage=WAITING — share-intent demand we couldn't serve locally. The
// marketplace ships to ALL of them. This one-time campaign tells them the
// shop exists: brand-voice email, three real products with prices, one CTA.
//
// Operator-triggered (admin-gated), NEVER a cron — Ben fires it from
// /admin/sell in batches. Body: { mode: 'dry-run' | 'live', cap? }.
//   dry-run → pool counts + a sample, Telegram report. NO sends, NO stamps.
//   live    → sends up to `cap` (default 100) per invocation. Re-trigger to
//             work through the pool — the once-ever stamp makes every run
//             resumable and double-fire-proof.
//
// Safety rails (the established owned-send discipline):
// - Selector mirrors waiting-activation: WAITING + has Email + not
//   Unsubscribed/Bounced/Complained (formula), stamp checked JS-side (the
//   {Refunded At} lesson — never put a maybe-missing field in a formula).
// - CLAIM-BEFORE-SEND with read-back verify — if 'Shop Drop Sent At' doesn't
//   persist, ABORT before any further send (one-nudge-per-buyer, ever).
// - Template 'shop_drop_announce' is NOT whitelisted — the 3/week frequency
//   guard applies, so an already-touched buyer is skipped, not stacked.
// - PRODUCT_BUYER stage excluded by the formula (they already know the shop).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { loadMarketplaceProducts, pickFunnelProducts, type MarketplaceProduct } from '@/lib/marketplaceProducts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const STAMP = 'Shop Drop Sent At';
const DEFAULT_CAP = 100;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderDropEmail(firstName: string, picks: MarketplaceProduct[]): { subject: string; html: string } {
  const rows = picks
    .map((p) => {
      const price = p.depositStyle
        ? `from ${escapeHtml(p.priceRange || `$${p.price.toFixed(0)}`)} · $${p.price.toFixed(0)} deposit`
        : `$${p.price.toFixed(2)} — shipping included`;
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E2DC">
          <a href="${SITE_URL}/shop/${p.id}?utm_source=email&utm_medium=broadcast&utm_campaign=shop-drop" style="color:#0E0E0E;font-weight:600;text-decoration:underline">${escapeHtml(p.name)}</a>
          <span style="color:#6B4F3F"> — ${escapeHtml(p.rancher)}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E2DC;white-space:nowrap;color:#2A2A2A">${price}</td>
      </tr>`;
    })
    .join('');
  return {
    subject: 'the shop is open — real ranch beef, shipped to your door',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>hey ${escapeHtml(firstName)},</p>
      <p>you signed up to get matched with a ranch — and while we keep working on ranch capacity near you, we opened something you can use <strong>today</strong>: the buyhalfcow shop. real beef from our verified ranches, shipped frozen to your door, anywhere in the country.</p>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #A7A29A;font-size:14px;margin:16px 0">${rows}</table>
      <p style="margin:20px 0"><a href="${SITE_URL}/shop?utm_source=email&utm_medium=broadcast&utm_campaign=shop-drop" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-size:14px;font-weight:600">see the whole shop &rarr;</a></p>
      <p style="font-size:13px;color:#5A5752">every listing says exactly what's in the box. shipping's included in the price you see. if anything shows up wrong, we make it right.</p>
      <p style="font-size:13px;color:#5A5752">and you're still first in line for a full share the moment a ranch opens up near you — nothing about your spot changed.</p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
    </div>`,
  };
}

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const mode = body?.mode === 'live' ? 'live' : 'dry-run';
  const cap = Math.min(Math.max(Number(body?.cap) || DEFAULT_CAP, 1), 500);

  // Pool: WAITING + emailable + not suppressed (formula), never-dropped (JS).
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.CONSUMERS,
      `AND({Buyer Stage}="WAITING", NOT({Email}=""), {Unsubscribed}!=1, {Bounced}!=1, {Complained}!=1)`,
    )) as any[];
  } catch (e: any) {
    return NextResponse.json({ error: `consumers query failed: ${e?.message || 'unknown'}` }, { status: 502 });
  }
  const pool = candidates.filter((c) => !c[STAMP]);
  const batch = pool.slice(0, cap);

  // The merchandise — same picker the funnel rail uses (≤3, shares excluded).
  const picks = pickFunnelProducts(await loadMarketplaceProducts());
  if (picks.length === 0) {
    return NextResponse.json({ error: 'no sellable products — nothing to announce' }, { status: 409 });
  }

  if (mode === 'dry-run') {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `SHOP DROP dry run: ${pool.length} WAITING buyers never told about the shop`,
      detail:
        `pool (WAITING, emailable, not suppressed, never dropped): ${pool.length}\n` +
        `next batch would send: ${batch.length} (cap ${cap})\n` +
        `products featured: ${picks.map((p) => p.name).join(' · ')}\n` +
        `fire live from /admin/sell → campaigns, batch by batch.`,
      dedupeKey: 'shop-drop-dry-run',
      dedupeWindowMs: 60 * 60 * 1000,
    }).catch(() => {});
    return NextResponse.json({
      mode,
      pool: pool.length,
      wouldSend: batch.length,
      cap,
      picks: picks.map((p) => p.name),
    });
  }

  let sent = 0;
  let suppressed = 0;
  const errors: string[] = [];
  for (const c of batch) {
    try {
      const email = String(c['Email'] || '').trim().toLowerCase();
      if (!email) continue;

      // CLAIM BEFORE SEND + read-back verify (the product-recovery pattern).
      const updated: any = await updateRecord(TABLES.CONSUMERS, c.id, {
        [STAMP]: new Date().toISOString(),
      });
      if (!updated || !updated[STAMP]) {
        return NextResponse.json(
          { error: `ABORT: '${STAMP}' did not persist for ${c.id} — verify the field exists. sentBeforeAbort=${sent}` },
          { status: 500 },
        );
      }

      const first = String(c['Full Name'] || '').trim().split(/\s+/)[0] || 'there';
      const rendered = renderDropEmail(first, picks);
      const res = await sendEmail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        templateName: 'shop_drop_announce',
      });
      if (res?.success) sent++;
      else suppressed++;
      await new Promise((r) => setTimeout(r, 400)); // pace Resend + Airtable
    } catch (e: any) {
      errors.push(`${c.id}: ${e?.message?.slice(0, 60) || 'unknown'}`);
    }
  }

  await sendOperatorSignal({
    urgency: 'normal',
    kind: 'other',
    summary: `SHOP DROP: ${sent} sent · ${pool.length - batch.length} remaining in pool`,
    detail: `batch: ${batch.length} · sent: ${sent} · suppressed-by-cap: ${suppressed} · errors: ${errors.length}\nre-fire the batch button until remaining hits 0.`,
    dedupeKey: `shop-drop-batch:${Date.now()}`,
  }).catch(() => {});

  return NextResponse.json({
    mode,
    sent,
    suppressed,
    errors: errors.length,
    remaining: pool.length - batch.length,
  });
}
