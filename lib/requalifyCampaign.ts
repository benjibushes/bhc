// Pure half of the requalification campaign sender (route:
// app/api/campaign/requalify-send). Template is the Ben-approved copy from
// docs/marketing/email-quiz-resume.md — quiz-incomplete variant, pinned to
// Champion Valley. Body validation is strict: recipients carry ONLY
// email/name/state, so the endpoint can never be used to send arbitrary
// content. The CAN-SPAM footer + unsubscribe link are appended downstream by
// the guarded rail — do not add them here (double-footer).
//
// ── ONE-TAP DEPOSIT CTA (2026-07-30) ──────────────────────────────────────
// MEASURED PROBLEM: Champion Valley day 1 — 50 sent, 49 delivered, 27 opened
// (54%), 4 clicked (8%), 0 leads reached the rancher. Every clicker had ALREADY
// completed the funnel (Order Type, Budget, Intent Score, phone on file). The
// CTA pointed at /access — the 5 step quiz — and nobody re-answers a quiz they
// already answered, so nobody got a qualification stamp and the routing engine
// never handed them over. The campaign manufactured interest and dropped it.
//
// FIX: when we can prove the buyer is deposit-ready for THIS rancher, send the
// existing campaign-reserve 1-tap link (/r/d/<token>, lib/campaignReserve) with
// the cut pre-selected instead of the quiz. Everyone else keeps today's quiz
// link — we never send a link that will bounce.
//
// *** THIS IS NOT A QUALIFICATION BYPASS. *** decideRequalifyCta stamps
// NOTHING: no Qualified At, no Buyer Stage, no routing. The quiz-required
// routing rule (lib/qualification.ts — a buyer is routable only after funnel +
// quiz) is untouched. A one-tap recipient becomes a real lead exactly one way:
// by PAYING a deposit, which the existing deposit rail settles end to end
// (lib/stripeSettlement) — the same rule the self-serve reserve path already
// follows, and a strictly stronger signal than a quiz answer. If you are here
// to add a "just stamp them qualified" shortcut: don't.

import { assertReserveEligible, CUT_LABELS, type Cut } from '@/lib/reserveDeposit';
import { depositDisplay, MIN_TIER_PRICE } from '@/lib/pricing';
import { isActiveDealReferral } from '@/lib/capacityCount';
import { normalizeState } from '@/lib/states';
import { hasServiceZipGate, buyerZipServedBy } from '@/lib/exclusiveZip';
import { requalifySubject, type CampaignVariant } from '@/lib/campaignVariants';
import { nationwideAllowed } from '@/lib/nationwidePreference';

export type { Cut };

export const MAX_BATCH = 60;
// Domain-wide campaign ceiling per UTC day, across ALL rancher campaigns.
// The deliverability ramp (docs/marketing/launch-runbook.md) is 50-100/day for
// the WHOLE domain — five parallel rancher campaigns must share it, not
// multiply it. Enforced in the route against Email Sends truth.
export const DAILY_CAMPAIGN_BUDGET = 120;

const SITE_URL = 'https://www.buyhalfcow.com';

export interface RequalifyRecipient { email: string; name: string; state: string }
export interface CampaignRancher { name: string; slug: string }

// Rancher pricing fields per cut — same keys the deposit route and
// assertReserveEligible read, so the number we quote is the number charged.
const CUT_PRICE_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Price',
  half: 'Half Price',
  whole: 'Whole Price',
};
const CUT_DEPOSIT_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Deposit',
  half: 'Half Deposit',
  whole: 'Whole Deposit',
};

// ---------------------------------------------------------------------------
// Links (both modes keep the SAME utm triple so the funnel report still splits
// by campaign, and a one-tap vs quiz comparison is apples to apples).
// ---------------------------------------------------------------------------

export function requalifyUtm(state: string): string {
  const st = /^[A-Za-z]{2}$/.test(state) ? state.toLowerCase() : 'xx';
  return `utm_source=email&utm_medium=drip&utm_campaign=waiting-wake-${st}`;
}

export function requalifyCta(state: string, slug: string): string {
  return `${SITE_URL}/access?rancher=${slug}&${requalifyUtm(state)}`;
}

