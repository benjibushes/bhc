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

export async function settleProductPurchase(pi: any): Promise<void> {
  const productName = String(pi?.metadata?.productName || 'a product');
  const rancherId = String(pi?.metadata?.rancherId || '');
  const rancherName = String(pi?.metadata?.rancherName || 'the ranch');
  // Email: operator links stamp metadata.buyerEmail; self-serve storefront buys
  // don't (Stripe collects it) → fall back to the charge's billing/receipt email.
  const charge0 = pi?.charges?.data?.[0] || {};
  const buyerEmail = (
    String(pi?.metadata?.buyerEmail || '').trim() ||
    String(charge0?.billing_details?.email || '').trim() ||
    String(pi?.receipt_email || '').trim()
  ).toLowerCase();
  // Name: metadata (operator) → the shipping/billing name Stripe collected.
  const buyerName = (
    String(pi?.metadata?.buyerName || '').trim() ||
    String(pi?.shipping?.name || charge0?.shipping?.name || charge0?.billing_details?.name || '').trim()
  );
  const displayCents = Number(pi?.metadata?.displayCents || 0);
  const baseCents = Number(pi?.metadata?.baseCents || 0);
  const marginCents = Number(pi?.metadata?.marginCents || Math.max(0, displayCents - baseCents));
  // DEPOSIT-STYLE (audit fix C-1.5): a price-range product where this charge is
  // a DEPOSIT, not the full price. Every notification below MUST say so — the
  // old copy told the buyer "on its way" and the rancher "pack it, ship it",
  // the exact opposite of the storefront's "balance confirmed before shipping"
  // promise. Absent/legacy PIs default to false (full-purchase copy).
  const depositStyle = String(pi?.metadata?.depositStyle || '') === 'true';

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

  const shipTo = formatShipping(pi);

  const created: any = await createRecord(TABLES.RANCHER_ORDERS, {
    // Deposit-style orders carry the marker in the ref so the ops view reads
    // the truth at a glance (no schema change needed).
    'Order Ref': `${depositStyle ? 'DEPOSIT — ' : ''}${productName} — ${buyerName || buyerEmail}`,
    'Product Name': productName,
    'Rancher Name': rancherName,
    'Rancher Record ID': rancherId,
    'Buyer Email': buyerEmail,
    'Buyer Name': buyerName,
    'Ship To Address': shipTo,
    'Buyer Paid': displayCents / 100,
    'Rancher Payout': baseCents / 100,
    'BHC Margin': marginCents / 100,
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
      : `PRODUCT SOLD — ${productName} · $${dollars(displayCents)}`,
    detail: depositStyle
      ? `${buyerName || buyerEmail} put $${dollars(displayCents)} down on ${productName} from ${rancherName}.\n` +
        `DEPOSIT-STYLE: ${rancherName} confirms size + the balance with the buyer BEFORE shipping.\n` +
        `You keep $${dollars(marginCents)} of the deposit · rancher nets $${dollars(baseCents)}.\n` +
        `Ship to (once confirmed):\n${shipTo || '(address on the order)'}`
      : `${buyerName || buyerEmail} bought ${productName} from ${rancherName}.\n` +
        `You keep $${dollars(marginCents)} · rancher nets $${dollars(baseCents)}.\n` +
        `Tell ${rancherName} to ship to:\n${shipTo || '(address on the order)'}`,
    dedupeKey: `product-sold:${pi.id}`,
  }).catch(() => {});

  // Buyer receipt (brand voice). All interpolated strings HTML-escaped.
  // Deposit-style receipt matches the storefront promise exactly: deposit
  // counts toward the total, rancher reaches out BEFORE anything ships.
  const buyerFirst = escapeHtml(buyerName ? buyerName.split(/\s+/)[0] : 'there');
  if (buyerEmail) {
    await sendEmail({
      to: buyerEmail,
      subject: depositStyle
        ? `you're set — your ${productName} deposit is in`
        : `you're set — ${productName} is on its way`,
      html: depositStyle
        ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
        <p>hey ${buyerFirst},</p>
        <p>your deposit's in — <strong>${escapeHtml(rancherName)}</strong> has your <strong>${escapeHtml(productName)}</strong> reservation and will reach out to confirm the size you want + the balance <em>before anything ships</em>.</p>
        <p style="font-size:14px;color:#5A5752">deposit paid: $${dollars(displayCents)} — it counts toward your total. nothing ships until you've confirmed the details together.</p>
        <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
      </div>`
        : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
        <p>hey ${buyerFirst},</p>
        <p>you're all set — <strong>${escapeHtml(rancherName)}</strong> got your order for a <strong>${escapeHtml(productName)}</strong> and will ship it direct to you.</p>
        <p style="font-size:14px;color:#5A5752">paid: $${dollars(displayCents)}. you'll get tracking as soon as it's on the way.</p>
        <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
      </div>`,
      templateName: 'product_receipt',
    }).catch(() => {});
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
          <p style="font-size:14px;color:#2A2A2A">you've already netted <strong>$${dollars(baseCents)}</strong> of the deposit in your Stripe account. confirm details → collect the balance → then ship &amp; reply with tracking.</p>
          <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
        </div>`
          : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
          <p>hi ${escapeHtml(rancherName)},</p>
          <p>you have a paid BuyHalfCow order to ship:</p>
          <div style="background:#fff;border:1px solid #A7A29A;padding:16px;margin:16px 0;font-size:15px">
            <strong>${escapeHtml(productName)}</strong><br>
            ship to:<br>${escapeHtml(shipTo || '(see BuyHalfCow order)').replace(/\n/g, '<br>')}
          </div>
          <p style="font-size:14px;color:#2A2A2A">you net <strong>$${dollars(baseCents)}</strong> — already routed to your Stripe account. pack it, ship it, and reply with the tracking number.</p>
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
        const next = Math.max(0, Number(left) - 1);
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
          value: displayCents / 100,
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
  opts: { kind: 'refund' | 'dispute'; amountCents?: number },
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

  await updateRecord(TABLES.RANCHER_ORDERS, order.id, {
    'Status': 'Refunded',
    'Refunded At': new Date().toISOString(),
  });

  const product = String(order['Product Name'] || 'a product');
  const rancher = String(order['Rancher Name'] || 'the ranch');
  const amt = opts.amountCents ? ` ($${dollars(opts.amountCents)})` : '';
  await sendOperatorSignal({
    urgency: 'loud',
    kind: opts.kind === 'dispute' ? 'dispute' : 'sale',
    summary: `PRODUCT ${opts.kind === 'dispute' ? 'DISPUTED' : 'REFUNDED'} — ${product}${amt}`,
    detail:
      `Order for ${product} from ${rancher} was ${opts.kind === 'dispute' ? 'disputed (chargeback)' : 'refunded'}.\n` +
      `Order flipped to Refunded. If ${rancher} hasn't shipped yet — TELL THEM TO STOP.`,
    dedupeKey: `product-${opts.kind}:${piId}`,
  }).catch(() => {});

  return true;
}
