// BROKER RAIL × THE MATCHING ENGINE — what a match is allowed to send.
//
// ⚠️ THIS FILE IS A MONEY GUARD. Read docs/BUSINESS-MODEL.md model 3 first.
//
// Making a self-serve represented ranch routable (lib/brokerRail
// isBrokerRoutable + lib/rancherEligibility) put broker ranches into
// app/api/matching/suggest — a pipeline written entirely for the CONNECT rail.
// Its final act is to INTRODUCE the two sides: it emails the rancher the
// buyer's details and emails the buyer the RANCHER'S EMAIL AND PHONE, then
// texts them "they'll call you in 24-48h".
//
// On the Connect rail that is correct and costs nothing — BHC's commission is
// an application_fee collected on the rancher's own Stripe account at deposit
// time, so the two parties talking is the product.
//
// On the BROKER rail it is a total revenue loss. There is no application_fee.
// BHC's ENTIRE fee is the deposit the buyer pays on BHC's own Stripe account
// (lib/brokerCheckout). Hand a matched buyer the ranch's phone number and they
// simply buy from the ranch directly: the ranch is paid, the buyer is fed, and
// BHC earns exactly $0 on a lead it sourced, qualified, and routed.
//
// Two more things the Connect ending would do to a represented ranch, which
// never signed up for any of it:
//   • email it a lead with a 30-day quick-action JWT whose buttons post to a
//     dashboard it has no login for;
//   • state in that email that Closed Won "auto-generates the 10% commission
//     invoice" — an agreement it never signed. On this rail it is never
//     invoiced; it simply collects price − deposit from the buyer.
//
// SO: a broker match is DEPOSIT-FIRST. The buyer is sent to the ranch's own
// reserve/deposit surface to pay BHC the deposit; the ranch hears about it at
// SETTLEMENT (lib/brokerSettlement), when there is money and a real order to
// tell it about. Nobody is handed anyone's phone number in between, and the
// operator alert goes to BEN, because there is no ranch inbox to alert.
//
// HERMETIC — imports lib/brokerRail + lib/brokerSelfServe (both pure) and
// nothing else, so every decision here is unit-tested without Airtable, Stripe
// or Resend. The route consumes the plan; it must never re-derive it.

import {
  isBrokerRancher,
  isBrokerRoutable,
  formatUsdCents,
  type Cut,
} from '@/lib/brokerRail';
import { buildBrokerSelfServeView, type BrokerSelfServeView } from '@/lib/brokerSelfServe';

export type MatchRail = 'broker' | 'connect';

/**
 * Every notification the matching engine can fire at the end of a match,
 * decided ONCE from the matched rancher. Booleans (not a rail string the route
 * re-interprets) so each send site reads as its own named guard and a removed
 * guard is a visible diff.
 */
export interface MatchNotificationPlan {
  rail: MatchRail;
  /** Connect-shaped lead email to the RANCHER: buyer contact details, 30-day
   *  quick-action JWT, commission-invoice copy. Never on the broker rail. */
  rancherLeadEmail: boolean;
  /** Buyer intro that REVEALS the rancher's email + phone (sendBuyerIntroNotification).
   *  Never on the broker rail — this is the direct-transaction leak. */
  buyerIntroHandoff: boolean;
  /** "they'll text or call you in the next 24-48h" SMS. Never on the broker
   *  rail: nobody is going to call, and it would invite the same direct deal. */
  expectACallSms: boolean;
  /** Broker-correct buyer email whose only CTA is the deposit surface. */
  brokerReserveInvite: boolean;
  /** Tell BEN a represented ranch just got a buyer. He is the one who
   *  coordinates it; there is no ranch dashboard to notify. */
  operatorHandoffAlert: boolean;
}

const CONNECT_PLAN: MatchNotificationPlan = {
  rail: 'connect',
  rancherLeadEmail: true,
  buyerIntroHandoff: true,
  expectACallSms: true,
  brokerReserveInvite: false,
  operatorHandoffAlert: false,
};

const BROKER_PLAN: MatchNotificationPlan = {
  rail: 'broker',
  rancherLeadEmail: false,
  buyerIntroHandoff: false,
  expectACallSms: false,
  brokerReserveInvite: true,
  operatorHandoffAlert: true,
};