/**
 * BROKER RAIL CTA (2026-08-17). A self-serve represented ranch can now own a
 * state's wave (it passes rancherForStateTable now that it is routable supply),
 * and the quiz CTA above would have sent its recipients into /access — the
 * CONNECT funnel, whose deposit step that ranch has no Stripe account for.
 *
 * The correct destination is the ranch's OWN reserve surface: price, deposit
 * and balance on the page, and a POST that runs the broker checkout. It is
 * also strictly fewer steps than the quiz.
 *
 * The utm triple is identical to every other mode so the funnel report still
 * splits by campaign. `#reserve` is the anchor rendered by BrokerReserve and
 * must trail the query string to survive as a fragment.
 */
export function brokerReserveCta(state: string, slug: string): string {
  return `${SITE_URL}/ranchers/${encodeURIComponent(slug)}?${requalifyUtm(state)}#reserve`;
}

/**
 * The 1-tap deposit link. `token` is a campaign-reserve JWT
 * (mintCampaignReserveToken — ~30d, outlives any send window) naming
 * {consumerId, rancherSlug, cut}. /r/d/<token> verifies it, resolves the
 * buyer's own referral, sets a REFERRAL-SCOPED deposit grant (never a member
 * session) and lands them on the deposit checkout with the cut pre-selected.
 * The utm query is inert on that route (the token rides the path segment).
 */
export function requalifyOneTapCta(state: string, token: string): string {
  return `${SITE_URL}/r/d/${token}?${requalifyUtm(state)}`;
}

// ---------------------------------------------------------------------------
// Consumer resolution
// ---------------------------------------------------------------------------

/**
 * Normalize a Consumer's `Order Type` into a deposit cut.
 *
 * Real values in the wild: 'Quarter'|'Half'|'Whole' (quiz — lib/qualifyUpdates),
 * 'Quarter Cow'|'Half Cow'|'Whole Cow' (reserve rail — CUT_LABELS),
 * 'Not Sure' (quiz opt-out), 'Not specified', ''. Only the first three map;
 * everything else returns null and the buyer keeps the quiz link (we will not
 * guess a cut into a payment link). Mirrors cutLabelToCut in the demand-router.
 */
export function orderTypeToCut(orderType: unknown): Cut | null {
  const raw =
    orderType && typeof orderType === 'object' && 'name' in (orderType as Record<string, unknown>)
      ? String((orderType as Record<string, unknown>).name || '')
      : String(orderType ?? '');
  const first = raw.trim().toLowerCase().split(/\s+/)[0];
  if (first === 'quarter' || first === 'half' || first === 'whole') return first as Cut;
  return null;
}

/**
 * Pick THE Consumer row for a recipient email. Exactly one row, or nothing.
 *
 * Consumers has no unique constraint and 13 creation paths that all fail OPEN
 * to create (docs/WRITE-MAP.md — "the duplicate-pair factory"), so an email can
 * legitimately resolve to several rows.
 *
 * WHY ANY DUPLICATE IS FATAL HERE, not merely awkward: the token names ONE
 * consumerId, and /r/d creates the referral pinned to THAT row — but at the
 * deposit page resolveDepositAuth (lib/buyerAuth.ts:85) gives a full MEMBER
 * SESSION precedence over the referral-scoped grant. If the buyer's member
 * cookie was minted from the OTHER duplicate row, the deposit route's ownership
 * check (`referral.Buyer.includes(session.consumerId)`) fails and both GET and
 * POST return 403. The buyer taps a working link and dead-ends at the money
 * step. We cannot see which row their cookie names from a send job, so no
 * survivor rule — recency, first-row, or otherwise — can prove the pick is the
 * one that will be presented at checkout.
 *
 * So: one row wins outright; TWO OR MORE is ambiguous and the caller falls back
 * to the quiz, which resolves identity correctly downstream. ~1.3% of buyers
 * (33 known duplicate pairs) keep today's behavior; none of them dead-end.
 * Never guess an identity into a payment link.
 */
export function pickCanonicalConsumer(
  rows: unknown,
): { consumer: Record<string, any> | null; ambiguous: boolean } {
  const valid = (Array.isArray(rows) ? rows : []).filter(
    (r: any): r is Record<string, any> => !!r && typeof r.id === 'string' && r.id.length > 0,
  );
  if (valid.length === 0) return { consumer: null, ambiguous: false };
  if (valid.length > 1) return { consumer: null, ambiguous: true };
  return { consumer: valid[0], ambiguous: false };
}

