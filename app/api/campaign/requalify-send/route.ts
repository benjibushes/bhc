// POST /api/campaign/requalify-send — CRON_SECRET-gated requalification
// campaign sender (2026-07-28, Ben-approved CV campaign).
//
// WHY THIS EXISTS: campaign sends must run IN PRODUCTION where the live
// RESEND_API_KEY lives (Vercel Sensitive — unreadable locally; the local copy
// drifted and silently failed 50/50 sends). This endpoint accepts a vetted
// recipient batch and pushes every send through the FULL guarded rail
// (sendEmail → guardedSend: suppression re-check at send time, frequency cap,
// tokenized unsubscribe headers + CAN-SPAM footer, Email Sends logging with
// delivered/opened/clicked tracking).
//
// SAFETY SHAPE:
//   • Bearer CRON_SECRET (requireCron) — machine auth, no cookies.
//   • The TEMPLATE IS BAKED IN server-side (the approved copy from
//     docs/marketing/email-quiz-resume.md, quiz-incomplete variant, CV pin).
//     Callers supply ONLY {email, name, state} — this can never send
//     arbitrary content.
//   • Hard cap MAX_BATCH per call; ~600ms pacing (deliverability + the shared
//     8/s Resend gate); per-recipient results returned for the operator log.
//   • dryRun=true renders a sample of EVERY mode present and sends nothing.
//
// ── ONE-TAP DEPOSIT CTA (2026-07-30) ──────────────────────────────────────
// Day 1 of the Champion Valley run measured the whole problem: 50 sent, 49
// delivered, 27 opened, 4 clicked, 0 leads reached the rancher. The CTA was
// /access — the quiz — and all 4 clickers had already completed the funnel.
// Nobody re-answers a quiz, so nobody got stamped, so nothing routed.
//
// So the endpoint now RESOLVES each recipient server-side and picks the CTA:
//   ONE-TAP  → /r/d/<campaign-reserve token> (lib/campaignReserve), landing on
//              the deposit checkout with the cut pre-selected, when we can
//              PROVE the tap won't bounce (decideRequalifyCta).
//   QUIZ     → today's /access link, unchanged, for everyone else.
// Both counts come back in the response, and a dryRun shows the exact split
// plus a rendered sample of each mode before a single email goes out.
//
// *** NOT A QUALIFICATION BYPASS. *** Nothing here stamps Qualified At, Buyer
// Stage, or routes anybody. The quiz-required routing rule is untouched. A
// one-tap recipient becomes a real lead the normal way: by PAYING a deposit,
// which the existing deposit rail settles end to end — the same rule the
// self-serve reserve path follows, and a stronger signal than a quiz answer.

