// Self-serve deposit "reserve" — the fast path behind a Connect-active rancher
// page's "Reserve your share — deposit now" CTA. Mints consumer + buyer session
// + referral pinned to the rancher, then returns a depositUrl the client
// redirects to. No quiz, no rancher callback email. Legacy/ineligible ranchers
// get a 409 with fallback=true so the client routes to the lead form/quiz.

import { NextResponse } from 'next/server';
import {
  TABLES,
  createRecord,
  updateRecord,
  getAllRecords,
  getRancherBySlug,
  escapeAirtableValue,
} from '@/lib/airtable';
import { incrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { resolveBuyerSession, setBuyerSessionCookie } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import {
  assertReserveEligible,
  buildReserveReferralFields,
  depositPathFor,
  CUT_LABELS,
  type Cut,
} from '@/lib/reserveDeposit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s);
}

export async function POST(req: Request) {
  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const slug = String(body.slug || '').trim();
  const cut = String(body.cut || '').toLowerCase() as Cut;
  const nameInput = String(body.name || '').trim();
  const emailInput = String(body.email || '').trim().toLowerCase();

  if (!slug) return NextResponse.json({ error: 'Rancher slug required' }, { status: 400 });
  if (!CUT_LABELS[cut]) return NextResponse.json({ error: 'cut must be quarter|half|whole' }, { status: 400 });

  // Logged-in buyer shortcut: reuse their session identity, skip email collect.
  const existingSession = await resolveBuyerSession(req);

  let buyerEmail = existingSession?.email || emailInput;
  let buyerName = existingSession?.name || nameInput;
  let buyerState = existingSession?.state || '';
  let consumerId = existingSession?.consumerId || '';

  if (!existingSession && !isValidEmail(buyerEmail)) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }

  // Look up + gate the rancher BEFORE creating anything.
  let rancher: any;
  try { rancher = await getRancherBySlug(slug); }
  catch { return NextResponse.json({ error: 'Rancher lookup failed' }, { status: 500 }); }
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const gate = assertReserveEligible(rancher, cut);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error, fallback: gate.fallback === true },
      { status: gate.status },
    );
  }

  // Find or create the Consumer (so abandoned-deposit recovery + CAPI work).
  if (!consumerId) {
    try {
      const safeEmail = escapeAirtableValue(buyerEmail);
      const existing: any[] = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${safeEmail.toLowerCase()}"`,
      );
      if (existing.length > 0) {
        consumerId = existing[0].id;
        buyerName = buyerName || existing[0]['Full Name'] || '';
        buyerState = buyerState || existing[0]['State'] || '';
      } else {
        const created: any = await createRecord(TABLES.CONSUMERS, {
          'Full Name': buyerName || '',
          'Email': buyerEmail,
          'Segment': 'Beef Buyer',
          'Source': `rancher-page-deposit:${slug}`,
          'Order Type': CUT_LABELS[cut],
          'Interest Beef': true,
          'Intent Score': 90,
          'Intent Classification': 'High',
        });
        consumerId = created.id;
      }
    } catch (e: any) {
      console.error('[checkout/reserve] consumer upsert failed:', e?.message);
      return NextResponse.json({ error: 'Could not start your reservation — try again.' }, { status: 500 });
    }
  }

  // Create the deposit-intent referral pinned to the rancher.
  let referral: any;
  try {
    referral = await createRecord(
      TABLES.REFERRALS,
      buildReserveReferralFields({ rancher, consumerId, buyerName, buyerEmail, cut }),
    );
  } catch (e: any) {
    console.error('[checkout/reserve] referral create failed:', e?.message);
    return NextResponse.json({ error: 'Could not start your reservation — try again.' }, { status: 500 });
  }

  // Hold the slot during checkout (mirror orders/request:220-228). Transient:
  // an abandoned Pending referral is reconciled by capacity-drift-check.
  try {
    const newCount = await incrementCapacity(rancher.id);
    await syncCapacityToAirtable(rancher.id, newCount);
    await updateRecord(TABLES.RANCHERS, rancher.id, { 'Last Assigned At': new Date().toISOString() });
  } catch (e: any) {
    console.warn('[checkout/reserve] capacity bump skipped:', e?.message);
  }

  // Mint the buyer session + return the deposit URL. Cookie rides on this JSON
  // response so the subsequent deposit page GET/POST are authenticated.
  const res = NextResponse.json({
    referralId: referral.id,
    depositUrl: depositPathFor(referral.id, cut),
  });
  return setBuyerSessionCookie(res, { consumerId, email: buyerEmail, name: buyerName, state: buyerState });
}