/**
 * The one decision. `isBrokerRancher` — NOT `isBrokerRoutable` — is the test:
 * routability decides whether a broker ranch may be MATCHED, but once one has
 * been matched by any path (routing, a direct `?rancher=` pin, an admin
 * reassign, a stale flag flipped mid-request) the rail it is on is the only
 * thing that decides what may be sent. A represented ranch that somehow
 * reached the end of the pipeline while NOT routable must still never be
 * emailed a Connect lead, and its buyer must still never be handed its phone
 * number.
 *
 * FAIL-CLOSED, STATED EXACTLY (2026-08-17 — the old comment promised "fail
 * closed toward the broker plan" while the code returned CONNECT_PLAN for a
 * null rancher; the comment was the lie, so the CODE moved):
 *
 *   • rancher is not an object (null, undefined, a bare record id) → BROKER.
 *     Nothing was read, so Connect cannot be proven, and the Connect ending is
 *     the irreversible one: contact details out, fee gone.
 *   • a real row with NO `Broker Rail` key → CONNECT. This is deliberately NOT
 *     treated as unknown: Airtable omits unchecked checkboxes from the fields
 *     payload entirely, so "no key" is the normal wire shape of every Connect
 *     rancher in the base. Failing closed on it would silently convert the
 *     whole platform to the broker plan and stop the Connect rail dead — a
 *     far worse outcome than the leak it would be guarding against.
 *
 * Same contract, same reasoning, as lib/brokerDownstream's
 * BROKER_RAIL_FAIL_CLOSED — which is what every rail DOWNSTREAM of the match
 * consults.
 */
export function planMatchNotifications(rancher: any): MatchNotificationPlan {
  if (!rancher || typeof rancher !== 'object') return BROKER_PLAN;
  return isBrokerRancher(rancher) ? BROKER_PLAN : CONNECT_PLAN;
}

/** Convenience for the route's log line + referral stamp. */
export function isBrokerMatch(rancher: any): boolean {
  return planMatchNotifications(rancher).rail === 'broker';
}

/** Re-exported so callers importing the match layer don't also have to reach
 *  into brokerRail for the routability question. */
export { isBrokerRoutable };

// ---------------------------------------------------------------------------
// Where a matched broker buyer is sent
// ---------------------------------------------------------------------------

/**
 * Buyer's requested share → the broker cut key, or null when the buyer never
 * said. Mirrors the `buyerTier` derivation in matching/suggest (substring
 * match on Order Type: "Quarter Cow", "half", "Whole Cow — ~440 lbs", …).
 */
export function brokerCutForOrderType(orderType: unknown): Cut | null {
  const ot = String(orderType ?? '').toLowerCase();
  if (ot.includes('quarter')) return 'quarter';
  if (ot.includes('half')) return 'half';
  if (ot.includes('whole')) return 'whole';
  return null;
}

/**
 * The buyer's destination. Both options are the EXISTING broker deposit path —
 * nothing new is minted here, and neither is ever a raw Stripe URL (repo rule
 * #3):
 *
 *   • `deep`  — /checkout/<refId>/broker?cut=<cut>, the page the /r/b tap and
 *     the self-serve reserve POST both land on. Used when the buyer told us
 *     which share they want, so the match is one tap from paying.
 *   • `page`  — /ranchers/<slug>, the ranch's public self-serve reserve
 *     surface. Used when the cut is unknown (the buyer picks there). Its POST
 *     runs findOrCreateBrokerReferral, which REUSES this same referral rather
 *     than duplicating it — that is why the match stamps Match Type
 *     BROKER_MATCH_TYPE.
 *
 * Returns a PATH; the caller prefixes the origin (and, for the deep link,
 * wraps it in the member-verify magic link so the deposit auth resolves).
 */
export function brokerMatchDestinationPath(args: {
  slug: string;
  referralId: string;
  cut: Cut | null;
}): { kind: 'deep' | 'page'; path: string } {
  const slug = String(args.slug || '').trim();
  const referralId = String(args.referralId || '').trim();
  if (args.cut && referralId) {
    return { kind: 'deep', path: `/checkout/${referralId}/broker?cut=${args.cut}` };
  }
  return { kind: 'page', path: `/ranchers/${encodeURIComponent(slug)}` };
}