import { NextResponse } from 'next/server';
import { requireCron } from '@/lib/cronAuth';
import { sendEmail } from '@/lib/email';
import {
  renderRequalifyEmail,
  validateRequalifyBatch,
  decideRequalifyCta,
  requalifyCta,
  requalifyOneTapCta,
  DAILY_CAMPAIGN_BUDGET,
  type RequalifyCta,
  type RequalifyQuizReason,
} from '@/lib/requalifyCampaign';
import { getAllRecords, getRancherBySlug, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { mintCampaignReserveToken } from '@/lib/campaignReserve';
import { getOperationalServedStates } from '@/lib/rancherEligibility';
import { depositCommissionRate, tierFor } from '@/lib/tiers';
import { DEFAULT_CAMPAIGN_RANCHER_IDS } from '@/lib/demandRouter';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Emails are ~30 chars each, so keep each OR() formula comfortably under
// Airtable's URL limit. MAX_BATCH=60 → at most 3 reads per table per call
// (NOT one read per recipient — an N+1 here would blow the 5 req/s cap).
const EMAIL_CHUNK = 20;

/** One chunked read: every row whose `field` (lowercased, trimmed) is in `emails`. */
async function readByEmail(
  table: string,
  field: string,
  emails: string[],
): Promise<Map<string, Record<string, any>[]>> {
  const byEmail = new Map<string, Record<string, any>[]>();
  for (let i = 0; i < emails.length; i += EMAIL_CHUNK) {
    const slice = emails.slice(i, i + EMAIL_CHUNK);
    const clause = `OR(${slice
      .map((e) => `LOWER(TRIM({${field}})) = "${escapeAirtableValue(e)}"`)
      .join(', ')})`;
    const rows = (await getAllRecords(table, clause)) as Record<string, any>[];
    for (const row of rows) {
      const key = String(row?.[field] || '').trim().toLowerCase();
      if (!key) continue;
      const bucket = byEmail.get(key);
      if (bucket) bucket.push(row);
      else byEmail.set(key, [row]);
    }
  }
  return byEmail;
}

export async function POST(request: Request) {
  const denied = requireCron(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = validateRequalifyBatch(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { recipients, campaign, dryRun, rancher } = parsed;

  // ── Resolve the campaign rancher ─────────────────────────────────────────
  // A THROW is an Airtable failure (fail closed below). A null is a legitimate
  // state (slug typo, Page Live off) — every recipient simply gets the quiz
  // link, i.e. exactly today's behavior. Never a bouncing deposit link.
  let rancherRec: Record<string, any> | null = null;
  try {
    rancherRec = (await getRancherBySlug(rancher.slug)) as Record<string, any> | null;
  } catch {
    return NextResponse.json(
      { error: 'rancher lookup failed — refusing to send blind' },
      { status: 503 },
    );
  }

  // The curated nationwide campaign pair ships without a state gate; every
  // other rancher only takes buyers from the states it actually serves. Mirrors
  // the ROUTING-STATES belt lib/campaignReferral enforces on redemption, so a
  // link we mint is a link that resolves.
  const servedStates =
    rancherRec && !DEFAULT_CAMPAIGN_RANCHER_IDS.includes(String(rancherRec.id))
      ? getOperationalServedStates(rancherRec as any)
      : null;
  // Same rate resolution as the deposit page and the charge path (locked
  // Commission Rate wins, else the tier constant) so the number in the email
  // equals the number on the card.
  const commissionRate = rancherRec ? depositCommissionRate(rancherRec, tierFor(rancherRec)) : 0;

  // ── Resolve identities + deal state, batched ─────────────────────────────
  // FAIL CLOSED on a read error, same posture as the budget check below: a
  // silent downgrade of the whole batch to quiz links would re-create the exact
  // failure this endpoint exists to fix, and a missed referral read could
  // double-deal a buyer who is already mid-deal. A campaign email is never
  // urgent enough to send blind.
  const emails = [...new Set(recipients.map((r) => r.email))];
  let consumersByEmail: Map<string, Record<string, any>[]>;
  let referralsByEmail: Map<string, Record<string, any>[]>;
  try {
    consumersByEmail = await readByEmail(TABLES.CONSUMERS, 'Email', emails);
    referralsByEmail = await readByEmail(TABLES.REFERRALS, 'Buyer Email', emails);
  } catch {
    return NextResponse.json(
      { error: 'buyer lookup failed — refusing to send blind' },
      { status: 503 },
    );
  }

  // ── Decide + build the CTA per recipient ─────────────────────────────────
  const planned = recipients.map((r) => {
    const decision = decideRequalifyCta({
      consumers: consumersByEmail.get(r.email) || [],
      rancher: rancherRec,
      buyerReferrals: referralsByEmail.get(r.email) || [],
      servedStates,
      commissionRate,
    });
    let cta: RequalifyCta = { mode: 'quiz', url: requalifyCta(r.state, rancher.slug) };
    let reason: RequalifyQuizReason | 'mint-failed' | undefined =
      decision.mode === 'quiz' ? decision.reason : undefined;
    if (decision.mode === 'one-tap') {
      try {
        // ~30d TTL (CAMPAIGN_RESERVE_TTL) — a campaign link must outlive the
        // send window. Same mint the sell console and demand router use.
        const token = mintCampaignReserveToken({
          consumerId: decision.consumerId,
          rancherSlug: rancher.slug,
          cut: decision.cut,
        });
        cta = {
          mode: 'one-tap',
          url: requalifyOneTapCta(r.state, token),
          cutLabel: decision.cutLabel,
          dueNowDollars: decision.dueNowDollars,
        };
      } catch (e: unknown) {
        // Mint throws only on a malformed claim — fall back rather than ship a
        // broken link (mirrors lib/demandRouter's resolveLink).
        console.warn(`[requalify-send] mint failed for ${r.email}:`, (e as Error)?.message);
        reason = 'mint-failed';
      }
    }
    return { r, cta, reason };
  });

  // Counts reflect what will ACTUALLY be sent (a mint failure counts as quiz).
  const oneTap = planned.filter((p) => p.cta.mode === 'one-tap').length;
  const quizFallback = planned.length - oneTap;
  const split = planned.map((p) => ({
    email: p.r.email,
    mode: p.cta.mode,
    ...(p.reason ? { ctaReason: p.reason } : {}),
  }));

  if (dryRun) {
    const sampleFor = (mode: 'one-tap' | 'quiz') => {
      const hit = planned.find((p) => p.cta.mode === mode);
      return hit ? renderRequalifyEmail(hit.r.name, hit.r.state, rancher, hit.cta) : undefined;
    };
    const previews: Record<string, unknown> = {};
    // Render a sample of EVERY mode present, so a dry run shows exactly what
    // will go out before anything does.
    const oneTapPreview = sampleFor('one-tap');
    const quizPreview = sampleFor('quiz');
    if (oneTapPreview) previews.oneTap = oneTapPreview;
    if (quizPreview) previews.quiz = quizPreview;
    return NextResponse.json({
      dryRun: true,
      count: recipients.length,
      rancher: rancher.slug,
      rancherResolved: !!rancherRec,
      oneTap,
      quizFallback,
      recipients: split,
      previews,
      // Back-compat with the original operator script (first recipient's body).
      preview: renderRequalifyEmail(planned[0].r.name, planned[0].r.state, rancher, planned[0].cta),
    });
  }

  // DOMAIN-WIDE DAILY BUDGET: all rancher campaigns share one deliverability
  // ramp. Count today's campaign_* sends (Email Sends truth) and refuse any
  // batch that would blow the ceiling — five parallel campaigns must never
  // multiply into a blast. Fails CLOSED on a read error: a campaign email is
  // never urgent enough to send blind.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = await getAllRecords(
      'Email Sends',
      `AND(FIND('campaign_', {Template Name}) = 1, IS_SAME({Sent At}, '${today}', 'day'))`,
    );
    if (sentToday.length + recipients.length > DAILY_CAMPAIGN_BUDGET) {
      return NextResponse.json(
        { error: `daily campaign budget: ${sentToday.length} sent today + ${recipients.length} requested > ${DAILY_CAMPAIGN_BUDGET}` },
        { status: 429 },
      );
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: 'budget check failed — refusing to send blind' }, { status: 503 });
  }

  let sent = 0, suppressed = 0, failed = 0;
  const results: Array<{
    email: string;
    ok: boolean;
    mode: 'one-tap' | 'quiz';
    ctaReason?: string;
    suppressed?: boolean;
    reason?: string;
  }> = [];
  for (const p of planned) {
    const { r, cta } = p;
    try {
      const rendered = renderRequalifyEmail(r.name, r.state, rancher, cta);
      const res = await sendEmail({
        to: r.email,
        subject: rendered.subject,
        html: rendered.html,
        templateName: `campaign_${campaign}`,
      });
      if (res.success) sent += 1;
      else if (res.suppressed) suppressed += 1;
      else failed += 1;
      results.push({
        email: r.email,
        ok: !!res.success,
        mode: cta.mode,
        ...(p.reason ? { ctaReason: p.reason } : {}),
        suppressed: res.suppressed,
        reason: res.reason,
      });
    } catch (e: unknown) {
      failed += 1;
      results.push({
        email: r.email,
        ok: false,
        mode: cta.mode,
        ...(p.reason ? { ctaReason: p.reason } : {}),
        reason: String((e as Error)?.message || 'send threw').slice(0, 120),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return NextResponse.json({ campaign, sent, suppressed, failed, oneTap, quizFallback, results });
}
