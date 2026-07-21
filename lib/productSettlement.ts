// lib/productSettlement.ts
//
// LOW-TICKET PRODUCT settlement (2026-07-06). Runs from the stripe-connect
// webhook on payment_intent.succeeded when metadata.type === 'product_purchase'.
// The money already moved (Stripe direct-charge split the funds automatically:
// rancher got Base, BHC got the application fee). This handler RECORDS the
// order + tells the humans: create a Rancher Orders row, fire a loud operator
// signal (a real sale — this one SHOULD ring), receipt the buyer, and email the
// rancher the ship-to so they fulfill.
//
// HARDENED 2026-07-06 (money-rail audit of #268):
//   - idempotency: claimOnce lock + existing-order lookup that THROWS on a
//     transient Airtable error (→ webhook 5xx → Stripe redelivers, never a
//     silent duplicate) + a post-create RACE GUARD so a simultaneous
//     redelivery with Redis down can't double-notify / double-ship.
//   - settlement re-asserts base <= display (a malformed PI can't record an
//     inverted-margin order).
//   - all buyer/rancher/product strings are HTML-escaped into email bodies.
//   - reconcileProductOrderRefund(): a product refund/dispute flips the order
//     to Refunded + alerts (was silent — the row stayed 'New' forever).

import { getAllRecords, createRecord, updateRecord, TABLES, escapeAirtableValue, getRecordById } from '@/lib/airtable';
import { getStripeClient } from '@/lib/stripeConnect';
import { claimOnce } from '@/lib/rancherCapacity';
import { PermanentSettlementError } from '@/lib/stripeSettlement';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { sendEmail } from '@/lib/email';
import { fireCapi, buildUserData, productPurchaseEnabled } from '@/lib/metaCapi';

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatShipping(pi: any): string {
  // Prefer the charge's shipping (reliably populated on direct-charge Checkout)
  // then fall back to pi.shipping. Audit: pi.shipping isn't always set for
  // Checkout direct charges on the pinned preview API version.
  const s = pi?.charges?.data?.[0]?.shipping || pi?.shipping || null;
  if (!s) return '';
  const a = s.address || {};
  const parts = [
    s.name,
    a.line1,
    a.line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(', '),
  ].filter(Boolean);
  return parts.join('\n');
}

const dollars = (c: number) => (c / 100).toFixed(2);

