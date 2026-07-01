import { NextResponse } from 'next/server';
import { createRecord, updateRecord, getAllRecords, escapeAirtableValue, getRancherBySlug } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { validateAffiliateRefForSignup } from '@/lib/affiliates';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 90;
import { sendConsumerConfirmation, sendAdminAlert, sendWelcomeAndReadyToBuy, sendStateWaitlistLetter, sendQuizInvite, getSuppressionList } from '@/lib/email';
import { normalizeState } from '@/lib/states';
import { hasOperationalRancherForState } from '@/lib/rancherEligibility';
import { sendTelegramConsumerSignup, sendTelegramHotLeadAlert } from '@/lib/telegram';
import { transitionBuyerStage } from '@/lib/contracts';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';
import { leadValueUsd } from '@/lib/leadValue';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

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

    // Honeypot — /access renders a hidden `website` field. Real users never
    // fill it; bots that POST it get a fake success so they don't adapt.
    // Client drops these silently too, but server-side is the real gate.
    if (typeof body.website === 'string' && body.website.trim().length > 0) {
      return NextResponse.json({ success: true, consumer: null, rancherAvailable: false });
    }

    // ── UNIFIED FUNNEL — mid-flow lead capture (2026-06-18) ──────────────────
    // The game-like buyer wizard (BuyerFunnel) creates the lead at its contact
    // step by POSTing `{ quizStarted: true, ... }`. This is an ADDITIVE branch:
    // it returns before any legacy /access form logic runs, so the legacy path
    // below is byte-for-byte unchanged.
    //
    // Lead shape per spec (docs/.../2026-06-18-unified-buyer-funnel-design.md):
    //   Status=Approved, Buyer Stage=WAITING, Segment=Beef Buyer, Order Type=tier,
    //   Timing, State, contact, Source/UTMs — and CRUCIALLY no `Qualified At`.
    //   With Approved + empty `Qualified At`, GUARD-2 in /api/matching/suggest
    //   keeps the lead UNROUTABLE until the quiz completes via /api/qualify
    //   (which stamps `Qualified At`). The wizard stays on-page and calls
    //   /api/qualify next, so we issue NO legacy qualifyUrl/redirect here —
    //   just a 14d `qualify-access` resume token for that finalize call.
    if (body.quizStarted === true) {
      const fullNameQ = typeof body.fullName === 'string' ? body.fullName.trim() : '';
      const emailQ = typeof body.email === 'string' ? body.email.trim() : '';
      const phoneQ = typeof body.phone === 'string' ? body.phone.trim() : '';
      const stateQ = typeof body.state === 'string' ? body.state.trim() : '';
      const tierQ = typeof body.tier === 'string' ? body.tier.trim() : '';
      // Reuse the entry-level "now" → "Within 30 days" normalization so the
      // funnel and legacy paths speak the same Timing vocabulary downstream.
      const timingQ = body.timing === 'now' ? 'Within 30 days'
        : (typeof body.timing === 'string' ? body.timing.trim() : '');

      // Required fields — clear 400 per missing field. Phone is a HARD product
      // rule (operator decision 2026-06-18): the rancher must be able to reach
      // the buyer, so an empty/missing phone is a 400, not a soft default.
      if (!fullNameQ) {
        return NextResponse.json({ error: 'Please enter your name' }, { status: 400 });
      }
      if (!emailQ) {
        return NextResponse.json({ error: 'Email is required' }, { status: 400 });
      }
      if (!phoneQ) {
        return NextResponse.json({ error: 'Phone number is required so your rancher can reach you' }, { status: 400 });
      }
      if (!stateQ) {
        return NextResponse.json({ error: 'State is required' }, { status: 400 });
      }
      if (!tierQ) {
        return NextResponse.json({ error: 'Please pick a size' }, { status: 400 });
      }
      if (!timingQ) {
        return NextResponse.json({ error: 'Please pick a timing' }, { status: 400 });
      }

      // Reuse the same field validators as the legacy path so quality bars
      // (throwaway-domain block, phone digit count, name sanity) never drift.
      if (!isValidName(fullNameQ)) {
        return NextResponse.json({ error: 'Please enter a valid name' }, { status: 400 });
      }
      if (!isValidEmail(emailQ)) {
        return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
      }
      if (!isValidPhone(phoneQ)) {
        return NextResponse.json({ error: 'Please enter a valid phone number' }, { status: 400 });
      }
      if (!normalizeState(stateQ)) {
        return NextResponse.json({
          error: `State "${stateQ}" not recognized — pick from the dropdown or use the 2-letter code (e.g. TX, MT, WV).`,
        }, { status: 400 });
      }

      const emailLowerQ = emailQ.toLowerCase();
      const nowIsoQ = new Date().toISOString();
      const todayDateQ = nowIsoQ.slice(0, 10); // YYYY-MM-DD (Date field type)

      // TCPA explicit SMS opt-in. Stored true ONLY when the buyer ticked the
      // funnel consent box AND supplied a phone — mirrors the legacy path's
      // gate (line ~515) so the two signup surfaces can never drift. Without
      // this, smsOptIn was never sent and `SMS Opt-In` was hard-false for
      // every funnel signup → SMS reached 0 buyers despite /privacy claiming
      // a consent box.
      const smsOptInQ = body.smsOptIn === true && phoneQ.trim().length > 0;

      // UPSERT on email (spec: "don't create a second record"). Reuse the
      // file's existing duplicate-lookup query shape (LOWER({Email}) match).
      // Unlike the legacy path (which 409s a non-stub duplicate), the funnel
      // intentionally updates the existing lead in place — a buyer re-entering
      // the wizard with the same email should resume their record, not be
      // blocked. Fail-open on lookup error (create a fresh record).
      let existingIdQ: string | null = null;
      try {
        const existingQ = await getAllRecords(
          TABLES.CONSUMERS,
          `LOWER({Email}) = "${escapeAirtableValue(emailLowerQ)}"`
        ) as any[];
        if (existingQ.length > 0) existingIdQ = existingQ[0].id;
      } catch (e) {
        console.error('[funnel] duplicate-email lookup failed:', e);
      }

      // Source/UTMs exactly as the legacy flow records them.
      const funnelFields: Record<string, unknown> = {
        'Full Name': fullNameQ,
        'Email': emailLowerQ,
        'Phone': phoneQ,
        'State': normalizeState(stateQ) || stateQ.toUpperCase(),
        'Order Type': tierQ,
        'Timing': timingQ,
        'Segment': 'Beef Buyer',
        'Status': 'Approved',
        'Buyer Stage': 'WAITING',
        'Buyer Stage Updated At': nowIsoQ,
        'Created': todayDateQ,
        'Approved At': nowIsoQ,
        'Source': typeof body.source === 'string' && body.source ? body.source : 'funnel',
        'Campaign': typeof body.campaign === 'string' ? body.campaign : '',
        'UTM Parameters': typeof body.utmParams === 'string' ? body.utmParams : '',
        // NOTE: `Qualified At` is DELIBERATELY NOT set — GUARD-2 holds the lead
        // unroutable until /api/qualify stamps it on quiz completion.
      };

      // ── Ad attribution write-through (per-field UTM + click-ids) ─────────────
      // Reads the `attribution` object posted by BuyerFunnel from bhc_source_v2.
      // Only writes non-empty values so missing/empty attribution never clobbers
      // an existing value (e.g. a manychat row that already has fbclid). Signup
      // always completes even when attribution is absent or malformed.
      const attrRaw = body.attribution && typeof body.attribution === 'object' ? body.attribution as Record<string, unknown> : {};
      const attrStr = (k: string): string => (typeof attrRaw[k] === 'string' && (attrRaw[k] as string).trim() ? (attrRaw[k] as string).trim() : '');
      if (attrStr('utm_source'))   funnelFields['utm_source']   = attrStr('utm_source');
      if (attrStr('utm_medium'))   funnelFields['utm_medium']   = attrStr('utm_medium');
      if (attrStr('utm_campaign')) funnelFields['utm_campaign'] = attrStr('utm_campaign');
      if (attrStr('utm_content'))  funnelFields['utm_content']  = attrStr('utm_content');
      if (attrStr('utm_term'))     funnelFields['utm_term']     = attrStr('utm_term');
      if (attrStr('fbclid'))       funnelFields['fbclid']       = attrStr('fbclid');
      if (attrStr('fbclid_ts'))    funnelFields['fbclid_ts']    = attrStr('fbclid_ts');
      if (attrStr('gclid'))        funnelFields['gclid']        = attrStr('gclid');

      // ── SMS opt-in write (TCPA) ──────────────────────────────────────────────
      // Write semantics chosen so the funnel can never silently REVOKE a prior
      // opt-in (or wipe its consent timestamp) when a buyer re-enters the wizard
      // without re-ticking the box:
      //   • opting in  → always write true + stamp the consent timestamp.
      //   • new record → explicitly seed false so the default is correct and the
      //                  Twilio gate (sendSMSToConsumer) starts closed.
      //   • re-entry w/o tick → leave the existing value untouched (don't clobber).
      // The dedicated inbound STOP webhook (twilio-sms) is the authoritative way
      // a buyer turns SMS off, mirroring the legacy /access path's gate at ~515.
      if (smsOptInQ) {
        funnelFields['SMS Opt-In'] = true;
        funnelFields['SMS Opt-In At'] = nowIsoQ;
      } else if (!existingIdQ) {
        funnelFields['SMS Opt-In'] = false;
      }

      let funnelRec: any;
      try {
        if (existingIdQ) {
          await updateRecord(TABLES.CONSUMERS, existingIdQ, funnelFields);
          funnelRec = { id: existingIdQ };
        } else {
          funnelRec = await createRecord(TABLES.CONSUMERS, funnelFields);
        }
      } catch (e) {
        console.error('[funnel] consumer upsert failed:', e);
        return NextResponse.json(
          { error: 'Could not save your details. Please try again or email hello@buyhalfcow.com.' },
          { status: 500 },
        );
      }

      // 14d resume token — lets the wizard (and the quiz-drip resume link)
      // finalize this exact lead at /api/qualify. Same `qualify-access` shape
      // /api/qualify verifies (type + consumerId + email).
      const resumeToken = jwt.sign(
        { type: 'qualify-access', consumerId: funnelRec.id, email: emailLowerQ },
        JWT_SECRET,
        { expiresIn: '14d' },
      );

      // ── Meta CAPI: server-side `Lead` event ──────────────────────────────────
      // Contact step = lead created. Pairs with client Pixel Lead fire via
      // event_id=consumerId (metaEventId = raw record id, no prefix). Both
      // surfaces MUST use the same id or Meta sees two Leads → double-count.
      // Fire-and-forget — never block the 201 response.
      // Match-quality signals — read ip/userAgent/fbp/fbc off the request the
      // same way the legacy /access-form Lead does (~613-633). Since /access is
      // the single front door, nearly every paid Lead flows through THIS branch;
      // omitting these dropped match quality (weaker ad attribution) on the
      // hottest cohort. event_id/dedup unchanged.
      const capiIpQ = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
      const capiUserAgentQ = request.headers.get('user-agent') || undefined;
      const { fbp: capiFbpQ, fbc: capiFbcQ } = getMetaCookiesFromRequest(request);
      (async () => {
        try {
          fireCapi([{
            event_name: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
            event_id: metaEventId(funnelRec.id),
            action_source: 'website',
            user_data: buildUserData({
              email: emailLowerQ,
              phone: phoneQ,
              firstName: fullNameQ.split(/\s+/)[0] || undefined,
              state: normalizeState(stateQ) || stateQ.toUpperCase() || undefined,
              ip: capiIpQ,
              userAgent: capiUserAgentQ,
              fbp: capiFbpQ,
              fbc: capiFbcQ,
            }),
            custom_data: {
              // Modeled expected value (never 0 — that told Meta the lead was
              // worthless + killed value-based bidding). Funnel-start has no
              // qualifying signal yet, so this is the base; the richer signup
              // Lead below carries intent/basket. See lib/leadValue.
              value: leadValueUsd(),
              currency: 'usd',
              content_name: 'funnel-lead',
              content_category: 'buyer-funnel',
            },
          }]).catch((e) => console.error('[meta-capi] funnel Lead fire failed:', e));
        } catch (e) {
          console.error('[meta-capi] funnel Lead import/fire failed:', e);
        }
      })();

      return NextResponse.json(
        { success: true, consumerId: funnelRec.id, resumeToken },
        { status: 201 },
      );
    }

    const {
      fullName, email, phone, smsOptIn, state,
      orderType: orderTypeRaw, budgetRange: budgetRangeRaw, timing: timingRaw, notes,
      interestBeef: interestBeefRaw, interestLand, interestMerch, interestAll,
      intentScore, intentClassification, segment,
      source, campaign, utmParams, ref, rancherSlug,
    } = body;

    // FUNNEL FIX (2026-06-13): the /access form's highest-intent timing option
    // submits the literal "now", but every downstream check here AND in
    // /api/qualify speaks "Within 30 days". Unmapped, "now" scored 0 intent
    // points → highIntentTiming=false → Order Type stayed blank → segment fell
    // to "Community" → the quiz-redirect gate (Beef Buyer only) never fired.
    // Production proof: 47 of 47 "now" signups landed Community, 0 Beef Buyer —
    // the hottest cohort was the ONLY one auto-disqualified from the quiz.
    // Normalize once at the entry so all branches below classify it correctly.
    const timing = timingRaw === 'now' ? 'Within 30 days' : timingRaw;

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
      // FUNNEL FIX (2026-06-17, Suspect #2): '$1500-$2500' is the DEFAULT value
      // written at signup (route.ts:132) AND a live form option, but was absent
      // from this scorer → fell through to +0. 127 buyers carry it. Weight it
      // between $1000-$1500 (+15) and $2000-$2500 (+20).
      else if (budgetRange === '$1500-$2500') serverIntentScore += 18;
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

    // ── Ad attribution write-through (per-field UTM + click-ids) ─────────────
    // Parity with the funnel branch above: the legacy/non-funnel signup path
    // also persists per-field UTM columns + click-ids from the `attribution`
    // payload so organic/rancher/manychat signups don't lose attribution.
    // Only writes non-empty values so a missing/empty payload never clobbers
    // an existing value. Signup always completes even when attribution is absent.
    const legacyAttrRaw = body.attribution && typeof body.attribution === 'object' ? body.attribution as Record<string, unknown> : {};
    const legacyAttrStr = (k: string): string => (typeof legacyAttrRaw[k] === 'string' && (legacyAttrRaw[k] as string).trim() ? (legacyAttrRaw[k] as string).trim() : '');
    if (legacyAttrStr('utm_source'))   consumerFields['utm_source']   = legacyAttrStr('utm_source');
    if (legacyAttrStr('utm_medium'))   consumerFields['utm_medium']   = legacyAttrStr('utm_medium');
    if (legacyAttrStr('utm_campaign')) consumerFields['utm_campaign'] = legacyAttrStr('utm_campaign');
    if (legacyAttrStr('utm_content'))  consumerFields['utm_content']  = legacyAttrStr('utm_content');
    if (legacyAttrStr('utm_term'))     consumerFields['utm_term']     = legacyAttrStr('utm_term');
    if (legacyAttrStr('fbclid'))       consumerFields['fbclid']       = legacyAttrStr('fbclid');
    if (legacyAttrStr('fbclid_ts'))    consumerFields['fbclid_ts']    = legacyAttrStr('fbclid_ts');
    if (legacyAttrStr('gclid'))        consumerFields['gclid']        = legacyAttrStr('gclid');

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
        // Valued signup Lead — scales with intent + basket + ready-to-buy so
        // Meta value-bidding optimizes toward whole-cow buyers, not the
        // cheapest click (was sending no value at all). See lib/leadValue.
        value: leadValueUsd({
          intentScore: serverIntentScore,
          orderType: consumerFields['Order Type'] as string | undefined,
          readyToBuy: !!consumerFields['Ready to Buy'],
        }),
        currency: 'usd',
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

        // ── QUALIFICATION GATE REDIRECT (broadened 2026-06-05) ───────────
        // ALL beef-buyer signups must clear /qualify before any rancher sees
        // them. GUARD-2 enforces this at matching/suggest with a hard 412 if
        // Qualified At is missing — meaning every routing path requires the
        // quiz.
        //
        // Original gate (2026-06-03) only issued qualifyUrl for hot signups
        // (intent>=60 + concrete tier/budget/timing). Result: 95.5% of leads
        // (43 of 45 last 48h) skipped the redirect, got the welcome email
        // instead, and never came back to take the quiz. The intent gate
        // was double-gating — the quiz IS the qualifier.
        //
        // Now: every in-state Beef Buyer + every rancher-page lead gets a
        // qualifyUrl. /access redirects immediately. Out-of-state buyers
        // (no operational rancher) still get the welcome email and reach
        // /qualify via the YES click once a rancher comes online.
        //
        // Rancher-page leads are special: they signed up on a specific
        // rancher's landing page, so we also pass them through quiz to
        // collect quiz answers + Qualified At (required by GUARD-2). The
        // backgroundTasks matching/suggest call for rancher-page leads is
        // now suppressed when redirectToQualify=true — /api/qualify fires
        // matching/suggest with the campaign param so the pinned rancher is
        // preserved through the state-match cascade.
        let qualifyUrl: string | null = null;
        let redirectToQualify = false;
        if (consumerSegment === 'Beef Buyer' && (hasInStateRancher || isRancherPageLead)) {
          // 30d expiry (was 24h): this qualifyUrl is also EMAILED as a backup
          // via sendQuizInvite below, so the buyer may click it days later. A
          // 24h window stranded those late clicks in the expired-link loop
          // (Email QA, Audit B P1). /api/qualify only checks
          // type==='qualify-access' + consumerId, so the wider window is safe.
          const qualifyToken = jwt.sign(
            { type: 'qualify-access', consumerId: record.id, email: email.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '30d' }
          );
          // PERFECT-C: preserve campaign in URL for rancher-page leads so the
          // quiz page can forward it back to /api/qualify → matching/suggest.
          // Pins the originally-selected rancher through the cascade instead
          // of letting Performance Score pick a different one in the same state.
          const campaignQs =
            isRancherPageLead && campaign
              ? `&campaign=${encodeURIComponent(campaign)}`
              : '';
          qualifyUrl = `${SITE_URL}/qualify/${encodeURIComponent(record.id)}?token=${encodeURIComponent(qualifyToken)}${campaignQs}`;
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

        // Determine stage + send the appropriate single welcome email
        if (redirectToQualify) {
          // Hot signup — /access redirects them straight to /qualify.
          // Stage stays READY; /api/qualify flips to MATCHED post-quiz pass.
          buyerStage = 'READY';
          // FUNNEL FIX (2026-06-13): also email the quiz link as a backup. The
          // redirect is a client-side window.location — if JS stalls or the tab
          // closes before it fires, the buyer was previously stranded with no
          // email and no quiz. Fire-and-forget so it never delays the redirect.
          if (qualifyUrlForResponse && email) {
            sendQuizInvite({ firstName, email, state, quizUrl: qualifyUrlForResponse })
              .catch((e) => console.error('[quiz-invite] send failed:', e));
          }
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

          // 2026-06-30: removed the redundant signup-time sendStateWaitlistLetter.
          // The no-rancher sendWelcomeAndReadyToBuy above already sets waitlist
          // expectations, so firing this letter here produced TWO near-identical
          // "no rancher in {state} yet" emails seconds apart. The spaced nurture
          // follow-up is owned by the email-sequences engine; the triggered
          // "now available in {state}" email (planned) covers the supply event.
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

    // F9 — signup SMS (gated by ENABLE_SMS feature flag, default OFF)
    try {
      const { fireSMSEvent } = await import('@/lib/smsEvents');
      await fireSMSEvent({
        type: 'signup',
        consumer: record.fields,
        vars: { firstName },
      });
    } catch (e: any) {
      console.warn('[/api/consumers] signup SMS fire failed:', e?.message);
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
      //
      // LEAK-2 (2026-06-05): Skip this background matching call when the buyer
      // is being redirected to /qualify. GUARD-2 412s the call without Qualified
      // At, so it silently fails. /api/qualify will fire matching/suggest with
      // the campaign param after the quiz so the pinned rancher is preserved
      // through the cascade.
      if (!qualifyUrlForResponse && (campaign || '').startsWith('rancher-') && state) {
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
    return NextResponse.json({ error: 'Could not complete signup. Please try again or email hello@buyhalfcow.com.' }, { status: 500 });
  }
}