// A deposit-intent referral is born 'Pending' (lib/reserveDeposit
// buildReserveReferralFields) — a status isActiveDealReferral does NOT count as
// active. These are the statuses that mean such a referral is DEAD; anything
// else means the buyer is holding a live, payable reservation.
const TERMINAL_REFERRAL_STATUSES = new Set([
  'Closed Won',
  'Closed Lost',
  'Dormant',
  'Refunded',
  'Lost',
]);

/**
 * Does this referral mean the buyer already holds a live deal we must not
 * stack a second deposit link on top of?
 *
 * isActiveDealReferral is the canonical predicate but its status set is the
 * CAPACITY-holding one, which starts at 'Intro Sent'. A campaign/self-serve
 * deposit intent sits at 'Pending' until it is paid — invisible to that
 * predicate. Without the second clause a buyer holding an unpaid reservation
 * with ranch A is minted a one-tap for ranch B (campaignReferral only reuses a
 * referral whose Rancher link matches), ending up with two live unpaid deposit
 * intents, both payable. Pure + synchronous.
 */
export function blocksOneTapDeposit(ref: any): boolean {
  if (isActiveDealReferral(ref)) return true;
  const matchType = String(ref?.['Match Type'] || '');
  if (!matchType.includes('Deposit')) return false;
  return !TERMINAL_REFERRAL_STATUSES.has(String(ref?.['Status'] || ''));
}

// ---------------------------------------------------------------------------
// The decision — pure. One-tap or quiz, per recipient.
// ---------------------------------------------------------------------------

export type RequalifyQuizReason =
  /** No Consumers row for this email — we have no identity to pin a token to. */
  | 'no-consumer'
  /** Several rows tie for canonical — never guess an identity into a payment link. */
  | 'ambiguous-consumer'
  /** Order Type is blank / 'Not Sure' — no cut to pre-select. */
  | 'no-cut'
  /** Rancher fails the deposit gates (Connect, operational, tier). */
  | 'rancher-ineligible'
  /** That specific cut is unpriced or below the online-deposit floor. */
  | 'cut-unpriced'
  /** Buyer's state is outside this rancher's served set (the /r/d routing belt). */
  | 'state-not-served'
  /** Nationwide (no-state-gate) offer, but the buyer explicitly opted 'local-only'. */
  | 'local-only-preference'
  /** Rancher has an exclusive ZIP territory this buyer's ZIP is outside of (or unknown). */
  | 'zip-not-served'
  /** Buyer already has a live deal — a second deposit link would double-deal them. */
  | 'active-referral'
  /** Price math produced nothing quotable — never email a blank amount. */
  | 'no-price-math';

export type RequalifyCtaDecision =
  | { mode: 'one-tap'; consumerId: string; cut: Cut; cutLabel: string; dueNowDollars: number }
  | { mode: 'quiz'; reason: RequalifyQuizReason };

export interface RequalifyCtaInput {
  /** Every Consumers row matching the recipient email (0, 1 or many). */
  consumers: unknown;
  /** The live Ranchers record for the campaign slug, or null when unresolvable. */
  rancher: Record<string, any> | null | undefined;
  /** That buyer's Referrals rows (any status) for the collision check. */
  buyerReferrals?: unknown;
  /**
   * States this rancher may take buyers from, or null for "no state gate"
   * (the curated nationwide campaign pair). Mirrors the ROUTING-STATES belt in
   * lib/campaignReferral — an out-of-zone one-tap link bounces to the public
   * page, so it must never be sent.
   *
   * REQUIRED, not optional: an omitted field would silently disable a gate the
   * redemption path still enforces. Pass `null` to mean "no gate" explicitly.
   */
  servedStates: string[] | null;
  /** depositCommissionRate(rancher, tierFor(rancher)) — resolved by the caller. */
  commissionRate: number;
}

