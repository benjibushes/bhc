// Rancher Vertical — all writes from /rancher, /ranchers/[slug], /api/rancher/*
// MUST route here. Close-completion logic was previously duplicated in 3 places
// (dashboard PATCH, quick-action email link, Telegram close-amount reply). Each
// copy drifted independently — capacity decrement, Buyer Stage flip, Missed
// Responses reset, activity stamps. recordClose() is the single source of truth.

import { updateRecord, getRecordById, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { shouldDecrementOnClose } from '@/lib/refundLifecycle';
import { transitionBuyerStage } from './buyer';
import { funnelRecord } from '@/lib/funnelMetrics';
import { ensureBuyerAffiliate } from '@/lib/affiliates';
import { sendAffiliateWelcome } from '@/lib/email';
import {
  fireCapi,
  buildUserData,
  reconstructFbc,
  closePurchaseEnabled,
  depositPurchaseEnabled,
  shouldFireClosePurchase,
} from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';

const AFFILIATE_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export type ReferralStatus =
  | 'Pending Approval'
  | 'Intro Sent'
  | 'Rancher Contacted'
  | 'Negotiation'
  | 'Awaiting Payment'
  | 'Closed Won'
  | 'Closed Lost';

export interface RecordCloseInput {
  referralId: string;
  rancherId: string;
  outcome: 'won' | 'lost' | 'awaiting_payment';
  saleAmount?: number;
  reason?: string;
  closeReason?: 'no_response' | 'price' | 'timing' | 'other';
  // MONEY-TRUTH TAIL finding 2 (2026-07-01): caller-specific stamps that must
  // ride the SAME single Referrals write as the close (atomicity — a second
  // update could fail separately, leaving a closed deal without its stamps).
  // Merged AFTER the base fields so a caller may override (confirm-payment
  // preserves a pre-existing 'Closed At'). Existing callers pass nothing and
  // are byte-identical — pinned in rancher.recordCloseUpdates.test.ts.
  extraFields?: Record<string, any>;
}

/**
 * Pure field-builder for recordClose's single Referrals write. Extracted so
 * the byte-preservation guarantee (existing callers) and the extraFields
 * merge order (new confirm-payment delegation) are unit-testable without
 * mocking Airtable.
 */
export function buildRecordCloseUpdates(
  input: RecordCloseInput,
  nowIso: string,
): Record<string, any> {
  const nextStatus: ReferralStatus =
    input.outcome === 'won' ? 'Closed Won' :
    input.outcome === 'lost' ? 'Closed Lost' :
    'Awaiting Payment';
  const updates: Record<string, any> = {
    'Status': nextStatus,
    'Closed At': nowIso,
    'Last Rancher Activity At': nowIso,
    'Rancher Engaged Flag': true,
  };
  if (input.outcome === 'won' && typeof input.saleAmount === 'number') {
    updates['Sale Amount'] = input.saleAmount;
  }
  if (input.extraFields) Object.assign(updates, input.extraFields);
  return updates;
}

/**
 * Pure per-row close behavior (My Leads, 2026-07-29). A rancher-entered lead
 * ('Referral Source' = 'rancher-added', lib/rancherLeads) closes through the
 * SAME recordClose contract as every other deal, with three deliberate
 * differences, decided here so they are unit-testable:
 *   - skipCapacityDecrement: the lead never INCR'd a capacity slot (it was
 *     never routed), so a DECR would drift the Redis counter low and
 *     over-book the rancher until the next truth reseed.
 *   - skipAffiliateAndCapi: no affiliate-welcome email to a buyer who never
 *     consented to BHC email, and no Meta Purchase — this sale was the
 *     rancher's own sourcing, attributing it to ads would poison bidding.
 *   - lostBuyerHandling 'close': a lost rancher-entered lead must NOT be
 *     restored to READY / Ready-to-Buy (that would drop the rancher's own
 *     customer into BHC's routing pool). They go quietly to CLOSED.
 */
export function recordCloseBehavior(ref: any): {
  skipCapacityDecrement: boolean;
  skipAffiliateAndCapi: boolean;
  lostBuyerHandling: 'restore' | 'close';
} {
  const src = ref?.['Referral Source'];
  const srcStr =
    src && typeof src === 'object' && 'name' in (src as any)
      ? String((src as any).name || '')
      : String(src ?? '');
  const rancherAdded = srcStr.trim() === 'rancher-added';
  return {
    skipCapacityDecrement: rancherAdded,
    skipAffiliateAndCapi: rancherAdded,
    lostBuyerHandling: rancherAdded ? 'close' : 'restore',
  };
}

export async function recordClose(input: RecordCloseInput): Promise<{ ok: boolean; capacityFreed: boolean }> {
  const ref: any = await getRecordById(TABLES.REFERRALS, input.referralId);
  if (!ref) return { ok: false, capacityFreed: false };
  const prevStatus = String(ref['Status'] || '') as ReferralStatus;
  const behavior = recordCloseBehavior(ref);

  const now = new Date().toISOString();
  const nextStatus: ReferralStatus =
    input.outcome === 'won' ? 'Closed Won' :
    input.outcome === 'lost' ? 'Closed Lost' :
    'Awaiting Payment';

  await updateRecord(TABLES.REFERRALS, input.referralId, buildRecordCloseUpdates(input, now));

  // Wave-2 fix: the DECR decision derives from the canonical held set
  // (HELD_REFERRAL_STATUSES via shouldDecrementOnClose), not the old local
  // ACTIVE_REF_STATES. That set (a) included 'Pending Approval' — pre-INCR,
  // so closing from it freed a slot never taken (drift DOWN, over-booking) —
  // and (b) excluded 'Awaiting Payment'/'Slot Locked' — so tier_v2 closes
  // from those skipped the DECR (drift UP, phantom-full ranchers). Also:
  // outcome='awaiting_payment' now frees NOTHING (held → held per canon; the
  // slot frees once, at the real terminal close) — pre-fix it double-freed
  // when the deal later closed Won from Awaiting Payment.
  let capacityFreed = false;
  if (!behavior.skipCapacityDecrement && shouldDecrementOnClose(prevStatus, nextStatus)) {
    try {
      const newCount = await decrementCapacity(input.rancherId);
      await syncCapacityToAirtable(input.rancherId, newCount);
      capacityFreed = true;
    } catch (capErr: any) {
      console.warn('[contracts.recordClose] capacity decrement failed:', capErr?.message);
    }
  }

  // Buyer Stage propagation. Closed Won + Closed Lost normally flip to CLOSED.
  // Awaiting Payment keeps the buyer in MATCHED until final close lands —
  // a partial pay-on-delivery deal should not flip the buyer to CLOSED yet.
  //
  // F-2 audit fix: Closed Lost is NOT terminal for the buyer when they have
  // no other active referrals. Pre-fix, rancher passes/loses a deal →
  // Buyer Stage=CLOSED forever → stuck-buyer-recovery cron skips them
  // (only retries READY). Dead-end. Now: on Closed Lost, check for other
  // active referrals; if none, restore Buyer Stage=READY + Ready to Buy=true
  // so the buyer re-enters the routing pool.
  const buyerIds: string[] = (ref['Buyer'] || []) as string[];
  const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
  if (buyerId && input.outcome === 'won') {
    try {
      // Only on the FIRST transition into Closed Won — a re-run (dual webhook
      // delivery, or a read-blip retry) must not re-flip an already-CLOSED buyer.
      if (prevStatus !== 'Closed Won') {
        await transitionBuyerStage(buyerId, 'CLOSED', `referral:${nextStatus}`);
      }
    } catch (e: any) {
      console.warn('[contracts.recordClose] Buyer Stage flip failed:', e?.message);
    }

    // P2-A audit fix: auto-enroll Closed Won buyer as affiliate AND send the
    // welcome email. Single helper (enrollClosedWonAffiliate) so every close
    // path — Stripe webhook tier_v2, admin contract, Telegram quick-action,
    // legacy dashboard PATCH — gets identical enrollment + welcome behavior.
    // Pre-fix the dashboard PATCH path called ensureBuyerAffiliate WITHOUT
    // firing the welcome email; the tier_v2 Stripe webhook path skipped
    // enrollment entirely. Fire-and-forget: never block the close path.
    //
    // T2.2 (2026-07-02): also pays the UPSTREAM affiliate ('Referred By' on
    // the buyer) — ONLY on a fresh transition into Closed Won so dual webhook
    // delivery / retries can never double-credit a commission.
    //
    // My Leads: rancher-entered leads skip enrollment entirely — the welcome
    // email is a BHC marketing touch this buyer never consented to, and the
    // sale wasn't sourced by any affiliate.
    if (!behavior.skipAffiliateAndCapi) {
      await enrollClosedWonAffiliate(buyerId, {
        ...(prevStatus !== 'Closed Won' &&
        typeof input.saleAmount === 'number' &&
        input.saleAmount > 0
          ? {
              credit: {
                referralId: input.referralId,
                rancherId: input.rancherId,
                saleAmount: input.saleAmount,
              },
            }
          : {}),
      });
    }

    // Meta CAPI: the attributed Purchase for this close. recordClose covers the
    // Stripe final-invoice, Telegram/quick-action, and tier_v2 webhook close
    // paths. The rancher-dashboard PATCH and admin PATCH close INLINE (not via
    // recordClose), so those routes call fireClosePurchaseIfEnabled() directly
    // too — all routed through the one gated helper (env flag + first-transition
    // guard + positive amount). Off-session, so attribution rides on the buyer's
    // stored fbclid rebuilt into _fbc. When the flag is off, settleFinalInvoice
    // keeps firing its legacy Purchase (no double-count). Never blocks the close.
    if (!behavior.skipAffiliateAndCapi) {
      fireClosePurchaseIfEnabled({
        referralId: input.referralId,
        buyerId,
        saleAmount: input.saleAmount,
        prevStatus,
        closedAtIso: now,
      });
    }
  }
  if (buyerId && input.outcome === 'lost') {
    if (behavior.lostBuyerHandling === 'close') {
      // Rancher-entered lead: the buyer belongs to the RANCHER. Never restore
      // them to READY / Ready-to-Buy — that would hand the rancher's own
      // customer to the routing pool. Quiet CLOSED, nothing else.
      try {
        await transitionBuyerStage(buyerId, 'CLOSED', 'rancher-crm:lost');
      } catch (e: any) {
        console.warn('[contracts.recordClose] rancher-crm lost buyer flip failed:', e?.message);
      }
    } else {
      await restoreBuyerAfterClosedLost(buyerId, input.referralId);
    }
  }

  // Only on a FRESH transition — a re-run (dual webhook delivery / retry) must
  // not double-count close revenue in the funnel metrics.
  if (prevStatus !== nextStatus) {
    await funnelRecord({
      stage: `close:${input.outcome}`,
      rancherId: input.rancherId,
      referralId: input.referralId,
      amount: input.saleAmount,
    });
  }

  // Close any open Threads for this referral on terminal close. Awaiting
  // Payment keeps threads Active (deal still in progress; rancher may still
  // need to message buyer about delivery). Non-fatal: a Threads write failure
  // shouldn't block the close.
  if (input.outcome === 'won' || input.outcome === 'lost') {
    try {
      const { getAllRecords, updateRecord } = await import('@/lib/airtable');
      const { THREADS_TABLE, threadsByReferralFormula } = await import('./threads');
      // Exact-match on the denormalized {Referral Id Text} first; legacy
      // ARRAYJOIN scan only when that returns nothing (pre-field rows). The
      // legacy scan never actually matched in this base (Referrals' primary
      // field is empty — see threadsByReferralFormula), so this close hook was
      // dead until the denorm field shipped. Whole block is non-fatal already.
      let threads: any[] = await getAllRecords(
        THREADS_TABLE,
        `AND(${threadsByReferralFormula(input.referralId)}, {Status} = "Active")`,
      );
      if (threads.length === 0) {
        threads = await getAllRecords(
          THREADS_TABLE,
          `AND(${threadsByReferralFormula(input.referralId, { legacy: true })}, {Status} = "Active")`,
        );
      }
      for (const t of threads) {
        try {
          await updateRecord(THREADS_TABLE, t.id, { 'Status': 'Closed' });
        } catch (e: any) {
          console.warn('[contracts.recordClose] thread close failed:', t.id, e?.message);
        }
      }
    } catch (e: any) {
      console.warn('[contracts.recordClose] thread close lookup failed:', e?.message);
    }
  }

  return { ok: true, capacityFreed };
}

/**
 * Fire the attributed Closed-Won Purchase to Meta CAPI. Server-side and
 * off-session (rancher/admin close — no buyer browser), so we rebuild the
 * buyer's _fbc from their stored fbclid + click-time ms. event_time is the real
 * close time (within Meta's 7-day website-event window); event_id is the
 * referral id so it shares the dedup key with any prior event for this deal.
 * Best-effort: callers wrap in .catch and never let this block a close.
 */
async function fireClosedWonPurchase(args: {
  buyerId: string;
  referralId: string;
  saleAmount: number;
  closedAtIso: string;
}): Promise<void> {
  // DEDUP GUARD (deposit vs close). The deposit Purchase is the PRIMARY paid-ad
  // conversion and counts ONCE per deal. When the deposit-Purchase flag is on
  // AND this referral already paid a deposit (Deposit Paid At stamped by
  // settleBuyerDeposit), its Purchase already fired at deposit-paid — firing
  // again here would double-count the deal's value in Meta. Suppress. Legacy
  // no-deposit closes (no stamp) still fire — the close is their only Purchase.
  // A read failure fails OPEN to the pre-deposit behavior (fire) so a transient
  // Airtable blip never silently drops a real close conversion.
  const refForGuard: any = await getRecordById(TABLES.REFERRALS, args.referralId).catch(() => null);
  const depositPaidAt = refForGuard?.['Deposit Paid At'];
  if (!shouldFireClosePurchase({ depositPurchaseEnabled: depositPurchaseEnabled(), depositPaidAt })) {
    return;
  }

  const buyer: any = await getRecordById(TABLES.CONSUMERS, args.buyerId).catch(() => null);
  if (!buyer?.['Email']) return; // no match key → nothing useful to send

  const fullName = String(buyer['Full Name'] || '').trim();
  const nameParts = fullName ? fullName.split(/\s+/) : [];
  const fbclid = String(buyer['fbclid'] || '').trim();
  const fbclidTs = Number(buyer['fbclid_ts'] || 0);
  const fbc = reconstructFbc(fbclid, fbclidTs);

  const parsed = Date.parse(args.closedAtIso);
  const eventTime = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);

  await fireCapi([{
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: metaEventId(args.referralId),
    // system_generated, not 'website': this is a server-initiated close with no
    // buyer browser, so we have no event_source_url / client_user_agent — and
    // Meta DISCARDS action_source='website' events that omit those. fbc is still
    // honored for attribution under system_generated. Matches the legacy fire.
    action_source: 'system_generated',
    event_source_url: AFFILIATE_SITE_URL,
    user_data: buildUserData({
      email: String(buyer['Email']).toLowerCase(),
      firstName: nameParts[0] || undefined,
      lastName: nameParts.slice(1).join(' ') || undefined,
      state: String(buyer['State'] || '') || undefined,
      fbc,
    }),
    custom_data: {
      value: args.saleAmount,
      currency: 'usd',
      content_name: 'Beef — full sale',
      content_category: 'closed-won',
    },
  }]);
}

