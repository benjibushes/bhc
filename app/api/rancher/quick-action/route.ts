import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import {
  TABLES,
  getAllRecords,
  getRecordById,
  updateRecord,
} from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { calcCommission, calcCommissionForRancher, hasLockedCommissionRate } from '@/lib/commission';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import {
  sendTelegramMessage,
  TELEGRAM_ADMIN_CHAT_ID,
  sendTelegramSaleCelebration,
} from '@/lib/telegram';
import { createCommissionInvoice } from '@/lib/stripe-commission';
import { sendInstantCommissionInvoice } from '@/lib/email';

// Site URL for internal calls (used by pass-action re-route → matching/suggest)
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// ── Multi-secret JWT verify (mirrors activate/route.ts pattern) ────────────
// 2026-05-28 audit #14: prior version only verified against JWT_SECRET. If
// JWT_SECRET ever rotates without JWT_SECRET_LEGACY mirrored here, all
// in-flight intro emails carrying quick-action JWTs (up to 30d expiry) die.
// Fallback array reads comma-separated legacy secrets so rotation is graceful.
const FALLBACK_SECRETS: string[] = (process.env.JWT_SECRET_LEGACY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Rancher one-click action endpoint. Reachable via JWT-signed URLs in the
// intro email so the rancher can update a referral status without logging
// in. Each link in the email carries a `rancher-quick-action` JWT scoped
// to a specific referral + rancher record (not a session).
//
// Actions:
//   GET ?token=X&action=in_talks       → Status=Rancher Contacted
//   GET ?token=X&action=lost           → renders simple reason form (POST)
//   POST ?token=X&action=lost          → Status=Closed Lost + reason
//   GET ?token=X&action=won            → renders simple amount form (POST)
//   POST ?token=X&action=won           → Status=Closed Won + Sale Amount +
//                                        Commission Due + Stripe invoice
//   GET ?token=X&action=pass           → Status=Closed Lost + reason=passed
//
// JWT shape:
//   { type: 'rancher-quick-action', referralId, rancherId, exp: 30d }
//
// Security: token bound to specific referral. Re-use after action is
// idempotent (returns "already done"). Token can be replayed for a different
// action though — that's intentional, e.g. rancher first marks "in_talks"
// then later "won". Decrement of Active Referrals is guarded against
// double-decrement by checking previous Status.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ActionToken {
  type: string;
  referralId: string;
  rancherId: string;
}

