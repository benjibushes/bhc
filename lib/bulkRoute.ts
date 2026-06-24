import { getAllRecords, updateRecord, createRecord, escapeAirtableValue, TABLES } from './airtable';
import { sendEmail, sendBuyerIntroNotification } from './email';
import { normalizeState, normalizeStates } from './states';
import { isQualifiedForRouting } from './qualification';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import jwt from 'jsonwebtoken';

import { JWT_SECRET, generateMemberLoginToken } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export type BulkRouteSummary = {
  state: string;
  targetRancher: string;
  dryRun: boolean;
  scheduledAt?: string;
  totalConsumers: number;
  processed: number;
  skipped_already_intro_sent: number;
  skipped_unqualified: number;
  unqualified_reasons: Record<string, number>;
  updated_stuck_referral: number;
  created_new_referral: number;
  canceled_duplicates: number;
  emails_sent_rancher: number;
  emails_sent_buyer: number;
  errors: string[];
  details: any[];
};

export type BulkRouteResult =
  | { ok: true; summary: BulkRouteSummary }
  | { ok: false; error: string; status: number };

// Routes all stuck consumers in a given state to a target rancher.
//   - Cancels duplicate Pending Approval referrals (keeps latest per consumer)
//   - Updates the latest stuck referral to Intro Sent, points at target rancher, sends intro emails
//   - Creates fresh Intro Sent referrals for Unmatched/Waitlisted consumers, sends intro emails
// If `scheduledAt` is provided (ISO date), Resend holds and delivers emails at that time.
export async function bulkRouteStateToRancher(opts: {
  state: string;
  rancherSlug: string;
  dryRun?: boolean;
  scheduledAt?: string;
}): Promise<BulkRouteResult> {
  // Normalize the target state to a 2-letter code. Prevents bugs when callers
  // pass full state names ("Montana") which would never match buyer states
  // stored as 2-letter codes ("MT") in Airtable.
  const state = normalizeState(opts.state);
  const slug = opts.rancherSlug;
  const dryRun = !!opts.dryRun;
  const scheduledAt = opts.scheduledAt;

  if (!state || !slug) {
    return { ok: false, error: 'state and rancherSlug are required', status: 400 };
  }

  // 1. Find target rancher
  const allRanchers: any[] = await getAllRecords(TABLES.RANCHERS);
  const rancher = allRanchers.find((r: any) => (r['Slug'] || '') === slug);
  if (!rancher) {
    return { ok: false, error: `Rancher with slug "${slug}" not found`, status: 404 };
  }
  const rancherId = rancher.id;
  const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
  const rancherEmail = rancher['Email'] || '';
  const rancherPhone = rancher['Phone'] || '';
  const rancherSlug = rancher['Slug'] || '';

  // Validate the rancher is actually operational for buyers. Use the single-
  // source gate the matcher uses (lib/rancherEligibility) instead of a bare
  // Active Status check. The old check let bulkRoute (go-live auto-router +
  // admin/Telegram manual routes) send buyers to a tier_v2 rancher whose
  // deposit endpoint 409s (Connect not active / past_due / onboarding not
  // Live / agreement unsigned) — a dead-end conversion. This mirrors the
  // gate at app/api/matching/suggest/route.ts (isEligibleBase).
  if (!isRancherOperationalForBuyers(rancher)) {
    return { ok: false, error: `Rancher "${rancherName}" is not operational for buyers`, status: 400 };
  }

  // 2. Find all consumers in the state with Status=Approved
  const consumers: any[] = await getAllRecords(
    TABLES.CONSUMERS,
    `AND({State} = "${escapeAirtableValue(state)}", {Status} = "Approved")`
  );

  // ── PRE-FIRE TELEGRAM (2026-06-05 hardening) ───────────────────────
  // Loud alert BEFORE the loop fires so the operator sees the planned
  // fan-out and can manually intervene before emails go out. Includes
  // count + target + dry-run state. Fires even in dryRun so the path
  // is verified during testing.
  if (consumers.length > 5) {
    try {
      const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('./telegram');
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📣 <b>BULKROUTE PRE-FIRE</b>\n\n` +
          `About to route up to <b>${consumers.length}</b> buyers in ${state} → ${rancherName}\n` +
          `Mode: ${dryRun ? '🧪 DRY RUN' : '🚀 LIVE'}\n\n` +
          `<i>If this is unexpected, set MATCHING_ENABLED=false in Vercel env IMMEDIATELY to halt. Otherwise this proceeds.</i>`,
      );
    } catch {}
  }

  // Kill-switch check (2026-06-05): allows operator to halt mid-run by
  // flipping env. Eval at top of every batch so a runaway iteration can
  // be stopped between buyers.
  if (process.env.MATCHING_ENABLED === 'false') {
    return { ok: false, error: 'Matching engine paused via MATCHING_ENABLED=false', status: 503 };
  }

  // 3. Find all existing referrals in the state
  const referrals: any[] = await getAllRecords(
    TABLES.REFERRALS,
    `{Buyer State} = "${escapeAirtableValue(state)}"`
  );

  // Index referrals by consumer email
  const refsByEmail: Record<string, any[]> = {};
  for (const r of referrals) {
    const email = (r['Buyer Email'] || '').toLowerCase().trim();
    if (!email) continue;
    if (!refsByEmail[email]) refsByEmail[email] = [];
    refsByEmail[email].push(r);
  }

  const now = new Date().toISOString();
  const summary: BulkRouteSummary = {
    state,
    targetRancher: rancherName,
    dryRun,
    scheduledAt,
    totalConsumers: consumers.length,
    processed: 0,
    skipped_already_intro_sent: 0,
    skipped_unqualified: 0,
    unqualified_reasons: {},
    updated_stuck_referral: 0,
    created_new_referral: 0,
    canceled_duplicates: 0,
    emails_sent_rancher: 0,
    emails_sent_buyer: 0,
    errors: [],
    details: [],
  };

  for (const consumer of consumers) {
    try {
      const buyerId = consumer.id;
      const buyerEmail = (consumer['Email'] || '').toLowerCase().trim();
      const buyerName = consumer['Full Name'] || '';
      const buyerPhone = consumer['Phone'] || '';
      const buyerState = consumer['State'] || state;
      const orderType = consumer['Order Type'] || '';
      const budgetRange = consumer['Budget'] || '';
      const notes = consumer['Notes'] || '';
      const intentScore = consumer['Intent Score'] || 0;
      const intentClassification = consumer['Intent Classification'] || '';
      const referralStatus = consumer['Referral Status'] || '';

      if (!buyerEmail) continue;

      // LOCK-aware skip (2026-06-06): if buyer has any active or locked
      // referral (rancher engaged or deal in flight), don't double-route.
      // Adds 'Awaiting Payment' to the existing skip list so deposit-paid
      // buyers don't get a second intro mid-checkout.
      const myRefs = refsByEmail[buyerEmail] || [];
      const activeIntroSent = myRefs.find((r: any) =>
        ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Awaiting Payment', 'Closed Won'].includes(r['Status'])
      );
      if (activeIntroSent) {
        summary.skipped_already_intro_sent++;
        continue;
      }

      // ── CROSS-STATE ASSERTION (2026-06-05 hardening) ──────────────────
      // Before ANY routing decision, verify the buyer's state actually
      // matches the rancher's served states. This catches the failure
      // mode where a multi-state rancher's Routing States gets out of
      // sync with the cron's `state` parameter, OR where a Ships
      // Nationwide rancher silently absorbs every cross-state buyer
      // (the 2026-06-05 incident root cause).
      //
      // Skip cross-state mismatches with a loud Telegram alert — operator
      // must explicitly fix the rancher's Routing States OR pass an
      // explicit operatorOverride flag (not yet exposed in bulkRoute API).
      //
      // SERVED-STATES RESOLUTION (fix): use getOperationalServedStates — the
      // SAME admin-controlled gate the matcher uses
      // (app/api/matching/suggest/route.ts ~:567-582). Home-state-only by
      // default; multi-state requires `Admin Approved Multi-State === true`
      // AND admin `Routing States`. The old getRancherServedStates read the
      // rancher-editable `States Served` field, so a rancher could silently
      // route cross-state by editing their own profile — defeating the
      // 2026-05-13 admin gate and causing cross-state misroutes.
      const buyerStateNorm = String(buyerState || '').toUpperCase().trim();
      const rancherServedStates = getOperationalServedStates(rancher);
      const stateAllowed = rancherServedStates.includes(buyerStateNorm) ||
                           rancherServedStates.includes(state.toUpperCase());
      if (!stateAllowed) {
        summary.skipped_unqualified++;
        const r = `cross-state mismatch — buyer in ${buyerStateNorm}, rancher serves ${rancherServedStates.join('/')}`;
        summary.unqualified_reasons[r] = (summary.unqualified_reasons[r] || 0) + 1;
        try {
          const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('./telegram');
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🚨 <b>BULKROUTE CROSS-STATE BLOCKED</b>\n\n` +
              `Buyer: ${buyerName} (${buyerStateNorm})\n` +
              `Rancher: ${rancherName} — serves ${rancherServedStates.join(', ')}\n\n` +
              `<i>bulkRoute would have misrouted this buyer. Blocked + skipped. Check rancher's Routing States config.</i>`,
          );
        } catch {}
        continue;
      }

      // ── QUALIFICATION GATE ────────────────────────────────────────────
      // Reject buyers who haven't completed /qualify quiz. Legacy fallbacks
      // (Ready to Buy, Warmup Engaged At) removed 2026-06-05 — strict gate.
      const qual = isQualifiedForRouting(consumer);
      if (!qual.ok) {
        summary.skipped_unqualified++;
        const r = qual.reason || 'unknown';
        summary.unqualified_reasons[r] = (summary.unqualified_reasons[r] || 0) + 1;
        continue;
      }

      summary.processed++;

      const pendingRefs = myRefs.filter((r: any) => r['Status'] === 'Pending Approval');

      let targetReferralId: string;

      if (pendingRefs.length > 0) {
        targetReferralId = pendingRefs[0].id;
        if (!dryRun) {
          await updateRecord(TABLES.REFERRALS, targetReferralId, {
            'Status': 'Intro Sent',
            'Rancher': [rancherId],
            'Suggested Rancher': [rancherId],
            'Suggested Rancher Name': rancherName,
            'Suggested Rancher State': rancher['State'] || state,
            'Match Type': 'Local',
            'Approved At': now,
            'Intro Sent At': now,
          });
        }
        summary.updated_stuck_referral++;

        for (let i = 1; i < pendingRefs.length; i++) {
          if (!dryRun) {
            try {
              await updateRecord(TABLES.REFERRALS, pendingRefs[i].id, {
                'Status': 'Closed Lost',
                'Closed At': now,
                'Notes': `${pendingRefs[i]['Notes'] || ''}\n[Auto-closed duplicate — primary referral routed to ${rancherName}]`.trim(),
              });
            } catch (e: any) {
              summary.errors.push(`Close duplicate ${pendingRefs[i].id}: ${e.message}`);
            }
          }
          summary.canceled_duplicates++;
        }
      } else {
        if (!dryRun) {
          const newRef: any = await createRecord(TABLES.REFERRALS, {
            'Buyer': [buyerId],
            'Status': 'Intro Sent',
            'Buyer Name': buyerName,
            'Buyer Email': buyerEmail,
            'Buyer Phone': buyerPhone,
            'Buyer State': buyerState,
            'Order Type': orderType,
            'Budget Range': budgetRange,
            'Intent Score': intentScore,
            'Intent Classification': intentClassification,
            'Notes': notes,
            'Rancher': [rancherId],
            'Suggested Rancher': [rancherId],
            'Suggested Rancher Name': rancherName,
            'Suggested Rancher State': rancher['State'] || state,
            'Match Type': 'Local',
            'Approved At': now,
            'Intro Sent At': now,
          });
          targetReferralId = newRef.id;
        } else {
          targetReferralId = 'dry-run';
        }
        summary.created_new_referral++;
      }

      // Update consumer referral status
      if (!dryRun) {
        try {
          await updateRecord(TABLES.CONSUMERS, buyerId, {
            'Referral Status': 'Intro Sent',
          });
        } catch (e: any) {
          summary.errors.push(`Update consumer ${buyerId} status: ${e.message}`);
        }
      }

      // Send rancher intro email (scheduled if scheduledAt provided)
      if (!dryRun && rancherEmail) {
        try {
          await sendEmail({
            to: rancherEmail,
            subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
            scheduledAt,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
              <h1 style="font-family:Georgia,serif;">New Qualified Buyer Lead</h1>
              <p>Hi ${rancherName},</p>
              <p>A qualified buyer in your area came through BuyHalfCow and has been connected to you:</p>
              <p><strong>Buyer:</strong> ${buyerName}</p>
              <p><strong>Email:</strong> ${buyerEmail}</p>
              ${buyerPhone ? `<p><strong>Phone:</strong> ${buyerPhone}</p>` : ''}
              <p><strong>State:</strong> ${buyerState}</p>
              <p><strong>Order:</strong> ${orderType || 'Not specified'}</p>
              ${budgetRange ? `<p><strong>Budget:</strong> ${budgetRange}</p>` : ''}
              ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
              <p>Reach out within 24 hours to close the sale. Reply-all to keep me in the loop.</p>
              <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow | 10% commission on BHC referral sales.</p>
            </div>`,
          });
          summary.emails_sent_rancher++;
        } catch (e: any) {
          summary.errors.push(`Rancher email for ${buyerEmail}: ${e.message}`);
        }
      }

      // Send buyer intro email (scheduled if scheduledAt provided)
      if (!dryRun && buyerEmail) {
        try {
          const buyerToken = jwt.sign(
            { type: 'member-login', consumerId: buyerId, email: buyerEmail },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const buyerLoginUrl = `${SITE_URL}/member/verify?token=${buyerToken}`;
          const buyerFirstName = (buyerName || '').split(' ')[0] || 'there';

          // tier_v2 ranchers route deposits through Stripe Connect direct
          // charge at /checkout/<refId>/deposit, which requires the
          // bhc-member-auth cookie. Wrap the deposit deep-link in a magic-link
          // verify URL so the buyer can land authenticated. Legacy ranchers
          // stay on the tap-any-tier Payment Link copy (depositMagicLinkUrl
          // stays undefined).
          const pricingModel = String(rancher['Pricing Model'] || 'legacy');
          let depositMagicLinkUrl: string | undefined;
          if (pricingModel === 'tier_v2' && targetReferralId && targetReferralId !== 'dry-run') {
            const magicToken = generateMemberLoginToken(buyerId, buyerEmail);
            const nextPath = `/checkout/${targetReferralId}/deposit`;
            depositMagicLinkUrl = `${SITE_URL}/api/auth/member/verify?token=${magicToken}&next=${encodeURIComponent(nextPath)}`;
          }

          await sendBuyerIntroNotification({
            firstName: buyerFirstName,
            email: buyerEmail,
            rancherName,
            rancherEmail,
            rancherPhone,
            rancherSlug,
            loginUrl: buyerLoginUrl,
            scheduledAt,
            depositMagicLinkUrl,
          });
          summary.emails_sent_buyer++;
        } catch (e: any) {
          summary.errors.push(`Buyer email for ${buyerEmail}: ${e.message}`);
        }
      }

      summary.details.push({
        name: buyerName,
        email: buyerEmail,
        order: orderType,
        budget: budgetRange,
        intent: intentClassification,
        prev_referral_status: referralStatus,
        action: pendingRefs.length > 0 ? 'updated_stuck' : 'created_new',
        referralId: targetReferralId,
      });
    } catch (e: any) {
      summary.errors.push(`Consumer ${consumer.id}: ${e.message}`);
    }
  }

  // Increment rancher's active referral count atomically via Redis (one INCR
  // per netNew slot). Previously this did a non-atomic Airtable read+write
  // which could lose slots under burst (matching/suggest INCR in flight when
  // bulkRoute writes the stale read+1). PA-MATCH audit (2026-05-28) flagged.
  // syncCapacityToAirtable mirrors the final value once at the end so the
  // dashboard sees consistent counts.
  if (!dryRun) {
    try {
      const netNew = summary.updated_stuck_referral + summary.created_new_referral;
      if (netNew > 0) {
        const { incrementCapacity, syncCapacityToAirtable } = await import('./rancherCapacity');
        let lastN = 0;
        for (let i = 0; i < netNew; i++) {
          lastN = await incrementCapacity(rancherId);
        }
        // Mirror to Airtable + stamp Last Assigned At in one update.
        await updateRecord(TABLES.RANCHERS, rancherId, {
          'Current Active Referrals': lastN,
          'Last Assigned At': now,
        });
        // syncCapacityToAirtable not needed — we already wrote the field in
        // the same update along with Last Assigned At.
        void syncCapacityToAirtable;
      }
    } catch (e: any) {
      summary.errors.push(`Increment rancher count: ${e.message}`);
    }
  }

  return { ok: true, summary };
}

// Returns the list of states a rancher serves: their primary `State` plus
// anything in `States Served`. All values are normalized to 2-letter codes,
// so "Montana" and "MT" are treated as the same state.
export function getRancherServedStates(rancher: any): string[] {
  const out = new Set<string>();
  const primary = normalizeState(rancher['State']);
  if (primary) out.add(primary);
  for (const s of normalizeStates(rancher['States Served'])) {
    out.add(s);
  }
  return Array.from(out);
}
