// lib/reserveTracking.ts — the event SHAPE decisions for the two public
// reserve forms (app/ranchers/[slug]/DepositReserveForm.tsx on the Connect
// rail, app/ranchers/[slug]/BrokerReserve.tsx on the broker rail).
//
// Pure on purpose. The forms are 'use client' components that cannot be
// imported under `tsx --test`, so the two decisions that were actually wrong
// live here where they can be pinned:
//
// ── 1. VALUE = WHAT THE CARD IS CHARGED ────────────────────────────────────
// Both forms used to report the rancher's LISTED price. On the Connect rail
// the buyer is charged deposit + platform fee (money model 1: the rancher
// keeps 100% of the listed price, the fee is added ON TOP and collected as one
// payment at deposit — lib/pricing depositDisplay.dueNowCents). On the broker
// rail the card is charged the deposit and nothing else, ever (money model 3
// — the balance is paid to the ranch off-platform and no event confirms it).
//
// Reporting the listed price therefore inflated every ad conversion, and — the
// part that actually broke reporting — it DISAGREED with the server-side
// InitiateCheckout, which reports totalChargedCents / 100
// (app/api/checkout/deposit/route.ts, lib/stripeSettlement, lib/brokerCapi).
// A deduped Pixel/CAPI pair keeps ONE of the two fires, so two different
// values for the same event_id means the reported value is a coin flip.
// dueNow is also what the eventual deposit Purchase reports, so AddToCart →
// InitiateCheckout → Purchase now form one consistent value ladder.
//
// ── 2. THE CLIENT InitiateCheckout MUST CARRY THE SERVER'S event_id ────────
// Both forms fired an InitiateCheckout with NO event_id, so it could not
// dedup against the referral-keyed server fires — one buyer journey produced
// two InitiateCheckouts and the IC→Purchase rate was meaningless. The id is
// the RAW Airtable referral record id (lib/analytics metaEventId — no prefix,
// no namespace), passed through lib/track as fbq's 4th-arg {eventID}.
//
// We keep the client fire (rather than deleting it) because it is the EARLIEST
// and best-attributed signal on the rail: it happens in the buyer's browser,
// with their cookies, at the moment of intent. Meta keeps the first fire it
// receives for a given (event_name, event_id) and drops the rest, so sending
// it with the right id preserves that signal while removing the duplicate.

import { metaEventId } from '@/lib/analytics';

export interface ReserveEventInput {
  /** Rancher display name → content_name. */
  ranchName: string;
  /** Rancher slug → the creative-attribution segment. */
  ranchSlug: string;
  /** 'Half' / 'Half Cow' … → content_category. */
  cutLabel: string;
  /**
   * ALL-IN dollars the buyer's card is charged at deposit. Connect rail:
   * depositDisplay().dueNowCents / 100 (deposit + fee). Broker rail:
   * the cut's depositCents / 100. NEVER the listed share price.
   */
  dueNowDollars: number;
  /**
   * The referral record id, once one exists. Absent on AddToCart (no referral
   * has been minted yet) and on any InitiateCheckout whose response did not
   * carry one — in which case no event_id is sent at all, which is strictly
   * better than sending a wrong one.
   */
  referralId?: string;
}

export interface ReserveEvent {
  name: 'AddToCart' | 'InitiateCheckout';
  params: Record<string, string | number>;
}

/**
 * Money for a conversion payload. Never NaN, never negative, never a price:
 * an unreadable value reports 0 (which Meta accepts) rather than poisoning the
 * conversion-value column. Rounded to cents — Meta stores a decimal, and a
 * float artefact in the value column is noise in every ROAS report.
 */
function eventValue(dollars: unknown): number {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

function baseParams(input: ReserveEventInput): Record<string, string | number> {
  return {
    content_name: input.ranchName,
    content_category: input.cutLabel,
    ranchSlug: input.ranchSlug,
    value: eventValue(input.dueNowDollars),
    currency: 'USD',
  };
}

/**
 * Cut selected on a rancher page. NO event_id: there is no server-side
 * AddToCart to dedup against, and no referral exists yet.
 */
export function reserveAddToCartEvent(input: ReserveEventInput): ReserveEvent {
  return { name: 'AddToCart', params: baseParams(input) };
}

/**
 * Reservation accepted, buyer is being sent to checkout. Carries the raw
 * referral id as event_id so Meta folds this into the ONE InitiateCheckout the
 * referral's server-side fires already produce.
 */
export function reserveInitiateCheckoutEvent(input: ReserveEventInput): ReserveEvent {
  const params = baseParams(input);
  const referralId = String(input.referralId || '').trim();
  if (referralId) params.event_id = metaEventId(referralId);
  return { name: 'InitiateCheckout', params };
}

/**
 * Pull the referral id out of a checkout path the reserve APIs hand back.
 *
 * The broker endpoint returns only `{ redirect: '/checkout/<refId>/broker?…' }`
 * (lib/campaignReserve brokerDepositPathFor), so the id has to be read off the
 * path there. Fails CLOSED — anything that is not an own-origin, absolute
 * /checkout/<id>/(broker|deposit) path returns '', and the caller then fires
 * with no event_id rather than a fabricated one.
 */
export function referralIdFromCheckoutPath(path: unknown): string {
  const p = String(path ?? '');
  const m = /^\/checkout\/([A-Za-z0-9_-]{3,})\/(?:broker|deposit)(?:[/?#]|$)/.exec(p);
  return m ? m[1] : '';
}