/**
 * Decide the CTA for one recipient. ONE-TAP only when every gate below holds,
 * so a tap can never bounce:
 *
 *   1. the email resolves to exactly one canonical Consumer with a record id
 *   2. that Consumer's Order Type maps to a real cut
 *   3. the rancher passes assertReserveEligible for THAT cut — the same gate
 *      /api/checkout/deposit and /r/d already enforce (Connect active,
 *      operational, valid tier, cut priced >= MIN_TIER_PRICE)
 *   4. the buyer's state is one the rancher serves (the /r/d routing belt)
 *   5. the buyer has no active/held referral that would collide
 *   6. the money math yields a quotable all-in number
 *   7. a nationwide (servedStates=null) offer additionally requires the buyer
 *      NOT to have opted 'local-only' (Nationwide Preference — same gate
 *      matching/suggest applies to the nationwide routing fallback)
 *
 * Otherwise: quiz fallback with a reason, exactly today's behavior.
 *
 * NOT mirrored, deliberately: the rancher's live CAPACITY. lib/campaignReferral
 * re-checks it at redemption ('at-capacity' → public page) because the campaign
 * machine over-invites on purpose (openSlots x3), and a slot count read at send
 * time is stale by the time anyone taps. Capacity stays a redemption-time gate.
 *
 * Stamps nothing, routes nobody — see the module header. Pure + synchronous.
 */
