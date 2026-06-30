// app/api/qualify/route.ts
//
// QUALIFICATION GATE (2026-06-03)
//
// Stands between the YES-click on the Ready-to-Buy email and the rancher
// intro fire. Buyer must complete a 4-question quiz (tier / timing / storage
// / ack) before matching/suggest runs. Only qualified buyers reach a rancher.
//
// Flow:
//   1. /api/warmup/engage redirects to /qualify/<consumerId>?token=<jwt>
//   2. /qualify page renders gamified 4-step quiz w/ progress bar
//   3. Buyer submits → POST /api/qualify with answers
//   4. Server validates JWT, normalizes answers, computes score
//   5. Persists Qualification Answers + Score + Qualified At + Path to Consumer
//   6. Fires matching/suggest with the validated buyer profile
//   7. Returns { refId, rancher, hasDeposit, pricingModel }
//   8. Client renders dual-path CTA:
//      Path A: "Meet your rancher" → /matched
//      Path B (tier_v2 only): "Reserve your share — $X deposit" → /checkout/<refId>/deposit
//
// Why server-side: client can't be trusted to mint a real referral. JWT-gated
// to prevent enumeration / replay attacks.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET, generateMemberLoginToken } from '@/lib/secrets';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { getOperatorBookingUrl } from '@/lib/calBooking';
import { isDepositCapableMatch } from '@/lib/depositOptionality';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Tier values match the Order Type single-select on Consumers.
type Tier = 'Quarter' | 'Half' | 'Whole' | 'Not Sure';
const VALID_TIERS: Tier[] = ['Quarter', 'Half', 'Whole', 'Not Sure'];

// Timing values shown on the quiz; map to existing Timing field values.
type Timing = 'ASAP' | 'Within 30 days' | 'Within 60 days' | 'Within 90 days' | 'Just exploring';
const VALID_TIMINGS: Timing[] = ['ASAP', 'Within 30 days', 'Within 60 days', 'Within 90 days', 'Just exploring'];

// Storage answers — narrow set so we can map to per-rancher fulfillment.
type Storage = 'have_freezer' | 'need_freezer' | 'rancher_holds' | 'cuts_only';
const VALID_STORAGE: Storage[] = ['have_freezer', 'need_freezer', 'rancher_holds', 'cuts_only'];

interface QualifyAnswers {
  tier: Tier;
  timing: Timing;
  storage: Storage;
  ack: boolean;
}

// Score 0-100. Auto-route threshold: 75. Below 75 → waitlist (nurture).
function scoreAnswers(a: QualifyAnswers): number {
  let s = 0;
  // Tier specified concretely = 25 pts. "Not Sure" gets 5 pts only.
  if (a.tier === 'Not Sure') s += 5;
  else if (VALID_TIERS.includes(a.tier)) s += 25;
  // Timing — closer = higher.
  if (a.timing === 'ASAP') s += 25;
  else if (a.timing === 'Within 30 days') s += 25;
  else if (a.timing === 'Within 60 days') s += 15;
  else if (a.timing === 'Within 90 days') s += 10;
  else if (a.timing === 'Just exploring') s += 0;
  // Storage — any concrete answer = 25 pts; demonstrates the buyer has thought about logistics.
  if (VALID_STORAGE.includes(a.storage)) s += 25;
  // Commitment ack — required to clear gate. 25 pts.
  if (a.ack === true) s += 25;
  return s;
}