export async function settleProductPurchase(pi: any, connectedAccountId?: string): Promise<void> {
  const productName = String(pi?.metadata?.productName || 'a product');
  const rancherId = String(pi?.metadata?.rancherId || '');
  const rancherName = String(pi?.metadata?.rancherName || 'the ranch');
  // Email: operator links stamp metadata.buyerEmail; self-serve storefront buys
  // don't (Stripe collects it) → fall back to the charge's billing/receipt email.
  const charge0 = pi?.charges?.data?.[0] || {};
  let buyerEmail = (
    String(pi?.metadata?.buyerEmail || '').trim() ||
    String(charge0?.billing_details?.email || '').trim() ||
    String(pi?.receipt_email || '').trim()
  ).toLowerCase();
  // Name: metadata (operator) → the shipping/billing name Stripe collected.
  let buyerName = (
    String(pi?.metadata?.buyerName || '').trim() ||
    String(pi?.shipping?.name || charge0?.shipping?.name || charge0?.billing_details?.name || '').trim()
  );
  const displayCents = Number(pi?.metadata?.displayCents || 0);
  const baseCents = Number(pi?.metadata?.baseCents || 0);
  const marginCents = Number(pi?.metadata?.marginCents || Math.max(0, displayCents - baseCents));
  // Shipping passthrough (2026-07-07): rides metadata from createProductCheckout.
  // Part of what the buyer paid + what the rancher nets; NEVER part of the
  // margin. Absent/legacy PIs → 0 (shipping-included pricing).
  const shippingCents = Math.max(0, Number(pi?.metadata?.shippingCents || 0));
  // Units (2026-07-07): displayCents is the UNIT price; qty scales product +
  // margin, shipping stays flat. Absent/legacy PIs → 1.
  const quantity = Math.max(1, Math.round(Number(pi?.metadata?.quantity || 1)) || 1);
  const paidCents = displayCents * quantity + shippingCents;
  const qtyLabel = quantity > 1 ? `${quantity}× ` : '';
  // DEPOSIT-STYLE (audit fix C-1.5): a price-range product where this charge is
  // a DEPOSIT, not the full price. Every notification below MUST say so — the
  // old copy told the buyer "on its way" and the rancher "pack it, ship it",
  // the exact opposite of the storefront's "balance confirmed before shipping"
  // promise. Absent/legacy PIs default to false (full-purchase copy).
  const depositStyle = String(pi?.metadata?.depositStyle || '') === 'true';
  // LOCAL PICKUP (2026-07-07): the buyer collects at the ranch — every
  // notification below must say pickup, never "ship to". Absent/legacy → ship.
  const isPickup = String(pi?.metadata?.fulfillment || 'ship') === 'pickup';

  if (!pi?.id || !displayCents) {
    // Malformed → can never settle. Permanent so Stripe stops the 3-day retry.
    throw new PermanentSettlementError(
      `product_purchase missing required fields — piId=${!!pi?.id} displayCents=${displayCents}`,
    );
  }
  // Email may legitimately be blank in a rare Stripe edge — record the order
  // anyway (never lose a paid sale) and just skip the buyer receipt below.
  // Audit finding 4: re-assert the money invariant at settle time — a PI that
  // somehow stamped base>display must never record an inverted-margin order.
  if (baseCents > displayCents) {
    throw new PermanentSettlementError(
      `product_purchase base (${baseCents}) > display (${displayCents}) — inverted margin, refusing to record`,
    );
  }

  // Concurrency lock. If we can't claim, another delivery is mid-flight — skip.
  if (!(await claimOnce(`settle-product:${pi.id}`, 60))) return;

  // Redelivery dedup: already recorded this PI? then we're done. Audit finding
  // 3: on a lookup ERROR, THROW — the webhook returns 5xx and Stripe redelivers
  // (safe: this handler is idempotent). Never fall through to create on a
  // transient blip, which would guarantee a duplicate order.
  let existing: any[];
  try {
    existing = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{Stripe Payment Intent} = "${escapeAirtableValue(pi.id)}"`,
    )) as any[];
  } catch (e: any) {
    throw new Error(`RANCHER_ORDERS dedup lookup failed (retryable): ${e?.message || 'unknown'}`);
  }
  if (Array.isArray(existing) && existing.length > 0) return;

  let shipTo = formatShipping(pi);

  // AUDIT CRITICAL (2026-07-07): on modern Stripe API versions the webhook PI
  // payload is CHARGES-LESS — pi.charges.data[0] is empty, so ship-to and the
  // self-serve buyer email can come back blank on a PAID order (rancher gets a
  // ship-it email with no address; buyer gets no receipt). Recover them by
  // fetching the latest charge on the connected account. Best-effort — a fetch
  // failure keeps today's behavior, never blocks settlement.
  if ((!shipTo || !buyerEmail || !buyerName) && connectedAccountId && typeof pi?.latest_charge === 'string' && pi.latest_charge) {
    try {
      const stripe = getStripeClient();
      const ch: any = await stripe.charges.retrieve(pi.latest_charge, { stripeAccount: connectedAccountId });
      if (!shipTo) shipTo = formatShipping({ charges: { data: [ch] } });
      if (!buyerEmail) {
        buyerEmail = String(ch?.billing_details?.email || ch?.receipt_email || '').trim().toLowerCase();
      }
      if (!buyerName) {
        buyerName = String(ch?.shipping?.name || ch?.billing_details?.name || '').trim();
      }
    } catch (e: any) {
      console.warn('[productSettlement] latest_charge fetch failed (degrading to payload fields):', e?.message);
    }
  }

  const created: any = await createRecord(TABLES.RANCHER_ORDERS, {
    // Deposit-style orders carry the marker in the ref so the ops view reads
    // the truth at a glance (no schema change needed).
    'Order Ref': `${depositStyle ? 'DEPOSIT — ' : ''}${isPickup ? 'PICKUP — ' : ''}${qtyLabel}${productName} — ${buyerName || buyerEmail}`,
    // GTM-hardening F2: link back to the product row so a refund/dispute can
    // RESTORE its 'Orders Left' (inventory symmetry with the decrement below).
    'Product Record ID': String(pi?.metadata?.productId || ''),
    'Product Name': productName,
    'Rancher Name': rancherName,
    'Rancher Record ID': rancherId,
    'Buyer Email': buyerEmail,
    'Buyer Name': buyerName,
    'Ship To Address': shipTo,
    'Buyer Paid': paidCents / 100,
    'Rancher Payout': (baseCents * quantity + shippingCents) / 100,
    'BHC Margin': (marginCents * quantity) / 100,
    'Quantity': quantity,
    'Stripe Payment Intent': pi.id,
    'Status': 'New',
    'Ordered At': new Date().toISOString(),
  });

  // Audit finding 1 — POST-CREATE RACE GUARD. claimOnce fails OPEN when Redis
  // is down, so two simultaneous redeliveries could both pass the pre-create
  // lookup and both create a row. Re-query by PI; if >1 row exists, only the
  // lowest record id proceeds to notify (both racers compute the same winner
  // deterministically). The loser returns silently — no double receipt, no
  // double ship-it email, no double "SOLD" alert. (A rare duplicate ROW may
  // remain, but nobody double-ships.)
  try {
    const rows = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{Stripe Payment Intent} = "${escapeAirtableValue(pi.id)}"`,
    )) as any[];
    if (Array.isArray(rows) && rows.length > 1) {
      const winner = rows.map((r) => String(r.id)).sort()[0];
      if (String(created?.id) !== winner) return; // lost the race — winner notifies
    }
  } catch {
    // Re-query failed — proceed to notify (the normal single-delivery path).
  }

  // LOUD operator signal — a real sale. This is exactly the alert that should
  // ring after the noise cut. Deposit-style says so (C-1.5) — Ben must never
  // read a $95 deposit as a completed $95 sale.
  await sendOperatorSignal({
    urgency: 'loud',
    kind: 'sale',
    summary: depositStyle
      ? `DEPOSIT PAID — ${productName} · $${dollars(displayCents)} down (balance TBD)`
      : `PRODUCT SOLD — ${qtyLabel}${productName} · $${dollars(paidCents)}`,
    detail: depositStyle
      ? `${buyerName || buyerEmail} put $${dollars(displayCents)} down on ${productName} from ${rancherName}.\n` +
        `DEPOSIT-STYLE: ${rancherName} confirms size + the balance with the buyer BEFORE shipping.\n` +
        `You keep $${dollars(marginCents)} of the deposit · rancher nets $${dollars(baseCents)}.\n` +
        `Ship to (once confirmed):\n${shipTo || '(address on the order)'}`
      : isPickup
        ? `${buyerName || buyerEmail} bought ${qtyLabel}${productName} from ${rancherName} — LOCAL PICKUP.\n` +
          `You keep $${dollars(marginCents * quantity)} · rancher nets $${dollars(baseCents * quantity)}.\n` +
          `${rancherName} coordinates pickup with the buyer${buyerEmail ? ` (${buyerEmail})` : ''}.`
        : `${buyerName || buyerEmail} bought ${qtyLabel}${productName} from ${rancherName}.\n` +
          `You keep $${dollars(marginCents * quantity)} · rancher nets $${dollars(baseCents * quantity + shippingCents)}${shippingCents > 0 ? ` (incl. $${dollars(shippingCents)} shipping)` : ''}.\n` +
          `Tell ${rancherName} to ship to:\n${shipTo || '(address on the order)'}` +
          (!shipTo ? `\n⚠️ NO SHIP-TO CAPTURED — pull the address from the Stripe payment (${pi.id}) and get it to ${rancherName}.` : ''),
    dedupeKey: `product-sold:${pi.id}`,
  }).catch(() => {});

  // Buyer receipt (brand voice). All interpolated strings HTML-escaped.
  // Deposit-style receipt matches the storefront promise exactly: deposit
  // counts toward the total, rancher reaches out BEFORE anything ships.
  const buyerFirst = escapeHtml(buyerName ? buyerName.split(/\s+/)[0] : 'there');
  // SHOP → SHARE CROSS-SELL (2026-07-17, revenue-path audit): the product rail
  // carried ZERO /access links anywhere, so a buyer who just paid a ranch for
  // a box was never once asked about the ~$2k share — the highest-margin
  // product, offered to the single most qualified audience there is (someone
  // who already bought beef from a BHC ranch). One P.S., no new infrastructure.
  const SITE = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
  const shareLadderPs =
    `<p style="font-size:13px;color:#5A5752;border-top:1px solid #A7A29A;padding-top:14px;margin-top:22px">` +
    `p.s. if it's good and you'd rather stop buying beef by the box, a quarter or half from a ranch like this one runs about $5.50 to $9.50 a pound and fills a freezer for the year. ` +
    `<a href="${SITE}/access?utm_source=email&utm_medium=product_receipt&utm_campaign=shop_to_share" style="color:#0E0E0E">see what's available near you</a>.</p>`;
  if (buyerEmail) {
    await sendEmail({
      to: buyerEmail,
      subject: depositStyle
        ? `you're set — your ${productName} deposit is in`
        : isPickup
          ? `you're set — ${productName} is ready to plan pickup`
          : `order's in — ${productName} ships from the ranch soon`,
      html: depositStyle
        ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
        <p>hey ${buyerFirst},</p>
        <p>your deposit's in — <strong>${escapeHtml(rancherName)}</strong> has your <strong>${escapeHtml(productName)}</strong> reservation and will reach out to confirm the size you want + the balance <em>before anything ships</em>.</p>
        <p style="font-size:14px;color:#5A5752">deposit paid: $${dollars(displayCents)} — it counts toward your total. nothing ships until you've confirmed the details together.</p>
        ${shareLadderPs}
        <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
      </div>`
        : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
        <p>hey ${buyerFirst},</p>
        <p>you're all set — <strong>${escapeHtml(rancherName)}</strong> got your order for <strong>${quantity > 1 ? `${quantity}× ` : 'a '}${escapeHtml(productName)}</strong>${isPickup ? ' and will reach out to set up your pickup at the ranch.' : ' and will ship it direct to you.'}</p>
        <p style="font-size:14px;color:#5A5752">paid: $${dollars(paidCents)}${quantity > 1 || shippingCents > 0 ? ` (${quantity > 1 ? `${quantity} × $${dollars(displayCents)}` : `$${dollars(displayCents)}`}${shippingCents > 0 ? ` + $${dollars(shippingCents)} shipping` : ''})` : ''}. ${isPickup ? 'local pickup — no shipping charged; the ranch will confirm the time and place with you.' : "you'll get tracking as soon as it's on the way."}</p>
        ${shipTo ? `<p style="font-size:13px;color:#5A5752">shipping to:<br>${escapeHtml(shipTo).replace(/\n/g, '<br>')}<br><span style="color:#A7A29A">typo in the address? just reply to this email and we'll fix it before it ships.</span></p>` : ''}
        ${shareLadderPs}
        <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
      </div>`,
      templateName: 'product_receipt',
    }).catch(() => {});
  }

  // PWA push (2026-07-08) — instant pocket alert, rides alongside the email.
  // Dark-safe no-op without VAPID env/subscriptions; never blocks settlement.
  if (rancherId) {
    try {
      const { sendRancherPush } = await import('@/lib/rancherPush');
      await sendRancherPush(rancherId, {
        title: depositStyle
          ? `💰 deposit in — confirm before shipping`
          : isPickup
            ? `💰 pickup order paid — reach out`
            : `📦 new order to ship`,
        body: `${quantity > 1 ? `${quantity}× ` : ''}${productName} — ${buyerName || buyerEmail || 'a buyer'}. you net $${dollars(baseCents * quantity + (isPickup ? 0 : shippingCents))}.`,
        url: '/rancher#products',
      });
    } catch (e: any) {
      console.warn('[productSettlement] push skipped (non-fatal):', e?.message);
    }
  }

  // Rancher notification (operational — clear, not marketing). Deposit-style
  // flips the instruction from "pack it, ship it" to "CONFIRM FIRST" — the
  // rancher must never ship a $95–355 range box against a deposit-only payout.
  try {
    const rancher: any = rancherId ? await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null) : null;
    const rancherEmail = String(rancher?.['Email'] || '').trim();
    if (rancherEmail) {
      await sendEmail({
        to: rancherEmail,
        subject: depositStyle
          ? `deposit in — confirm details BEFORE shipping — ${productName}`
          : isPickup
            ? `pickup order paid — coordinate with the buyer — ${productName}`
            : `new order to ship — ${productName}`,
        html: depositStyle
          ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
          <p>hi ${escapeHtml(rancherName)},</p>
          <p>a buyer put a <strong>$${dollars(displayCents)} deposit</strong> down on a <strong>${escapeHtml(productName)}</strong>. <strong>do not ship yet</strong> — reach out first, confirm the size they want, and settle the balance with them. their deposit counts toward the total.</p>
          <div style="background:#fff;border:1px solid #A7A29A;padding:16px;margin:16px 0;font-size:15px">
            buyer: ${escapeHtml(buyerName || buyerEmail || '(on the order)')}<br>
            ${buyerEmail ? `email: ${escapeHtml(buyerEmail)}<br>` : ''}
            ship to (once confirmed):<br>${escapeHtml(shipTo || '(see BuyHalfCow order)').replace(/\n/g, '<br>')}
          </div>
          <p style="font-size:14px;color:#2A2A2A">you've already netted <strong>$${dollars(baseCents)}</strong> of the deposit in your Stripe account. confirm details → collect the balance (quote it WITH your shipping cost — the deposit didn't include shipping) → then ship &amp; reply with tracking.</p>
          <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
        </div>`
          : isPickup
            ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
          <p>hi ${escapeHtml(rancherName)},</p>
          <p>you have a paid <strong>LOCAL PICKUP</strong> order — nothing to ship:</p>
          <div style="background:#fff;border:1px solid #A7A29A;padding:16px;margin:16px 0;font-size:15px">
            <strong>${quantity > 1 ? `${quantity}× ` : ''}${escapeHtml(productName)}</strong><br>
            buyer: ${escapeHtml(buyerName || buyerEmail || '(on the order)')}<br>
            ${buyerEmail ? `email: ${escapeHtml(buyerEmail)}<br>` : ''}
            ${shipTo ? `buyer address (contact info, NOT a ship-to):<br>${escapeHtml(shipTo).replace(/\n/g, '<br>')}` : ''}
          </div>
          <p style="font-size:14px;color:#2A2A2A">you net <strong>$${dollars(baseCents * quantity)}</strong> — already routed to your Stripe account. reach out to the buyer, set a pickup time at the ranch, and mark the order complete in your dashboard (Products tab) once they've picked it up.</p>
          <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
        </div>`
            : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
          <p>hi ${escapeHtml(rancherName)},</p>
          <p>you have a paid BuyHalfCow order to ship:</p>
          <div style="background:#fff;border:1px solid #A7A29A;padding:16px;margin:16px 0;font-size:15px">
            <strong>${quantity > 1 ? `${quantity}× ` : ''}${escapeHtml(productName)}</strong><br>
            ship to:<br>${escapeHtml(shipTo || '(see BuyHalfCow order)').replace(/\n/g, '<br>')}
          </div>
          <p style="font-size:14px;color:#2A2A2A">you net <strong>$${dollars(baseCents * quantity + shippingCents)}</strong>${shippingCents > 0 ? ` (includes the $${dollars(shippingCents)} shipping the buyer paid)` : ''} — already routed to your Stripe account. pack it, then mark it shipped in your dashboard (Products tab) and paste the tracking number — that sends the buyer their tracking email automatically. or just reply here with the tracking and we'll handle it.</p>
          <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
        </div>`,
        templateName: 'rancher_order_notify',
      }).catch(() => {});
    }
  } catch { /* non-fatal — the operator signal already carries the ship-to */ }

  // ── INVENTORY DECREMENT (Phase 11, ad-readiness) ──────────────────────────
  // If the product tracks 'Orders Left', burn one on every settled order and
  // refresh /shop so a sell-out disappears from the grid in seconds (the
  // sellability gate + charge-time checks make it un-buyable regardless).
  // Best-effort + non-fatal: Airtable has no atomic decrement, and an
  // off-by-one under heavy simultaneous sales self-corrects at the monthly
  // stock check-in — never worth failing a settled order over.
  try {
    const productId = String(pi?.metadata?.productId || '').trim();
    if (productId) {
      const prod: any = await getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null);
      const left = prod?.['Orders Left'];
      if (prod && left !== undefined && left !== null && left !== '') {
        // OVERSELL (audit 2026-07-07): stock was already 0 when this order
        // settled — a session minted before sell-out got paid after it. The
        // clamp below hides that silently; the rancher can't ship what they
        // don't have, so ring the operator to resolve (refund or restock).
        if (Number(left) < quantity) {
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'sale',
            summary: `OVERSOLD — ${qtyLabel}${productName} settled with ${Number(left)} in stock`,
            detail:
              `${buyerName || buyerEmail || 'A buyer'} paid for ${qtyLabel}${productName} from ${rancherName}, but 'Orders Left' was ${Number(left)}.\n` +
              `A checkout session minted before sell-out completed after it. Resolve with ${rancherName}: restock + ship, or refund.`,
            dedupeKey: `product-oversold:${pi.id}`,
          }).catch(() => {});
        }
        const next = Math.max(0, Number(left) - quantity);
        await updateRecord(TABLES.RANCHER_PRODUCTS, productId, { 'Orders Left': next });
        try {
          const { revalidatePath } = await import('next/cache');
          revalidatePath('/shop');
          revalidatePath(`/shop/${productId}`);
        } catch { /* ISR backstop */ }
      }
    }
  } catch (e: any) {
    console.warn('[productSettlement] inventory decrement skipped (non-fatal):', e?.message);
  }

  // ── FULFILLMENT CONNECTOR PUSH (2026-07-21, Shopify v1) ───────────────────
  // If the rancher has a connected store, inject this paid order into it so
  // their own logistics stack fulfills (docs/plans/2026-07-21-shopify-
  // fulfillment-connector.md). Best-effort, never blocks settlement; gates +
  // outcome stamps live in the runner; misses swept by fulfillment-push-net.
  try {
    const { runFulfillmentPush } = await import('./fulfillmentPushRunner');
    await runFulfillmentPush(String(created?.id || ''));
  } catch (e: any) {
    console.warn('[productSettlement] fulfillment push skipped (non-fatal):', e?.message);
  }

  // ── Meta Conversions API: server-side Purchase (the ROAS conversion) ──────
  // Gated on productPurchaseEnabled() (privacy dry-run first). No fbp/fbc at
  // webhook time → action_source='system_generated' + email match (same posture
  // as the deposit Purchase). event_id=product_purchase_<pi.id> is unique per
  // sale so Meta can never collapse two real sales into one. content_ids=
  // [productId] feeds the past-buyer / lookalike-seed audiences. Fire-and-forget
  // — fireCapi fails open, so this can never affect settlement.
  if (productPurchaseEnabled()) {
    try {
      const firstName = buyerName ? buyerName.split(/\s+/)[0] : undefined;
      const productId = String(pi?.metadata?.productId || '').trim();
      void fireCapi([{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: `product_purchase_${pi.id}`,
        action_source: 'system_generated',
        user_data: buildUserData({ email: buyerEmail || undefined, firstName }),
        custom_data: {
          value: paidCents / 100,
          currency: 'usd',
          content_ids: productId ? [productId] : [],
          content_type: 'product',
          content_name: productName,
        },
      }]).catch(() => {});
    } catch { /* analytics only — never affects settlement */ }
  }

  // ── Product-buyer → Consumers bridge (owned-side remarketing) ─────────────
  // A product sale otherwise leaves ONLY a Rancher Orders row — invisible to the
  // repeat/cross-sell crons + to lookalike seeds. Upsert the buyer as a Consumer
  // stamped PRODUCT_BUYER so the owned-side crons can reach them. Best-effort: a
  // missing field / stage option (until the Airtable schema is added) is caught
  // and NEVER blocks the sale. Never DEMOTES a real share-funnel buyer — it only
  // claims the stage when they have none.
  if (buyerEmail) {
    try {
      const nowIso = new Date().toISOString();
      const productFields: Record<string, any> = {
        'Last Product Bought': productName,
        'Last Product Bought At': nowIso,
        'Product Buyer Rancher': rancherName,
      };
      const existingConsumers = (await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${escapeAirtableValue(buyerEmail)}"`,
      )) as any[];
      if (Array.isArray(existingConsumers) && existingConsumers.length > 0) {
        const c = existingConsumers[0];
        const stage = String(c['Buyer Stage'] || '').trim();
        const fields =
          !stage || stage === 'PRODUCT_BUYER'
            ? { ...productFields, 'Buyer Stage': 'PRODUCT_BUYER' }
            : productFields; // already in the share funnel — keep their stage
        await updateRecord(TABLES.CONSUMERS, c.id, fields);
      } else {
        await createRecord(TABLES.CONSUMERS, {
          'Full Name': buyerName || '',
          'Email': buyerEmail,
          'Buyer Stage': 'PRODUCT_BUYER',
          ...productFields,
        });
      }
    } catch { /* schema not ready or transient — non-fatal, never blocks the sale */ }
  }
}

