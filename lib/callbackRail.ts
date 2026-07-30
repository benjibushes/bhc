// lib/callbackRail.ts
//
// THE INBOUND CALLBACK RAIL — config, and the rule about WHERE a phone number
// is allowed to appear.
//
// The rail turns outbound cold dialing into inbound hot calls: instead of Ben
// working a list, the hottest buyers raise their own hand and jump the queue.
// That only works if the affordance is RARE. A phone number sprinkled across
// the site manufactures exactly the tire-kicker calls the rail exists to
// replace, so the number is allowed on precisely two kinds of surface:
//
//   1. the deposit checkout page — someone is looking at a real dollar amount,
//      and a human can unblock it in ninety seconds; and
//   2. the member dashboard of a buyer with a live, PAID deal — they already
//      wired money, so they have earned a person.
//
// NEVER on a cold or browse surface: homepage, /shop browse, quiz start,
// waitlist confirmations. If you are about to add a third call site, the
// question to answer first is "is money on the table on this page, and can a
// human unblock it right now?" If the answer is no, do not add it.
//
// ── TWO INDEPENDENT SWITCHES, both server-side, both off by default ─────────
//
//   CALLBACK_RAIL_ENABLED — the master flag for the whole buyer-facing rail.
//     Off (default): no callback UI renders anywhere, and the request endpoint
//     answers as though it does not exist. The desk, the ranking helper, and
//     the mark-handled action are NOT gated on this — they are inert with no
//     rows and must keep working the instant the flag flips.
//
//   CALLBACK_PHONE — the actual line, in any parseable format. UNSET BY
//     DEFAULT and there is deliberately no fallback, no placeholder, and no
//     "coming soon" copy: with no number configured the call/text affordance
//     renders NOTHING. There is no phone number anywhere in this repository.
//
// They are independent on purpose. Flag ON + phone UNSET is a supported, useful
// state: the "have Ben call me" request button needs no number to work, so the
// inbound rail can run before the line exists. Never make one imply the other.
//
// Both are read at REQUEST time from the server environment (never
// NEXT_PUBLIC_*, which is frozen into the client bundle at build time), so
// going live is an env change in the dashboard, not a redeploy.
//
// PURE apart from the default `process.env` read — every function takes an env
// bag so the whole config surface is unit-testable (lib/callbackRail.test.ts).

import { normalizeToE164 } from './phoneE164';
import { formatPhoneInput } from './phoneFormat';

export const CALLBACK_RAIL_FLAG_ENV = 'CALLBACK_RAIL_ENABLED';
export const CALLBACK_PHONE_ENV = 'CALLBACK_PHONE';

/** Minimal shape of the env bag these readers need. */
export type EnvBag = Record<string, string | undefined>;

/**
 * Values that turn the rail ON. Everything else — unset, empty, 'false', '0',
 * 'off', a typo — leaves it off. A feature that shows buyers a phone number
 * must never come up hot because someone set the var to the wrong word.
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);

/** Master flag for the buyer-facing rail. Default OFF. */
export function isCallbackRailEnabled(env: EnvBag = process.env): boolean {
  return TRUTHY.has(String(env?.[CALLBACK_RAIL_FLAG_ENV] ?? '').trim().toLowerCase());
}

export interface CallbackPhone {
  /** E.164, for tel:/sms: hrefs. */
  e164: string;
  /** Human display, e.g. national format. */
  display: string;
  telHref: string;
  smsHref: string;
}

/**
 * Resolve the configured line, or null.
 *
 * Returns null — meaning "render no call/text affordance at all" — when the var
 * is unset, blank, or cannot be coerced to E.164. FAILS CLOSED: a half-typed
 * number would render a tel: link that dials nowhere, which is worse than no
 * link, because the buyer believes they tried.
 */