export function decideRequalifyCta(input: RequalifyCtaInput): RequalifyCtaDecision {
  const quiz = (reason: RequalifyQuizReason): RequalifyCtaDecision => ({ mode: 'quiz', reason });

  const { consumer, ambiguous } = pickCanonicalConsumer(input.consumers);
  if (ambiguous) return quiz('ambiguous-consumer');
  if (!consumer) return quiz('no-consumer');

  const cut = orderTypeToCut(consumer['Order Type']);
  if (!cut) return quiz('no-cut');

  const rancher = input.rancher;
  if (!rancher) return quiz('rancher-ineligible');

  // THE gate. assertReserveEligible collapses every reject into one shape, so
  // re-read the price purely to LABEL the reason (diagnostics only — the gate
  // above is the authority, and mirroring it here is what keeps the mint and
  // the redemption in lockstep).
  if (!assertReserveEligible(rancher, cut).ok) {
    const price = Number(rancher[CUT_PRICE_FIELD[cut]]) || 0;
    return quiz(price < MIN_TIER_PRICE ? 'cut-unpriced' : 'rancher-ineligible');
  }

  // Routing-states belt — same rule lib/campaignReferral applies on redemption.
  // A blank/unprovable buyer state fails a regional rancher's gate.
  if (Array.isArray(input.servedStates)) {
    const buyerState = normalizeState(consumer['State']);
    if (!buyerState || !input.servedStates.includes(buyerState)) return quiz('state-not-served');
  }

  // Gate 7 — NATIONWIDE PREFERENCE (preference-fidelity audit 2026-08-12).
  // servedStates === null means the curated nationwide pair: the offer is a
  // cross-state ship with no state belt at all. Routing already honors the
  // buyer's explicit 'local-only' opt-out (matching/suggest skips the
  // nationwide fallback via the same nationwideAllowed helper); this campaign
  // rail must not one-tap the same buyer into the same cross-state offer.
  // Exact parity with the suggest gate: ONLY the explicit 'local-only' value
  // blocks — nationwide-ok / unset / garbage all pass (fail-open, a corrupted
  // field never strands a buyer). A rancher with a real served-states set
  // that covers the buyer's state is the LOCAL match these buyers opted to
  // wait for, so the array branch above is deliberately not preference-gated.
  if (input.servedStates === null && !nationwideAllowed(consumer['Nationwide Preference'])) {
    return quiz('local-only-preference');
  }

  // Exclusive-ZIP belt. /api/checkout/deposit runs this as its LAST gate before
  // a charge and FAILS CLOSED on an unknown ZIP, so for a contracted-territory
  // rancher every ZIP-less recipient would tap through, burn a referral + a
  // capacity hold, then 409 out_of_area at the deposit page. No-op (not even a
  // field read) for every rancher without Service ZIP Prefixes.
  if (hasServiceZipGate(rancher) && !buyerZipServedBy(consumer['Zip'], rancher)) {
    return quiz('zip-not-served');
  }

  // Collision belt. Deliberately CONSERVATIVE: any live deal sends them to the
  // quiz. Some of those referrals would in fact be reused cleanly by
  // findOrCreateCampaignReferral, but the ones it CANNOT reuse ('Awaiting
  // Payment', 'Slot Locked', or any deal with a different rancher) would spawn
  // a second deposit intent and double-deal a buyer who is already being
  // worked. On a money path we take the cheap over-block: the fallback is a
  // working quiz link, the failure mode is a duplicate charge path.
  const refs = Array.isArray(input.buyerReferrals) ? input.buyerReferrals : [];
  if (refs.some((r) => blocksOneTapDeposit(r))) return quiz('active-referral');

  // FEE-INVISIBLE money (founder directive 2026-07-01): the buyer sees ONE
  // number — dueNowCents, commission already baked in. Same helper, same rate,
  // same stored-deposit resolution as the deposit page and the charge path, so
  // the amount in the email equals the amount on the card.
  const money = depositDisplay(
    Number(rancher[CUT_PRICE_FIELD[cut]]),
    Number(rancher[CUT_DEPOSIT_FIELD[cut]]),
    input.commissionRate,
  );
  // Number.isFinite, not `> 0`: depositDisplay propagates a NaN commission rate
  // straight into dueNowCents, and `NaN <= 0` is FALSE — a bare comparison
  // waves it through and the buyer receives "$NaN today". Caught in test.
  if (!money || !Number.isFinite(money.dueNowCents) || money.dueNowCents <= 0) {
    return quiz('no-price-math');
  }

  return {
    mode: 'one-tap',
    consumerId: String(consumer.id),
    cut,
    cutLabel: CUT_LABELS[cut],
    // CEIL, not round: feeCents is round(fullCents x rate) and need not land on
    // a whole dollar (price 2591 @ 10% → 90910c → "$909" quoted vs $909.10
    // charged). Quoting BELOW the charge is the one direction a money email
    // must never round; ceil keeps the quote >= the card.
    dueNowDollars: Math.ceil(money.dueNowCents / 100),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The resolved CTA handed to the renderer (link already built by the caller). */
export type RequalifyCta =
  | { mode: 'one-tap'; url: string; cutLabel: string; dueNowDollars: number }
  | { mode: 'quiz'; url: string }
  /** Represented (broker-rail) wave owner — straight to its reserve surface. */
  | { mode: 'broker-reserve'; url: string };

const money = (dollars: number): string => `$${Math.round(dollars).toLocaleString('en-US')}`;

const SHELL_OPEN =
  '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#2b2b2b;font-size:16px;line-height:1.6">';

/**
 * Render the campaign email. `cta` omitted → the original quiz body, verbatim.
 *
 * COPY RULES: no hyphens in prose (Ben). Money model stays true — and it is
 * NOT the same model in every mode:
 *   • quiz / one-tap (CONNECT rail) — the rancher keeps 100% of the beef price
 *     and BHC's cut rides on top of the buyer's reservation, never itemized
 *     buyer-side (fee-invisible directive).
 *   • broker-reserve (BROKER rail) — the buyer's total IS the ranch's own
 *     price with nothing added on top; the deposit is "toward your share" and
 *     the balance is "paid to the ranch". Nothing rides on top, so the
 *     Connect sentence must never appear in that branch, and BHC keeping the
 *     deposit is never mentioned (docs/BUSINESS-MODEL.md model 3).
 *
 * `variant` (ADAPTIVE-MARKETING-DESIGN PR 1) selects between the two
 * repo-versioned SUBJECTS in lib/campaignVariants — the body is identical
 * across arms. Default 'A' is byte-identical to the pre-variant subject, so
 * every existing caller renders exactly what it always rendered.
 */
export function renderRequalifyEmail(
  name: string,
  state: string,
  rancher: CampaignRancher,
  cta?: RequalifyCta,
  variant: CampaignVariant = 'A',
): { subject: string; html: string } {
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  const st = /^[A-Za-z]{2}$/.test(state) ? state.toUpperCase() : 'your state';
  const subject = requalifySubject(name, variant);

  const opener = `<p>${first} — you signed up for the waitlist a while back and then heard nothing from me. That silence was real: we didn't have a ranch serving ${st}, and I wasn't going to send you hype about beef you couldn't buy.</p>`;

  if (cta && cta.mode === 'one-tap') {
    const share = cta.cutLabel.toLowerCase();
    return {
      subject,
      html: `${SHELL_OPEN}
${opener}
<p>That changed. We now have a ranch serving ${st} — ${rancher.name}. You already told me you wanted a ${share}, so I skipped the questions and built you a link that goes straight to your reservation.</p>
<p>Reserve your ${share} — ${money(cta.dueNowDollars)} today:<br><a href="${cta.url}">${cta.url}</a></p>
<p>That holds the share in your name. The rest you settle straight with ${rancher.name} when your beef is ready, and every dollar of the beef price goes to them.</p>
<p>If the timing is wrong, ignore me. You lose nothing. But the shares are a real count of what's left this round, so if a freezer full of honest beef is still the plan, it's worth a look this week.</p>
<p>— Ben</p></div>`,
    };
  }

  if (cta && cta.mode === 'broker-reserve') {
    return {
      subject,
      html: `${SHELL_OPEN}
${opener}
<p>That changed. We now have a ranch serving ${st} — ${rancher.name}. Their shares are listed with the price and the deposit right there, so you can reserve one now without waiting on a call from anybody.</p>
<p>Reserve your share:<br><a href="${cta.url}">${cta.url}</a></p>
<p>The deposit holds the share in your name. You settle the balance straight with ${rancher.name} when your beef is ready.</p>
<p>If the timing is wrong, ignore me. You lose nothing. But the shares are a real count of what's left this round, so if a freezer full of honest beef is still the plan, it's worth a look this week.</p>
<p>— Ben</p></div>`,
    };
  }

  const url = cta?.url || requalifyCta(state, rancher.slug);
  return {
    subject,
    html: `${SHELL_OPEN}
${opener}
<p>That changed. We now have a ranch serving ${st} — ${rancher.name}. One thing stands between you and a match: the 90 second quiz you started. Finish it and we route you to your rancher.</p>
<p>Finish the quiz:<br><a href="${url}">${url}</a></p>
<p>If the timing is wrong, ignore me. You lose nothing. But the shares on that page are a real count of what's left this round, so if a freezer full of honest beef is still the plan, it's worth a look this week.</p>
<p>— Ben</p></div>`,
  };
}

export function validateRequalifyBatch(body: unknown):
  | { recipients: RequalifyRecipient[]; campaign: string; dryRun: boolean; rancher: CampaignRancher; rail: string }
  | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const campaign = String(b.campaign || '').trim();
  if (!/^[a-z0-9-]{3,40}$/.test(campaign)) return { error: 'campaign must be a kebab-case slug' };
  // Claim attribution (ADAPTIVE-MARKETING-DESIGN PR 2): which rail this batch
  // belongs to — stamped to Consumers `Campaign Rail` claim-before-send. The
  // operator script omits it (default 'requalify', byte-identical behavior);
  // the campaign-autopilot cron passes 'autopilot' so an audit can tell a
  // machine wave from a hand-fired one. Optional-with-default, never blank.
  const rail = b.rail === undefined ? 'requalify' : String(b.rail || '').trim();
  if (!/^[a-z0-9-]{3,20}$/.test(rail)) return { error: 'rail must be a kebab-case slug' };
  const rr = b.rancher as Record<string, unknown> | undefined;
  const rancherName = String(rr?.name || '').trim();
  const rancherSlug = String(rr?.slug || '').trim();
  if (rancherName.length < 2 || rancherName.length > 60) return { error: 'rancher.name required (2-60 chars)' };
  if (!/^[a-z0-9-]{3,60}$/.test(rancherSlug)) return { error: 'rancher.slug must be a kebab-case slug' };
  if (!Array.isArray(b.recipients) || b.recipients.length === 0) return { error: 'recipients required' };
  if (b.recipients.length > MAX_BATCH) return { error: `max ${MAX_BATCH} recipients per call` };
  const recipients: RequalifyRecipient[] = [];
  for (const r of b.recipients) {
    const rec = r as Record<string, unknown>;
    const email = String(rec?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `invalid email: ${email.slice(0, 40)}` };
    recipients.push({ email, name: String(rec?.name || '').slice(0, 80), state: String(rec?.state || '').slice(0, 2) });
  }
  return { recipients, campaign, dryRun: b.dryRun === true, rancher: { name: rancherName, slug: rancherSlug }, rail };
}
