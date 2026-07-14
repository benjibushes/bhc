// app/api/cron/deposit-link-refresh/route.ts
//
// DEPOSIT LINK SELF-HEAL — converts legacy expiring deposit links to durable
// pay links and re-emails the buyer, exactly once per referral.
//
// Recovery for the 2026-07-14 dead-link incident (PR #369): every deposit
// requested before the fix stored + emailed a raw Stripe-hosted Checkout URL
// (~24h lifetime). Eight requested deposits, seven already-dead links, zero
// paid. This cron finds every requested-but-unpaid referral whose stored
// 'Deposit Checkout URL' still points at checkout.stripe.com, mints the
// durable /r/p/<grant> link (SERVER-side — grant JWTs must be signed with
// prod's secret; never mint these in local scripts), rewrites the stored URL,
// and re-sends the buyer the deposit email through the same guarded send the
// request route uses.
//
// Naturally idempotent: once converted the URL no longer matches the
// checkout.stripe.com filter, so each referral is emailed at most once by
// this rail — safe to leave scheduled as a permanent straggler-healer.
//
// DRY-RUN by default (bhc-mutation-guardrails): without ?send=1 it only
// reports what it WOULD convert. Live mode requires the explicit param.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { mintDepositGrantToken } from '@/lib/campaignReserve';
import { sendBuyerDepositInvoice } from '@/lib/emailMinimal';
import { depositEmailOutcome } from '@/lib/depositRequest';
import { tierFor, depositCommissionRate, type TierSlug } from '@/lib/tiers';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface RefreshResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

function realHandlerFor(send: boolean) {
  return async function realHandler(_request: Request): Promise<RefreshResult> {
    // Requested + unpaid + still carrying an expiring Stripe URL.
    const stale = await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Requested At} != '', {Deposit Paid At} = '', FIND('checkout.stripe.com', {Deposit Checkout URL} & '') > 0)`,
    );

    if (stale.length === 0) {
      return { status: 'success', recordsTouched: 0, notes: 'no stale deposit links' };
    }

    let converted = 0;
    let emailed = 0;
    const skipped: string[] = [];
    const lines: string[] = [];

    for (const ref of stale as any[]) {
      const referralId = ref.id as string;
      const buyerEmail = String(ref['Buyer Email'] || '').trim();
      const buyerIds: string[] = Array.isArray(ref['Buyer']) ? ref['Buyer'] : [];
      const buyerId = buyerIds[0] || '';
      const cut = String(ref['Order Type'] || '').trim(); // 'Quarter'|'Half'|'Whole'
      const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
      const rancherId = rancherIds[0] || '';

      if (!buyerEmail || !rancherId || !['Quarter', 'Half', 'Whole'].includes(cut)) {
        skipped.push(`${referralId}: missing ${!buyerEmail ? 'email' : !rancherId ? 'rancher' : 'cut'}`);
        continue;
      }

      // Amounts: the rancher-quoted numbers stamped at request time. Without
      // them the email cannot promise a truthful "Today" figure — skip loud.
      const depositDollars = Number(ref['Deposit Amount'] || 0);
      const fullSaleDollars = Number(ref['Total Sale Amount'] || 0);
      if (!(depositDollars > 0) || !(fullSaleDollars > 0)) {
        skipped.push(`${referralId}: missing amounts`);
        continue;
      }
      const depositCents = Math.round(depositDollars * 100);
      const fullSaleCents = Math.round(fullSaleDollars * 100);

      const durableUrl = buyerId
        ? `${SITE_URL}/r/p/${mintDepositGrantToken({ consumerId: buyerId, referralId }, { expiresIn: '30d' })}`
        : `${SITE_URL}/checkout/${referralId}/deposit?cut=${cut.toLowerCase()}`;

      lines.push(`${referralId} · ${buyerEmail} · ${cut} $${depositDollars.toFixed(0)}`);

      if (!send) continue; // dry-run: report only

      // Convert the stored URL FIRST — even if the email fails, the rancher's
      // dashboard copy-link is durable from this moment.
      try {
        await updateRecord(TABLES.REFERRALS, referralId, { 'Deposit Checkout URL': durableUrl });
        converted += 1;
      } catch (e: any) {
        skipped.push(`${referralId}: url write failed (${e?.message || 'unknown'})`);
        continue;
      }

      // Same email + same quoted-vs-charged mirror as the request route.
      try {
        const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
        const tierSlug: TierSlug = tierFor(rancher) || 'legacy_connect';
        const feeRate = depositCommissionRate(rancher, tierSlug);
        const buyerName = String(ref['Buyer Name'] || '').trim() || buyerEmail.split('@')[0];
        const outcome = depositEmailOutcome(
          await sendBuyerDepositInvoice({
            buyerEmail,
            buyerName,
            rancherName: String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'your ranch').trim(),
            cutTier: cut,
            depositCents,
            fullSaleCents,
            chargedCents: depositCents + Math.round(fullSaleCents * feeRate),
            checkoutUrl: durableUrl,
            rancherPhone: String(rancher?.['Phone'] || '').trim() || undefined,
          }),
        );
        if (outcome.emailSent) emailed += 1;
        else skipped.push(`${referralId}: email not sent (${outcome.reason || (outcome.suppressed ? 'suppressed' : 'unknown')})`);
      } catch (e: any) {
        skipped.push(`${referralId}: email threw (${e?.message || 'unknown'})`);
      }
    }

    const mode = send ? 'LIVE' : 'DRY-RUN';
    const notes =
      `${mode}: ${stale.length} stale, ${send ? `${converted} converted, ${emailed} emailed` : `${lines.length} would convert`}` +
      (skipped.length ? `; skipped ${skipped.length}: ${skipped.slice(0, 4).join(' | ')}` : '');

    if (TELEGRAM_ADMIN_CHAT_ID && (send || stale.length > 0)) {
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🔗 <b>DEPOSIT LINK REFRESH (${mode})</b>\n\n${lines.join('\n')}\n\n${notes}`,
        );
      } catch { /* best-effort */ }
    }

    return {
      status: skipped.length > 0 ? 'partial' : 'success',
      recordsTouched: send ? converted : 0,
      notes,
    };
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  const send = new URL(request.url).searchParams.get('send') === '1';
  return withCronRun('deposit-link-refresh', realHandlerFor(send))(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
