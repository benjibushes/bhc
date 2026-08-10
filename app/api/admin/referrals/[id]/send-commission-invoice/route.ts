import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { isCommissionOwedRow } from '@/lib/commissionOwed';
import { createCommissionInvoice } from '@/lib/stripe-commission';
import { sendInstantCommissionInvoice } from '@/lib/email';

export const maxDuration = 30;

// POST /api/admin/referrals/[id]/send-commission-invoice — operator-side
// (re)send of the post-close commission invoice email.
//
// WHY (collections 2026-08-08): 8 Closed Won rows carried Commission Due
// with no recent ask — some with a minted-but-unpaid Stripe invoice, some
// (the lazy-mint dashboard rows) with none. The rancher-facing mint stays
// self-serve (their dashboard Pay button, commission-invoice route); this
// endpoint only re-SENDS the ask through the existing guarded email rail.
//
// Money-model guardrails, all reused not reimplemented:
//   - isCommissionOwedRow: legacy-invoice rail only (deposit-rail and
//     broker rows refuse — their fee was already taken), Commission Due > 0,
//     Commission Paid unchecked.
//   - NO Stripe mint here: rows with a stamped hosted URL send it; unminted
//     rows send the dashboard-CTA variant (sendInstantCommissionInvoice's
//     no-URL mode), preserving the self-serve lazy-mint design.
//   - Send truth: a dated [COMMISSION-NUDGE] Notes stamp per send, so the
//     ask is persisted on the money record (hard rule 2), and repeat sends
//     within 7 days refuse.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await context.params;

  const referral: any = await getRecordById(TABLES.REFERRALS, id).catch(() => null);
  if (!referral) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  if (!isCommissionOwedRow(referral)) {
    return NextResponse.json(
      { error: 'Not an owed legacy-rail row (deposit/broker rail, zero due, or already paid)' },
      { status: 409 },
    );
  }

  // ?mint=1 — mint the hosted Stripe invoice first when the row has none
  // (idempotent: invoice-${referralId} key), so the email carries a one-click
  // hosted Pay page instead of the dashboard CTA. A mint-upgrade send skips
  // the 7-day throttle: it replaces a weaker ask, it doesn't repeat one.
  const wantMint = new URL(request.url).searchParams.get('mint') === '1';
  const mintNeeded = wantMint && !referral['Stripe Invoice URL'];

  // 7-day nudge throttle off the dated Notes stamp — partners, not debtors.
  const notes = String(referral['Notes'] || '');
  const lastNudge = /\[COMMISSION-NUDGE (\d{4}-\d{2}-\d{2})/.exec(notes);
  if (lastNudge && !mintNeeded) {
    const ageDays = (Date.now() - Date.parse(lastNudge[1])) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays < 7) {
      return NextResponse.json(
        { error: `Nudged ${Math.floor(ageDays)}d ago — 7d throttle`, lastNudge: lastNudge[1] },
        { status: 429 },
      );
    }
  }

  const rancherIds: string[] = Array.isArray(referral['Rancher']) ? referral['Rancher'] : [];
  const rancher: any = rancherIds[0]
    ? await getRecordById(TABLES.RANCHERS, rancherIds[0]).catch(() => null)
    : null;
  const email = String(rancher?.['Email'] || '').trim();
  if (!email) return NextResponse.json({ error: 'Rancher has no email' }, { status: 422 });

  let hostedUrl: string = referral['Stripe Invoice URL'] || '';
  let minted = false;
  if (mintNeeded) {
    try {
      const result = await createCommissionInvoice({
        rancher: {
          id: String(rancher.id),
          operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || '',
          ranchName: rancher['Ranch Name'] || '',
          email,
          stripeCustomerId: rancher['Stripe Customer ID'] || undefined,
        },
        referral: {
          id,
          buyerName: referral['Buyer Name'] || '',
          orderType: referral['Order Type'] || 'Beef order',
          saleAmount: Number(referral['Sale Amount'] || 0),
          commissionDue: Number(referral['Commission Due'] || 0),
        },
      });
      hostedUrl = result.invoiceUrl;
      minted = true;
      await updateRecord(TABLES.REFERRALS, id, {
        'Stripe Invoice ID': result.invoiceId,
        'Stripe Invoice URL': result.invoiceUrl,
      });
    } catch (e: any) {
      // Guards (sale floor/ceiling, ratio) and Stripe errors land here.
      // Refuse rather than silently downgrade to the dashboard CTA — the
      // caller asked for a hosted invoice and should see why there isn't one.
      return NextResponse.json({ error: `Mint failed: ${e?.message || 'unknown'}` }, { status: 502 });
    }
  }

  const res = await sendInstantCommissionInvoice({
    operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || '',
    ranchName: rancher['Ranch Name'] || '',
    email,
    buyerName: referral['Buyer Name'] || '',
    orderType: referral['Order Type'] || 'Beef order',
    saleAmount: Number(referral['Sale Amount'] || 0),
    commissionDue: Number(referral['Commission Due'] || 0),
    closedAt: String(referral['Closed At'] || new Date().toISOString()),
    stripeInvoiceUrl: hostedUrl || undefined,
  });
  if (!res?.success) {
    return NextResponse.json(
      { error: 'Send failed or suppressed', detail: res },
      { status: 502 },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const modeLabel = hostedUrl
    ? minted
      ? 'hosted invoice, minted this send'
      : 'hosted invoice'
    : 'dashboard CTA';
  await updateRecord(TABLES.REFERRALS, id, {
    Notes: `[COMMISSION-NUDGE ${today}] invoice ask re-sent (${modeLabel}). ${notes}`.slice(0, 2000),
  }).catch((e: any) => console.error('[send-commission-invoice] notes stamp failed:', e?.message));

  return NextResponse.json({
    ok: true,
    mode: hostedUrl ? 'hosted-invoice' : 'dashboard-cta',
    minted,
    commissionDue: Number(referral['Commission Due'] || 0),
  });
}
