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
import { JWT_SECRET } from '@/lib/secrets';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

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
  const { token, consumerId, answers, campaign } = body || {};
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
  const tier = String(answers.tier || '').trim() as Tier;
  const timing = String(answers.timing || '').trim() as Timing;
  const storage = String(answers.storage || '').trim() as Storage;
  const ack = answers.ack === true;
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

  // PASSED — fire matching/suggest. Server-to-server call with internal secret.
  let suggestedRancher: any = null;
  let referralId: string | null = null;
  let pricingModel = 'legacy';
  let depositAmount: number | null = null;
  let routingOk = false;

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
        }),
      });
      if (matchRes.ok) {
        const j = await matchRes.json();
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

  // Persist path + stage transition AFTER matching outcome is known.
  consumerUpdates['Qualification Path'] = 'rancher_meet'; // default — client may flip to direct_deposit later
  try {
    await updateRecord(TABLES.CONSUMERS, consumerId, consumerUpdates);
  } catch (e: any) {
    console.error('[/api/qualify] consumer update failed:', e?.message);
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

  return NextResponse.json({
    qualified: true,
    score,
    routingOk,
    rancher: suggestedRancher
      ? {
          name: suggestedRancher.name,
          state: suggestedRancher.state,
          slug: suggestedRancher.slug || '',
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
    // Client uses these to render the dual-path CTA. If routingOk + tier_v2 +
    // depositAmount → render Path B. Otherwise Path A only.
  });
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
