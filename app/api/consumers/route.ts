import { NextResponse } from 'next/server';
import { createRecord, updateRecord, getAllRecords, escapeAirtableValue, getRancherBySlug } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { validateAffiliateRefForSignup } from '@/lib/affiliates';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 90;
import { sendConsumerConfirmation, sendAdminAlert, sendWelcomeAndReadyToBuy, sendStateWaitlistLetter, getSuppressionList } from '@/lib/email';
import { normalizeState } from '@/lib/states';
import { hasOperationalRancherForState } from '@/lib/rancherEligibility';
import { sendTelegramConsumerSignup, sendTelegramHotLeadAlert } from '@/lib/telegram';
import { transitionBuyerStage } from '@/lib/contracts';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Every signup is an Approved member. No "Pending" purgatory — the old
// Pending status created a delay where customers thought they were in but
// couldn't actually log in or get matched until a cron ran the next day.
// Qualification (do they get matched to a rancher, or do they get nurtured?)
// is a separate decision, made below.
function deriveStatus(_segment: string, _intentClassification: string): string {
  return 'Approved';
}

// Qualification gate for sending a buyer to a rancher. We never want a rancher
// to get a tire-kicker — minimum bar is: explicitly want beef + chose a tier
// (Quarter/Half/Whole) + provided a budget. Without all three, the rancher
// can't quote, and the rancher's perception of BHC lead quality tanks.
//
// Buyers who don't qualify still get Approved + access — they just go into
// nurture instead of matching, and can self-upgrade via /api/member/upgrade-intent
// once they fill in the missing details.
// Logic moved to lib/qualification.ts as the single source of truth — re-imported
// here so signup-time and routing-time gates can never drift apart.

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com', '10minutemail.com', 'trashmail.com'];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function isValidName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/[<>{}()\[\]\\\/]/.test(trimmed)) return false;
  return true;
}