export function resolveCallbackPhone(env: EnvBag = process.env): CallbackPhone | null {
  const raw = String(env?.[CALLBACK_PHONE_ENV] ?? '').trim();
  if (!raw) return null;
  const e164 = normalizeToE164(raw);
  if (!e164) return null;
  // formatPhoneInput is the repo's one phone display formatter; it strips a
  // leading US country code and groups the rest. A non-US number formats to
  // something odd-looking, so fall back to the E.164 itself in that case
  // rather than showing a mangled string.
  const display = /^\+1\d{10}$/.test(e164) ? formatPhoneInput(e164) : e164;
  return { e164, display, telHref: `tel:${e164}`, smsHref: `sms:${e164}` };
}

// ── WHEN a member deserves the affordance ──────────────────────────────────

/**
 * A deal is "stalled on the rancher" after this many days of silence following
 * acceptance. Chosen to sit just past the 24–48h the buyer was promised on the
 * deposit page, with several days of grace — so this only fires once the buyer
 * has genuinely begun to wonder, never on a deal that is simply young.
 */
export const STALLED_ON_RANCHER_DAYS = 7;

/**
 * The member-page fields this reads. camelCase — Airtable names stay in the
 * route, exactly as lib/buyerDealStage does it.
 */
export interface MemberCallbackDeal {
  status?: string;
  depositPaidAt?: string;
  rancherAcceptedAt?: string;
  handoffDate?: string;
  processingDate?: string;
  fulfillmentStatus?: string;
  fulfillmentConfirmedAt?: string;
  finalInvoiceSentAt?: string;
  finalPaidAt?: string;
}

/** Deals that are over. A finished or dead deal earns no callback affordance. */
const DEAD_STATUSES = new Set(['Closed Lost', 'Lost', 'Refunded', 'Rejected']);

const present = (v: unknown): boolean => String(v ?? '').trim().length > 0;

const parsed = (v: unknown): number | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/** Live deal with the buyer's money already in it. */
export function isPaidLiveDeal(deal: MemberCallbackDeal): boolean {
  return present(deal?.depositPaidAt) && !DEAD_STATUSES.has(String(deal?.status ?? '').trim());
}

/**
 * Has this paid deal gone quiet on the RANCHER's side?
 *
 * The signal is deliberately cheap — every field is already on the member
 * page's referral row, so this costs no extra read:
 *   paid · accepted · and then nothing. No handoff date, no processing date,
 *   no fulfillment status, no final invoice, no completion — for
 *   STALLED_ON_RANCHER_DAYS.
 *
 * Any one of those stamps means the rancher moved, and the deal is not stalled
 * no matter how old the acceptance is.
 */
export function isStalledOnRancher(deal: MemberCallbackDeal, now: number): boolean {
  if (!isPaidLiveDeal(deal)) return false;
  const accepted = parsed(deal?.rancherAcceptedAt);
  if (accepted == null) return false;
  const moved =
    present(deal?.handoffDate) ||
    present(deal?.processingDate) ||
    present(deal?.fulfillmentStatus) ||
    present(deal?.fulfillmentConfirmedAt) ||
    present(deal?.finalInvoiceSentAt) ||
    present(deal?.finalPaidAt);
  if (moved) return false;
  return now - accepted >= STALLED_ON_RANCHER_DAYS * 86_400_000;
}

export type MemberCallbackReason = 'stalled-on-rancher' | 'paid-deal';

/**
 * Should the member dashboard offer a human, and why?
 *
 * `stalled-on-rancher` wins when any deal qualifies, because it changes the
 * copy from "we're here if you need us" to "this one's been quiet — let's
 * chase it", which is the message that actually saves the deal. Returns null
 * for a buyer with no paid live deal: browsing the dashboard is not a reason
 * to get a phone number.
 */
export function resolveMemberCallbackReason(
  deals: MemberCallbackDeal[] | null | undefined,
  now: number,
): MemberCallbackReason | null {
  const live = (deals || []).filter(isPaidLiveDeal);
  if (live.length === 0) return null;
  return live.some((d) => isStalledOnRancher(d, now)) ? 'stalled-on-rancher' : 'paid-deal';
}