// ---------------------------------------------------------------------------
// The buyer email — PURE, so the copy contract is unit-tested
// ---------------------------------------------------------------------------
//
// COPY CONTRACT (identical to lib/brokerSelfServe + lib/brokerNotify's buyer
// receipt): the deposit is "toward your share"; the balance is "paid to the
// ranch"; a third-party processor bill is disclosed BEFORE payment. The buyer's
// total is the ranch's own price, unchanged from buying direct, so the split is
// not their transaction — that BHC keeps the deposit is NEVER stated, hinted
// at, or implied by the word "fee" or "commission" anywhere in this email.
//
// It also never contains the ranch's email or phone. That is not squeamishness
// about contact details: it is the entire reason this rail earns anything.

function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface BrokerMatchInviteFacts {
  buyerFirstName: string;
  ranchName: string;
  ranchState: string;
  /** Absolute URL to the broker deposit surface. */
  reserveUrl: string;
  /** The share the buyer asked for, when they said. */
  requestedCutLabel?: string;
  view: BrokerSelfServeView;
}

export interface BuiltBrokerMatchInvite {
  subject: string;
  html: string;
  text: string;
}

/** One "Quarter Cow — $1,050 total · $250 today · $800 to the ranch" line. */
function cutLine(c: BrokerSelfServeView['cards'][number]): string {
  const total = c.weightPriced && c.priceMaxCents
    ? `estimated ${formatUsdCents(c.priceCents)}–${formatUsdCents(c.priceMaxCents)}`
    : formatUsdCents(c.priceCents);
  const balance = c.weightPriced && c.balanceMaxCents !== undefined
    ? `${formatUsdCents(c.balanceCents)}–${formatUsdCents(c.balanceMaxCents)}`
    : formatUsdCents(c.balanceCents);
  return `${c.label} — ${total} total · ${formatUsdCents(c.depositCents)} deposit today · ${balance} to the ranch`;
}

/**
 * The buyer's match email on the broker rail. Replaces BOTH the Connect intro
 * (rancher email + phone + "expect a call") and the SMS: one CTA, and it is the
 * deposit.
 */