// ── REFUND / DISPUTE RECONCILE (audit finding 2) ─────────────────────────────
// A product refund or chargeback fires charge.refunded / charge.dispute on the
// connected account. The existing deposit refund path (markDepositRefunded)
// looks up the Payments table — a product PI has NO Payments row, only a
// Rancher Orders row, so the refund was SILENT: the order stayed 'New' and a
// rancher could ship a refunded box. This flips the order + alerts loudly.
// Returns true if a product order was found + reconciled (so the webhook can
// tell it apart from a deposit refund).
export async function reconcileProductOrderRefund(
  piId: string,
  opts: { kind: 'refund' | 'dispute'; amountCents?: number; partial?: boolean },
): Promise<boolean> {
  if (!piId) return false;
  let rows: any[];
  try {
    rows = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{Stripe Payment Intent} = "${escapeAirtableValue(piId)}"`,
    )) as any[];
  } catch (e: any) {
    // Transient — let the caller decide to 5xx. Signal not-found-yet by throwing.
    throw new Error(`RANCHER_ORDERS refund lookup failed (retryable): ${e?.message || 'unknown'}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) return false; // not a product order

  const order = rows[0];
  if (String(order['Status'] || '') === 'Refunded') return true; // already reconciled

  // PARTIAL refund (audit 2026-07-07): a $10-of-$170 goodwill refund must NOT
  // flip the order to Refunded, restore stock, or stop the ship — the buyer
  // still gets their box. Alert loudly with the real amount and leave the
  // order live. Disputes never take this branch (a chargeback of any size is
  // a stop-ship).
  if (opts.kind === 'refund' && opts.partial) {
    const productP = String(order['Product Name'] || 'a product');
    const rancherP = String(order['Rancher Name'] || 'the ranch');
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'sale',
      summary: `PARTIAL REFUND — ${productP} ($${dollars(opts.amountCents || 0)})`,
      detail:
        `A partial refund of $${dollars(opts.amountCents || 0)} was issued on the ${productP} order from ${rancherP}.\n` +
        `Order stays LIVE — the buyer still gets their box; nothing was un-shipped or restocked.`,
      dedupeKey: `product-partial-refund:${piId}:${opts.amountCents || 0}`,
    }).catch(() => {});
    return true;
  }

  // GTM-hardening F2 (secondary): flip EVERY row for this PI — the Redis-down
  // race guard can leave a rare duplicate row, and a 'New' twin would sit on
  // the rancher's ship list after the refund.
  for (const row of rows) {
    if (String(row['Status'] || '') === 'Refunded') continue;
    await updateRecord(TABLES.RANCHER_ORDERS, row.id, {
      'Status': 'Refunded',
      'Refunded At': new Date().toISOString(),
    }).catch(() => {});
  }

  // GTM-hardening F2 (primary): RESTORE inventory — the settle path burned one
  // 'Orders Left'; a refunded unit goes back on the shelf so the product
  // doesn't sit sold-out losing sales until the monthly check-in. Best-effort,
  // mirrors the decrement (blank = unlimited = nothing to restore).
  try {
    const productId = String(order['Product Record ID'] || '').trim();
    if (productId) {
      const prod: any = await getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null);
      const left = prod?.['Orders Left'];
      if (prod && left !== undefined && left !== null && left !== '') {
        // Restore the ORDER's unit count (multi-unit orders restore all units;
        // legacy rows without Quantity restore 1 — the old behavior).
        const orderQty = Math.max(1, Math.round(Number(order['Quantity'] || 1)) || 1);
        await updateRecord(TABLES.RANCHER_PRODUCTS, productId, { 'Orders Left': Number(left) + orderQty });
        try {
          const { revalidatePath } = await import('next/cache');
          revalidatePath('/shop');
          revalidatePath(`/shop/${productId}`);
        } catch { /* ISR backstop */ }
      }
    }
  } catch (e: any) {
    console.warn('[productSettlement] refund stock restore skipped (non-fatal):', e?.message);
  }

  // FULFILLMENT CONNECTOR CANCEL (2026-07-21): if this order was pushed into
  // the rancher's own store, cancel it there too (restock:true) — otherwise
  // their Shopify keeps fulfilling a refunded deal. FULL refunds/disputes
  // only: the partial-refund branch above returned early and the external
  // order must stay live (buyer still gets their box).
  const externalOrderId = String(order['External Order Id'] || '').trim();
  if (externalOrderId && String(order['External Push Status'] || '') !== 'cancelled') {
    try {
      const { parseIntegration, getConnector } = await import('./fulfillmentConnector');
      const rancherRow = await getRecordById(TABLES.RANCHERS, String(order['Rancher Record ID'] || '')).catch(() => null);
      const integration = parseIntegration(rancherRow?.['Fulfillment Integration']);
      if (integration) {
        const res = await getConnector(integration.provider).cancelOrder(
          integration, externalOrderId, `BHC ${opts.kind} — ${String(order['Order Ref'] || '')}`.slice(0, 255));
        await updateRecord(TABLES.RANCHER_ORDERS, order.id, {
          'External Push Status': res.ok ? 'cancelled' : `cancel-failed:${res.error || 'unknown'}`.slice(0, 250),
        }).catch(() => {});
        if (!res.ok) {
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'sale',
            summary: `EXTERNAL ORDER CANCEL FAILED — ${String(order['Product Name'] || 'product')}`,
            detail:
              `Shopify order ${externalOrderId} could not be cancelled after the ${opts.kind} ` +
              `and may still ship. Cancel it manually in the rancher's store. ${res.error || ''}`,
            dedupeKey: `shopify-cancel-fail-${order.id}`,
            dedupeWindowMs: 24 * 60 * 60 * 1000,
          }).catch(() => {});
        }
      }
    } catch (e: any) {
      console.warn('[productSettlement] external cancel skipped (non-fatal):', e?.message);
    }
  }

  const product = String(order['Product Name'] || 'a product');
  const rancher = String(order['Rancher Name'] || 'the ranch');
  const amt = opts.amountCents ? ` ($${dollars(opts.amountCents)})` : '';
  await sendOperatorSignal({
    urgency: 'loud',
    kind: opts.kind === 'dispute' ? 'dispute' : 'sale',
    summary: `PRODUCT ${opts.kind === 'dispute' ? 'DISPUTED' : 'REFUNDED'} — ${product}${amt}`,
    detail:
      `Order for ${product} from ${rancher} was ${opts.kind === 'dispute' ? 'disputed (chargeback)' : 'refunded'}.\n` +
      `Order flipped to Refunded. Stop-ship push + email just went straight to ${rancher} too.`,
    dedupeKey: `product-${opts.kind}:${piId}`,
  }).catch(() => {});

  // Tell the RANCHER — the one person who can actually stop the box (Wave A
  // 2026-07-14). The ops Telegram literally said "TELL THEM TO STOP", i.e.
  // stop-ship depended on Ben manually relaying it; and the settle email
  // invites email-only fulfillment ("just reply here with the tracking"), so
  // the dashboard's 409-on-refunded guard only helps if they check first.
  // Push + email, both best-effort (a notify failure must never fail the
  // reconcile); skipped on the partial-refund branch above (order stays
  // live); idempotent via the Status==='Refunded' early-return.
  const stopShipRancherId = String(order['Rancher Record ID'] || '').trim();
  const buyerNameForStopShip = String(order['Buyer Name'] || '').trim() || 'the buyer';
  if (stopShipRancherId) {
    try {
      const { sendRancherPush } = await import('@/lib/rancherPush');
      await sendRancherPush(stopShipRancherId, {
        title: '🛑 DO NOT SHIP — order refunded',
        body: `${product} for ${buyerNameForStopShip} was ${opts.kind === 'dispute' ? 'charged back' : 'refunded'} — do not ship. Marked Refunded in your dashboard.`,
        url: '/rancher#products',
      });
    } catch (e: any) {
      console.warn('[productSettlement] stop-ship push failed (non-fatal):', e?.message);
    }
    try {
      const rancherRec: any = await getRecordById(TABLES.RANCHERS, stopShipRancherId).catch(() => null);
      const rancherEmail = String(rancherRec?.['Email'] || '').trim();
      if (rancherEmail) {
        const { sendRancherStopShip } = await import('@/lib/emailMinimal');
        await sendRancherStopShip({
          rancherEmail,
          rancherFirstName: String(rancherRec?.['Operator Name'] || '').trim().split(/\s+/)[0],
          productName: product,
          buyerName: buyerNameForStopShip,
          kind: opts.kind,
        });
      } else {
        console.warn('[productSettlement] stop-ship email skipped — rancher has no email:', stopShipRancherId);
      }
    } catch (e: any) {
      console.warn('[productSettlement] stop-ship email failed (non-fatal):', e?.message);
    }
  } else {
    console.warn('[productSettlement] stop-ship notify skipped — order has no Rancher Record ID (pre-stamp legacy row)');
  }

  // Tell the BUYER (checkout audit 2026-07-14): refunding in silence was a
  // trust hole — money moved with zero confirmation from BuyHalfCow. Best-
  // effort; a mail failure must not fail the reconcile (Stripe already moved
  // the money — this record flip is the source of truth).
  const buyerEmail = String(order['Buyer Email'] || '').trim();
  if (buyerEmail) {
    try {
      const { sendBuyerRefundNotice } = await import('@/lib/emailMinimal');
      await sendBuyerRefundNotice({
        buyerEmail,
        buyerName: String(order['Buyer Name'] || '').trim(),
        productName: product,
        rancherName: rancher,
        amountCents: opts.amountCents,
        kind: opts.kind === 'dispute' ? 'dispute' : 'refund',
      });
    } catch (e: any) {
      console.warn('[productSettlement] buyer refund notice failed (non-fatal):', e?.message);
    }
  }

  return true;
}
