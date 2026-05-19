import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import {
  TABLES,
  getAllRecords,
  getRecordById,
  updateRecord,
} from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { calcCommission } from '@/lib/commission';
import {
  sendTelegramMessage,
  TELEGRAM_ADMIN_CHAT_ID,
  sendTelegramSaleCelebration,
} from '@/lib/telegram';
import { createCommissionInvoice } from '@/lib/stripe-commission';
import { sendInstantCommissionInvoice } from '@/lib/email';

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

function verifyToken(token: string): ActionToken | null {
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
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
  } catch {
    return null;
  }
}

const ALLOWED_ACTIONS = new Set(['in_talks', 'won', 'lost', 'pass']);
const TERMINAL_STATUSES = ['Closed Won', 'Closed Lost'];

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
    if (!saleAmount || saleAmount <= 0) {
      return { ok: false, message: 'Sale amount required for Closed Won.' };
    }
    updates['Status'] = 'Closed Won';
    updates['Sale Amount'] = saleAmount;
    updates['Commission Due'] = calcCommission(saleAmount);
    updates['Closed At'] = new Date().toISOString();
    summary = `Marked Closed Won at $${saleAmount.toFixed(2)}. Commission ($${updates['Commission Due'].toFixed(2)}) invoice on the way.`;
  } else if (action === 'lost') {
    updates['Status'] = 'Closed Lost';
    updates['Closed At'] = new Date().toISOString();
    if (reason) {
      const existing = (referral['Notes'] || '').toString();
      const stamp = `[CLOSED LOST ${new Date().toISOString().slice(0, 10)}] ${reason}`;
      updates['Notes'] = existing ? `${stamp}\n\n${existing}` : stamp;
    }
    summary = 'Marked Closed Lost.';
  } else if (action === 'pass') {
    updates['Status'] = 'Closed Lost';
    updates['Closed At'] = new Date().toISOString();
    const existing = (referral['Notes'] || '').toString();
    const stamp = `[PASSED ${new Date().toISOString().slice(0, 10)}] ${reason || 'Rancher passed via email link'}`;
    updates['Notes'] = existing ? `${stamp}\n\n${existing}` : stamp;
    summary = 'Passed on this lead. We\'ll re-route the buyer.';
  } else {
    return { ok: false, message: 'Unknown action.' };
  }

  try {
    await updateRecord(TABLES.REFERRALS, decoded.referralId, updates);
  } catch (e: any) {
    return { ok: false, message: `Couldn't update — try again. (${e?.message || 'unknown'})` };
  }

  // Decrement rancher counter if this is the first transition to a terminal status
  if (wasActiveBefore && TERMINAL_STATUSES.includes(updates['Status'])) {
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
      const cur = Number(rancher['Current Active Referrals'] || 0);
      await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
        'Current Active Referrals': Math.max(0, cur - 1),
      });
    } catch (e: any) {
      console.warn('[quick-action] counter decrement failed:', e?.message);
    }
  }

  // Closed Won: fire Stripe commission invoice + Telegram celebration
  if (action === 'won' && saleAmount) {
    let stripeInvoiceUrl = '';
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
      if (rancher && rancher['Email']) {
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