/**
 * Gated entry point for the attributed Closed-Won Purchase, callable from EVERY
 * close path: recordClose() (Stripe final-invoice, Telegram/quick-action,
 * tier_v2 webhook) AND the rancher-dashboard + admin PATCH routes that close
 * inline without recordClose. Fires at most once per close:
 *   - only when META_CLOSE_PURCHASE_ENABLED is on,
 *   - only on the FIRST transition into Closed Won (prevStatus guard — a re-close
 *     / re-edit, or a later final-invoice on an already-won deal, is a no-op so
 *     we never lean on Meta's ~48h event_id dedup window),
 *   - only with a positive sale amount and a known buyer.
 * Fire-and-forget: synchronous gating, detached CAPI call, never blocks a close.
 */
export function fireClosePurchaseIfEnabled(args: {
  referralId: string;
  buyerId: string | null;
  saleAmount?: number;
  prevStatus?: string;
  closedAtIso: string;
}): void {
  if (!closePurchaseEnabled()) return;
  if (!args.buyerId) return;
  if (args.prevStatus === 'Closed Won') return;
  if (typeof args.saleAmount !== 'number' || !Number.isFinite(args.saleAmount) || args.saleAmount <= 0) return;
  fireClosedWonPurchase({
    buyerId: args.buyerId,
    referralId: args.referralId,
    saleAmount: args.saleAmount,
    closedAtIso: args.closedAtIso,
  }).catch((e: any) =>
    console.error('[contracts.fireClosePurchaseIfEnabled] Purchase CAPI fire failed:', e?.message),
  );
}

