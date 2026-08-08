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
import { zipFromStripePayment, buyerZipPatch } from '@/lib/buyerZip';
import { orderStatusUrlFor } from '@/lib/orderStatusLink';
import { operationTypeFor, operationTypeEmailLine } from '@/lib/operationType';

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

// Pure money resolver (extracted for L1 + testability). All cent amounts a
// settled product order records/reports, derived from PI metadata.
//
// L1 (reporting): metadata.marginCents (set at productCheckout buildProductMetadata
// = charge.applicationFeeCents) is the WHOLE-ORDER application fee — already
// quantity-scaled AND net of any absorbed Stripe fee. It must NEVER be
// multiplied by quantity again (that inflated multi-unit 'BHC Margin' ~qty×).
// Only the LEGACY fallback (PI without metadata.marginCents) is per-unit, so it
// keeps its ×quantity. Buyer Paid − Rancher Payout === totalMarginCents when no
// Stripe fee is absorbed — the invariant the admin P&L reads.
export function computeSettlementMoney(pi: any): {
  displayCents: number;
  baseCents: number;
  shippingCents: number;
  quantity: number;
  paidCents: number;
  rancherPayoutCents: number;
  totalMarginCents: number;
} {
  const displayCents = Number(pi?.metadata?.displayCents || 0);
  const baseCents = Number(pi?.metadata?.baseCents || 0);
  const shippingCents = Math.max(0, Number(pi?.metadata?.shippingCents || 0));
  const quantity = Math.max(1, Math.round(Number(pi?.metadata?.quantity || 1)) || 1);
  const paidCents = displayCents * quantity + shippingCents;
  const rancherPayoutCents = baseCents * quantity + shippingCents;
  const totalMarginCents = pi?.metadata?.marginCents
    ? Number(pi.metadata.marginCents)
    : Math.max(0, displayCents - baseCents) * quantity;
  return { displayCents, baseCents, shippingCents, quantity, paidCents, rancherPayoutCents, totalMarginCents };
}

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
  // Money (L1): one pure resolver. displayCents is the UNIT price; qty scales
  // product + margin, shipping stays flat. totalMarginCents is the WHOLE-ORDER
  // fee — never re-multiplied by quantity (see computeSettlementMoney).
  const { displayCents, baseCents, shippingCents, quantity, paidCents, rancherPayoutCents, totalMarginCents } =
    computeSettlementMoney(pi);
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
    'Rancher Payout': rancherPayoutCents / 100,
    'BHC Margin': totalMarginCents / 100,
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
        `You keep $${dollars(totalMarginCents)} of the deposit · rancher nets $${dollars(baseCents)}.\n` +
        `Ship to (once confirmed):\n${shipTo || '(address on the order)'}`
      : isPickup
        ? `${buyerName || buyerEmail} bought ${qtyLabel}${productName} from ${rancherName} — LOCAL PICKUP.\n` +
          `You keep $${dollars(totalMarginCents)} · rancher nets $${dollars(baseCents * quantity)}.\n` +
          `${rancherName} coordinates pickup with the buyer${buyerEmail ? ` (${buyerEmail})` : ''}.`
        : `${buyerName || buyerEmail} bought ${qtyLabel}${productName} from ${rancherName}.\n` +
          `You keep $${dollars(totalMarginCents)} · rancher nets $${dollars(baseCents * quantity + shippingCents)}${shippingCents > 0 ? ` (incl. $${dollars(shippingCents)} shipping)` : ''}.\n` +
          `Tell ${rancherName} to ship to:\n${shipTo || '(address on the order)'}` +
          (!shipTo ? `\n⚠️ NO SHIP-TO CAPTURED — pull the address from the Stripe payment (${pi.id}) and get it to ${rancherName}.` : ''),
    dedupeKey: `product-sold:${pi.id}`,
  }).catch(() => {});

  // Rancher row — fetched ONCE and reused by the buyer receipt (contact block
  // + pickup address, 2026-07-29) and the rancher order notification below.
  // Best-effort: a failed read degrades to the metadata rancherName and the
  // receipt simply omits the contact/pickup details.
  let rancherRow: any = null;
  try {
    rancherRow = rancherId ? await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null) : null;
  } catch { rancherRow = null; }

  // ── RANCHER CONTACT (middle-journey audit 2026-07-29) ─────────────────────
  // The receipt previously gave the buyer NO way to reach the ranch — replies
  // dead-ended at Ben. Pickup + deposit-style orders NEED direct contact (the
  // rancher must coordinate before anything moves); shipped orders get a
  // contact line too so "where's my box?" goes to the person who packed it.
  const rancherContactEmail = String(rancherRow?.['Email'] || '').trim();
  const rancherContactPhone = String(rancherRow?.['Phone'] || '').trim();
  const rancherContactBlock = rancherContactEmail
    ? `<div style="background:#fff;border:1px solid #A7A29A;padding:14px 16px;margin:16px 0;font-size:14px">` +
      `<div style="text-transform:uppercase;letter-spacing:1px;font-size:11px;color:#A7A29A;margin-bottom:6px">your rancher</div>` +
      `<strong>${escapeHtml(rancherName)}</strong><br>` +
      `<a href="mailto:${escapeHtml(rancherContactEmail)}" style="color:#0E0E0E">${escapeHtml(rancherContactEmail)}</a>` +
      `${rancherContactPhone ? `<br>${escapeHtml(rancherContactPhone)}` : ''}` +
      `</div>`
    : '';
  const rancherContactLine = rancherContactEmail
    ? `<p style="font-size:13px;color:#5A5752">questions about your order? reach ${escapeHtml(rancherName)} directly at ` +
      `<a href="mailto:${escapeHtml(rancherContactEmail)}" style="color:#0E0E0E">${escapeHtml(rancherContactEmail)}</a>` +
      `${rancherContactPhone ? ` or ${escapeHtml(rancherContactPhone)}` : ''}.</p>`
    : '';

  // ── PICKUP TRUTH (P0, 2026-07-29) ─────────────────────────────────────────
  // A pickup buyer previously never learned WHERE to go. If the rancher filled
  // Pickup Address / Pickup Instructions, the receipt says so; when unset the
  // copy stays honest ("the ranch will reach out to set up your pickup").
  const pickupAddress = String(rancherRow?.['Pickup Address'] || '').trim();
  const pickupInstructions = String(rancherRow?.['Pickup Instructions'] || '').trim();
  const pickupWhereBlock = isPickup && (pickupAddress || pickupInstructions)
    ? `<div style="background:#fff;border:1px solid #A7A29A;padding:14px 16px;margin:16px 0;font-size:14px">` +
      `<div style="text-transform:uppercase;letter-spacing:1px;font-size:11px;color:#A7A29A;margin-bottom:6px">pickup details</div>` +
      `${pickupAddress ? `<strong>${escapeHtml(pickupAddress)}</strong>` : ''}` +
      `${pickupAddress && pickupInstructions ? '<br>' : ''}` +
      `${pickupInstructions ? `<span style="color:#5A5752">${escapeHtml(pickupInstructions).replace(/\n/g, '<br>')}</span>` : ''}` +
      `</div>`
    : '';

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
  // ── ORDER-STATUS LINK (shop-chain audit 2026-08-01) ───────────────────────
  // Until now the buyer's ONLY state model was this inbox — the product rail
  // had no buyer-facing order surface at all. Every receipt now carries the
  // signed, read-only /order/<token> link (lib/orderStatusLink). Returns ''
  // on any mint failure (no JWT secret, bad id) so a broken link is never
  // emailed — the receipt just reads as it did before.
  const orderStatusUrl = orderStatusUrlFor(String(created?.id || ''), SITE);
  const orderStatusHtml = orderStatusUrl
    ? `<p style="font-size:14px"><a href="${orderStatusUrl}" style="color:#0E0E0E">see your order &rarr;</a></p>`
    : '';
  const shareLadderPs =
    `<p style="font-size:13px;color:#5A5752;border-top:1px solid #A7A29A;padding-top:14px;margin-top:22px">` +
    `p.s. if it's good and you'd rather stop buying beef by the box, a quarter or half from a ranch like this one runs about $5.50 to $9.50 a pound and fills a freezer for the year. ` +
    `<a href="${SITE}/access?utm_source=email&utm_medium=product_receipt&utm_campaign=shop_to_share" style="color:#0E0E0E">see what's available near you</a>.</p>`;
  // Operation-type label (P4): one quiet line naming the KIND of operation.
  // PI metadata carries no shelf-stable flag, so the helper stays on the
  // frozen-agnostic "ships nationwide"; pickup orders classify null and the
  // line simply doesn't render (their copy already says pickup).
  const opTypeLine = operationTypeEmailLine(
    operationTypeFor({ type: 'product', localOnly: isPickup, depositStyle }),
  );
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
        ${opTypeLine}
        ${rancherContactBlock}
        ${orderStatusHtml}
        ${shareLadderPs}
        <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
      </div>`
        : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
        <p>hey ${buyerFirst},</p>
        <p>you're all set — <strong>${escapeHtml(rancherName)}</strong> got your order for <strong>${quantity > 1 ? `${quantity}× ` : 'a '}${escapeHtml(productName)}</strong>${isPickup ? ' and will reach out to set up your pickup at the ranch.' : ' and will ship it direct to you.'}</p>
        <p style="font-size:14px;color:#5A5752">paid: $${dollars(paidCents)}${quantity > 1 || shippingCents > 0 ? ` (${quantity > 1 ? `${quantity} × $${dollars(displayCents)}` : `$${dollars(displayCents)}`}${shippingCents > 0 ? ` + $${dollars(shippingCents)} shipping` : ''})` : ''}. ${isPickup ? 'local pickup — no shipping charged; the ranch will confirm the time and place with you.' : "you'll get tracking as soon as it's on the way."}</p>
        ${opTypeLine}
        ${isPickup ? pickupWhereBlock + rancherContactBlock : ''}
        ${!isPickup && shipTo ? `<p style="font-size:13px;color:#5A5752">shipping to:<br>${escapeHtml(shipTo).replace(/\n/g, '<br>')}<br><span style="color:#A7A29A">typo in the address? just reply to this email and we'll fix it before it ships.</span></p>` : ''}
        ${!isPickup ? rancherContactLine : ''}
        ${orderStatusHtml}
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
  // Reuses the rancherRow fetched above (one Airtable read, not two).
  try {
    const rancherEmail = rancherContactEmail;
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
        // Release this order's mint-time stock hold (oversell prevention,
        // 2026-07-29): the units now live in the Orders Left truth above, so
        // the hold's shadow must lift or the gate double-counts them against
        // the next buyer. Best-effort — TTL expires it anyway.
        const { releaseStockHold } = await import('@/lib/productStockHold');
        await releaseStockHold(productId, quantity);
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
      // ZIP CAPTURE (2026-07-25): the storefront checkout deliberately asks for
      // NO ZIP up front (two taps is the whole point), so we harvest it from
      // the address Stripe already collected at payment. This is the "capture
      // after payment" half of the fast-path decision documented in
      // /api/checkout/product/buy. buyerZipPatch drops anything that isn't a
      // real US ZIP and never stomps a ZIP the buyer told us themselves.
      const stripeZip = zipFromStripePayment(pi);
      const existingConsumers = (await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${escapeAirtableValue(buyerEmail)}"`,
      )) as any[];
      if (Array.isArray(existingConsumers) && existingConsumers.length > 0) {
        const c = existingConsumers[0];
        const stage = String(c['Buyer Stage'] || '').trim();
        const fields = {
          ...(!stage || stage === 'PRODUCT_BUYER'
            ? { ...productFields, 'Buyer Stage': 'PRODUCT_BUYER' }
            : productFields), // already in the share funnel — keep their stage
          ...buyerZipPatch(stripeZip, c['Zip']),
        };
        await updateRecord(TABLES.CONSUMERS, c.id, fields);
      } else {
        await createRecord(TABLES.CONSUMERS, {
          'Full Name': buyerName || '',
          'Email': buyerEmail,
          'Buyer Stage': 'PRODUCT_BUYER',
          ...productFields,
          ...buyerZipPatch(stripeZip, null),
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
//
// CANCEL (shop-chain audit 2026-08-01): 'Cancelled' was READ by three modules
// (fulfillmentPushRunner, fulfillmentWebhookHealth, shopifyCatalogSync) and
// WRITTEN by nobody — a buyer who changed their mind ten minutes after paying
// had no path but a support ticket. `opts.terminalStatus` lets the operator/
// rancher-initiated path record a cancel as a state distinct from a refund
// while reusing this one reconcile (stock restore, external-order cancel,
// notifications, idempotency). Both statuses are terminal here, so a webhook
// redelivery of the resulting charge.refunded can never downgrade a Cancelled
// order to Refunded.
export const TERMINAL_PRODUCT_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'Refunded',
  'Cancelled',
  // Imported/US spelling — lib/shopifyCatalogSync already treats it terminal.
  'Canceled',
]);

export async function reconcileProductOrderRefund(
  piId: string,
  opts: {
    kind: 'refund' | 'dispute';
    amountCents?: number;
    partial?: boolean;
    /** Status to record. Default 'Refunded'; 'Cancelled' for a real cancel. */
    terminalStatus?: 'Refunded' | 'Cancelled';
    /**
     * Skip the already-terminal early return. ONLY for the initiating path,
     * which flipped Status itself as its fail-closed gate BEFORE moving money
     * and still needs the side effects to run. Safe: each side effect has its
     * own durable guard ('Stock Restored At', External Push Status), and the
     * caller holds a claimOnce lock.
     */
    force?: boolean;
    /**
     * false when the RANCHER is the one cancelling — mailing them a
     * "🛑 DO NOT SHIP" alarm about their own click is noise, not safety.
     */
    notifyRancher?: boolean;
  },
): Promise<boolean> {
  if (!piId) return false;
  const terminalStatus = opts.terminalStatus || 'Refunded';
  const cancelled = terminalStatus === 'Cancelled';
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
  // Already terminal (Refunded OR Cancelled) ⇒ nothing left to do. `force`
  // is the one exception: the initiating path flipped Status itself and the
  // side effects below still have to run.
  if (!opts.force && TERMINAL_PRODUCT_ORDER_STATUSES.has(String(order['Status'] || ''))) return true;

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

  // L3: serialize concurrent full refunds/disputes on the same PI. Stripe fans
  // charge.refunded to the platform AND the Connect endpoint with DIFFERENT
  // event ids, so the Stripe-Events dedupe gives no cross-endpoint protection —
  // two reconciles can both pass the Status!=='Refunded' check above and then
  // double-restore stock / double-cancel the external order. PI-keyed claim: the
  // loser returns (this IS a product order — the winner reconciles it). Fails
  // OPEN when Redis is absent, so the durable 'Stock Restored At' marker below
  // is the second layer for the side effects.
  if (!(await claimOnce(`reconcile-refund:${piId}`, 120))) return true;

  // Durable idempotency marker for the restore/cancel side effects (survives a
  // Redis-down concurrent run + a webhook redelivery after Status was flipped
  // but before this row was re-read). NOTE: 'Stock Restored At' is a NEW Rancher
  // Orders field — until Ben adds it the stamp write below no-ops via .catch and
  // L3 degrades to claimOnce-only (still correct; the marker just can't persist).
  const stockAlreadyRestored = Boolean(order['Stock Restored At']);

  // GTM-hardening F2 (secondary): flip EVERY row for this PI — the Redis-down
  // race guard can leave a rare duplicate row, and a 'New' twin would sit on
  // the rancher's ship list after the refund.
  for (const row of rows) {
    if (TERMINAL_PRODUCT_ORDER_STATUSES.has(String(row['Status'] || ''))) continue;
    await updateRecord(TABLES.RANCHER_ORDERS, row.id, {
      'Status': terminalStatus,
      'Refunded At': new Date().toISOString(),
    }).catch(async (e: any) => {
      // A 'Cancelled' option that doesn't exist yet on the singleSelect would
      // 422 the whole patch and leave a refunded order sitting in 'New' — the
      // one state that can still ship. Fall back to 'Refunded' (money-true,
      // semantically coarser) rather than leave the ship rail open.
      console.warn('[productSettlement] terminal status write failed, falling back to Refunded:', e?.message);
      if (cancelled) {
        await updateRecord(TABLES.RANCHER_ORDERS, row.id, {
          'Status': 'Refunded',
          'Refunded At': new Date().toISOString(),
        }).catch(() => {});
      }
    });
  }
  // 'Cancelled At' is a NEW Rancher Orders field — its own best-effort patch
  // so a not-yet-created field can never 422 the status flip above.
  if (cancelled) {
    await updateRecord(TABLES.RANCHER_ORDERS, order.id, {
      'Cancelled At': new Date().toISOString(),
    }).catch(() => {});
  }

  // GTM-hardening F2 (primary): RESTORE inventory — the settle path burned one
  // 'Orders Left'; a refunded unit goes back on the shelf so the product
  // doesn't sit sold-out losing sales until the monthly check-in. Best-effort,
  // mirrors the decrement (blank = unlimited = nothing to restore).
  try {
    const productId = String(order['Product Record ID'] || '').trim();
    if (!stockAlreadyRestored && productId) {
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
  // order must stay live (buyer still gets their box). Loops ALL rows for
  // this PI (audit close 2026-07-21): the Redis-down race can leave a rare
  // duplicate row holding its OWN external order.
  try {
    const { parseIntegration, getConnector } = await import('./fulfillmentConnector');
    let integration: any = null;
    let integrationLoaded = false;
    if (!stockAlreadyRestored) for (const row of rows) {
      if (String(row['External Push Status'] || '') === 'cancelled') continue; // already cancelled
      const externalOrderId = String(row['External Order Id'] || '').trim();
      if (!externalOrderId) {
        // H2 BELT: no external order recorded yet — a push may be mid-flight in
        // its network window. Stamp 'cancelled' so (a) the net cron's blank-
        // status filter won't re-push this now-refunded order and (b) the
        // runner's decidePushDisposition short-circuits a stray push. The
        // runner's own post-push Status re-read cancels the LIVE order if the
        // push completes after this belt.
        await updateRecord(TABLES.RANCHER_ORDERS, row.id, {
          'External Push Status': 'cancelled',
        }).catch(() => {});
        continue;
      }
      if (!integrationLoaded) {
        const rancherRow = await getRecordById(TABLES.RANCHERS, String(row['Rancher Record ID'] || '')).catch(() => null);
        integration = parseIntegration(rancherRow?.['Fulfillment Integration']);
        integrationLoaded = true;
      }
      if (!integration) break;
      const res = await getConnector(integration.provider).cancelOrder(
        integration, externalOrderId, `BHC ${opts.kind} — ${String(row['Order Ref'] || '')}`.slice(0, 255));
      await updateRecord(TABLES.RANCHER_ORDERS, row.id, {
        'External Push Status': res.ok ? 'cancelled' : `cancel-failed:${res.error || 'unknown'}`.slice(0, 250),
      }).catch(() => {});
      if (!res.ok) {
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'sale',
          summary: `EXTERNAL ORDER CANCEL FAILED — ${String(row['Product Name'] || 'product')}`,
          detail:
            `Shopify order ${externalOrderId} could not be cancelled after the ${opts.kind} ` +
            `and may still ship. Cancel it manually in the rancher's store. ${res.error || ''}`,
          dedupeKey: `shopify-cancel-fail-${row.id}`,
          dedupeWindowMs: 24 * 60 * 60 * 1000,
        }).catch(() => {});
      }
    }
  } catch (e: any) {
    console.warn('[productSettlement] external cancel skipped (non-fatal):', e?.message);
  }

  // L3: stamp the durable marker once the restore/cancel pass is done, so a
  // Redis-down concurrent run or a later redelivery won't restore stock or
  // cancel a second time. Isolated + best-effort: a not-yet-created field can
  // NEVER break the Status flip / restore above (they already ran).
  if (!stockAlreadyRestored) {
    await updateRecord(TABLES.RANCHER_ORDERS, order.id, {
      'Stock Restored At': new Date().toISOString(),
    }).catch(() => {});
  }

  const product = String(order['Product Name'] || 'a product');
  const rancher = String(order['Rancher Name'] || 'the ranch');
  const amt = opts.amountCents ? ` ($${dollars(opts.amountCents)})` : '';
  const eventWord = opts.kind === 'dispute' ? 'DISPUTED' : cancelled ? 'CANCELLED' : 'REFUNDED';
  const notifyRancher = opts.notifyRancher !== false;
  await sendOperatorSignal({
    urgency: 'loud',
    kind: opts.kind === 'dispute' ? 'dispute' : 'sale',
    summary: `PRODUCT ${eventWord} — ${product}${amt}`,
    detail:
      `Order for ${product} from ${rancher} was ${opts.kind === 'dispute' ? 'disputed (chargeback)' : cancelled ? 'cancelled and refunded in full' : 'refunded'}.\n` +
      `Order flipped to ${terminalStatus}.` +
      (notifyRancher ? ` Stop-ship push + email just went straight to ${rancher} too.` : ` (${rancher} initiated it — no stop-ship alarm sent.)`),
    dedupeKey: `product-${cancelled ? 'cancel' : opts.kind}:${piId}`,
  }).catch(() => {});

  // Tell the RANCHER — the one person who can actually stop the box (Wave A
  // 2026-07-14). The ops Telegram literally said "TELL THEM TO STOP", i.e.
  // stop-ship depended on Ben manually relaying it; and the settle email
  // invites email-only fulfillment ("just reply here with the tracking"), so
  // the dashboard's 409-on-refunded guard only helps if they check first.
  // Push + email, both best-effort (a notify failure must never fail the
  // reconcile); skipped on the partial-refund branch above (order stays
  // live); idempotent via the Status==='Refunded' early-return.
  //
  // notifyRancher=false (shop-chain audit 2026-08-01): when the RANCHER is the
  // one who clicked cancel, screaming "🛑 DO NOT SHIP" back at them is noise —
  // they already know, and crying wolf is how a real stop-ship alarm gets
  // ignored. Every other path (Stripe webhook, dispute, admin) still fires it.
  const stopShipRancherId = String(order['Rancher Record ID'] || '').trim();
  const buyerNameForStopShip = String(order['Buyer Name'] || '').trim() || 'the buyer';
  if (stopShipRancherId && notifyRancher) {
    try {
      const { sendRancherPush } = await import('@/lib/rancherPush');
      await sendRancherPush(stopShipRancherId, {
        title: cancelled ? '🛑 DO NOT SHIP — order cancelled' : '🛑 DO NOT SHIP — order refunded',
        body: `${product} for ${buyerNameForStopShip} was ${opts.kind === 'dispute' ? 'charged back' : cancelled ? 'cancelled' : 'refunded'} — do not ship. Marked ${terminalStatus} in your dashboard.`,
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
          kind: cancelled ? 'cancel' : opts.kind,
        });
      } else {
        console.warn('[productSettlement] stop-ship email skipped — rancher has no email:', stopShipRancherId);
      }
    } catch (e: any) {
      console.warn('[productSettlement] stop-ship email failed (non-fatal):', e?.message);
    }
  } else if (!stopShipRancherId) {
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
        kind: opts.kind === 'dispute' ? 'dispute' : cancelled ? 'cancel' : 'refund',
        orderStatusUrl: orderStatusUrlFor(order.id),
      });
    } catch (e: any) {
      console.warn('[productSettlement] buyer refund notice failed (non-fatal):', e?.message);
    }
  }

  return true;
}
