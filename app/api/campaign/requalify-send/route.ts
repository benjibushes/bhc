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
//
// ── MEASUREMENT SUBSTRATE (ADAPTIVE-MARKETING-DESIGN PR 1, 2026-08-10) ────
//   • CLAIM STAMPS: every matched Consumers row gets `Campaign Last Sent At`
//     + `Campaign Rail` stamped claim-BEFORE-send, with the demand-router
//     revert-on-failure pattern — closes the idempotency hole where a re-run
//     re-emailed the whole "uncampaigned" cohort (nothing wrote the field
//     this rail's pool filter reads).
//   • VARIANTS: deterministic 50/50 subject split (lib/campaignVariants),
//     gated by tri-state ADAPTIVE_VARIANTS_ENABLED (fail-to-off); the arm
//     actually sent is stamped to Email Sends `Variant`.
//   • MESSAGE ID: guardedSend persists the Resend send id to Email Sends
//     `Resend Id`, and the engagement webhook attributes events by that id.

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
import { getAllRecords, getRancherBySlug, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { campaignVariant, variantMode, type CampaignVariant } from '@/lib/campaignVariants';
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
  // Variant instrumentation (ADAPTIVE-MARKETING-DESIGN PR 1): deterministic
  // 50/50 subject split, keyed on (consumerId, templateName). Tri-state
  // kill switch fails to OFF — 'live' sends the assigned arm, 'shadow'
  // (dry-run) surfaces the assignment in the response but still sends A,
  // off sends A. The arm actually SENT is stamped to Email Sends `Variant`.
  const templateName = `campaign_${campaign}`;
  const vmode = variantMode();
  const planned = recipients.map((r) => {
    const matchedConsumers = consumersByEmail.get(r.email) || [];
    const decision = decideRequalifyCta({
      consumers: matchedConsumers,
      rancher: rancherRec,
      buyerReferrals: referralsByEmail.get(r.email) || [],
      servedStates,
      commissionRate,
    });
    // Reply threading: prefer the decision's resolved consumer (one-tap),
    // else the first matched record from the same lookup. A recipient with
    // no Consumer record falls through to the generic inbox Reply-To.
    const replyConsumerId: string | null =
      (decision.mode === 'one-tap' ? decision.consumerId : null) ||
      (matchedConsumers[0] as any)?.id ||
      null;
    // Claim targets: EVERY matched Consumers row for this email. The
    // "uncampaigned" pool filters per row on isEmpty(Campaign Last Sent At),
    // so a duplicate pair must BOTH be claimed or a re-run re-emails the
    // buyer through the unclaimed twin. Pre-claim values ride along so a
    // failed send can revert (demand-router pattern).
    const claimRows = matchedConsumers
      .filter((row: any) => row && typeof row.id === 'string' && row.id)
      .map((row: any) => ({
        id: String(row.id),
        prior: {
          lastSent: row['Campaign Last Sent At'] ? String(row['Campaign Last Sent At']) : null,
          rail: row['Campaign Rail'] ? String(row['Campaign Rail']) : null,
        },
      }));
    // Only a recipient with a resolved consumer identity enters the split —
    // the hash needs a stable unit id, and unrandomized rows would pollute
    // the arms. Everyone else gets the baseline A subject, unstamped.
    const variantAssigned: CampaignVariant | null = replyConsumerId
      ? campaignVariant(replyConsumerId, templateName)
      : null;
    const variantSent: CampaignVariant | null = variantAssigned
      ? vmode === 'live'
        ? variantAssigned
        : 'A'
      : null;
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
    return { r, cta, replyConsumerId, reason, claimRows, variantAssigned, variantSent };
  });

  // Counts reflect what will ACTUALLY be sent (a mint failure counts as quiz).
  const oneTap = planned.filter((p) => p.cta.mode === 'one-tap').length;
  const quizFallback = planned.length - oneTap;
  const split = planned.map((p) => ({
    email: p.r.email,
    mode: p.cta.mode,
    ...(p.reason ? { ctaReason: p.reason } : {}),
    ...(p.variantAssigned ? { variant: p.variantAssigned, variantSent: p.variantSent } : {}),
  }));

  if (dryRun) {
    const sampleFor = (mode: 'one-tap' | 'quiz') => {
      const hit = planned.find((p) => p.cta.mode === mode);
      return hit
        ? renderRequalifyEmail(hit.r.name, hit.r.state, rancher, hit.cta, hit.variantSent ?? 'A')
        : undefined;
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
      variantMode: vmode,
      oneTap,
      quizFallback,
      recipients: split,
      previews,
      // Back-compat with the original operator script (first recipient's body).
      preview: renderRequalifyEmail(
        planned[0].r.name,
        planned[0].r.state,
        rancher,
        planned[0].cta,
        planned[0].variantSent ?? 'A',
      ),
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
    variant?: string;
    suppressed?: boolean;
    reason?: string;
  }> = [];
  // Claim-stamp anomalies (skipped sends, burned claims) — counts + short
  // reasons only, surfaced so the operator log shows every row the
  // idempotency belt touched abnormally.
  const claimFailures: string[] = [];
  const pace = () => new Promise((resolve) => setTimeout(resolve, 600));
  for (const p of planned) {
    const { r, cta } = p;

    // RENDER FIRST (pure, no side effects — demand-router ordering): a render
    // failure must consume nothing, so it aborts before any claim stamp.
    let rendered: { subject: string; html: string };
    try {
      rendered = renderRequalifyEmail(r.name, r.state, rancher, cta, p.variantSent ?? 'A');
    } catch (e: unknown) {
      failed += 1;
      results.push({
        email: r.email,
        ok: false,
        mode: cta.mode,
        ...(p.reason ? { ctaReason: p.reason } : {}),
        reason: `render failed, NOT stamped/sent — ${String((e as Error)?.message || 'unknown').slice(0, 100)}`,
      });
      await pace();
      continue;
    }

    // ── CLAIM BEFORE SEND (ADAPTIVE-MARKETING-DESIGN PR 1 — the idempotency
    // hole). Nothing on this rail ever wrote `Campaign Last Sent At`, so the
    // "uncampaigned" pool (isEmpty on that field) passed the same buyers
    // forever and any re-run re-emailed the whole cohort. Stamp Campaign
    // Last Sent At + Campaign Rail on every matched Consumers row BEFORE the
    // send — the demand-router pattern (stampSend/revertClaim in
    // app/api/cron/demand-router/route.ts): a crash or timeout after this
    // point can never re-send on the next run. If ANY row's claim fails we
    // SKIP the send (better a missed campaign touch than a double-send),
    // reverting rows already claimed. `Campaign Rail` may not exist yet —
    // updateRecord auto-strips unknown fields (deduped operator alert), so
    // the core idempotency stamp still lands.
    const nowIso = new Date().toISOString();
    const claimed: typeof p.claimRows = [];
    let claimOk = true;
    for (const row of p.claimRows) {
      try {
        await updateRecord(TABLES.CONSUMERS, row.id, {
          'Campaign Last Sent At': nowIso,
          'Campaign Rail': 'requalify',
        });
        claimed.push(row);
      } catch (e: unknown) {
        claimOk = false;
        claimFailures.push(
          `${r.email}: claim stamp failed, send SKIPPED — ${String((e as Error)?.message || 'unknown').slice(0, 80)}`,
        );
        break;
      }
    }

    // Revert claimed rows to their pre-claim values so a later run retries
    // this buyer. A failed revert leaves the claim burned — surfaced, never
    // retried blind — the same trade the router makes (no double-send risk).
    const revertClaims = async (why: string): Promise<void> => {
      for (const row of claimed) {
        try {
          await updateRecord(TABLES.CONSUMERS, row.id, {
            'Campaign Last Sent At': row.prior.lastSent,
            'Campaign Rail': row.prior.rail,
          });
        } catch (e: unknown) {
          claimFailures.push(
            `${r.email}: claim revert failed after ${why} — claim burned — ${String((e as Error)?.message || 'unknown').slice(0, 80)}`,
          );
        }
      }
    };

    if (!claimOk) {
      await revertClaims('claim failure');
      failed += 1;
      results.push({
        email: r.email,
        ok: false,
        mode: cta.mode,
        ...(p.reason ? { ctaReason: p.reason } : {}),
        reason: 'claim stamp failed — send skipped',
      });
      await pace();
      continue;
    }

    try {
      const res = await sendEmail({
        to: r.email,
        subject: rendered.subject,
        html: rendered.html,
        templateName,
        // Email Sends attribution (PR 1): consumer link + campaign tag +
        // the variant arm actually sent ride to the audit row. The Resend
        // message id is captured inside guardedSend on the same row.
        recipientConsumerId: p.replyConsumerId || undefined,
        campaign,
        variant: p.variantSent || undefined,
        // Thread replies to the buyer's Consumer record (usr-<id>@replies…)
        // so the inbound webhook logs the conversation against the right
        // person and the buyer arm can adapt their state. No consumer match
        // → wrapper falls back to the generic inbox (still captured+logged).
        ...(p.replyConsumerId
          ? { _replyContext: { type: 'usr', recordId: p.replyConsumerId } }
          : {}),
      } as any);
      if (res.success) sent += 1;
      else if (res.suppressed) {
        suppressed += 1;
        // Claim disposition on suppression: unsub/bounce/complaint is
        // TERMINAL — keep the stamp, never retry into a suppression (router
        // rule). A cap/pause suppression is TRANSIENT — nothing was
        // delivered and the buyer is sendable again within days, so revert
        // rather than marking them campaigned forever with zero emails.
        if (res.reason !== 'unsubscribed-bounced-or-complained') {
          await revertClaims('transient suppression');
        }
      } else {
        failed += 1;
        await revertClaims('send failure');
      }
      results.push({
        email: r.email,
        ok: !!res.success,
        mode: cta.mode,
        ...(p.reason ? { ctaReason: p.reason } : {}),
        ...(p.variantSent ? { variant: p.variantSent } : {}),
        suppressed: res.suppressed,
        reason: res.reason,
      });
    } catch (e: unknown) {
      failed += 1;
      await revertClaims('send throw');
      results.push({
        email: r.email,
        ok: false,
        mode: cta.mode,
        ...(p.reason ? { ctaReason: p.reason } : {}),
        ...(p.variantSent ? { variant: p.variantSent } : {}),
        reason: String((e as Error)?.message || 'send threw').slice(0, 120),
      });
    }
    await pace();
  }
  return NextResponse.json({
    campaign,
    variantMode: vmode,
    sent,
    suppressed,
    failed,
    oneTap,
    quizFallback,
    results,
    ...(claimFailures.length > 0 ? { claimFailures } : {}),
  });
}
