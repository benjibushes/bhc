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
import { incrementCapacity, decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { resolveBuyerSession, setBuyerSessionCookie } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { generateMemberLoginToken } from '@/lib/secrets';
import { sendBuyerIntroNotification } from '@/lib/email';
import {
  assertReserveEligible,
  buildReserveReferralFields,
  depositPathFor,
  normalizeReservePhone,
  CUT_LABELS,
  type Cut,
} from '@/lib/reserveDeposit';
import { normalizeState } from '@/lib/states';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

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
  // Phone is REQUIRED on the self-serve rail — the rancher's whole promise is to
  // call the buyer the moment the deposit lands. State is captured for routing/
  // context; normalized to a 2-letter code (may be blank if unrecognized).
  const phoneInput = normalizeReservePhone(body.phone);
  const stateInput = normalizeState(body.state);

  if (!slug) return NextResponse.json({ error: 'Rancher slug required' }, { status: 400 });
  if (!CUT_LABELS[cut]) return NextResponse.json({ error: 'cut must be quarter|half|whole' }, { status: 400 });
  if (!phoneInput) {
    return NextResponse.json({ error: 'A valid phone number is required so the rancher can reach you.' }, { status: 400 });
  }

  // TCPA SMS consent from DepositReserveForm's checkbox (funnel payload
  // convention). Same gate as /api/consumers (~172 + ~545): stored true ONLY
  // when the buyer ticked the box AND supplied a phone — phone is already
  // required on this rail (400 above), so the guard is belt-and-braces.
  // Opt-IN only: false never revokes a prior opt-in (STOP webhook is the
  // authoritative off switch).
  const smsOptInReserve = body.smsOptIn === true && !!phoneInput;

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
  let buyerState = existingSession?.state || stateInput || '';
  const buyerPhone = phoneInput;
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
        // Backfill Phone/State on the existing Consumer when blank so the
        // rancher always has a number to call (never overwrite a real value).
        const patch: Record<string, any> = {};
        if (buyerPhone && !String(existing[0]['Phone'] || '').trim()) patch['Phone'] = buyerPhone;
        if (buyerState && !String(existing[0]['State'] || '').trim()) patch['State'] = buyerState;
        // SMS consent: opting in always writes true + stamps the consent time;
        // no tick leaves the existing value untouched (mirrors /api/consumers'
        // funnel-path semantics — never silently revoke). Rides the existing
        // non-fatal patch, so a write failure can't block the reserve.
        if (smsOptInReserve) {
          patch['SMS Opt-In'] = true;
          patch['SMS Opt-In At'] = new Date().toISOString();
        }
        if (Object.keys(patch).length > 0) {
          try { await updateRecord(TABLES.CONSUMERS, consumerId, patch); }
          catch (e: any) { console.warn('[checkout/reserve] consumer backfill skipped:', e?.message); }
        }
      } else {
        const created: any = await createRecord(TABLES.CONSUMERS, {
          'Full Name': buyerName || '',
          'Email': buyerEmail,
          'Phone': buyerPhone,
          ...(buyerState ? { 'State': buyerState } : {}),
          'Segment': 'Beef Buyer',
          'Source': `rancher-page-deposit:${slug}`,
          'Order Type': CUT_LABELS[cut],
          // FIX (store-reserve 500): 'Interest Beef' is a singleLineText field —
          // writing boolean `true` 422'd Airtable (typecast can't coerce
          // bool→text), the catch returned 500, and reserve aborted BEFORE the
          // referral was created → EVERY new store buyer's deposit failed. The
          // real, read-everywhere field is 'Interests' (multipleSelects); match
          // the main funnel (/api/consumers). typecast auto-creates 'Beef'.
          'Interests': ['Beef'],
          'Intent Score': 90,
          'Intent Classification': 'High',
          // SMS consent (TCPA): seed the checkbox explicitly on a brand-new
          // Consumer so the Twilio gate starts in a known state; stamp the
          // consent time only on a real opt-in. Mirrors /api/consumers ~545.
          'SMS Opt-In': smsOptInReserve,
          ...(smsOptInReserve ? { 'SMS Opt-In At': new Date().toISOString() } : {}),
        });
        consumerId = created.id;
      }
    } catch (e: any) {
      console.error('[checkout/reserve] consumer upsert failed:', e?.message);
      return NextResponse.json({ error: 'Could not start your reservation — try again.' }, { status: 500 });
    }
  } else if (smsOptInReserve) {
    // Already-logged-in buyer: the upsert above is skipped, so persist their
    // ticked consent here. Same guards (true only with phone, opt-IN only).
    // NON-FATAL: consent persistence must never block the reserve money path.
    try {
      await updateRecord(TABLES.CONSUMERS, consumerId, {
        'SMS Opt-In': true,
        'SMS Opt-In At': new Date().toISOString(),
      });
    } catch (e: any) {
      console.warn('[checkout/reserve] SMS opt-in persist skipped (non-fatal):', e?.message);
    }
  }

  // Create the deposit-intent referral pinned to the rancher.
  let referral: any;
  try {
    referral = await createRecord(
      TABLES.REFERRALS,
      buildReserveReferralFields({ rancher, consumerId, buyerName, buyerEmail, buyerPhone, buyerState, cut }),
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
    let emailSent = false;
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
      emailSent = true;
    } catch (e: any) {
      console.error('[checkout/reserve] magic-link email failed:', e?.message);
    }

    // U3: never tell the buyer "check your inbox" when the email did NOT send.
    // Void the hold we just created (referral → Lost + release the capacity
    // bump, together so we don't leave a counter-drift), then return an honest,
    // retryable error. Leaving it as-is would strand a phantom Pending lead the
    // rancher sees + a buyer waiting on an email that never comes.
    if (!emailSent) {
      try {
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'Status': 'Lost',
          'Notes': 'Voided automatically — the reserve sign-in email failed to send; buyer was asked to retry.',
        });
      } catch (voidErr: any) {
        console.warn('[checkout/reserve] orphan referral void skipped:', voidErr?.message);
      }
      try {
        const newCount = await decrementCapacity(rancher.id);
        await syncCapacityToAirtable(rancher.id, newCount);
      } catch (capErr: any) {
        console.warn('[checkout/reserve] capacity release after email fail skipped:', capErr?.message);
      }
      return NextResponse.json(
        { error: "We couldn't email your secure sign-in link just now. Please try again in a moment — or log in from the member page to finish reserving." },
        { status: 502 },
      );
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