export async function POST(request: Request) {
  try {
    // Rate limit signup. No-op when Upstash env unset (safe fallthrough).
    // 5/min/IP + 30/hr/IP. Closes audit finding 2026-05-20 #9.
    const ip = getRequestIp(request);
    const rlMin = await rateLimit(`signup:${ip}`, { requests: 5, window: '1m' });
    if (!rlMin.ok) {
      return NextResponse.json(
        { error: 'Too many signups from this network — wait a minute and try again.' },
        { status: 429 },
      );
    }
    const rlHour = await rateLimit(`signup-hr:${ip}`, { requests: 30, window: '1h' });
    if (!rlHour.ok) {
      return NextResponse.json(
        { error: 'Too many signups from this network in the past hour. Email ben@buyhalfcow.com if this is wrong.' },
        { status: 429 },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const {
      fullName, email, phone, smsOptIn, state,
      orderType: orderTypeRaw, budgetRange: budgetRangeRaw, timing, notes,
      interestBeef: interestBeefRaw, interestLand, interestMerch, interestAll,
      intentScore, intentClassification, segment,
      source, campaign, utmParams, ref, rancherSlug,
    } = body;

    // ── DEFAULT QUALIFICATION SIGNALS — revenue lever ────────────────
    // /access form trimmed to 5 fields (state, household, timing, email,
    // firstName) for top-of-funnel velocity. Tradeoff: Order Type +
    // Budget unfilled → segment classified as 'Community' instead of
    // 'Beef Buyer' → auto-route gate fails → buyer stuck in WAITING
    // until manual warmup YES click.
    //
    // Fix: when timing signals immediate intent (Within 30 days OR
    // 1-3 months) AND Order Type/Budget not collected, default to Half
    // + $1500-$2500 (median tier + median price). Lifts segment to
    // Beef Buyer → auto-route fires → 3-5× conversion lift per CRO
    // audit (docs/REVENUE-AUDIT-2026-05-25.md path 1).
    //
    // Rancher gets the lead w/ "assumed Half" annotation in Notes; can
    // adjust on first call. Better than buyer sitting in WAITING for 14
    // days hoping for warmup engage.
    const highIntentTiming = timing === 'Within 30 days' || timing === '1-3 months';
    const orderType = orderTypeRaw || (highIntentTiming ? 'Half' : '');
    const budgetRange = budgetRangeRaw || (highIntentTiming ? '$1500-$2500' : '');
    // Auto-flag Beef interest when timing signals intent — same logic:
    // buyer filling the trimmed form w/ high-intent timing is signaling
    // beef-buy intent even if they didn't tick the explicit checkbox.
    const interestBeef = interestBeefRaw || (highIntentTiming ? true : false);

    if (!fullName || !email || !state) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Reject unrecognized states at the door. Otherwise buyers with typo
    // states ("Calfornia", "ZZ", etc.) write through normalizeState's
    // null-fallback into a permanently-stranded record that matching
    // engine can never route. Audit finding 2026-05-20 #20.
    if (!normalizeState(state)) {
      return NextResponse.json({
        error: `State "${state}" not recognized — pick from the dropdown or use the 2-letter code (e.g. TX, MT, WV).`,
      }, { status: 400 });
    }

    if (!isValidName(fullName)) {
      return NextResponse.json({ error: 'Please enter a valid name' }, { status: 400 });
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
    }

    // Suppression check — silently pretend success for bounced/unsubscribed
    // emails so scrapers can't probe suppression state and so re-submitted
    // dead addresses don't re-enter nurture flows. Fail-open: if the
    // suppression list fetch errors, let the signup through.
    try {
      const suppressionList = await getSuppressionList();
      if (suppressionList.has(email.trim().toLowerCase())) {
        console.log(`[signup] SKIPPED ${email} (suppressed: unsubscribed/bounced/complained)`);
        return NextResponse.json({ success: true }, { status: 201 });
      }
    } catch (e) {
      console.warn('[signup] suppression check failed, allowing through:', e);
      // Fall through — fail-open on suppression check failure
    }

    // Phone REQUIRED (2026-06-03). Previously optional, but matched ranchers
    // can't reliably reach buyers without it (email-only ghost rate ~50%).
    // Booking the Cal.com intro call also needs a callback channel, and SMS
    // opt-in needs a number to send to. Reject signups missing or invalid.
    if (!phone || !phone.trim()) {
      return NextResponse.json({ error: 'Phone number is required so your rancher can reach you' }, { status: 400 });
    }
    if (!isValidPhone(phone)) {
      return NextResponse.json({ error: 'Please enter a valid phone number' }, { status: 400 });
    }

    if (notes && notes.length > 2000) {
      return NextResponse.json({ error: 'Notes must be under 2000 characters' }, { status: 400 });
    }

    // Check for duplicate email. Special case: if the existing record is an
    // abandoned-application stub (Source = 'abandoned_application'), we'll
    // UPGRADE it in place rather than rejecting the user. Otherwise the user
    // who started the form, abandoned it, then came back to finish would see
    // a confusing "already registered" error.
    let upgradeStubId: string | null = null;
    try {
      const existing = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${escapeAirtableValue(email.trim().toLowerCase())}"`
      ) as any[];
      if (existing.length > 0) {
        const stub = existing.find((c) => c['Source'] === 'abandoned_application');
        if (stub) {
          upgradeStubId = stub.id;
        } else {
          return NextResponse.json({ error: 'This email is already registered. Check your inbox for your confirmation.' }, { status: 409 });
        }
      }
    } catch (e) {
      console.error('Error checking duplicate email:', e);
    }

    const interests: string[] = [];
    if (interestBeef) interests.push('Beef');
    if (interestLand) interests.push('Land');
    if (interestMerch) interests.push('Merch');
    if (interestAll) interests.push('All');

    // Server-side segment + intent calculation (don't trust client-supplied values).
    // Mirrors app/access/page.tsx calculateIntentScore — the form rework gives
    // bracket-level weights so casual signups land at ~40, serious buyers at 70+.
    const consumerSegment = (interestBeef || interestAll) && orderType ? 'Beef Buyer' : 'Community';
    const isRancherPageLead = source === 'rancher-page' && campaign?.startsWith('rancher-');

    // G15 — rancher deep-link attribution on /access?rancher=<slug>
    // Pre-attribute lead to the rancher who shared the link. Lookup rancher by slug
    // and treat as similar to rancher-page lead (high intent, direct relationship).
    let rancherRecord: any = null;
    let isRancherDeepLink = false;
    if (rancherSlug) {
      try {
        rancherRecord = await getRancherBySlug(rancherSlug);
        if (rancherRecord) {
          isRancherDeepLink = true;
        } else {
          console.warn(`[signup] rancher slug "${rancherSlug}" not found or not live`);
        }
      } catch (e) {
        console.error(`[signup] error looking up rancher slug "${rancherSlug}":`, e);
      }
    }

    let serverIntentScore = 0;
    if (isRancherPageLead || isRancherDeepLink) {
      // Both rancher-page leads and rancher deep-link signups represent high intent
      // (clicked "Buy" on rancher or shared rancher's custom link). Boost to 85.
      serverIntentScore = 85;
    } else {
      // Interest signal
      if (interestBeef) serverIntentScore += 30;
      if (interestAll) serverIntentScore += 15;
      if (interestMerch && !interestBeef && !interestAll) serverIntentScore -= 10;

      // Tier — bigger commit = higher intent
      if (orderType === 'Whole') serverIntentScore += 30;
      else if (orderType === 'Half') serverIntentScore += 20;
      else if (orderType === 'Quarter') serverIntentScore += 10;

      // Budget bracket — realistic ones add, "Just exploring" subtracts
      if (budgetRange === '$5000+') serverIntentScore += 30;
      else if (budgetRange === '$4000-$5000') serverIntentScore += 25;
      else if (budgetRange === '$2000-$2500') serverIntentScore += 20;
      else if (budgetRange === '$1000-$1500') serverIntentScore += 15;
      else if (/just exploring/i.test(budgetRange || '')) serverIntentScore -= 15;
      // Legacy brackets (existing buyers in DB) — keep partial credit so old
      // records don't get demoted on a re-evaluation.
      else if (budgetRange === '$2000+') serverIntentScore += 25;
      else if (budgetRange === '$1000-$2000') serverIntentScore += 20;
      else if (budgetRange === '$500-$1000') serverIntentScore += 5;

      // Timing — strongest commitment signal we have
      if (timing === 'Within 30 days') serverIntentScore += 25;
      else if (timing === '1-3 months') serverIntentScore += 15;
      else if (timing === '3-6 months') serverIntentScore += 5;
      else if (/just exploring/i.test(timing || '')) serverIntentScore -= 15;

      if (notes && notes.length > 20) serverIntentScore += 15;
      if (phone) serverIntentScore += 15;
    }
    serverIntentScore = Math.max(serverIntentScore, 0);
    const serverIntentClassification = serverIntentScore >= 70 ? 'High' : serverIntentScore >= 40 ? 'Medium' : 'Low';

    const status = deriveStatus(consumerSegment, serverIntentClassification);
    const firstName = fullName.split(' ')[0];

    // validateAffiliateRefForSignup normalizes case + blocks self-referrals
    // (when the affiliate's own email OR phone matches the buyer's). Returns
    // '' if the ref is invalid for any reason. Stored lowercased. Phone
    // included because an affiliate could otherwise sign up under
    // `me+sock@x.com` (fresh email, same phone) and farm self-attribution.
    const referredBy = await validateAffiliateRefForSignup(ref, { email, phone });

    // ── Stamp lifecycle fields at signup ────────────────────────────────
    // Previously these were written by downstream crons (reclassify-buyers,
    // batch-approve) on their next nightly run, leaving fresh signups with
    // NULL Created + NULL Buyer Stage. Side effects:
    //   - /api/stats/public activity24h.signups filters by Created → 0
    //   - familiesMatched stat filters by Buyer Stage IN
    //     [READY,MATCHED,CLOSED] → fresh signups missing
    //   - Operator views looked like "no data attached"
    // Now: every signup self-stamps these so dashboards + counters reflect
    // reality immediately, and downstream crons take over to transition
    // through subsequent stages.
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.slice(0, 10); // YYYY-MM-DD (Date field type)

    const consumerFields: Record<string, unknown> = {
      'Full Name': fullName.trim(),
      'Email': email.trim().toLowerCase(),
      'Phone': phone || '',
      // F-3 audit: TCPA explicit SMS opt-in. False unless buyer ticked the
      // checkbox AND supplied a phone. All Twilio sends gate on this field
      // via sendSMSToConsumer() in lib/twilio.ts.
      'SMS Opt-In': !!smsOptIn && !!(phone && phone.trim().length > 0),
      // P4-D audit: explicit consent timestamp = TCPA evidence trail. Without
      // this we can't defend a complaint ("when did you receive consent?").
      // Stamped only when the opt-in is TRUE at signup. Future flips back to
      // true from the Twilio inbound webhook (re-opt-in) should re-stamp.
      // Requires a `SMS Opt-In At` dateTime field on Consumers (Airtable).
      'SMS Opt-In At': (!!smsOptIn && !!(phone && phone.trim().length > 0)) ? nowIso : null,
      'Created': todayDate,
      'Approved At': nowIso,
      'Buyer Stage': 'NEW',
      'Buyer Stage Updated At': nowIso,
      // Always store as canonical 2-letter code via normalizeState so all
      // downstream comparisons (matching, warmup, sequences) hit the same
      // value. Form may submit "Montana", "montana", "MT", or " mt " —
      // they all collapse to "MT". Invalid input returns ''.
      'State': normalizeState(state) || state.toString().trim().toUpperCase(),
      'Interests': interests,
      'Status': status,
      'Segment': consumerSegment,
      'Order Type': orderType || '',
      'Budget': budgetRange || '',
      // Timing prepended to Notes (no schema migration needed). Surfaces in
      // admin views + the rancher intro email for context. Used transiently
      // below to decide auto-route eligibility too.
      'Notes': [
        timing ? `[Timing: ${timing}]` : '',
        notes || '',
      ].filter(Boolean).join('\n'),
      'Source': isRancherDeepLink ? `rancher-${rancherSlug}` : (source || 'organic'),
      'Intent Score': serverIntentScore,
      'Intent Classification': serverIntentClassification,
      'Referral Status': 'Unmatched',
      'Campaign': campaign || '',
      'UTM Parameters': utmParams || '',
      // Rancher-page leads and rancher deep-link leads explicitly clicked "Buy {tier}"
      // or shared a rancher's custom link. That's the strongest possible intent signal —
      // equivalent to a YES click on the Ready-to-Buy prompt. Mark them ready-to-buy at
      // creation so matching/suggest sees the flag and formats the rancher's intro email
      // with the 🔥 prefix + READY TO BUY banner. Telegram fires the READY-TO-BUY MATCH alert too.
      // High-intent timing at signup is equivalent to clicking YES on the warmup email.
      // 'Within 30 days' and '1-3 months' both indicate immediate purchase intent, so
      // set Ready to Buy = true at creation. This puts the buyer into the MATCH_NOW
      // segment on the next reclassify-buyers run and fires intro same-second rather
      // than waiting for a warmup email + YES click (multi-day delay).
      'Ready to Buy': isRancherPageLead || isRancherDeepLink || timing === 'Within 30 days' || timing === '1-3 months',
    };
    if (referredBy) consumerFields['Referred By'] = referredBy;

    // G15 — rancher deep-link leads get linked to the rancher who shared the link
    // (Preferred Rancher field is a linked record).
    if (isRancherDeepLink && rancherRecord) {
      consumerFields['Preferred Rancher'] = [rancherRecord.id];
    }

    // Maintenance mode: store the consumer record but skip ALL downstream
    // processing — no emails, no telegram, no matching. Tag the record as
    // maintenance_capture so it's distinguishable from live signups and can
    // be batch-processed cleanly when we exit maintenance.
    if (isMaintenanceMode()) {
      consumerFields['Source'] = 'maintenance_capture';
      consumerFields['Notes'] = `${consumerFields['Notes'] || ''}\n[CAPTURED DURING MAINTENANCE ${new Date().toISOString()}]`.trim();
      try {
        if (upgradeStubId) {
          await updateRecord(TABLES.CONSUMERS, upgradeStubId, consumerFields);
        } else {
          await createRecord(TABLES.CONSUMERS, consumerFields);
        }
      } catch (e) {
        console.error('Maintenance capture error:', e);
      }
      return NextResponse.json({
        success: true,
        maintenance: true,
        message: "You're on the list. We'll email you as soon as the platform re-opens.",
      }, { status: 201 });
    }

    // If we're upgrading an abandoned stub, update the existing record in
    // place — keeps the original record ID stable + clears the abandon stage.
    let record: any;
    if (upgradeStubId) {
      consumerFields['Sequence Stage'] = 'none'; // remove the abandon marker so they stop receiving recovery emails
      consumerFields['Source'] = source || 'organic'; // overwrite "abandoned_application"
      await updateRecord(TABLES.CONSUMERS, upgradeStubId, consumerFields);
      record = { id: upgradeStubId, ...consumerFields };
    } else {
      record = await createRecord(TABLES.CONSUMERS, consumerFields);
    }

    // Funnel telemetry — every signup gets a 'signup' event in the Funnel Events
    // table so the admin dashboard can compute conversion rates. Non-fatal; a
    // write failure logs a warning but doesn't break the signup flow.
    await funnelRecord({
      stage: 'signup',
      buyerId: record.id,
      intentScore: serverIntentScore,
      metadata: {
        source: isRancherDeepLink ? `rancher-${rancherSlug}` : (source || 'organic'),
        state,
        isRancherPageLead,
        isRancherDeepLink,
        readyToBuy: !!consumerFields['Ready to Buy'],
      },
    });

    // ── Meta Conversions API: server-side `Lead` event ──────────────────
    // Client Pixel loses 30-50% of events to iOS 14.5+ ATT + adblockers.
    // CAPI fires the same Lead event from the server, deduped with the
    // client Pixel via event_id=<consumerId>. Restores attribution for
    // paid ad optimization. Fire-and-forget — never block the response.
    const capiIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const capiUserAgent = request.headers.get('user-agent') || undefined;
    const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(request);
    const nameParts = fullName.trim().split(/\s+/);
    fireCapi([{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: `${SITE_URL}/access`,
      event_id: record.id,
      action_source: 'website',
      user_data: buildUserData({
        email,
        phone,
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(' ') || undefined,
        state,
        ip: capiIp,
        userAgent: capiUserAgent,
        fbp: capiFbp,
        fbc: capiFbc,
      }),
      custom_data: {
        content_name: 'BHC Signup',
        content_category: consumerSegment,
      },
    }]).catch((e) => console.error('[meta-capi] consumer lead fire failed:', e));

    // ── REBUILT POST-APPROVAL FLOW (state-machine driven) ────────────────────
    // Old flow sent 2 emails on approval (sendConsumerApproval + then RTB or
    // Waitlist) — collapsed into ONE founder-voice email (sendWelcomeAndReadyToBuy)
    // that branches by rancher-availability. Buyer Stage transitions:
    //   no rancher in state            → WAITING  (founder letters via cron)
    //   rancher in state, auto-routed  → MATCHED  (matching/suggest fired intro)
    //   rancher in state, not routed   → READY    (welcome includes YES button)
    //   not approved (rare path)       → NEW      (sendConsumerConfirmation only)
    // Hoisted so the final response builder (after the try block) can include
    // the qualifyUrl when the buyer should be redirected directly to /qualify
    // instead of waiting for the welcome+RTB email.
    let qualifyUrlForResponse: string | null = null;

    if (status === 'Approved') {
      const isRancherPageLead = (campaign || '').startsWith('rancher-');
      let buyerStage: 'WAITING' | 'READY' | 'MATCHED' = 'WAITING';

      try {
        const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
        const hasInStateRancher = hasOperationalRancherForState(allRanchers, state);

        // ── QUALIFICATION GATE REDIRECT (2026-06-03) ─────────────────────
        // Previously: high-intent signup → matching/suggest fires immediately
        // → rancher gets intro before buyer even sees the welcome email.
        //
        // Now: ALL beef-buyer signups must clear /qualify before any rancher
        // sees them. For high-intent signups w/ a state-matched rancher, mint
        // a qualify JWT and return qualifyUrl in the response so /access can
        // redirect the buyer directly to the gamified quiz. They never wait
        // on email delivery. Low-intent signups still get the welcome+RTB
        // email and reach /qualify via the YES click.
        //
        // No bypass: matching/suggest is no longer called here. /api/qualify
        // is the SINGLE entry point that fires routing for buyer-initiated
        // flows. Eliminates the lead-quality leak.
        let qualifyUrl: string | null = null;
        let redirectToQualify = false;
        if (hasInStateRancher && consumerSegment === 'Beef Buyer' && !isRancherPageLead) {
          const isJustExploring = /just exploring/i.test(budgetRange || '') ||
            /just exploring/i.test(timing || '');
          const isFutureTiming = /3-6 months/i.test(timing || '');
          // Phone is REQUIRED at signup (2026-06-03), so the (intent>=80 || phone)
          // ladder collapses to just intent>=60. Sub-60 intents stay on the
          // welcome email path so the buyer self-selects via YES click.
          const formIsQualified =
            !!orderType && !!budgetRange &&
            !/unsure|not sure/i.test(orderType) &&
            !/unsure/i.test(budgetRange) &&
            !isJustExploring &&
            !isFutureTiming &&
            serverIntentScore >= 60;

          if (formIsQualified) {
            const qualifyToken = jwt.sign(
              { type: 'qualify-access', consumerId: record.id, email: email.trim().toLowerCase() },
              JWT_SECRET,
              { expiresIn: '24h' }
            );
            qualifyUrl = `${SITE_URL}/qualify/${encodeURIComponent(record.id)}?token=${encodeURIComponent(qualifyToken)}`;
            qualifyUrlForResponse = qualifyUrl;
            redirectToQualify = true;
            // Mark Ready to Buy so the existing tooling treats this buyer as
            // engaged (same as a YES click would). Warmup Engaged At gets
            // stamped after they actually complete the quiz in /api/qualify.
            try {
              await updateRecord(TABLES.CONSUMERS, record.id, {
                'Ready to Buy': true,
              });
            } catch (e: any) {
              console.warn('[signup] Ready-to-Buy stamp failed:', e?.message);
            }
          }
        }

        // Determine stage + send the appropriate single welcome email
        if (redirectToQualify) {
          // Hot signup — /access is about to redirect them to /qualify directly.
          // No welcome email needed; the quiz page IS the welcome experience.
          // Stage stays READY; /api/qualify will flip to MATCHED post-quiz pass.
          buyerStage = 'READY';
        } else if (hasInStateRancher && !isRancherPageLead) {
          // Rancher available, not auto-routed (form not qualified or rancher full).
          // Send welcome with YES button — engageUrl drives the matching click later.
          const engageToken = jwt.sign(
            { type: 'warmup-engage', consumerId: record.id },
            JWT_SECRET,
            { expiresIn: '60d' }
          );
          const engageUrl = `${SITE_URL}/api/warmup/engage?token=${engageToken}`;
          await sendWelcomeAndReadyToBuy({
            firstName, email, state, rancherAvailable: true, engageUrl,
          });
          buyerStage = 'READY';
        } else if (isRancherPageLead) {
          // Rancher-page lead: matching fires in backgroundTasks below. Stage
          // defaults to READY (not MATCHED) — the matching call inside
          // backgroundTasks flips it to MATCHED on success. If matching fails
          // (network error, etc.), the buyer stays READY so batch-approve's
          // waitlist-retry can pick them up instead of being orphaned at
          // MATCHED with no referral. Old code defaulted to MATCHED which
          // produced "matched but no referral" ghosts under failure.
          buyerStage = 'READY';
        } else {
          // No rancher in state — waitlist with the founder-voice welcome
          await sendWelcomeAndReadyToBuy({
            firstName, email, state, rancherAvailable: false,
          });
          buyerStage = 'WAITING';

          // F-1 audit fix: ALSO fire sendStateWaitlistLetter for any
          // out-of-state signup, including Community-segment buyers
          // (Order Type blank, Budget blank → segment != "Beef Buyer").
          // Pre-fix, this letter only fired from matching/suggest:1015 —
          // which is gated behind formIsQualified + consumerSegment === 'Beef Buyer',
          // so Community signups never got the founder-voice letter.
          // Mirror the matching/suggest signature + stamp Routing Segment
          // counter so email-sequences cron doesn't double-fire.
          const normalizedBuyerState = normalizeState(state) || state.toString().trim().toUpperCase();
          if (email) {
            sendStateWaitlistLetter({
              email,
              firstName,
              buyerState: normalizedBuyerState,
            })
              .then(async () => {
                try {
                  await updateRecord(TABLES.CONSUMERS, record.id, {
                    'Routing Segment Send Count': 1,
                    'Routing Segment Last Sent At': new Date().toISOString(),
                  });
                } catch (e) {
                  console.error('[state-waitlist] segment counter stamp failed:', e);
                }
              })
              .catch(e => console.error('[state-waitlist] signup-time fire failed:', e));
          }
        }

        // Set Buyer Stage + Updated At via contract — emits funnel event.
        // Replaces a direct updateRecord that bypassed the funnel telemetry +
        // duplicated the stage-write logic seen in /api/warmup/engage,
        // /api/matching/suggest, and the rancher PATCH handler.
        await transitionBuyerStage(record.id, buyerStage, `signup:${redirectToQualify ? 'qualify-redirect' : isRancherPageLead ? 'rancher-page' : hasInStateRancher ? 'in-state' : 'no-rancher'}`);
      } catch (e) {
        console.error('Post-approval flow error:', e);
      }
    } else {
      // status !== Approved → NEW state, application received but not yet approved
      await sendConsumerConfirmation({ firstName, email, state });
    }

    // ── RESPOND TO BUYER IMMEDIATELY — everything below runs without blocking ──
    // Fire-and-forget: admin notifications, Telegram, and matching engine
    // These can take 5-10 seconds combined and don't affect the buyer's experience
    const backgroundTasks = async () => {
      try {
        await sendAdminAlert({
          type: 'consumer',
          name: fullName,
          email,
          details: {
            State: state,
            Segment: consumerSegment,
            Status: status,
            'Order Type': orderType || 'Not specified',
            'Budget': budgetRange || 'Not specified',
            'Intent Score': `${serverIntentScore} (${serverIntentClassification})`,
            Interests: interests.join(', '),
            Phone: phone || 'Not provided',
            Notes: notes || 'None',
          },
        });
      } catch (e) { console.error('Admin alert error:', e); }

      // Visibility threshold raised 2026-05-13 from 40 → 80 ahead of volume
      // spike. The 40 setting produced 1 ping per medium-intent signup and
      // detonated Telegram's 1 msg/sec/chat cap at burst scale. 80+ now
      // captures only "real" buyers — daily-digest still rolls up the
      // medium-intent population. Hot-lead alert below (also 80+) provides
      // 1-tap action buttons for those highest-priority signups.
      if (serverIntentScore >= 80) {
        try {
          await sendTelegramConsumerSignup({
            consumerId: record.id,
            name: fullName,
            email,
            state,
            segment: consumerSegment,
            intentScore: serverIntentScore,
            intentClassification: serverIntentClassification,
            status,
            orderType,
            budgetRange,
          });
        } catch (e) { console.error('Telegram consumer signup error:', e); }
      }

      // 🔥 HOT LEAD: score 80+ Beef Buyers get a loud second alert with 1-tap actions
      if (serverIntentScore >= 80 && consumerSegment === 'Beef Buyer') {
        try {
          await sendTelegramHotLeadAlert({
            consumerId: record.id,
            name: fullName,
            email,
            phone,
            state,
            intentScore: serverIntentScore,
            orderType,
            budgetRange,
            notes,
          });
        } catch (e) { console.error('Telegram hot lead alert error:', e); }
      }

      // ROUTING DELIBERATELY DOES NOT HAPPEN HERE.
      // Quality over quantity: every signup must click YES on the Ready-to-Buy
      // prompt email (sent right above) before any rancher hears about them.
      // The click flows through /api/warmup/engage which sets Ready to Buy=true
      // and fires matching/suggest synchronously. No rancher inbox sees a lead
      // who didn't actively press the button.
      //
      // EXCEPTION: rancher-page leads (campaign starts with "rancher-") signed
      // up directly on a specific rancher's landing page. They typed in their
      // info on that rancher's page — that IS an explicit signal of interest
      // in that specific rancher. Route them immediately so the rancher gets
      // the lead info in their inbox right away.
      if ((campaign || '').startsWith('rancher-') && state) {
        try {
          await fetch(
            `${SITE_URL}/api/matching/suggest`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
              },
              body: JSON.stringify({
                buyerState: state,
                buyerId: record.id,
                buyerName: fullName,
                buyerEmail: email,
                buyerPhone: phone,
                orderType,
                budgetRange,
                intentScore: serverIntentScore,
                intentClassification: serverIntentClassification,
                notes,
                campaign: campaign || '',
                // Rancher-page leads typed their info on the rancher's own
                // page — that's explicit consent equivalent to a YES click.
                warmupEngaged: true,
              }),
            }
          );
        } catch (matchError) {
          console.error('Error calling matching engine for rancher-page lead:', matchError);
        }
      }
    };

    // Don't await — let it run in the background after response is sent
    backgroundTasks().catch(e => console.error('Background tasks error:', e));

    // Synchronous "rancher available?" check so the success page can branch
    // honestly. Without this the UI promised "matching you right now" to
    // every Beef Buyer including the ones who'd actually be waitlisted in
    // an uncovered state. getAllRecords(RANCHERS) is cached 10s → second
    // read here is free if the matching engine ran first; otherwise +~150ms.
    let rancherAvailable = false;
    try {
      const { getAllRecords, TABLES } = await import('@/lib/airtable');
      const { hasOperationalRancherForState } = await import('@/lib/rancherEligibility');
      const allRanchers = await getAllRecords(TABLES.RANCHERS);
      rancherAvailable = hasOperationalRancherForState(allRanchers, state);
    } catch (e) {
      console.warn('Could not compute rancherAvailable for response:', (e as any)?.message);
    }

    return NextResponse.json({
      success: true,
      consumer: record,
      rancherAvailable,
      // /access form checks for qualifyUrl and router.push() if present.
      // Hot signups (intent>=60 + in-state rancher + concrete tier/budget/timing)
      // get routed directly to the gamified quiz instead of waiting for email.
      qualifyUrl: qualifyUrlForResponse,
    }, { status: 201 });
  } catch (error: any) {
    // Sanitize: never echo internal error messages to the client (may leak
    // Airtable IDs, API token hints, internal table names, etc.). Full
    // error is in server logs for debugging.
    console.error('API error creating consumer:', error);
    return NextResponse.json({ error: 'Could not complete signup. Please try again or email support@buyhalfcow.com.' }, { status: 500 });
  }
}
