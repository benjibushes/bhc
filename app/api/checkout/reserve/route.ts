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
  createReferral,
  updateRecord,
  getAllRecords,
  getRancherBySlug,
  escapeAirtableValue,
  getRecordById,
} from '@/lib/airtable';
import { claimOnce } from '@/lib/rancherCapacity';
import { resolveBuyerSession, setBuyerSessionCookie } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { generateMemberLoginToken } from '@/lib/secrets';
import { sendBuyerIntroNotification } from '@/lib/email';
import {
  assertReserveEligible,
  buildReserveConsumerFields,
  buildReserveReferralFields,
  depositPathFor,
  normalizeReservePhone,
  reserveConsumerStatusPatch,
  CUT_LABELS,
  type Cut,
} from '@/lib/reserveDeposit';
import { normalizeState } from '@/lib/states';
import { normalizeZip } from '@/lib/zipFormat';
import { buyerZipPatch, ZIP_OUT_OF_AREA_MESSAGE } from '@/lib/buyerZip';
import { buyerZipServedBy } from '@/lib/exclusiveZip';

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
  // ZIP: null unless the client sent a real 5-digit US ZIP. Optional on the
  // wire by design — see the ZIP CAPTURE decision below. Never a 400 on its
  // own; a garbage value is simply dropped and never persisted.
  const zipInput = normalizeZip(body.zip);

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

  // ── EXCLUSIVE-ZIP GATE + THE ZIP-CAPTURE DECISION (2026-07-25) ────────────
  //
  // This is the fastest checkout in the product and it's about to receive paid
  // traffic, so WHEN we ask for a ZIP is a conversion decision, not a taste
  // one. Two different answers, split on whether the ZIP is contractually
  // load-bearing for THIS rancher:
  //
  //   • Rancher HAS `Service ZIP Prefixes` (hasServiceZipGate) — Ben signed an
  //     exclusivity contract for that territory. The ZIP must be known BEFORE
  //     the money moves, because a payment from outside it is a breach we'd
  //     then have to refund. The rancher page renders a required ZIP field
  //     (DepositReserveForm `requireZip`), and this gate is the fail-closed
  //     backstop for any client that doesn't.
  //
  //   • Rancher has NO prefixes — every live rancher today. Adding a required
  //     field here costs conversion for zero eligibility benefit, so the fast
  //     path stays untouched: buyerZipServedBy returns true for a no-prefix
  //     rancher regardless of ZIP (documented contract in lib/exclusiveZip), so
  //     the line below is a literal no-op for them. We still get the ZIP — just
  //     AFTER payment, harvested from the Stripe address at settlement
  //     (lib/stripeSettlement → buyerZipPatch). Same data, no form friction.
  //
  // Fail CLOSED for the gated case: missing, malformed, and out-of-prefix ZIPs
  // are all ineligible. The response mirrors the route's existing 409+fallback
  // shape so the client routes the buyer to the quiz instead of dead-ending,
  // and the copy never reveals the other ranch's area.
  if (!buyerZipServedBy(zipInput, rancher)) {
    // `outOfArea` tells the client NOT to re-pin this ranch on the way to the
    // quiz (the usual `fallback` target is /access?rancher=<slug>, which would
    // loop the buyer straight back to the ranch that just declined them).
    return NextResponse.json(
      { error: ZIP_OUT_OF_AREA_MESSAGE, fallback: true, outOfArea: true },
      { status: 409 },
    );
  }

  // T2.2 (2026-07-02): affiliate attribution on the reserve rail. The success
  // page's share link appends ?ref=<code> and the rancher page threads it into
  // this POST — validate it exactly like /api/consumers does (existence,
  // Status=Active, self-referral email+phone block) and stamp 'Referred By'
  // below. Invalid/self refs validate to '' and are silently dropped.
  // Best-effort: an Airtable hiccup here must never block the reserve.
  let referredBy = '';
  try {
    const rawRef = typeof body.ref === 'string' ? body.ref : '';
    if (rawRef) {
      const { validateAffiliateRefForSignup } = await import('@/lib/affiliates');
      referredBy = await validateAffiliateRefForSignup(rawRef, {
        email: emailInput,
        phone: phoneInput,
      });
    }
  } catch (e: any) {
    console.warn('[checkout/reserve] affiliate ref validation skipped:', e?.message);
  }

  // Resolve buyer identity. Track whether we CREATE the consumer vs adopt an
  // existing one — only a created consumer may be auto-sessioned (see SECURITY).
  let buyerEmail = existingSession?.email || emailInput;
  let buyerName = existingSession?.name || nameInput;
  let buyerState = existingSession?.state || stateInput || '';
  const buyerPhone = phoneInput;
  let consumerId = existingSession?.consumerId || '';
  let adoptedExisting = false;
  // QUIZ GATE state — set true only when the resolved consumer carries a
  // 'Qualified At' stamp (the funnel+quiz completion mark). Checked below
  // before any referral/session minting.
  let quizQualified = false;

  if (!consumerId) {
    try {
      const safeEmail = escapeAirtableValue(buyerEmail.toLowerCase());
      const existing: any[] = await getAllRecords(TABLES.CONSUMERS, `LOWER({Email}) = "${safeEmail}"`);
      if (existing.length > 0) {
        adoptedExisting = true;
        consumerId = existing[0].id;
        quizQualified = !!existing[0]['Qualified At'];
        buyerName = buyerName || existing[0]['Full Name'] || '';
        buyerState = buyerState || existing[0]['State'] || '';
        // Backfill Phone/State on the existing Consumer when blank so the
        // rancher always has a number to call (never overwrite a real value).
        const patch: Record<string, any> = {};
        if (buyerPhone && !String(existing[0]['Phone'] || '').trim()) patch['Phone'] = buyerPhone;
        if (buyerState && !String(existing[0]['State'] || '').trim()) patch['State'] = buyerState;
        // Same never-overwrite rule for ZIP (buyerZipPatch enforces it): fill a
        // blank/garbage Zip, leave a real one alone.
        Object.assign(patch, buyerZipPatch(zipInput, existing[0]['Zip']));
        // A reserving buyer must ALWAYS be able to log in: promote a blank/
        // Pending Status to Approved so the magic link we're about to email
        // passes the member LOGIN_ALLOWED gate instead of 302ing to /access.
        // Never touches login-allowed or deliberately-set (Rejected) statuses.
        Object.assign(patch, reserveConsumerStatusPatch(existing[0]['Status']));
        // SMS consent: opting in always writes true + stamps the consent time;
        // no tick leaves the existing value untouched (mirrors /api/consumers'
        // funnel-path semantics — never silently revoke). Rides the existing
        // non-fatal patch, so a write failure can't block the reserve.
        if (smsOptInReserve) {
          patch['SMS Opt-In'] = true;
          patch['SMS Opt-In At'] = new Date().toISOString();
        }
        // First-touch attribution: stamp Referred By only when BLANK — an
        // earlier attribution (quiz signup or a prior share) always wins.
        if (referredBy && !String(existing[0]['Referred By'] || '').trim()) {
          patch['Referred By'] = referredBy;
        }
        if (Object.keys(patch).length > 0) {
          try { await updateRecord(TABLES.CONSUMERS, consumerId, patch); }
          catch (e: any) { console.warn('[checkout/reserve] consumer backfill skipped:', e?.message); }
        }
      } else {
        // QUIZ GATE (founder rule 2026-07-08): a share deposit is NEVER sold
        // to someone who hasn't been through the quiz. A brand-new email has
        // by definition not taken it — 409 { fallback:true } sends them to
        // /access?rancher=<slug>, which pre-pins this ranch so they land
        // right back here qualified. (Campaign /r/[token] links are exempt
        // by construction — those grants only mint for already-qualified
        // waitlist buyers.)
        return NextResponse.json(
          {
            error: 'Take the 90-second quiz first — it locks your spot with this ranch.',
            fallback: true,
          },
          { status: 409 },
        );
        // (unreachable) Field set lives in lib/reserveDeposit (buildReserveConsumerFields,
        // tested) — includes Status='Approved' so the buyer can always log in
        // (member LOGIN_ALLOWED gate), plus the Interests/SMS-consent fixes.
        const created: any = await createRecord(
          TABLES.CONSUMERS,
          buildReserveConsumerFields({
            slug,
            cut,
            buyerName,
            buyerEmail,
            buyerPhone,
            buyerState,
            buyerZip: zipInput || undefined,
            smsOptIn: smsOptInReserve,
            referredBy,
          }),
        );
        consumerId = created.id;
      }
    } catch (e: any) {
      console.error('[checkout/reserve] consumer upsert failed:', e?.message);
      return NextResponse.json({ error: 'Could not start your reservation — try again.' }, { status: 500 });
    }
  } else if (smsOptInReserve || zipInput) {
    // Already-logged-in buyer: the upsert above is skipped, so persist their
    // ticked consent (and a supplied ZIP) here. Same guards (consent true only
    // with phone, opt-IN only; ZIP never stomps a stored one).
    // NON-FATAL: neither write may block the reserve money path.
    try {
      const patch: Record<string, any> = {};
      if (smsOptInReserve) {
        patch['SMS Opt-In'] = true;
        patch['SMS Opt-In At'] = new Date().toISOString();
      }
      if (zipInput) {
        // Only reached when the client actually sent a ZIP — i.e. the gated
        // rancher case — so the fast path pays for no extra Airtable read.
        const current: any = await getRecordById(TABLES.CONSUMERS, consumerId).catch(() => null);
        Object.assign(patch, buyerZipPatch(zipInput, current?.['Zip']));
      }
      if (Object.keys(patch).length > 0) {
        await updateRecord(TABLES.CONSUMERS, consumerId, patch);
      }
    } catch (e: any) {
      console.warn('[checkout/reserve] consumer patch skipped (non-fatal):', e?.message);
    }
  }

  // QUIZ GATE enforcement (founder rule 2026-07-08): whole/half/quarter
  // deposits only after the quiz. Existing-session buyers get their stamp
  // checked here (one read); email-path buyers were checked at lookup; new
  // emails were bounced above. Unqualified → 409 fallback → the client
  // sends them to /access?rancher=<slug> with this ranch pre-pinned.
  if (!quizQualified && consumerId) {
    try {
      const c: any = await getRecordById(TABLES.CONSUMERS, consumerId);
      quizQualified = !!c?.['Qualified At'];
    } catch { /* fail-closed below */ }
  }
  if (!quizQualified) {
    return NextResponse.json(
      {
        error: 'Take the 90-second quiz first — it locks your spot with this ranch.',
        fallback: true,
      },
      { status: 409 },
    );
  }

  // ── Duplicate-mint guards (write-safety audit 2026-07-07) ────────────────
  // The dominant real-world duplicate is a SERIAL retry: the route does 5+
  // sequential Airtable calls, the buyer re-submits after a slow response,
  // and a second Pending referral + second capacity hold appear — and the
  // abandoned-reserve recovery cron later nudges a buyer who already PAID on
  // the other row. Reuse an existing open deposit-intent referral for this
  // buyer+rancher instead of always-creating. Fail-open: a lookup error just
  // falls through to create (never blocks the money path).
  let referral: any = null;
  try {
    const { fetchReferralRowsForRancher } = await import('@/lib/referralReads');
    const mine = (await fetchReferralRowsForRancher(rancher.id)).filter((row: any) => {
      const buyers = Array.isArray(row['Buyer']) ? row['Buyer'] : [];
      const status = String(row['Status'] || '');
      return (
        buyers.includes(consumerId) &&
        !row['Deposit Paid At'] &&
        (status === 'Pending' || status === 'Pending Approval')
      );
    });
    if (mine.length > 0) {
      referral = mine[0];
    }
  } catch (e: any) {
    console.warn('[checkout/reserve] dedup lookup skipped (non-fatal):', e?.message);
  }

  if (!referral) {
    // Concurrency claim: two truly simultaneous POSTs (double-tap/two tabs)
    // serialize here — the loser re-runs the dedup lookup to adopt the
    // winner's referral. claimOnce fails OPEN when Redis is down (serial
    // dedup above remains the belt).
    const claimed = await claimOnce(`reserve:${consumerId}:${rancher.id}`, 15);
    if (!claimed) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const { fetchReferralRowsForRancher } = await import('@/lib/referralReads');
        const mine = (await fetchReferralRowsForRancher(rancher.id)).filter((row: any) => {
          const buyers = Array.isArray(row['Buyer']) ? row['Buyer'] : [];
          return buyers.includes(consumerId) && !row['Deposit Paid At'];
        });
        if (mine.length > 0) referral = mine[0];
      } catch {}
      if (!referral) {
        return NextResponse.json(
          { error: 'Your reservation is already starting — give it a few seconds and try again.' },
          { status: 409 },
        );
      }
    }
  }

  const reusedReferral = !!referral;
  if (!referral) {
    try {
      referral = await createReferral(
        buildReserveReferralFields({ rancher, consumerId, buyerName, buyerEmail, buyerPhone, buyerState, cut }),
      );
    } catch (e: any) {
      console.error('[checkout/reserve] referral create failed:', e?.message);
      return NextResponse.json({ error: 'Could not start your reservation — try again.' }, { status: 500 });
    }
  }

  // NO capacity INCR here (2026-07-22): reserve rows are Status='Pending' —
  // NOT a held status (lib/capacityCount HELD_REFERRAL_STATUSES) — so both
  // daily reconcilers (capacity-drift-check, batch-approve self-heal)
  // recompute the counter WITHOUT them. INCRing on mint inflated the shared
  // Redis counter with phantom load the reconcilers then reset — a sawtooth
  // that waitlisted cold matching for that rancher for hours after a burst
  // of /r reserve clicks. The counter INCRs when the row reaches a held
  // status; abandoned Pending rows need no release. Round-robin freshness
  // (Last Assigned At) still stamps on a fresh row.
  if (!reusedReferral) {
    try {
      await updateRecord(TABLES.RANCHERS, rancher.id, { 'Last Assigned At': new Date().toISOString() });
    } catch (e: any) {
      console.warn('[checkout/reserve] Last Assigned At stamp skipped:', e?.message);
    }
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
    // Void the hold we just created (referral → Lost), then return an honest,
    // retryable error. Leaving it as-is would strand a phantom Pending lead the
    // rancher sees + a buyer waiting on an email that never comes. (No capacity
    // release needed — Pending mints no longer bump the counter, see above.)
    if (!emailSent) {
      try {
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'Status': 'Lost',
          'Notes': 'Voided automatically — the reserve sign-in email failed to send; buyer was asked to retry.',
        });
      } catch (voidErr: any) {
        console.warn('[checkout/reserve] orphan referral void skipped:', voidErr?.message);
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
