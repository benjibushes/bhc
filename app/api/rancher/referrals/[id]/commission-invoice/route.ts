import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import { commissionInvoiceEligibility } from '@/lib/commissionOwed';
import { createCommissionInvoice } from '@/lib/stripe-commission';

export const maxDuration = 30;

// Lazy commission-invoice mint — the dashboard "Pay" path for unpaid
// post-close commission whose close-time Stripe invoice never got created.
//
// WHY (ticket 2026-08-03): closes that predate the RAIL-PER-ROW fix (and any
// close where Stripe hiccuped) have Commission Due > 0 but no stamped
// `Stripe Invoice URL` — the rancher literally had no way to pay. This
// endpoint turns the dashboard's Pay button into a self-serve path: verify
// the row is genuinely owed, mint the Stripe hosted invoice (idempotent —
// lib/stripe-commission.ts uses idempotencyKey `invoice-${referralId}`, so a
// double-click or retry can never create two invoices for one referral),
// stamp `Stripe Invoice ID` + `Stripe Invoice URL` on the Referral, and hand
// the hosted URL back for redirect.
//
// Money-model guardrails (all enforced in commissionInvoiceEligibility +
// createCommissionInvoice's own floor/ratio gates):
//   - deposit-rail rows (Deposit Paid At stamped) are REFUSED — the fee was
//     buyer-paid at deposit; invoicing here would double-bill.
//   - Commission Due <= 0 is REFUSED — a locked 0% (Operator tier) rancher
//     owes nothing and must never be handed an invoice.
//   - already-stamped rows short-circuit to the existing hosted URL.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRancher(request);
    if (auth instanceof NextResponse) return auth;
    const { session } = auth;
    const { id } = await context.params;

    const referral: any = await getRecordById(TABLES.REFERRALS, id);
    const gate = commissionInvoiceEligibility(referral, session.rancherId);
    if (!gate.eligible) {
      // not-your-referral / not-found stay a flat 404 — never confirm to a
      // guessing session that a foreign referral id exists.
      if (gate.reason === 'referral-not-found' || gate.reason === 'not-your-referral') {
        return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
      }
      const friendly: Record<string, string> = {
        'not-closed-won': 'This deal is not closed yet — there is nothing to pay.',
        'already-paid': 'This commission is already settled — nothing owed here.',
        'deposit-rail-nothing-owed':
          'This deal collected the platform fee at deposit — you owe nothing on it.',
        'broker-rail-never-invoiced':
          'This deal was handled directly by BuyHalfCow — you owe nothing on it.',
        'nothing-due': 'No commission is due on this deal.',
      };
      return NextResponse.json(
        { error: friendly[gate.reason] || 'This invoice cannot be generated.' },
        { status: 409 },
      );
    }

    // Idempotent short-circuit — the close path (or a previous click here)
    // already minted it.
    if (gate.existingUrl) {
      return NextResponse.json({ ok: true, invoiceUrl: gate.existingUrl, existing: true });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
    if (!rancher?.['Email']) {
      return NextResponse.json(
        { error: 'No email on your account — contact hello@buyhalfcow.com to settle this invoice.' },
        { status: 409 },
      );
    }

    let result;
    try {
      result = await createCommissionInvoice({
        rancher: {
          id: session.rancherId,
          operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || session.name,
          ranchName: rancher['Ranch Name'] || session.ranchName,
          email: rancher['Email'],
          stripeCustomerId: rancher['Stripe Customer ID'] || undefined,
        },
        referral: {
          id,
          buyerName: referral['Buyer Name'] || 'Buyer',
          orderType: referral['Order Type'] || 'Beef order',
          saleAmount: Number(referral['Sale Amount']) || 0,
          commissionDue: Number(referral['Commission Due']) || 0,
        },
      });
    } catch (stripeErr: any) {
      // createCommissionInvoice already fires loud operator signals on its
      // own guard refusals; add one for generic Stripe failures so a rancher
      // actively TRYING to pay never dead-ends silently.
      console.error('[commission-invoice mint] Stripe create failed:', stripeErr?.message);
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: `Rancher tried to PAY commission on ${id} but Stripe invoice mint failed`,
          detail: `Error: ${stripeErr?.message || 'unknown'}\nCreate the invoice manually in Stripe and paste hosted_invoice_url into the referral's "Stripe Invoice URL" field.`,
          refs: [{ type: 'referral', id, label: referral['Buyer Name'] || id }],
          dedupeKey: `commission-mint-fail-${id}`,
          dedupeWindowMs: 60 * 60 * 1000,
        });
      } catch {}
      return NextResponse.json(
        { error: "We couldn't generate your invoice just now — we've been alerted and will email it to you today." },
        { status: 502 },
      );
    }

    // Money-path truth gets persisted (CLAUDE.md rule 2). A failed stamp is
    // non-fatal for THIS request (the rancher still gets the URL) but the
    // idempotencyKey guarantees a retry lands on the same Stripe invoice.
    try {
      await updateRecord(TABLES.REFERRALS, id, {
        'Stripe Invoice ID': result.invoiceId,
        'Stripe Invoice URL': result.invoiceUrl,
      });
    } catch (persistErr: any) {
      console.warn('[commission-invoice mint] stamp failed (non-fatal):', persistErr?.message);
    }

    return NextResponse.json({ ok: true, invoiceUrl: result.invoiceUrl, existing: false });
  } catch (err: any) {
    console.error('[commission-invoice mint] error:', err?.message || err);
    return NextResponse.json({ error: 'Something went wrong — try again in a minute.' }, { status: 500 });
  }
}
