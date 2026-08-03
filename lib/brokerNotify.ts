// BROKER RAIL — the two settlement emails, built as PURE functions.
//
// These are the deliverable of the whole rail. The represented rancher has no
// login, no dashboard, no app: this email is the ONLY thing he receives, so it
// must contain everything needed to fulfill and collect, with no follow-up.
//
// Kept free of I/O so the exact wording and the exact money lines are unit
// tested. lib/email.ts wraps these in guardedSend + Resend.
//
// THE TWO TRUTHS (see docs/BUSINESS-MODEL.md — this is deliberate, not a bug):
//   • RANCHER email states plainly that BHC kept the deposit as its commission
//     and that he nets price − deposit. He agreed to exactly this at signup
//     (/partner/represent). Never soften it — a rancher discovering the split
//     at order time is the one failure mode that kills this rail.
//   • BUYER receipt says "deposit toward your share" and "balance paid to the
//     ranch". It never mentions BHC keeping anything. The buyer's TOTAL is
//     identical to buying direct, so the split is not their transaction.
//
// FULFILLMENT TRANSPARENCY (2026-08-03). Some represented ranches sell the
// animal and hand the buyer to a separate processor who bills the buyer
// DIRECTLY on top of the share price. Both emails now carry the ranch's own
// next-steps script, and the buyer receipt restates any such third-party cost
// beside the balance line — the same words the buyer read on the checkout page
// before paying, so the receipt can never be the first place they learn of it.
// Both are optional per ranch; blank renders NOTHING, not an empty heading.

import { brokerBalanceNote, brokerFulfillmentSteps, brokerAdditionalCosts } from '@/lib/brokerRail';

/** Everything both emails need. Assembled by the settlement layer from the
 *  referral + rancher + consumer rows; no lookups happen in here. */
export interface BrokerOrderFacts {
  ranchName: string;
  /** The person at the ranch (falls back to the ranch name). */
  operatorName: string;
  rancherEmail: string;
  rancherPhone: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  /** 'pickup' / 'ship' / free text from the referral, or '' if unknown. */
  fulfillmentPref: string;
  /**
   * Coarse buyer location — state + ZIP. Verified against the live schema
   * 2026-07-31: Consumers has `State` and `Zip` and NO street-address field,
   * so there is no full delivery address to forward. The rancher arranges the
   * exact drop with the buyer directly using the phone/email above; this is
   * enough for him to know whether it is a drive or a ship.
   */
  buyerState: string;
  buyerZip: string;
  cutLabel: string;
  /** Full share price the buyer ultimately pays, in cents. */
  priceCents: number;
  /** Collected and KEPT by BHC. This is the commission, in cents. */
  depositCents: number;
  /** price − deposit. Buyer owes this to the ranch; it is the rancher's net. */
  balanceCents: number;
  /** Rancher's own instruction for collecting the balance. */
  balanceNote: string;
  /**
   * The ranch's buyer-facing "what happens next" script, one step per entry.
   * EMPTY IS NORMAL and must render nothing — not a heading with no list under
   * it. Shown to the buyer as their next steps and echoed to the rancher as
   * what the buyer was told, so both sides work from one script.
   */
  fulfillmentSteps: string[];
  /**
   * Money the buyer pays a THIRD PARTY on top of the share price — a processor's
   * cut-and-wrap bill, a hauler. Distinct from `balanceNote`, which is money to
   * the RANCH. '' means the share price is all-in; render nothing.
   */
  additionalCosts: string;
  orderRef: string;
}