// POST /api/qualify
export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // `campaign` arrives from /qualify page URL ?campaign=rancher-<slug> when the
  // buyer originally signed up on a specific rancher's landing page. PERFECT-A
  // (2026-06-05): pass it through to matching/suggest so the rancher cascade
  // pins the originally-selected rancher instead of falling back to generic
  // state-match. Without this, a buyer clicking Rancher A's ad gets matched
  // to Rancher B in the same state by Performance Score order.
  // S5 (2026-06-10): eventId comes from CLIENT so server CAPI + client Pixel
  // share the same event_id for Meta dedup. Falls back to server-mint if
  // client didn't send (older clients).
  const { token, consumerId, answers, campaign, eventId: clientEventId } = body || {};
  if (!token || !consumerId || !answers) {
    return NextResponse.json({ error: 'Missing token, consumerId, or answers' }, { status: 400 });
  }

  // Verify JWT and confirm it's scoped to this consumerId.
  let payload: any;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return NextResponse.json({ error: 'Invalid or expired qualification token' }, { status: 401 });
  }
  if (payload.type !== 'qualify-access' || payload.consumerId !== consumerId) {
    return NextResponse.json({ error: 'Token does not authorize this qualification' }, { status: 403 });
  }

  // Validate shape — reject unknown values so client can't smuggle freeform.
  let tier = String(answers.tier || '').trim() as Tier;
  let timing = String(answers.timing || '').trim() as Timing;
  const storage = String(answers.storage || '').trim() as Storage;
  const ack = answers.ack === true;

  // Resume-mode funnel (the YES-click / quiz-link path) starts at the storage
  // step and never re-collects tier/timing, so it POSTs them EMPTY — which
  // previously hard-400'd every such buyer out of the funnel. When empty,
  // hydrate from the buyer's stored signup answers (so they're scored on their
  // REAL order), then fall back to low-intent defaults so we never reject a
  // legitimate resume. A NON-empty invalid value (smuggled freeform) still 400s
  // below — only the empty case is hydrated.
  if (!tier || !timing) {
    try {
      const c: any = await getRecordById(TABLES.CONSUMERS, consumerId);
      if (!tier) tier = String(c?.['Order Type'] || '').trim() as Tier;
      if (!timing) timing = String(c?.['Timing'] || '').trim() as Timing;
    } catch { /* fall through to defaults */ }
    if (!VALID_TIERS.includes(tier)) tier = 'Not Sure';
    if (!VALID_TIMINGS.includes(timing)) timing = 'Just exploring';
  }

  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });
  }
  if (!VALID_TIMINGS.includes(timing)) {
    return NextResponse.json({ error: 'Invalid timing' }, { status: 400 });
  }
  if (!VALID_STORAGE.includes(storage)) {
    return NextResponse.json({ error: 'Invalid storage' }, { status: 400 });
  }

  const validated: QualifyAnswers = { tier, timing, storage, ack };
  const score = scoreAnswers(validated);
  const completedAt = new Date().toISOString();

  // Persist regardless of pass/fail so the operator can see drop-off patterns.
  const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId);
  if (!consumer) {
    return NextResponse.json({ error: 'Buyer record not found' }, { status: 404 });
  }

  // Update Consumer's Order Type to the chosen tier (overrides whatever was
  // captured at signup) so matching/suggest tier-fit gate uses the latest
  // intent. "Not Sure" leaves the existing value alone (no narrowing).
  // Same for Timing.
  const consumerUpdates: Record<string, any> = {
    'Qualification Answers': JSON.stringify(validated),
    'Qualification Score': score,
    'Qualified At': completedAt,
  };
  if (tier !== 'Not Sure') {
    consumerUpdates['Order Type'] = tier;
  }
  if (timing !== 'Just exploring') {
    consumerUpdates['Timing'] = timing;
  }

  // Score gate. Below 75 → record incomplete + stay in nurture. Don't fire
  // matching/suggest — these buyers aren't ready for a rancher's time.
  if (score < 75) {
    consumerUpdates['Qualification Path'] = 'incomplete';
    try {
      await updateRecord(TABLES.CONSUMERS, consumerId, consumerUpdates);
    } catch (e: any) {
      console.error('[/api/qualify] consumer update failed:', e?.message);
    }
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🛑 <b>QUIZ DROP-OFF</b> — ${consumer['Full Name'] || consumer['Email']} (${consumer['State'] || '?'})\n` +
          `Score: ${score}/100 | Tier: ${tier} | Timing: ${timing} | Storage: ${storage} | Ack: ${ack ? '✓' : '✗'}\n` +
          `<i>Not routed. Stays in nurture.</i>`
      );
    } catch {}
    return NextResponse.json({
      qualified: false,
      score,
      message:
        score === 0
          ? "Looks like you're still gathering info. We'll keep you in our nurture sequence and check back when you're ready."
          : "Thanks for being honest. We only route buyers who are ready — we'll send you more info and check back soon.",
    });
  }

  // CRITICAL ORDERING FIX (PERFECT-G, 2026-06-05): GUARD-2 reads Qualified At
  // from Airtable inside matching/suggest. If we call matching/suggest BEFORE
  // stamping Qualified At, GUARD-2 sees the stale (empty) value and 412s.
  // Every quiz pass since GUARD-2 shipped (2026-06-05) silently failed
  // to route. Synthetic E2E caught it.
  //
  // Write the routing-relevant fields NOW (Qualified At, Score, Answers, Order
  // Type, Timing) so matching/suggest's gate sees the fresh state. Path +
  // late-stage Updated At fields can land in a second write after matching.
  try {
    const earlyWrite: Record<string, any> = {
      'Qualification Answers': consumerUpdates['Qualification Answers'],
      'Qualification Score': consumerUpdates['Qualification Score'],
      'Qualified At': consumerUpdates['Qualified At'],
    };
    if (consumerUpdates['Order Type']) earlyWrite['Order Type'] = consumerUpdates['Order Type'];
    if (consumerUpdates['Timing']) earlyWrite['Timing'] = consumerUpdates['Timing'];
    await updateRecord(TABLES.CONSUMERS, consumerId, earlyWrite);
  } catch (e: any) {
    console.error('[/api/qualify] pre-route consumer update failed:', e?.message);
    // Fail early — without Qualified At in DB, matching/suggest will 412.
    return NextResponse.json({
      error: 'Could not save quiz answers. Please try again or reply to the email.',
    }, { status: 500 });
  }

  // PASSED — fire matching/suggest. Server-to-server call with internal secret.
  let suggestedRancher: any = null;
  let referralId: string | null = null;
  let pricingModel = 'legacy';
  let depositAmount: number | null = null;
  let routingOk = false;
  // R9 (2026-06-10): diagnostic surface for synthetic-e2e + manual debug.
  // Captures matching/suggest HTTP status + body so the response answers
  // "why no referralId?" instead of stranding the caller.
  let matchDiag: { status: number | null; body: any } = { status: null, body: null };

  if (consumer['Email'] && consumer['State']) {
    try {
      const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
        },
        body: JSON.stringify({
          buyerState: consumer['State'],
          buyerId: consumerId,
          buyerName: consumer['Full Name'] || '',
          buyerEmail: consumer['Email'],
          buyerPhone: consumer['Phone'] || '',
          // Use validated quiz answers as the source of truth.
          orderType: tier !== 'Not Sure' ? tier : consumer['Order Type'] || '',
          budgetRange: consumer['Budget'] || '',
          intentScore: Math.max(consumer['Intent Score'] || 0, score),
          intentClassification: consumer['Intent Classification'] || 'High',
          notes:
            (consumer['Notes'] || '') +
            `\n[QUIZ ${completedAt}] tier=${tier} timing=${timing} storage=${storage} ack=${ack} score=${score}/100`,
          // Hot-lead bypass — qualified buyer earned the over-cap allowance.
          warmupEngaged: true,
          // PERFECT-A: propagate rancher-page-lead campaign so the matching
          // cascade can pin the originally-clicked rancher.
          ...(typeof campaign === 'string' && campaign.startsWith('rancher-')
            ? { campaign }
            : {}),
          // 2026-06-09 sales-floor pivot: skip the buyer auto-intro from
          // matching/suggest. Buyer's primary CTA becomes the Cal invite
          // fired below — book a sales call w/ Ben, who closes on the call
          // and triggers deposit. Rancher still gets their intro so Ben's
          // pre-call context is loaded.
          skipBuyerIntro: true,
        }),
      });
      // R9 (2026-06-10): capture matching response shape on no-match
      // path so synthetic-e2e cron + manual debugs surface WHY routing
      // failed (no candidate / paused / 412 / no qualified-at race).
      matchDiag.status = matchRes.status;
      try {
        matchDiag.body = await matchRes.json();
      } catch {
        matchDiag.body = { _parseError: true };
      }
      if (matchRes.ok) {
        const j = matchDiag.body;
        if (j.matchFound || j.alreadyActive) {
          routingOk = true;
          suggestedRancher = j.suggestedRancher || null;
          referralId = j.referralId || null;
          // Look up rancher's Pricing Model + deposit + trust signals for
          // the dual-path UI + match-page rancher card.
          if (suggestedRancher?.id) {
            try {
              const rancher: any = await getRecordById(TABLES.RANCHERS, suggestedRancher.id);
              pricingModel = String(rancher?.['Pricing Model'] || 'legacy');
              if (pricingModel === 'tier_v2') {
                // Pick deposit field matching the buyer's chosen tier.
                const depositField =
                  tier === 'Quarter' ? 'Quarter Deposit'
                  : tier === 'Half' ? 'Half Deposit'
                  : tier === 'Whole' ? 'Whole Deposit'
                  : '';
                if (depositField) depositAmount = Number(rancher?.[depositField]) || null;
              }
              // Surface rancher trust fields for the match-page card —
              // pulled live from Airtable so /qualify always shows latest
              // photo + bio + processing date without a stale cache.
              if (suggestedRancher) {
                // Legacy-funnel branch: when the matched rancher runs their own
                // sales calls (funnel 1), the result page embeds THEIR Cal
                // event instead of the operator's. tier_v2 ranchers always get
                // the operator (Ben) booker — he runs every v2 sales call.
                suggestedRancher.calComSlug = String(rancher?.['Cal.com Slug'] || '');
                suggestedRancher.logoUrl = rancher?.['Logo URL'] || '';
                suggestedRancher.tagline = rancher?.['Tagline'] || '';
                suggestedRancher.aboutText = rancher?.['About Text'] || '';
                suggestedRancher.city = rancher?.['City'] || '';
                suggestedRancher.beefTypes = rancher?.['Beef Types'] || '';
                suggestedRancher.certifications = rancher?.['Certifications'] || '';
                suggestedRancher.processingFacility = rancher?.['Processing Facility'] || '';
                suggestedRancher.nextProcessingDate = rancher?.['Next Processing Date'] || '';
              }
            } catch (e: any) {
              console.warn('[/api/qualify] rancher lookup failed:', e?.message);
            }
          }
        }
      }
    } catch (e: any) {
      console.error('[/api/qualify] matching/suggest call failed:', e?.message);
    }
  }

  // R9 (2026-06-10): surface the matching outcome shape in response so
  // synthetic-e2e + manual probes can see WHY no referralId was minted.
  // routingOk/referralId already in response — add diagnostic field.

  // Persist path AFTER matching outcome is known. Early write above already
  // landed Qualified At + Score + Answers + Order Type + Timing; this second
  // write only sets the late-stage Path field so the operator can see whether
  // the buyer chose the deposit-first vs schedule-call path.
  try {
    await updateRecord(TABLES.CONSUMERS, consumerId, {
      'Qualification Path': 'rancher_meet', // default — client may flip to direct_deposit later
    });
  } catch (e: any) {
    console.error('[/api/qualify] path update failed:', e?.message);
  }

  // DEPOSIT OPTIONALITY (2026-06-30): for a tier_v2 / Stripe-Connect-active
  // rancher the buyer is deposit-capable — so the qualified email leads with
  // a one-tap deposit (reusing the bulkRoute member-verify magic-link pattern:
  // mint a member-login token → /api/auth/member/verify?token=…&next=
  // /checkout/<refId>/deposit so the buyer lands authed and goes straight to
  // Stripe) and demotes the call to a quiet "or book a 15-min call with ben"
  // secondary. NEVER call-only for a deposit-capable rancher — that was the
  // cash leak (a ready buyer matched to a Connect rancher could only book Ben's
  // Cal, with no way to deposit now).
  //
  // The deposit deep-link needs a referralId to point at /checkout/<refId>/
  // deposit. When matching minted one (routingOk + referralId), send the
  // deposit-primary email. If a tier_v2 match somehow has no referralId, fall
  // back to the call-only invite rather than a dead deposit link.
  //
  // Non-tier_v2 (legacy / Operator-without-Connect) ranchers genuinely can't
  // take a self-serve deposit, so they keep the call-only invite.
  //
  // Score guard unchanged: low scorers (<60) stay routed but get no email —
  // Ben follows up manually via /admin/today v2.
  if (score >= 60 && consumer['Email']) {
    const buyerEmail = String(consumer['Email']);
    const buyerFirstName = String(consumer['Full Name'] || 'there').split(' ')[0];
    const depositCapable = isDepositCapableMatch(pricingModel, referralId);
    if (depositCapable) {
      try {
        const magicToken = generateMemberLoginToken(consumerId, buyerEmail);
        const nextPath = `/checkout/${referralId}/deposit`;
        const depositMagicLinkUrl = `${SITE_URL}/api/auth/member/verify?token=${magicToken}&next=${encodeURIComponent(nextPath)}`;
        const { sendQuizCompleteDepositInvite } = await import('@/lib/emailMinimal');
        await sendQuizCompleteDepositInvite({
          to: buyerEmail,
          firstName: buyerFirstName,
          score,
          depositMagicLinkUrl,
          rancherName: suggestedRancher?.name || '',
          depositAmount,
          nextProcessingDate: suggestedRancher?.nextProcessingDate || '',
        });
      } catch (e: any) {
        console.warn('[/api/qualify] deposit invite fire failed:', e?.message);
      }
    } else if (pricingModel === 'tier_v2') {
      // tier_v2 but no referralId to deposit against → call-only fallback.
      try {
        const { sendQuizCompleteCalInvite } = await import('@/lib/emailMinimal');
        await sendQuizCompleteCalInvite({
          to: buyerEmail,
          firstName: buyerFirstName,
          score,
        });
      } catch (e: any) {
        console.warn('[/api/qualify] cal invite fire failed:', e?.message);
      }
    }
    // Non-tier_v2 (legacy) buyers: matching/suggest already fired their
    // off-platform rancher intro with contact info — no qualify email here.
  }

  // F2 — Meta CAPI CompleteRegistration. Server fire deduped w/ client fire
  // via event_id (client mints `qualify-{consumerId}-{ts}` so dedup window
  // catches both within 7d). Critical signal for ad optimization: only
  // qualified buyers reach this step.
  if (consumer['Email']) {
    try {
      const { fireCapi, buildUserData, getMetaCookiesFromRequest } = await import('@/lib/metaCapi');
      const cookies = getMetaCookiesFromRequest(request);
      const userData = buildUserData({
        email: String(consumer['Email']),
        phone: String(consumer['Phone'] || ''),
        state: String(consumer['State'] || ''),
        firstName: String(consumer['Full Name'] || '').split(' ')[0],
        fbp: cookies.fbp,
        fbc: cookies.fbc,
      });
      // S5 (2026-06-10): use client-minted event_id when present so Meta
      // dedupes the two fires within the 7-day window.
      const serverEventId = clientEventId || `qualify-server-${consumerId}-${completedAt}`;
      fireCapi([{
        event_name: 'CompleteRegistration',
        event_id: serverEventId,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: `${SITE_URL}/qualify/${consumerId}`,
        user_data: userData,
        custom_data: {
          currency: 'USD',
          value: depositAmount || 0,
          content_name: 'quiz_complete',
          content_category: tier,
        },
      }]);
    } catch (e: any) {
      console.warn('[/api/qualify] CAPI CompleteRegistration fire failed:', e?.message);
    }
  }

  try {
    const { transitionBuyerStage } = await import('@/lib/contracts');
    await transitionBuyerStage(
      consumerId,
      routingOk ? 'MATCHED' : 'READY',
      `qualify:${routingOk ? 'matched' : 'no-rancher'}`
    );
  } catch (e: any) {
    console.error('[/api/qualify] stage flip failed:', e?.message);
  }

  // Telegram celebration so operator sees every qualified buyer in real time.
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `⭐ <b>QUALIFIED BUYER</b> — ${consumer['Full Name'] || consumer['Email']} (${consumer['State'] || '?'})\n` +
        `Score: ${score}/100 | Tier: ${tier} | Timing: ${timing} | Storage: ${storage}\n` +
        (routingOk && suggestedRancher
          ? `→ Routed to <b>${suggestedRancher.name}</b> (${suggestedRancher.state}) | ${pricingModel === 'tier_v2' && depositAmount ? `deposit $${depositAmount}` : 'legacy'}`
          : `→ No rancher available — stays in READY for next opening`)
    );
  } catch {}

  // Operator booking link for the tier_v2 inline Cal booker on the result
  // page. page.tsx is a client component and can't call the server resolver,
  // so we resolve here (server-side, where CAL_API_KEY lives) and pass the
  // embed-ready slug down as a prop. The Cal embed wants a bare 'username/slug'
  // — strip the 'https://cal.com/' prefix the resolver returns. If the
  // resolver fell back to /contact (no live Cal event), there's no cal.com URL
  // to strip → send '' so the client shows "booking temporarily unavailable"
  // instead of feeding a non-Cal URL into the embed. Never throws.
  let operatorCalLink = '';
  try {
    const resolvedOperatorUrl = await getOperatorBookingUrl('sales');
    const CAL_PREFIX = 'https://cal.com/';
    if (resolvedOperatorUrl.startsWith(CAL_PREFIX)) {
      operatorCalLink = resolvedOperatorUrl.slice(CAL_PREFIX.length);
    }
  } catch {
    operatorCalLink = '';
  }

  const res = NextResponse.json({
    qualified: true,
    score,
    routingOk,
    rancher: suggestedRancher
      ? {
          name: suggestedRancher.name,
          state: suggestedRancher.state,
          slug: suggestedRancher.slug || '',
          calComSlug: suggestedRancher.calComSlug || '',
          city: suggestedRancher.city || '',
          logoUrl: suggestedRancher.logoUrl || '',
          tagline: suggestedRancher.tagline || '',
          aboutText: suggestedRancher.aboutText || '',
          beefTypes: suggestedRancher.beefTypes || '',
          certifications: suggestedRancher.certifications || '',
          processingFacility: suggestedRancher.processingFacility || '',
          nextProcessingDate: suggestedRancher.nextProcessingDate || '',
        }
      : null,
    referralId,
    pricingModel,
    depositAmount,
    // Buyer identity for the inline Cal booker prefill on the result page —
    // makes the cal-webhook → referral link bulletproof (it matches the
    // booking back to the buyer by attendee email).
    buyerName: consumer['Full Name'] || '',
    buyerEmail: consumer['Email'] || '',
    // Embed-ready operator Cal slug ('username/slug') for the tier_v2 inline
    // booker. '' when no live Cal event (client renders unavailable message).
    operatorCalLink,
    // R9 diagnostic — surfaces matching/suggest status + summary in the
    // response. Synthetic-e2e + manual debugs use this to find WHY a
    // qualified buyer didn't get a referralId.
    matchDiag: {
      status: matchDiag.status,
      matchFound: matchDiag.body?.matchFound ?? null,
      paused: matchDiag.body?.paused ?? null,
      error: matchDiag.body?.error ?? null,
      reason: matchDiag.body?.reason ?? null,
    },
    // Client uses these to render the dual-path CTA. If routingOk + tier_v2 +
    // depositAmount → render Path B. Otherwise Path A only.
  });

  // HOT-PATH SESSION (2026-06-15). The buyer just PASSED the quiz — on the hot
  // signup path (/api/consumers → qualifyUrl → quiz → "skip the call, pay
  // deposit") they never went through /api/warmup/engage, so they have no
  // bhc-member-auth cookie. Without it, the deposit button POST to
  // /api/checkout/deposit 401s ("Not authenticated") and /member bounces to
  // /member/login — the hot path dead-ends right at the conversion moment.
  //
  // Passing the quiz is sufficient auth: the qualify-access JWT (verified
  // above) proves this person owns the email-issued token for THIS consumerId,
  // exactly the same trust basis warmup/engage uses to mint its session.
  // Mirror that cookie EXACTLY — same name, JWT payload (type/consumerId/
  // email/state/name), 30-day maxAge, httpOnly, sameSite, secure, path — so
  // resolveBuyerSession + /api/member/content (reads decoded.state) work
  // identically on both paths.
  const sessionToken = jwt.sign(
    {
      type: 'member-session',
      consumerId,
      email: (consumer['Email'] || '').trim().toLowerCase(),
      state: consumer['State'] || '',
      name: consumer['Full Name'] || '',
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.cookies.set('bhc-member-auth', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60, // 30 days
    path: '/',
  });
  return res;
}

// PATCH /api/qualify — buyer chose direct_deposit path after quiz pass.
// Just records the choice; client navigates to /checkout/<refId>/deposit.
export async function PATCH(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { token, consumerId, path } = body || {};
  if (!token || !consumerId || !path) {
    return NextResponse.json({ error: 'Missing token, consumerId, or path' }, { status: 400 });
  }
  let payload: any;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }
  if (payload.type !== 'qualify-access' || payload.consumerId !== consumerId) {
    return NextResponse.json({ error: 'Token mismatch' }, { status: 403 });
  }
  if (path !== 'rancher_meet' && path !== 'direct_deposit') {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  try {
    await updateRecord(TABLES.CONSUMERS, consumerId, { 'Qualification Path': path });
  } catch (e: any) {
    console.error('[/api/qualify PATCH] update failed:', e?.message);
  }
  return NextResponse.json({ success: true });
}
