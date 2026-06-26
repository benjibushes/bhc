// Self-serve deposit "reserve" — the fast path behind a Connect-active rancher
// page's "Reserve your share — deposit now" CTA. Mints consumer + buyer session
// + referral pinned to the rancher, then returns a depositUrl the client
// redirects to. No quiz, no rancher callback email. Legacy/ineligible ranchers
// get a 409 with fallback=true so the client routes to the lead form/quiz.
//
// SECURITY: a buyer session is minted from the supplied email ONLY when we
// create a brand-new Consumer (nothing to leak). If the email matches an
// EXISTING consumer and the caller isn't already logged in, we never adopt
// their identity from an unverified email — we email them a one-tap magic link
// (proves ownership) that lands on the deposit page authed. This keeps the
// platform's "session only after an email-issued token" trust model intact.

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
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { generateMemberLoginToken } from '@/lib/secrets';
import { sendBuyerIntroNotification } from '@/lib/email';
import {
  assertReserveEligible,
  buildReserveReferralFields,
  depositPathFor,
  CUT_LABELS,
  type Cut,
} from '@/lib/reserveDeposit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Format check + disposable-domain block — mirrors /api/consumers:42-47 so a
// session-minting endpoint can't be farmed on throwaway addresses.
function isValidEmail(email: string): boolean {
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const domain = email.split('@')[1]?.toLowerCase() || '';
  const throwaway = [
    'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
    'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com',
    '10minutemail.com', 'trashmail.com',
  ];
  return !throwaway.includes(domain);
}

export async function POST(req: Request) {
  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  // Rate limit — this endpoint creates records, bumps capacity, and mints a
  // session. Same budget as /api/consumers signup.
  const ip = getRequestIp(req);
  const rlMin = await rateLimit(`reserve:${ip}`, { requests: 5, window: '1m' });
  if (!rlMin.ok) {
    return NextResponse.json({ error: 'Too many attempts — wait a minute and try again.' }, { status: 429 });
  }
  const rlHour = await rateLimit(`reserve-hr:${ip}`, { requests: 30, window: '1h' });
  if (!rlHour.ok) {
    return NextResponse.json({ error: 'Too many attempts from this network. Email ben@buyhalfcow.com if this is wrong.' }, { status: 429 });
  }

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const slug = String(body.slug || '').trim();
  const cut = String(body.cut || '').toLowerCase() as Cut;
  const nameInput = String(body.name || '').trim();
  const emailInput = String(body.email || '').trim().toLowerCase();

  if (!slug) return NextResponse.json({ error: 'Rancher slug required' }, { status: 400 });
  if (!CUT_LABELS[cut]) return NextResponse.json({ error: 'cut must be quarter|half|whole' }, { status: 400 });

  const existingSession = await resolveBuyerSession(req);
  if (!existingSession && !isValidEmail(emailInput)) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }

  // Look up + gate the rancher BEFORE creating anything.
  let rancher: any;
  try { rancher = await getRancherBySlug(slug); }
  catch { return NextResponse.json({ error: 'Rancher lookup failed' }, { status: 500 }); }
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const gate = assertReserveEligible(rancher, cut);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error, fallback: gate.fallback === true }, { status: gate.status });
  }

  // Resolve buyer identity. Track whether we CREATE the consumer vs adopt an
  // existing one — only a created consumer may be auto-sessioned (see SECURITY).
  let buyerEmail = existingSession?.email || emailInput;
  let buyerName = existingSession?.name || nameInput;
  let buyerState = existingSession?.state || '';
  let consumerId = existingSession?.consumerId || '';
  let adoptedExisting = false;

  if (!consumerId) {
    try {
      const safeEmail = escapeAirtableValue(buyerEmail.toLowerCase());
      const existing: any[] = await getAllRecords(TABLES.CONSUMERS, `LOWER({Email}) = "${safeEmail}"`);
      if (existing.length > 0) {
        adoptedExisting = true;
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

  const depositPath = depositPathFor(referral.id, cut);

  // SECURITY: existing consumer + not logged in → DO NOT mint a session from an
  // unverified email (account takeover). Email a one-tap magic link that proves
  // ownership and lands on the deposit page authed.
  if (adoptedExisting && !existingSession) {
    try {
      const token = generateMemberLoginToken(consumerId, buyerEmail);
      const magicLink = `${SITE_URL}/api/auth/member/verify?token=${token}&next=${encodeURIComponent(depositPath)}`;
      await sendBuyerIntroNotification({
        firstName: (buyerName || buyerEmail).split(/[ @]/)[0],
        email: buyerEmail,
        rancherName: rancher['Operator Name'] || rancher['Ranch Name'] || 'your rancher',
        rancherEmail: rancher['Email'] || '',
        rancherSlug: slug,
        loginUrl: magicLink,
        quarterPrice: Number(rancher['Quarter Price']) || undefined,
        halfPrice: Number(rancher['Half Price']) || undefined,
        wholePrice: Number(rancher['Whole Price']) || undefined,
        referralId: referral.id,
        depositMagicLinkUrl: magicLink,
      });
    } catch (e: any) {
      console.error('[checkout/reserve] magic-link email failed:', e?.message);
    }
    return NextResponse.json({
      requiresEmailVerification: true,
      message: 'We emailed you a secure link to finish reserving your share — check your inbox.',
    });
  }

  // New consumer (or already-logged-in buyer) → safe to mint/return the session
  // + go straight to the deposit page.
  const res = NextResponse.json({ referralId: referral.id, depositUrl: depositPath });
  return setBuyerSessionCookie(res, { consumerId, email: buyerEmail, name: buyerName, state: buyerState });
}