export function money(cents: number): string {
  const n = Number(cents);
  const safe = Number.isFinite(n) ? n : 0;
  return `$${(safe / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Escape, then honour the line breaks a rancher typed into a multiline field. */
function escMultiline(str: unknown): string {
  return esc(str).replace(/\r?\n/g, '<br>');
}

function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Assemble the facts from already-fetched Airtable rows. Pure.
 *
 * Money comes in as cents from the caller (resolved from Stripe metadata at
 * settlement, which is the authoritative record of what was actually charged) —
 * never re-derived from the rancher record here, because the rancher's prices
 * could have been edited between checkout and settlement.
 */
export function buildBrokerOrderFacts(args: {
  rancher: any;
  referral: any;
  consumer?: any;
  cutLabel: string;
  priceCents: number;
  depositCents: number;
  orderRef: string;
}): BrokerOrderFacts {
  const { rancher, referral, consumer } = args;
  const ranchName = String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'the ranch').trim();
  const priceCents = Math.max(0, Math.round(Number(args.priceCents) || 0));
  const depositCents = Math.max(0, Math.round(Number(args.depositCents) || 0));
  return {
    ranchName,
    operatorName: String(rancher?.['Operator Name'] || ranchName).trim(),
    rancherEmail: String(rancher?.['Email'] || '').trim(),
    rancherPhone: String(rancher?.['Phone'] || '').trim(),
    buyerName: String(referral?.['Buyer Name'] || consumer?.['Full Name'] || '').trim(),
    buyerEmail: String(referral?.['Buyer Email'] || consumer?.['Email'] || '').trim(),
    buyerPhone: String(referral?.['Buyer Phone'] || consumer?.['Phone'] || '').trim(),
    fulfillmentPref: String(referral?.['Buyer Fulfillment Pref'] || referral?.['Fulfillment Method'] || '').trim(),
    buyerState: String(referral?.['Buyer State'] || consumer?.['State'] || '').trim(),
    buyerZip: String(consumer?.['Zip'] || '').trim(),
    cutLabel: String(args.cutLabel || 'Beef share').trim(),
    priceCents,
    depositCents,
    // Clamp at 0: a malformed deposit larger than the price must never render
    // a negative balance on a rancher's fulfillment sheet.
    balanceCents: Math.max(0, priceCents - depositCents),
    balanceNote: brokerBalanceNote(rancher),
    // Read from the rancher record (not the referral): these describe how THIS
    // ranch fulfills, and the receipt must repeat what the buyer already saw on
    // the checkout page, which read the same two fields.
    fulfillmentSteps: brokerFulfillmentSteps(rancher),
    additionalCosts: brokerAdditionalCosts(rancher),
    orderRef: String(args.orderRef || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// RANCHER EMAIL — the fulfillment sheet
// ---------------------------------------------------------------------------

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildBrokerRancherEmail(f: BrokerOrderFacts): BuiltEmail {
  const subject = `New order: ${f.cutLabel} for ${f.buyerName || f.buyerEmail} — ${money(f.balanceCents)} to collect`;

  const contactRows: Array<[string, string]> = [
    ['Name', f.buyerName || '(not given)'],
    ['Email', f.buyerEmail || '(not given)'],
    ['Phone', f.buyerPhone || '(not given)'],
  ];
  if (f.fulfillmentPref) contactRows.push(['Wants', f.fulfillmentPref]);
  // Location is state + ZIP only — we hold no street address (see BrokerOrderFacts).
  const where = [f.buyerState, f.buyerZip].filter(Boolean).join(' ');
  if (where) contactRows.push(['Located', where]);

  const contactHtml = contactRows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#6B4F3F;white-space:nowrap;">${esc(k)}</td><td style="padding:4px 0;font-weight:600;">${esc(v)}</td></tr>`,
    )
    .join('');

  // WHAT THE BUYER WAS TOLD — the same script the buyer read at checkout and on
  // their receipt, echoed here so ranch and buyer never contradict each other on
  // the first call. Purely informational; it does not touch the money paragraph
  // above it. Omitted entirely when this ranch set neither field.
  const hasBuyerScript = f.fulfillmentSteps.length > 0 || !!f.additionalCosts;
  const buyerScriptHtml = hasBuyerScript
    ? `
    <h2>What your buyer was told</h2>
    ${
      f.fulfillmentSteps.length
        ? `<p class="muted">These are the next steps we showed them before they paid — work from the same script:</p>
    <ol style="margin:12px 0;padding-left:20px;color:#3A3A3A;">${f.fulfillmentSteps
      .map((s) => `<li style="margin:6px 0;">${esc(s)}</li>`)
      .join('')}</ol>`
        : ''
    }
    ${
      f.additionalCosts
        ? `<p class="muted"><strong>They were also shown this cost, which they pay a third party on top of the share price:</strong><br>${escMultiline(f.additionalCosts)}</p>`
        : ''
    }`
    : '';

  const buyerScriptText = hasBuyerScript
    ? [
        '',
        'WHAT YOUR BUYER WAS TOLD',
        ...(f.fulfillmentSteps.length
          ? [
              '  These are the next steps we showed them before they paid:',
              ...f.fulfillmentSteps.map((s, i) => `  ${i + 1}. ${s}`),
            ]
          : []),
        ...(f.additionalCosts
          ? [
              '  They were also shown this cost, which they pay a third party on top of the share price:',
              ...f.additionalCosts.split(/\r?\n/).map((l) => `  ${l}`),
            ]
          : []),
      ]
    : [];

  const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 40px; border: 1px solid #A7A29A; }
    h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 8px 0; }
    h2 { font-family: Georgia, serif; font-size: 18px; margin: 32px 0 12px 0; }
    p { margin: 14px 0; color: #3A3A3A; }
    .money { background: #F4F1EC; border: 1px solid #E5E2DC; padding: 20px; margin: 20px 0; }
    .money td { padding: 6px 0; }
    .collect { font-size: 22px; font-weight: 700; color: #0E0E0E; }
    .muted { color: #6B4F3F; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>You sold a ${esc(f.cutLabel)}</h1>
    <p>Hi ${esc(f.operatorName)}, BuyHalfCow just sold a ${esc(f.cutLabel)} from ${esc(f.ranchName)}. The buyer has paid their deposit. Everything you need is below — there is nothing to log into.</p>

    <h2>Your buyer</h2>
    <table cellpadding="0" cellspacing="0">${contactHtml}</table>

    <h2>The money</h2>
    <div class="money">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td>${esc(f.cutLabel)} — full share price</td><td align="right">${money(f.priceCents)}</td></tr>
        <tr><td>Deposit BuyHalfCow collected</td><td align="right">− ${money(f.depositCents)}</td></tr>
        <tr><td colspan="2"><hr style="border:none;border-top:1px solid #A7A29A;margin:8px 0;"></td></tr>
        <tr><td class="collect">You collect from the buyer</td><td align="right" class="collect">${money(f.balanceCents)}</td></tr>
      </table>
    </div>
    <p class="muted"><strong>How this works, as agreed:</strong> the ${money(f.depositCents)} deposit is BuyHalfCow's commission for finding and closing this buyer — we keep it, and we do not invoice you for anything. You collect the remaining ${money(f.balanceCents)} directly from the buyer, so your net on this share is <strong>${money(f.balanceCents)}</strong>.</p>

    <h2>Collecting your balance</h2>
    <p>${esc(f.balanceNote)}</p>
${buyerScriptHtml}
    <h2>What to do now</h2>
    <p>Contact the buyer to confirm timing, cut sheet, and pickup or delivery. Collect the ${money(f.balanceCents)} balance yourself at fulfillment. If anything about this order is wrong, reply to this email.</p>

    <p class="muted">Order reference: ${esc(f.orderRef)}</p>
  </div>
</body>
</html>`;

  const text = [
    `You sold a ${f.cutLabel} — ${f.ranchName}`,
    '',
    'YOUR BUYER',
    ...contactRows.map(([k, v]) => `  ${k}: ${v}`),
    '',
    'THE MONEY',
    `  ${f.cutLabel} full share price: ${money(f.priceCents)}`,
    `  Deposit BuyHalfCow collected: -${money(f.depositCents)}`,
    `  YOU COLLECT FROM THE BUYER: ${money(f.balanceCents)}`,
    '',
    `As agreed: the ${money(f.depositCents)} deposit is BuyHalfCow's commission for finding and closing this buyer. We keep it and never invoice you. You collect the remaining ${money(f.balanceCents)} directly from the buyer, so your net on this share is ${money(f.balanceCents)}.`,
    '',
    'COLLECTING YOUR BALANCE',
    `  ${f.balanceNote}`,
    ...buyerScriptText,
    '',
    `Order reference: ${f.orderRef}`,
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// BUYER RECEIPT
// ---------------------------------------------------------------------------

export function buildBrokerBuyerReceipt(f: BrokerOrderFacts): BuiltEmail {
  const subject = `Your ${f.cutLabel} is reserved — ${f.ranchName}`;

  const ranchContact = [
    f.rancherEmail ? `<tr><td style="padding:4px 16px 4px 0;color:#6B4F3F;">Email</td><td style="padding:4px 0;font-weight:600;">${esc(f.rancherEmail)}</td></tr>` : '',
    f.rancherPhone ? `<tr><td style="padding:4px 16px 4px 0;color:#6B4F3F;">Phone</td><td style="padding:4px 0;font-weight:600;">${esc(f.rancherPhone)}</td></tr>` : '',
  ].join('');

  // THIRD-PARTY COST — restated immediately under the balance line, because the
  // buyer saw exactly this before they paid and the receipt must not shrink back
  // to "balance due to the ranch" and nothing else. Blank renders no row at all.
  const extraCostRow = f.additionalCosts
    ? `<tr><td colspan="2" style="padding-top:12px;">
          <div style="border-top:1px solid #A7A29A;padding-top:12px;">
            <div style="font-weight:700;">Paid separately, not to the ranch</div>
            <div style="color:#3A3A3A;margin-top:4px;">${escMultiline(f.additionalCosts)}</div>
          </div>
        </td></tr>`
    : '';

  const stepsHtml = f.fulfillmentSteps.length
    ? `<h2>What happens next</h2>
    <ol style="margin:12px 0;padding-left:20px;color:#3A3A3A;">${f.fulfillmentSteps
      .map((s) => `<li style="margin:6px 0;">${esc(s)}</li>`)
      .join('')}</ol>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 40px; border: 1px solid #A7A29A; }
    h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 8px 0; }
    h2 { font-family: Georgia, serif; font-size: 18px; margin: 32px 0 12px 0; }
    p { margin: 14px 0; color: #3A3A3A; }
    .money { background: #F4F1EC; border: 1px solid #E5E2DC; padding: 20px; margin: 20px 0; }
    .balance { font-size: 22px; font-weight: 700; }
    .muted { color: #6B4F3F; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Your ${esc(f.cutLabel)} is reserved</h1>
    <p>Hi ${esc(f.buyerName || 'there')}, thanks — your deposit went through and ${esc(f.ranchName)} is holding your ${esc(f.cutLabel)}.</p>

    <h2>Your order</h2>
    <div class="money">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td>Ranch</td><td align="right"><strong>${esc(f.ranchName)}</strong></td></tr>
        <tr><td>Share</td><td align="right"><strong>${esc(f.cutLabel)}</strong></td></tr>
        <tr><td colspan="2"><hr style="border:none;border-top:1px solid #A7A29A;margin:8px 0;"></td></tr>
        <tr><td>Total price for your share</td><td align="right">${money(f.priceCents)}</td></tr>
        <tr><td>Deposit paid today</td><td align="right">${money(f.depositCents)}</td></tr>
        <tr><td class="balance">Balance due to the ranch</td><td align="right" class="balance">${money(f.balanceCents)}</td></tr>
        ${extraCostRow}
      </table>
    </div>

    <h2>Paying the balance</h2>
    <p>The remaining <strong>${money(f.balanceCents)}</strong> is paid <strong>directly to ${esc(f.ranchName)}</strong> — not to BuyHalfCow. ${esc(f.balanceNote)}</p>
${
  f.additionalCosts
    ? `
    <h2>The cost paid separately</h2>
    <p>${escMultiline(f.additionalCosts)}</p>
    <p class="muted">You pay that directly to the third party who does that work. It is separate from your ${money(f.depositCents)} deposit and from the ${money(f.balanceCents)} balance you pay ${esc(f.ranchName)}.</p>
`
    : ''
}
    ${stepsHtml}

    <h2>Your ranch</h2>
    <p>${esc(f.operatorName)} will be in touch to arrange your cut sheet and pickup or delivery. You can reach them directly:</p>
    <table cellpadding="0" cellspacing="0">${ranchContact || '<tr><td class="muted">Contact details will come with their first message.</td></tr>'}</table>

    <p class="muted">Order reference: ${esc(f.orderRef)}</p>
  </div>
</body>
</html>`;

  const text = [
    `Your ${f.cutLabel} is reserved — ${f.ranchName}`,
    '',
    'YOUR ORDER',
    `  Ranch: ${f.ranchName}`,
    `  Share: ${f.cutLabel}`,
    `  Total price for your share: ${money(f.priceCents)}`,
    `  Deposit paid today: ${money(f.depositCents)}`,
    `  BALANCE DUE TO THE RANCH: ${money(f.balanceCents)}`,
    '',
    'PAYING THE BALANCE',
    `  The remaining ${money(f.balanceCents)} is paid directly to ${f.ranchName}, not to BuyHalfCow.`,
    `  ${f.balanceNote}`,
    ...(f.additionalCosts
      ? [
          '',
          'THE COST PAID SEPARATELY',
          ...f.additionalCosts.split(/\r?\n/).map((l) => `  ${l}`),
          `  You pay that directly to the third party who does that work. It is separate from your ${money(f.depositCents)} deposit and from the ${money(f.balanceCents)} balance you pay ${f.ranchName}.`,
        ]
      : []),
    ...(f.fulfillmentSteps.length
      ? ['', 'WHAT HAPPENS NEXT', ...f.fulfillmentSteps.map((s, i) => `  ${i + 1}. ${s}`)]
      : []),
    '',
    'YOUR RANCH',
    `  ${f.operatorName}`,
    f.rancherEmail ? `  Email: ${f.rancherEmail}` : '',
    f.rancherPhone ? `  Phone: ${f.rancherPhone}` : '',
    '',
    `Order reference: ${f.orderRef}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Operator Telegram card
// ---------------------------------------------------------------------------

export function buildBrokerOperatorCard(f: BrokerOrderFacts): string {
  return [
    `🤝 <b>BROKER SALE</b> — ${esc(f.cutLabel)}`,
    '',
    `Ranch: <b>${esc(f.ranchName)}</b> (represented, off-platform)`,
    `Buyer: ${esc(f.buyerName || f.buyerEmail)}`,
    '',
    `Share price: ${money(f.priceCents)}`,
    `<b>BHC commission (deposit, kept in full): ${money(f.depositCents)}</b>`,
    `Rancher collects direct: ${money(f.balanceCents)}`,
    '',
    `Rancher emailed the fulfillment sheet. No Connect, no payout, no invoice.`,
    `Ref: ${esc(f.orderRef)}`,
  ].join('\n');
}