/**
 * P2-A audit helper. Exported so the legacy dashboard PATCH path
 * (app/api/rancher/referrals/[id]/route.ts) can share the same affiliate
 * enrollment + welcome email flow as recordClose() without re-implementing
 * it. Idempotent via ensureBuyerAffiliate's email-based lookup — calling
 * this twice for the same buyer is a no-op on the second call.
 *
 * T2.2 (2026-07-02) additions, all fire-and-forget:
 *   - opts.welcomeEmail=false → SILENT enrollment (mint + stamp, no email).
 *     Used at deposit-settle so the success page + /member can show the
 *     buyer's share link immediately; the welcome email still fires exactly
 *     once, at Closed Won (enrollment is idempotent, and the email only
 *     sends on a FRESH mint — an existing row skips it).
 *   - an EXISTING affiliate row now backfills the Consumer 'Affiliate Code'
 *     stamp when missing (pre-fix: existing rows early-returned, so /member
 *     never showed their code).
 *   - opts.credit → pays the UPSTREAM affiliate who referred this buyer
 *     ('Referred By', stamped at signup/reserve with self-referral blocks).
 *     Caller passes it ONLY on a fresh Closed Won transition so webhook
 *     retries can't double-credit.
 *
 * Fire-and-forget: every internal step swallows its own error so a Resend
 * outage or Airtable hiccup never blocks the close path.
 */