function tryDecode(token: string, secret: string): any | null {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

function verifyToken(token: string): ActionToken | null {
  let decoded: any = tryDecode(token, JWT_SECRET);
  if (!decoded) {
    for (const s of FALLBACK_SECRETS) {
      decoded = tryDecode(token, s);
      if (decoded) break;
    }
  }
  if (!decoded) return null;
  if (
    decoded.type !== 'rancher-quick-action' ||
    !decoded.referralId ||
    !decoded.rancherId
  ) {
    return null;
  }
  return {
    type: decoded.type,
    referralId: decoded.referralId,
    rancherId: decoded.rancherId,
  };
}

const ALLOWED_ACTIONS = new Set(['in_talks', 'won', 'lost', 'pass']);
// 2026-05-28 audit #15: 'Awaiting Payment' added to terminal set. Without
// this, a re-click of the won button after the deal already advanced to
// Awaiting Payment would re-fire createCommissionInvoice + persist a fresh
// Stripe Invoice URL over the existing one. Stripe idempotencyKey saves the
// actual double-charge, but the URL/ID overwrite still confuses the dashboard.
const TERMINAL_STATUSES = ['Closed Won', 'Closed Lost', 'Awaiting Payment'];

function htmlPage(
  title: string,
  body: string,
  cta?: { href: string; label: string }
) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — BuyHalfCow</title><style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:32px}
.box{max-width:560px;margin:80px auto 0;background:#fff;padding:48px 40px;border:1px solid #A7A29A}
h1{font-family:Georgia,serif;font-size:28px;margin:0 0 16px;line-height:1.3}
p{margin:14px 0;color:#2A2A2A}
.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;margin-top:14px}
form{margin-top:24px}
label{display:block;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6B4F3F;margin-bottom:6px}
input[type=number],input[type=text],select,textarea{width:100%;padding:12px;border:1px solid #A7A29A;background:#fff;font-size:16px;font-family:inherit;margin-bottom:16px}
button[type=submit]{padding:14px 32px;background:#0E0E0E;color:#F4F1EC;border:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;cursor:pointer;width:100%}
.note{font-size:13px;color:#6B4F3F;background:#F4F1EC;padding:12px 16px;border-left:3px solid #6B4F3F;margin:18px 0}
</style></head><body><div class="box">${body}${cta ? `<p><a href="${cta.href}" class="cta">${cta.label}</a></p>` : ''}</div></body></html>`;
}

async function applyAction(
  decoded: ActionToken,
  action: string,
  saleAmount?: number,
  reason?: string
): Promise<{ ok: boolean; message: string }> {
  // Look up referral + verify rancher ownership
  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, decoded.referralId);
  } catch {
    return { ok: false, message: 'Referral not found.' };
  }
  if (!referral) return { ok: false, message: 'Referral not found.' };

  const assigned = referral['Rancher'] || [];
  const suggested = referral['Suggested Rancher'] || [];
  const isOwner =
    assigned.includes(decoded.rancherId) || suggested.includes(decoded.rancherId);
  if (!isOwner) {
    return { ok: false, message: 'This action link is no longer valid for this referral.' };
  }

  const currentStatus = referral['Status'] || '';
  const wasActiveBefore = !TERMINAL_STATUSES.includes(currentStatus);

  // EVERY rancher action — including no-op repeats — stamps Last Rancher
  // Activity At + Rancher Engaged Flag. This extends the freshness window
  // so referral-chasup cron stops auto-killing leads ranchers are working.
  // Pre-2026-05-09 bug: cron used Intro Sent At only; couldn't see off-platform
  // rancher work; killed 70 referrals across 8 ranchers in 7 days.
  const nowISO = new Date().toISOString();
  const updates: Record<string, any> = {
    'Last Rancher Activity At': nowISO,
    'Rancher Engaged Flag': true,
  };
  let summary = '';

  if (action === 'in_talks') {
    if (currentStatus === 'Rancher Contacted' || currentStatus === 'Negotiation') {
      // Even on no-op, stamp activity so cron freshness window extends.
      try {
        await updateRecord(TABLES.REFERRALS, decoded.referralId, updates);
      } catch {
        /* non-fatal — message still returns success */
      }
      return { ok: true, message: `Already marked "${currentStatus}" — activity refreshed.` };
    }
    updates['Status'] = 'Rancher Contacted';
    summary = 'Status flipped to Rancher Contacted. Buyer is in active conversation with you.';
  } else if (action === 'won') {
    // Idempotency: if already terminal, don't re-fire Stripe invoice.
    // Audit #15: previously could re-fire and overwrite Stripe Invoice URL/ID.
    if (TERMINAL_STATUSES.includes(currentStatus)) {
      try {
        await updateRecord(TABLES.REFERRALS, decoded.referralId, updates);
      } catch {}
      return { ok: true, message: `Already marked "${currentStatus}". Invoice already on its way.` };
    }
    if (!saleAmount || saleAmount <= 0) {
      return { ok: false, message: 'Sale amount required for Closed Won.' };
    }
    // HARD GATE: rancher must have a locked Commission Rate. Stops the
    // "we never agreed on a rate" disputes that bit the Ashcraft pattern
    // (2026-05-20). Pull the rancher row to check + compute per-rancher
    // commission off their locked rate.
    let rancherForRate: any = null;
    try {
      rancherForRate = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
    } catch {}
    if (!hasLockedCommissionRate(rancherForRate)) {
      return {
        ok: false,
        message:
          'No Commission Rate locked on your account. Please contact hello@buyhalfcow.com before closing deals via email.',
      };
    }
    updates['Status'] = 'Closed Won';
    updates['Sale Amount'] = saleAmount;
    updates['Commission Due'] = calcCommissionForRancher(rancherForRate, saleAmount);
    updates['Closed At'] = new Date().toISOString();
    summary = `Marked Closed Won at $${saleAmount.toFixed(2)}. Commission ($${updates['Commission Due'].toFixed(2)}) invoice on the way.`;
  } else if (action === 'lost') {
    if (TERMINAL_STATUSES.includes(currentStatus)) {
      try {
        await updateRecord(TABLES.REFERRALS, decoded.referralId, updates);
      } catch {}
      return { ok: true, message: `Already "${currentStatus}".` };
    }
    updates['Status'] = 'Closed Lost';
    updates['Closed At'] = new Date().toISOString();
    if (reason) {
      const existing = (referral['Notes'] || '').toString();
      const stamp = `[CLOSED LOST ${new Date().toISOString().slice(0, 10)}] ${reason}`;
      updates['Notes'] = existing ? `${stamp}\n\n${existing}` : stamp;
    }
    summary = 'Marked Closed Lost.';
  } else if (action === 'pass') {
    if (TERMINAL_STATUSES.includes(currentStatus)) {
      try {
        await updateRecord(TABLES.REFERRALS, decoded.referralId, updates);
      } catch {}
      return { ok: true, message: `Already "${currentStatus}". Buyer was already re-routed.` };
    }
    // LOCK (2026-06-06): if the rancher has already engaged (Status =
    // Rancher Contacted / Negotiation / Awaiting Payment) refuse the pass.
    // Rancher already invested time + buyer is in real conversation — auto-
    // routing them to a new rancher right now creates buyer confusion +
    // wastes effort. The rancher has to explicitly mark Closed Lost w/ a
    // reason via the dashboard if they actually want out, which kills the
    // auto-reroute path on purpose (existing flow).
    const { isReferralLocked, lockNotice } = await import('@/lib/referralLock');
    if (isReferralLocked(currentStatus)) {
      // Log notice for audit; return shape stays {ok, message} to match
      // handler return type.
      console.log(lockNotice(currentStatus, 'pass'));
      return {
        ok: false,
        message:
          `Can't auto-pass this lead — you've already engaged with the buyer (status: "${currentStatus}"). ` +
          `Mark it Closed Lost from your dashboard with a reason if you actually want out.`,
      };
    }
    updates['Status'] = 'Closed Lost';
    updates['Closed At'] = new Date().toISOString();
    const existing = (referral['Notes'] || '').toString();
    const stamp = `[PASSED ${new Date().toISOString().slice(0, 10)}] ${reason || 'Rancher passed via email link'}`;
    updates['Notes'] = existing ? `${stamp}\n\n${existing}` : stamp;
    summary = 'Passed on this lead. Buyer is being re-routed now.';
  } else {
    return { ok: false, message: 'Unknown action.' };
  }

  // ROUTE CLOSE PATHS THROUGH CONTRACT.
  // For close transitions (won/lost/pass), recordClose() handles:
  //   - Status flip + Closed At + Last Rancher Activity At + Rancher Engaged Flag
  //   - Sale Amount stamp (won only)
  //   - Atomic capacity decrement (if was active before)
  //   - Buyer Stage flip → CLOSED (won/lost only; pass→lost handled too)
  //   - Funnel event emit (close:won|lost|awaiting_payment)
  // Supplemental fields not in contract (Commission Due, Notes) still written
  // here as a follow-up updateRecord.
  if (action === 'won' || action === 'lost' || action === 'pass') {
    const { recordClose } = await import('@/lib/contracts');
    const closeOutcome = action === 'won' ? 'won' : 'lost';
    try {
      await recordClose({
        referralId: decoded.referralId,
        rancherId: decoded.rancherId,
        outcome: closeOutcome,
        saleAmount: action === 'won' ? saleAmount : undefined,
        reason,
      });
    } catch (e: any) {
      return { ok: false, message: `Couldn't update — try again. (${e?.message || 'unknown'})` };
    }
    // Supplemental fields: Commission Due (won) + Notes append (lost/pass).
    // Both are non-fatal — contract already landed the core state change.
    try {
      const supp: Record<string, any> = {};
      if (action === 'won' && typeof updates['Commission Due'] === 'number') {
        supp['Commission Due'] = updates['Commission Due'];
      }
      if (updates['Notes']) {
        supp['Notes'] = updates['Notes'];
      }
      if (Object.keys(supp).length > 0) {
        await updateRecord(TABLES.REFERRALS, decoded.referralId, supp);
      }
    } catch (e: any) {
      console.warn('[quick-action] supplemental field write failed:', e?.message);
    }

    // ── Audit #7 (2026-05-28): PASS RE-ROUTES BUYER ────────────────────────
    // Previously: action=pass via email link just marked Closed Lost and
    // dead-ended. Dashboard pass calls matching/suggest with excludeRancherIds
    // — email pass did not. Result: paid-ad buyers whose first-suggested
    // rancher passed via email were silently abandoned.
    //
    // Fix: after recordClose runs (which set Buyer Stage=CLOSED), restore
    // Buyer Stage to WAITING and fire matching/suggest with the passing
    // rancher excluded. Re-route is best-effort — if it fails the buyer is
    // still flagged WAITING for cron recovery.
    if (action === 'pass') {
      try {
        const buyerLinkedIds: string[] = Array.isArray(referral['Buyer']) ? referral['Buyer'] : [];
        const buyerId = buyerLinkedIds[0];
        if (buyerId) {
          // Restore Buyer Stage so matching/suggest treats them as re-routable
          // and recovery crons pick them up if the re-route fetch fails.
          try {
            const { transitionBuyerStage } = await import('@/lib/contracts');
            await transitionBuyerStage(buyerId, 'WAITING', 'pass:reroute');
          } catch (stageErr: any) {
            console.warn('[quick-action pass] buyer stage restore failed:', stageErr?.message);
          }

          // Hydrate the buyer record for the matching/suggest call.
          let buyer: any = null;
          try {
            buyer = await getRecordById(TABLES.CONSUMERS, buyerId);
          } catch (bErr: any) {
            console.warn('[quick-action pass] buyer hydrate failed:', bErr?.message);
          }

          if (buyer && buyer['Email'] && buyer['State']) {
            try {
              const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(process.env.INTERNAL_API_SECRET
                    ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET }
                    : {}),
                },
                body: JSON.stringify({
                  buyerState: buyer['State'],
                  buyerId,
                  buyerName: buyer['Full Name'] || '',
                  buyerEmail: buyer['Email'],
                  buyerPhone: buyer['Phone'] || '',
                  orderType: buyer['Order Type'] || '',
                  budgetRange: buyer['Budget'] || '',
                  intentScore: buyer['Intent Score'] || 0,
                  intentClassification: buyer['Intent Classification'] || '',
                  notes: buyer['Notes'] || '',
                  excludeRancherIds: [decoded.rancherId],
                  // Treat as warmup-engaged so hot-lead bypass works for
                  // already-engaged buyers (they clicked YES once before).
                  warmupEngaged: !!buyer['Warmup Engaged At'],
                }),
              });
              if (matchRes.ok) {
                try {
                  const j: any = await matchRes.json();
                  if (j?.matchFound && j?.suggestedRancher?.name) {
                    summary = `Passed. Buyer routed to ${j.suggestedRancher.name}.`;
                  } else if (j?.alreadyActive) {
                    summary = 'Passed. Buyer already has another active match — no re-route needed.';
                  } else {
                    summary = 'Passed. No other rancher available in their state — buyer waitlisted.';
                  }
                } catch {}
              } else {
                console.warn(`[quick-action pass] re-route returned ${matchRes.status}; buyer flagged WAITING for cron recovery`);
              }
            } catch (mErr: any) {
              console.error('[quick-action pass] matching/suggest call failed:', mErr?.message);
            }
          }
        }
      } catch (rerouteErr: any) {
        console.error('[quick-action pass] re-route block failed:', rerouteErr?.message);
      }
    }
  } else {
    // Non-close transition (e.g. in_talks → Rancher Contacted) — direct write
    // since contract scope is close-completion only.
    try {
      await updateRecord(TABLES.REFERRALS, decoded.referralId, updates);
    } catch (e: any) {
      return { ok: false, message: `Couldn't update — try again. (${e?.message || 'unknown'})` };
    }
  }

  // Closed Won: fire Stripe commission invoice + Telegram celebration.
  // Tier_v2 ranchers SKIP — their commission was already taken at deposit
  // time via Stripe Connect application_fee_amount (lib/stripeConnect.ts).
  // Firing a legacy invoice here would double-bill them.
  if (action === 'won' && saleAmount) {
    let stripeInvoiceUrl = '';
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
      const pricingModel = String(rancher?.['Pricing Model'] || 'legacy');
      const skipLegacyInvoice = pricingModel === 'tier_v2';
      if (skipLegacyInvoice) {
        console.log(`[quick-action won] rancher ${decoded.rancherId} is tier_v2 — skipping legacy commission invoice (already taken via application_fee_amount)`);
      }
      if (rancher && rancher['Email'] && !skipLegacyInvoice) {
        try {
          const stripeResult = await createCommissionInvoice({
            rancher: {
              id: decoded.rancherId,
              operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || '',
              ranchName: rancher['Ranch Name'] || '',
              email: rancher['Email'],
              stripeCustomerId: rancher['Stripe Customer ID'] || undefined,
            },
            referral: {
              id: decoded.referralId,
              buyerName: referral['Buyer Name'] || '',
              orderType: referral['Order Type'] || 'Beef order',
              saleAmount,
              commissionDue: updates['Commission Due'],
            },
          });
          stripeInvoiceUrl = stripeResult.invoiceUrl;
          await updateRecord(TABLES.REFERRALS, decoded.referralId, {
            'Stripe Invoice ID': stripeResult.invoiceId,
            'Stripe Invoice URL': stripeInvoiceUrl,
          });
        } catch (e: any) {
          console.error('[quick-action won] stripe invoice error:', e?.message);
        }

        try {
          await sendInstantCommissionInvoice({
            operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || '',
            ranchName: rancher['Ranch Name'] || '',
            email: rancher['Email'],
            buyerName: referral['Buyer Name'] || '',
            orderType: referral['Order Type'] || 'Beef order',
            saleAmount,
            commissionDue: updates['Commission Due'],
            closedAt: updates['Closed At'],
            stripeInvoiceUrl: stripeInvoiceUrl || undefined,
          });
        } catch (e: any) {
          console.error('[quick-action won] commission email error:', e?.message);
        }
      }

      // Telegram celebration — hydrate lifetime/monthly stats from real
      // referral history so the alert shows accurate milestones (was
      // hardcoded to 0/0/0/0 for every email-link close, which undermined
      // the first-sale + milestone celebration UX).
      try {
        const rancherName =
          rancher?.['Operator Name'] ||
          rancher?.['Ranch Name'] ||
          'Rancher';

        let isFirstSaleForRancher = false;
        let monthlyWins = 0;
        let monthlyCommission = 0;
        let lifetimeWins = 0;
        let lifetimeCommission = 0;
        try {
          const allRefs = (await getAllRecords(TABLES.REFERRALS)) as any[];
          const wins = allRefs.filter((r) => {
            if (r['Status'] !== 'Closed Won') return false;
            const ids = r['Rancher'] || r['Suggested Rancher'] || [];
            return Array.isArray(ids) && ids.includes(decoded.rancherId);
          });
          isFirstSaleForRancher = wins.length === 1; // includes the one we just closed
          const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
          const monthWins = wins.filter((r) => new Date(r['Closed At'] || 0).getTime() >= monthStart);
          monthlyWins = monthWins.length;
          monthlyCommission = monthWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
          lifetimeWins = wins.length;
          lifetimeCommission = wins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
        } catch (statsErr: any) {
          console.warn('[quick-action won] stats hydration failed:', statsErr?.message);
        }

        await sendTelegramSaleCelebration({
          referralId: decoded.referralId,
          buyerName: referral['Buyer Name'] || 'Buyer',
          rancherName,
          saleAmount,
          commission: updates['Commission Due'],
          isFirstSaleForRancher,
          monthlyWins,
          monthlyCommission,
          lifetimeWins,
          lifetimeCommission,
        });
      } catch (e: any) {
        console.warn('[quick-action won] telegram celebration error:', e?.message);
      }
    } catch (e: any) {
      console.error('[quick-action won] post-update error:', e?.message);
    }
  } else if (action === 'lost' || action === 'pass') {
    // Telegram alert for closes
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `${action === 'pass' ? '🚫' : '✗'} <b>${action === 'pass' ? 'Rancher PASSED' : 'CLOSED LOST'}</b> via email link\n\n` +
            `Buyer: ${referral['Buyer Name'] || '?'} (${referral['Buyer State'] || '?'})\n` +
            `Rancher: ${referral['Suggested Rancher Name'] || '?'}\n` +
            (reason ? `Reason: ${reason}\n` : '') +
            `\nReferral ${decoded.referralId}`
        );
      }
    } catch {}
  } else if (action === 'in_talks') {
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `💬 <b>Rancher engaged</b>\n\n` +
            `${referral['Buyer Name'] || '?'} (${referral['Buyer State'] || '?'}) ↔ ${referral['Suggested Rancher Name'] || '?'}\n\n` +
            `<i>Rancher confirmed they're in conversation with the buyer (via email link).</i>`
        );
      }
    } catch {}
  }

  return { ok: true, message: summary };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const action = (url.searchParams.get('action') || '').toLowerCase();
  const decoded = verifyToken(token);

  if (!decoded) {
    return new NextResponse(
      htmlPage('Link expired', `<h1>This link expired or is invalid.</h1><p>It's been more than 30 days, or the link's already been used in a way that can't be repeated. Log into your dashboard to update this referral manually.</p>`, {
        href: 'https://www.buyhalfcow.com/rancher',
        label: 'Open dashboard',
      }),
      { headers: { 'content-type': 'text/html' } }
    );
  }

  if (!ALLOWED_ACTIONS.has(action)) {
    return new NextResponse(
      htmlPage('Action required', `<h1>Pick what happened with this lead.</h1>
<form method="post" action="${url.pathname}?token=${encodeURIComponent(token)}&action=in_talks">
  <button type="submit">💬 In talks with buyer</button>
</form>
<form method="post" action="${url.pathname}?token=${encodeURIComponent(token)}&action=won">
  <label>Sale amount ($) — final agreed price</label>
  <input type="number" name="saleAmount" step="0.01" min="0" placeholder="2500" required>
  <button type="submit">✓ Closed Won + send invoice</button>
</form>
<form method="post" action="${url.pathname}?token=${encodeURIComponent(token)}&action=lost">
  <label>Reason (optional)</label>
  <select name="reason">
    <option value="">—</option>
    <option value="No response">Buyer never replied</option>
    <option value="Price">Price mismatch</option>
    <option value="Timing">Timing didn't work</option>
    <option value="Out of area">Out of my area</option>
    <option value="At capacity">At capacity</option>
    <option value="Other">Other</option>
  </select>
  <button type="submit">✗ Closed Lost</button>
</form>`),
      { headers: { 'content-type': 'text/html' } }
    );
  }

  // Closed Won + Closed Lost (with reason) require a form first
  if (action === 'won') {
    return new NextResponse(
      htmlPage('Mark Closed Won', `<h1>Closed Won — confirm sale amount</h1>
<p class="note">Submitting auto-generates a 10% commission invoice via Stripe, emailed to your account. Pay by card or ACH within 30 days. The referral marks Commission Paid only when Stripe confirms payment.</p>
<form method="post" action="${url.pathname}?token=${encodeURIComponent(token)}&action=won">
  <label>Final sale amount ($)</label>
  <input type="number" name="saleAmount" step="0.01" min="0" placeholder="2500" required autofocus>
  <button type="submit">✓ Submit + send invoice</button>
</form>`),
      { headers: { 'content-type': 'text/html' } }
    );
  }

  if (action === 'lost') {
    return new NextResponse(
      htmlPage('Mark Closed Lost', `<h1>Closed Lost — quick reason?</h1>
<form method="post" action="${url.pathname}?token=${encodeURIComponent(token)}&action=lost">
  <label>Reason (optional)</label>
  <select name="reason">
    <option value="">—</option>
    <option value="No response">Buyer never replied</option>
    <option value="Price">Price mismatch</option>
    <option value="Timing">Timing didn't work</option>
    <option value="Out of area">Out of my area</option>
    <option value="At capacity">At capacity</option>
    <option value="Other">Other</option>
  </select>
  <button type="submit">✗ Confirm Closed Lost</button>
</form>`),
      { headers: { 'content-type': 'text/html' } }
    );
  }

  // in_talks + pass: confirm + apply
  const result = await applyAction(decoded, action);
  if (!result.ok) {
    return new NextResponse(
      htmlPage('Couldn\'t update', `<h1>${result.message}</h1>`, {
        href: 'https://www.buyhalfcow.com/rancher',
        label: 'Open dashboard',
      }),
      { headers: { 'content-type': 'text/html' } }
    );
  }
  return new NextResponse(
    htmlPage('Updated', `<h1>Done.</h1><p>${result.message}</p>`, {
      href: 'https://www.buyhalfcow.com/rancher',
      label: 'Open dashboard',
    }),
    { headers: { 'content-type': 'text/html' } }
  );
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const action = (url.searchParams.get('action') || '').toLowerCase();
  const decoded = verifyToken(token);

  if (!decoded) {
    return new NextResponse(
      htmlPage('Link expired', `<h1>This link expired or is invalid.</h1>`),
      { headers: { 'content-type': 'text/html' } }
    );
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return new NextResponse(
      htmlPage('Bad action', `<h1>Unknown action.</h1>`),
      { headers: { 'content-type': 'text/html' } }
    );
  }

  let saleAmount: number | undefined;
  let reason: string | undefined;
  try {
    const body = await request.formData();
    const sa = body.get('saleAmount');
    if (sa) saleAmount = parseFloat(String(sa));
    const r = body.get('reason');
    if (r) reason = String(r);
  } catch {}

  const result = await applyAction(decoded, action, saleAmount, reason);
  return new NextResponse(
    htmlPage(result.ok ? 'Updated' : 'Couldn\'t update', `<h1>${result.ok ? 'Done.' : 'Try again.'}</h1><p>${result.message}</p>`, {
      href: 'https://www.buyhalfcow.com/rancher',
      label: 'Open dashboard',
    }),
    { headers: { 'content-type': 'text/html' } }
  );
}