export function buildBrokerMatchInvite(f: BrokerMatchInviteFacts): BuiltBrokerMatchInvite {
  const ranch = f.ranchName || 'your local ranch';
  const where = f.ranchState ? ` in ${f.ranchState}` : '';
  const subject = `Your share is ready to reserve — ${ranch}`;
  const lines = f.view.cards.map(cutLine);
  const first = f.buyerFirstName || 'there';

  const stepsHtml = f.view.fulfillmentSteps.length
    ? `<h2>What happens next</h2><ol>${f.view.fulfillmentSteps
        .map((s) => `<li>${esc(s)}</li>`)
        .join('')}</ol>`
    : '';
  const costsHtml = f.view.additionalCosts
    ? `<p class="muted"><strong>Also billed separately:</strong> ${esc(f.view.additionalCosts)}</p>`
    : '';
  const pricingHtml = f.view.pricingNote
    ? `<p class="muted">${esc(f.view.pricingNote)}</p>`
    : '';
  const askedFor = f.requestedCutLabel
    ? `<p>You told us you were after a ${esc(f.requestedCutLabel)} — that's reserved for you below.</p>`
    : '';

  const html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height:1.6; color:#0E0E0E; background:#F4F1EC; margin:0; padding:20px; }
  .container { max-width:600px; margin:0 auto; background:#fff; padding:40px; border:1px solid #A7A29A; }
  h1 { font-family:Georgia, serif; font-size:26px; margin:0 0 8px; }
  h2 { font-family:Georgia, serif; font-size:18px; margin:28px 0 10px; }
  p { margin:14px 0; color:#3A3A3A; }
  .box { background:#F4F1EC; border:1px solid #E5E2DC; padding:20px; margin:20px 0; }
  .cut { margin:0 0 8px; }
  .cta { display:inline-block; padding:14px 26px; background:#0E0E0E; color:#F4F1EC; text-decoration:none; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; font-size:13px; }
  .muted { color:#6B4F3F; font-size:14px; }
</style></head>
<body><div class="container">
  <h1>We found your beef, ${esc(first)}</h1>
  <p><strong>${esc(ranch)}</strong>${esc(where)} has shares available and can take your order now.</p>
  ${askedFor}

  <h2>Your options</h2>
  <div class="box">
    ${lines.map((l) => `<p class="cut">${esc(l)}</p>`).join('')}
  </div>
  ${pricingHtml}

  <p>Reserve with the deposit and your share is held. You pay the balance to ${esc(ranch)} directly.</p>
  <p style="margin:26px 0;"><a class="cta" href="${esc(f.reserveUrl)}">Reserve my share</a></p>

  <p class="muted">${esc(f.view.balanceNote)}</p>
  ${costsHtml}
  ${stepsHtml}

  <p class="muted">Questions about the ranch, the cuts, or timing? Just reply to this email and we'll sort it out for you.</p>
</div></body></html>`;

  const text = [
    `We found your beef, ${first}.`,
    ``,
    `${ranch}${where} has shares available and can take your order now.`,
    ...(f.requestedCutLabel ? [``, `You told us you were after a ${f.requestedCutLabel}.`] : []),
    ``,
    `YOUR OPTIONS`,
    ...lines.map((l) => `  • ${l}`),
    ...(f.view.pricingNote ? [``, f.view.pricingNote] : []),
    ``,
    `Reserve with the deposit and your share is held. You pay the balance to ${ranch} directly.`,
    ``,
    `Reserve my share: ${f.reserveUrl}`,
    ``,
    f.view.balanceNote,
    ...(f.view.additionalCosts ? [``, `Also billed separately: ${f.view.additionalCosts}`] : []),
    ...(f.view.fulfillmentSteps.length
      ? [``, `WHAT HAPPENS NEXT`, ...f.view.fulfillmentSteps.map((s, i) => `  ${i + 1}. ${s}`)]
      : []),
    ``,
    `Questions about the ranch, the cuts, or timing? Just reply to this email.`,
  ].join('\n');

  return { subject, html, text };
}

/** Assemble the invite from the raw rancher row. Keeps the route from knowing
 *  how a broker view is built. Returns null when the ranch has no sellable cut
 *  (nothing honest to send — the route falls back to sending nothing). */
export function brokerMatchInviteFor(args: {
  rancher: any;
  buyerFirstName: string;
  reserveUrl: string;
  requestedCutLabel?: string;
}): BuiltBrokerMatchInvite | null {
  const view = buildBrokerSelfServeView(args.rancher);
  if (!view.cards.length) return null;
  return buildBrokerMatchInvite({
    buyerFirstName: args.buyerFirstName,
    ranchName: String(args.rancher?.['Ranch Name'] || args.rancher?.['Operator Name'] || ''),
    ranchState: String(args.rancher?.['State'] || '').trim(),
    reserveUrl: args.reserveUrl,
    requestedCutLabel: args.requestedCutLabel,
    view,
  });
}

/**
 * Ben's card. On this rail HE is the coordination — the ranch has no dashboard,
 * gets no lead email, and hears nothing until settlement. Buyer contact details
 * belong here (internal, operator-only) and nowhere in the ranch's direction.
 */
export function buildBrokerMatchOperatorCard(args: {
  ranchName: string;
  ranchState: string;
  buyerName: string;
  buyerState: string;
  orderType: string;
  reserveUrl: string;
  invited: boolean;
}): { summary: string; detail: string } {
  const summary =
    `BROKER MATCH: ${args.buyerName || 'a buyer'} (${args.buyerState || '?'}) routed to ` +
    `${args.ranchName || 'a represented ranch'} (${args.ranchState || '?'}) — deposit-first, ranch NOT notified.`;
  const detail = [
    `Represented ranch, so nothing was sent to the ranch and the buyer was never given its email or phone.`,
    args.orderType ? `Asked for: ${args.orderType}` : '',
    args.invited
      ? `Buyer was emailed the reserve link: ${args.reserveUrl}`
      : `NO buyer email went out (the ranch has no sellable cut priced) — reach out by hand: ${args.reserveUrl}`,
    `BHC's fee on this sale is the deposit, collected on our own Stripe account. The ranch hears about it at settlement, with money already in.`,
  ]
    .filter(Boolean)
    .join('\n');
  return { summary, detail };
}