export async function enrollClosedWonAffiliate(
  buyerId: string,
  opts: {
    welcomeEmail?: boolean;
    credit?: { referralId: string; rancherId: string; saleAmount: number };
  } = {},
): Promise<void> {
  if (!buyerId) return;
  const welcomeEmail = opts.welcomeEmail !== false;
  try {
    const buyerRecord: any = await getRecordById(TABLES.CONSUMERS, buyerId);
    const buyerEmail = String(buyerRecord?.['Email'] || '').trim();
    const buyerFullName = String(buyerRecord?.['Full Name'] || '');
    if (!buyerEmail) return;

    // Upstream credit — the affiliate who SENT this buyer gets paid on the
    // close. Independent of the buyer's own enrollment below; runs first so
    // an enrollment hiccup can't eat the payout.
    if (opts.credit && Number.isFinite(opts.credit.saleAmount) && opts.credit.saleAmount > 0) {
      const referredBy = String(buyerRecord?.['Referred By'] || '').trim();
      if (referredBy) {
        try {
          const { creditAffiliateOnClose } = await import('@/lib/affiliates');
          await creditAffiliateOnClose({
            code: referredBy,
            referralId: opts.credit.referralId,
            rancherId: opts.credit.rancherId,
            buyerId,
            saleAmount: opts.credit.saleAmount,
          });
        } catch (e: any) {
          console.warn('[enrollClosedWonAffiliate] upstream credit failed:', e?.message);
        }
      }
    }

    const result = await ensureBuyerAffiliate({
      consumerId: buyerId,
      email: buyerEmail,
      fullName: buyerFullName,
    });
    if (!result || !result.code) return;

    // Stamp Consumer row so a re-edit of Closed Won doesn't re-process.
    // Audit trail + dedup signal for downstream crons. Also backfills the
    // stamp when the affiliate row pre-existed but the Consumer was never
    // stamped (the /member share card reads this field).
    const alreadyStamped = String(buyerRecord?.['Affiliate Code'] || '').trim();
    if (!alreadyStamped) {
      try {
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Affiliate Created At': new Date().toISOString(),
          'Affiliate Code': result.code,
        });
      } catch (e: any) {
        console.warn('[enrollClosedWonAffiliate] affiliate stamp failed:', e?.message);
      }
    }

    // Welcome email — EXACTLY once per buyer, at the first welcomeEmail=true
    // call (i.e. at Closed Won). The dedupe is 'Affiliate Welcomed At' on the
    // Consumer, NOT result.existing — a buyer silently enrolled at deposit-
    // settle has an existing row by close time but has never been welcomed.
    // Silent (deposit) calls never send. Belt: if the stamp field is missing
    // from the schema the stamp write strips silently, and the only re-send
    // exposure is a re-fired close — which recordClose already guards.
    if (!welcomeEmail) return;
    if (String(buyerRecord?.['Affiliate Welcomed At'] || '').trim()) return;

    // Fail silently if Resend errors. Mirrors the link shape used by
    // /api/admin/affiliates POST for consistency.
    try {
      const buyerLink = `${AFFILIATE_SITE_URL}/access?ref=${encodeURIComponent(result.code)}`;
      const rancherLink = `${AFFILIATE_SITE_URL}/partner?ref=${encodeURIComponent(result.code)}`;
      const dashboardUrl = `${AFFILIATE_SITE_URL}/affiliate`;
      await sendAffiliateWelcome({
        name: buyerFullName || buyerEmail,
        email: buyerEmail,
        code: result.code,
        dashboardUrl,
        buyerLink,
        rancherLink,
      });
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Affiliate Welcomed At': new Date().toISOString(),
      }).catch(() => {});
    } catch (e: any) {
      console.warn('[enrollClosedWonAffiliate] sendAffiliateWelcome failed:', e?.message);
    }
  } catch (e: any) {
    console.warn('[enrollClosedWonAffiliate] failed:', e?.message);
  }
}

// F-2 audit helper. Exported so non-contract close paths (Telegram reject /
// closelost callbacks, dashboard PATCH legacy branch) can apply the same
// "restore READY if no other active referrals" logic without re-implementing
// the Airtable lookup + branch. Caller is responsible for stamping the
// Referral row itself — this helper only handles the Buyer side.
export async function restoreBuyerAfterClosedLost(buyerId: string, referralId: string): Promise<{ restored: boolean }> {
  if (!buyerId) return { restored: false };
  try {
    const safeBuyerId = escapeAirtableValue(buyerId);
    const safeRefId = escapeAirtableValue(referralId);
    const otherActive: any[] = await getAllRecords(
      TABLES.REFERRALS,
      `AND(SEARCH("${safeBuyerId}", ARRAYJOIN({Buyer})), {Status} != "Closed Won", {Status} != "Closed Lost", {Status} != "Dormant", RECORD_ID() != "${safeRefId}")`,
    );
    const now = new Date().toISOString();
    if (otherActive.length === 0) {
      const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
      const existingNotes = String(buyer?.['Notes'] || '');
      const auditStamp = `[auto-restore READY after Closed Lost ref=${referralId} @ ${now}]`;
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Buyer Stage': 'READY',
        'Buyer Stage Updated At': now,
        'Ready to Buy': true,
        'Referral Status': 'Unmatched',
        'Notes': existingNotes ? `${existingNotes}\n${auditStamp}` : auditStamp,
      });
      await funnelRecord({ stage: 'transition:READY', buyerId, reason: `auto-restore:after-Closed Lost` });
      return { restored: true };
    } else {
      await transitionBuyerStage(buyerId, 'MATCHED', `referral:Closed Lost:other-active`);
      return { restored: false };
    }
  } catch (e: any) {
    console.warn('[contracts.restoreBuyerAfterClosedLost] failed:', e?.message);
    try {
      await transitionBuyerStage(buyerId, 'CLOSED', `referral:Closed Lost:restore-failed`);
    } catch {}
    return { restored: false };
  }
}
