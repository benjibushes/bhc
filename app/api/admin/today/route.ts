// app/api/admin/today/route.ts
//
// Wave 1B — THE cockpit's single backing endpoint. One phone-first screen
// that answers, in 15 minutes a day: what did I earn, what broke, who do I
// call, what's the one move, how much supply do I have.
//
// READ-ONLY. No Airtable writes, no sends, no Telegram.
//
// Airtable budget (org limit 5 req/s shared with 63 crons):
//   • Five full-table reads ride lib/adminSnapshot (module-scope + shared
//     Redis, 3-min TTL) — the SAME snapshot keys command-center / health /
//     analytics already share, so opening the cockpit next to any other admin
//     surface costs zero extra scans inside a TTL window.
//   • Cron Runs is ONE 25h-filtered read (~3 paginated requests) under its
//     own snapshot key; both the failure count and the dead-man's diff are
//     derived from that single read.
//   • Conversations (CRM-parity C3) is ONE filtered read (waiting Reply
//     Status values only — a handful of rows) under its own snapshot key.
//   • Platform probes hit Stripe/Resend/Redis (not Airtable) and are cached
//     under the same 3-min snapshot so a 120s client poll can't turn into a
//     probe storm.
//   Cold-cache worst case ≈ 35 paginated Airtable requests (dominated by the
//   ~2.6k-row Consumers scan every admin surface already shares); warm cache
//   is ZERO Airtable reads. The client polls no faster than 120s.
//
// CONTRACT (same as command-center): every band is independently fail-soft.
// A failed read nulls THAT band; the route never 500s past auth.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { adminSnapshot, adminSnapshotTable } from '@/lib/adminSnapshot';
import { requireAdmin } from '@/lib/adminAuth';
import {
  computeConnectFeeCapturedInRange,
  computeProductMarginInRange,
} from '@/lib/commissionStats';
import { selectSlaEligible } from '@/lib/depositSla';
import { isAcceptedInFlight } from '@/lib/referralStage';
import {
  selectObligations,
  summarizeObligations,
  type ObligationRow,
  type ObligationsSummary,
} from '@/lib/obligations';
import { classifyCronFailures } from '@/lib/cronFailures';
import { missingExpectedCrons, type CronRunSummary } from '@/lib/cronIntrospection';
import { runPlatformProbes } from '@/lib/platformProbes';
import { operatorToday } from '@/lib/followUpQueue';
import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
} from '@/lib/rancherEligibility';
import { isBrokerRancher } from '@/lib/brokerRail';
import { hasOpenCallbackRequest, rankDialQueue } from '@/lib/callbackQueue';
import { buildDialCandidates } from '@/lib/dialCandidates';
import {
  rankStuckRancherQueue,
  PARKED_ACTIVE_STATUSES,
  REMOVED_VERIFICATION_STATUS,
} from '@/lib/stuckRancherQueue';
import {
  toStuckRancherRow,
  waitingDemandFromConsumers,
} from '@/lib/stuckRancherAirtable';
import { buildCockpitDialList, type CockpitDialRow } from '@/lib/cockpitDialList';
import { normalizeState } from '@/lib/states';
// ── CRM-parity (§3.5 C2/C3) ──
import { selectDueFollowUps } from '@/lib/followUpQueue';
import { rankCloseQueue, type CloseQueueRow } from '@/lib/closeQueue';
import { computeNBA } from '@/lib/nextBestAction';
import { computeLeadScore } from '@/lib/leadScore';
import { isRancherOnConnect } from '@/lib/rancherEligibility';
import { REPLY_WAITING_STATUSES, isReplySendable } from '@/lib/stagedReply';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const str = (v: any): string =>
  v == null ? '' : typeof v === 'object' && 'name' in v ? String(v.name ?? '') : String(v);
const num = (v: any): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toCents = (dollars: number): number => Math.round(dollars * 100);

/** Cron Runs window — 25h, mirroring the digest's dead-man jitter grace. */
const CRON_WINDOW_MS = 25 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const authResp = await requireAdmin(request);
  if (authResp) return authResp;

  const now = Date.now();
  const todayStr = operatorToday(now); // Ben's calendar day (America/Denver)
  const monthStr = todayStr.slice(0, 7);
  const isToday = (iso: string) => operatorToday(Date.parse(iso)) === todayStr;
  const isThisMonth = (iso: string) => operatorToday(Date.parse(iso)).slice(0, 7) === monthStr;

  const safe = async <T>(fn: () => Promise<T>, label: string): Promise<T | null> => {
    try {
      return await fn();
    } catch (e: any) {
      console.warn(`[admin/today] ${label} read failed:`, e?.message);
      return null;
    }
  };

  const [
    consumers,
    ranchers,
    referrals,
    payments,
    rancherOrders,
    rancherProducts,
    cronRuns,
    probes,
    waitingReplies,
  ] =
    await Promise.all([
      safe(() => adminSnapshotTable(TABLES.CONSUMERS) as Promise<any[]>, 'consumers'),
      safe(() => adminSnapshotTable(TABLES.RANCHERS) as Promise<any[]>, 'ranchers'),
      safe(() => adminSnapshotTable(TABLES.REFERRALS) as Promise<any[]>, 'referrals'),
      safe(() => adminSnapshotTable(TABLES.PAYMENTS) as Promise<any[]>, 'payments'),
      safe(() => adminSnapshotTable(TABLES.RANCHER_ORDERS) as Promise<any[]>, 'rancherOrders'),
      // OBLIGATIONS band only — the shop rail is judged against the ranch's
      // OWN 'Ships In Days' promise, which lives on the PRODUCT. One small
      // table, under the shared snapshot; a failed read degrades the shop lane
      // to the flat 3/6 windows rather than nulling the band.
      safe(() => adminSnapshotTable(TABLES.RANCHER_PRODUCTS) as Promise<any[]>, 'rancherProducts'),
      safe(
        () =>
          adminSnapshot('cron-runs-25h', () => {
            const cutoff = new Date(Date.now() - CRON_WINDOW_MS).toISOString();
            return getAllRecords(
              TABLES.CRON_RUNS,
              `IS_AFTER({Started At}, "${cutoff}")`,
            ) as Promise<any[]>;
          }) as Promise<any[]>,
        'cronRuns',
      ),
      safe(() => adminSnapshot('platform-probes', () => runPlatformProbes()), 'probes'),
      // CRM-parity C3 — Conversations rows waiting on a human. Filtered on the
      // exact Reply Status values the resend-inbound webhook writes; a
      // handful of rows, ONE request.
      safe(
        () =>
          adminSnapshot('replies-waiting', () =>
            getAllRecords(
              TABLES.CONVERSATIONS,
              `OR(${REPLY_WAITING_STATUSES.map((s) => `{Reply Status}='${s}'`).join(',')})`,
            ),
          ) as Promise<any[]>,
        'waitingReplies',
      ),
    ]);

  // ── Coverage — the 6-gate canon, shared by bands 3/4/5 ──────────────────
  const coveredStates = new Set<string>();
  if (ranchers) {
    for (const r of ranchers) {
      if (!isRancherOperationalForBuyers(r)) continue;
      for (const s of getOperationalServedStates(r)) coveredStates.add(s);
    }
  }

  // ── Shared joins — built ONCE off the snapshots, used by the money band
  // and the obligations band (zero extra Airtable reads). Refund/dispute
  // truth for an Awaiting-Payment deposit lives ONLY on the Payments row, so
  // prefer a flagged row whenever a referral has several.
  const paymentByReferralId = new Map<string, any>();
  for (const p of (payments as any[]) || []) {
    const rid = String(p['Referral Id Text'] || '');
    if (!rid) continue;
    const existing = paymentByReferralId.get(rid);
    const flagged =
      p['Refunded At'] ||
      String(p['Status'] || '').toLowerCase() === 'refunded' ||
      String(p['Dispute Status'] || '').trim();
    if (!existing || flagged) paymentByReferralId.set(rid, p);
  }
  const rancherRecordById = new Map<string, any>();
  for (const r of (ranchers as any[]) || []) rancherRecordById.set(String(r.id), r);

  // ════════════════════════════════════════════════════════════════════════
  // BAND 1 — MONEY: Earned today · Earned MTD · Owed to me · Stuck
  // ════════════════════════════════════════════════════════════════════════
  let money: any = null;
  try {
    if (payments && rancherOrders && referrals) {
      // Earned = Connect fee captured (Payments) + shop margin (Rancher
      // Orders) — the CURRENT money models only, same rails as command-
      // center's bhcRevenueCurrentRails, bounded to Ben's day/month.
      const feesToday = computeConnectFeeCapturedInRange(payments as any[], isToday);
      const feesMtd = computeConnectFeeCapturedInRange(payments as any[], isThisMonth);
      const marginToday = computeProductMarginInRange(rancherOrders as any[], isToday);
      const marginMtd = computeProductMarginInRange(rancherOrders as any[], isThisMonth);

      // OWED — money asked for but not collected:
      //   • Awaiting-Payment referrals whose deposit has NOT landed (the ones
      //     where the deposit HAS landed are not owed — they're stuck, below).
      //   • abandoned Payments rows, minus any row whose referral is already
      //     counted on the referral side (dedupe on Referral Id Text).
      const awaiting = (referrals as any[]).filter(
        (r) => str(r['Status']) === 'Awaiting Payment',
      );
      const awaitingUnpaid = awaiting.filter((r) => !r['Deposit Paid At']);
      const awaitingUnpaidIds = new Set(awaitingUnpaid.map((r) => String(r.id)));
      const owedReferralCents = awaitingUnpaid.reduce(
        (s, r) => s + toCents(num(r['Deposit Amount'])),
        0,
      );
      const abandonedRows = (payments as any[]).filter(
        (p) =>
          str(p['Status']) === 'abandoned' &&
          !awaitingUnpaidIds.has(String(p['Referral Id Text'] || '')),
      );
      const abandonedCents = abandonedRows.reduce((s, p) => s + num(p['Amount Cents']), 0);

      // STUCK — deposit PAID but the rancher never tapped Accept. Mirrors the
      // deposit-accept-sla cron's selection (lib/depositSla) with the age/
      // cooldown thresholds zeroed: the cron asks "who do I re-ping", the
      // cockpit asks "what money is frozen right now". The Payments join the
      // cron does per-row is done here in memory off the snapshot (Referral
      // Id Text), so refunded/disputed deposits are excluded the same way at
      // zero extra reads.
      const stuckCandidates = (referrals as any[])
        .filter((r) => r['Deposit Paid At'] && !r['Rancher Accepted At'])
        .map((r) => ({ ...r, __payment: paymentByReferralId.get(String(r.id)) || null }));
      const stuck = selectSlaEligible(stuckCandidates, {
        now,
        slaHours: 0,
        repingCooldownHours: 0,
      });
      const stuckCents = stuck.reduce((s, r) => s + toCents(num(r['Deposit Amount'])), 0);
      const oldestStuckMs = stuck.reduce((oldest: number | null, r) => {
        const t = Date.parse(String(r['Deposit Paid At'] || ''));
        if (!Number.isFinite(t)) return oldest;
        return oldest === null || t < oldest ? t : oldest;
      }, null as number | null);

      money = {
        earnedTodayCents: toCents(feesToday + marginToday),
        earnedMtdCents: toCents(feesMtd + marginMtd),
        owedCents: owedReferralCents + abandonedCents,
        owedCount: awaitingUnpaid.length + abandonedRows.length,
        stuckCents,
        stuckCount: stuck.length,
        stuckOldestHours:
          oldestStuckMs === null ? null : Math.floor((now - oldestStuckMs) / 3_600_000),
        breakdown: {
          feesTodayCents: toCents(feesToday),
          marginTodayCents: toCents(marginToday),
          feesMtdCents: toCents(feesMtd),
          marginMtdCents: toCents(marginMtd),
          owedReferralCents,
          owedAbandonedCents: abandonedCents,
        },
      };
    }
  } catch (e: any) {
    console.warn('[admin/today] money band failed:', e?.message);
    money = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // BAND 1b — OBLIGATIONS: money collected, delivery unproven (P0-1)
  //
  // THE HOLE THIS CLOSES: the "Stuck" tile above is `Deposit Paid At &&
  // !Rancher Accepted At`, so a deal left EVERY operator surface the instant a
  // rancher tapped Accept — and nothing anywhere read `Fulfillment Confirmed
  // At`. "What do I owe a customer right now?" had no answer on any screen.
  // This band answers it across all three rails at once (lib/obligations),
  // derived from snapshots already in hand: ZERO extra Airtable reads beyond
  // the small Rancher Products table the shop lane needs for the ship promise.
  // ════════════════════════════════════════════════════════════════════════
  let obligations: { rows: ObligationRow[]; summary: ObligationsSummary } | null = null;
  try {
    if (referrals) {
      const shipDaysByProductId = new Map<string, number>();
      for (const prod of (rancherProducts as any[]) || []) {
        const days = Number(prod?.['Ships In Days']);
        if (Number.isFinite(days) && days > 0) shipDaysByProductId.set(String(prod.id), days);
      }
      const rows = selectObligations({
        referrals: referrals as any[],
        // A failed Rancher Orders read must not null the whole band — the two
        // referral rails still answer for the money that matters most.
        rancherOrders: (rancherOrders as any[]) || [],
        paymentByReferralId,
        rancherById: rancherRecordById,
        shipDaysByProductId,
        now,
      });
      obligations = { rows, summary: summarizeObligations(rows) };
    }
  } catch (e: any) {
    console.warn('[admin/today] obligations band failed:', e?.message);
    obligations = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // BAND 2 — WHAT BROKE: probes + cron failures + dead-man, red rows only
  // ════════════════════════════════════════════════════════════════════════
  let health: any = null;
  try {
    const reds: Array<{ name: string; detail: string; fix?: string }> = [];

    if (probes) {
      for (const p of probes) {
        if (!p.ok) reds.push({ name: p.name, detail: p.detail, fix: p.fix });
      }
    } else {
      reds.push({ name: 'probes', detail: 'probe run failed — platform checks are blind' });
    }

    if (cronRuns) {
      const runs24h = cronRuns.filter((r: any) => {
        const t = Date.parse(String(r['Started At'] || ''));
        return Number.isFinite(t) && now - t <= DAY_MS;
      });
      const { errorRuns, failedCronNames } = classifyCronFailures(runs24h, now);
      if (errorRuns.length > 0) {
        reds.push({
          name: 'cron-failures',
          detail: `${errorRuns.length} failed run${errorRuns.length === 1 ? '' : 's'} across ${failedCronNames.length} cron${failedCronNames.length === 1 ? '' : 's'}: ${failedCronNames.slice(0, 6).join(', ')}`,
          fix: 'open /admin/health for the per-cron board',
        });
      }

      // Dead-man's diff off the SAME read — latest row per name, then the
      // shared missingExpectedCrons decision (identical to the digest's).
      const latest = new Map<string, CronRunSummary>();
      for (const r of cronRuns as any[]) {
        const name = String(r['Name'] || '');
        if (!name) continue;
        const startedAt = String(r['Started At'] || '');
        const prev = latest.get(name);
        if (!prev || new Date(startedAt).getTime() > new Date(prev.startedAt).getTime()) {
          latest.set(name, {
            name,
            startedAt,
            status: String(r['Status'] || '?'),
            recordsTouched: Number(r['Records Touched']) || 0,
            notes: String(r['Notes'] || ''),
          });
        }
      }
      const missing = missingExpectedCrons(latest, new Date(now).toISOString(), CRON_WINDOW_MS);
      if (missing.length > 0) {
        reds.push({
          name: 'cron-watchdog',
          detail: `${missing.length} expected cron${missing.length === 1 ? '' : 's'} wrote NO run in 25h: ${missing.slice(0, 6).join(', ')}`,
          fix: 'check the Vercel cron schedule / recent deploys',
        });
      }
    } else {
      reds.push({
        name: 'cron-watchdog',
        detail: 'Cron Runs read failed — failure count and dead-man check are blind',
      });
    }

    health = { healthy: reds.length === 0, reds };
  } catch (e: any) {
    console.warn('[admin/today] health band failed:', e?.message);
    health = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // BAND 3 — THE QUEUE: one merged, supply-gated ranking (max 10).
  // CRM-parity (§3.5 C2): fuses the dial sources with the promised
  // follow-ups (lib/followUpQueue), the open-deal call queue
  // (lib/closeQueue), and the NBA engine's one-liners — all derived from the
  // snapshots already in hand, ZERO extra Airtable reads.
  // ════════════════════════════════════════════════════════════════════════
  let dial: CockpitDialRow[] | null = null;
  try {
    if (consumers && referrals && ranchers) {
      // Buyer side — same three sources the desk API feeds rankDialQueue,
      // derived from the snapshots instead of three filtered reads.
      const callbackRows = consumers.filter((c: any) =>
        hasOpenCallbackRequest({
          callbackRequestedAt: c['Callback Requested At'],
          callbackHandledAt: c['Callback Handled At'],
        }),
      );
      const depositPending = referrals.filter(
        (r: any) => str(r['Status']) === 'Awaiting Payment',
      );
      const quizComplete = consumers.filter(
        (c: any) => c['Qualified At'] && str(c['Buyer Stage']) === 'READY',
      );
      const buyers = rankDialQueue(
        buildDialCandidates(callbackRows, depositPending, quizComplete),
        { now, limit: 25 },
      );

      // Rancher side — the stuck queue, demand-weighted off the same
      // Consumers snapshot (WAITING cohort).
      const demand = waitingDemandFromConsumers(consumers);
      const stuckRows = ranchers
        .filter((r: any) => !isBrokerRancher(r) && !!r['Stuck Escalated At'])
        .map((r: any) => toStuckRancherRow(r, demand));
      const stuckQueue = rankStuckRancherQueue(stuckRows, { now, limit: 10 });

      // C2 — promised follow-ups due (the desk's "⏰ Follow up today" lane).
      const followUpsDue = selectDueFollowUps(consumers as any[], todayStr, 10);

      // C2 — the open-deal call queue (lib/closeQueue), previously computed
      // only client-side on /admin/desk. rancherCanCapture rides the single
      // Connect canon (isRancherOnConnect) off the ranchers snapshot.
      const rancherById = new Map<string, { name: string; canCapture: boolean }>();
      for (const r of ranchers as any[]) {
        rancherById.set(String(r.id), {
          name: String(r['Operator Name'] || r['Ranch Name'] || ''),
          canCapture: isRancherOnConnect(r),
        });
      }
      const closeRows: CloseQueueRow[] = (referrals as any[]).map((r: any) => {
        const rancherId = Array.isArray(r['Rancher']) ? String(r['Rancher'][0] || '') : '';
        const info = rancherById.get(rancherId);
        return {
          id: String(r.id),
          status: str(r['Status']),
          buyerName: String(r['Buyer Name'] || ''),
          buyerState: String(r['Buyer State'] || ''),
          buyerEmail: String(r['Buyer Email'] || ''),
          buyerPhone: String(r['Buyer Phone'] || ''),
          rancherName: info?.name || String(r['Suggested Rancher Name'] || ''),
          hasRancher: !!rancherId,
          rancherCanCapture: !!info?.canCapture,
          intentScore: num(r['Intent Score']),
          saleAmount: num(r['Sale Amount']),
          budgetRange: String(r['Budget Range'] || ''),
          // Referrals has NO 'Created At' field — Airtable metadata is the
          // only universal creation stamp (same rule as the desk's R3 fix).
          createdAt: String(r._createdTime || ''),
          introSentAt: String(r['Intro Sent At'] || ''),
          lastChasedAt: String(r['Last Chased At'] || ''),
        };
      });
      const closeQueue = rankCloseQueue(closeRows, { now, limit: 10 });

      // C2 — the NBA engine, finally rendered. Inputs mirror the desk API's
      // shaping, derived from the snapshots (wholesale/Inquiries is left off:
      // it would cost the cockpit a sixth table read for a desk-owned lane).
      const DAY = 24 * 60 * 60 * 1000;
      const nbaCalls = (referrals as any[])
        .filter((r: any) => {
          const t = Date.parse(String(r['Sales Call Start At'] || ''));
          return Number.isFinite(t) && Math.abs(t - now) <= DAY;
        })
        .map((r: any) => ({
          id: String(r.id),
          startTime: String(r['Sales Call Start At'] || ''),
          buyerName: String(r['Buyer Name'] || '?'),
          buyerEmail: String(r['Buyer Email'] || '?'),
          state: String(r['Buyer State'] || ''),
        }));
      const nbaQuiz = quizComplete.map((c: any) => ({
        id: String(c.id),
        name: String(c['Full Name'] || '?'),
        email: String(c['Email'] || ''),
        state: String(c['State'] || ''),
        qualifiedAt: String(c['Qualified At'] || ''),
        leadScore: computeLeadScore(c).score,
      }));
      const nbaDeposits = depositPending.map((r: any) => ({
        id: String(r.id),
        buyerEmail: String(r['Buyer Email'] || '?'),
        rancherName: Array.isArray(r['Rancher'])
          ? rancherById.get(String(r['Rancher'][0] || ''))?.name || '(linked)'
          : String(r['Rancher Name'] || r['Suggested Rancher Name'] || '?'),
        state: String(r['Buyer State'] || ''),
        depositPaidAt: String(r['Deposit Paid At'] || ''),
      }));
      // P1-1 (2026-08-18): filtering on Status here found NOTHING — the
      // final-invoice write erases 'Slot Locked' seconds after the accept.
      // The accept stamp is the durable truth (lib/referralStage).
      const nbaSlots = (referrals as any[])
        .filter((r: any) => isAcceptedInFlight(r))
        .map((r: any) => ({
          id: String(r.id),
          buyerEmail: String(r['Buyer Email'] || '?'),
          rancherName: Array.isArray(r['Rancher'])
            ? rancherById.get(String(r['Rancher'][0] || ''))?.name || '(linked)'
            : String(r['Rancher Name'] || '?'),
        }));
      const nba = computeNBA(
        {
          calls: nbaCalls,
          quizComplete: nbaQuiz,
          depositPending: nbaDeposits,
          slotsLocked: nbaSlots,
        },
        { coveredStates },
      );

      dial = buildCockpitDialList({
        buyers,
        stuckRanchers: stuckQueue.rows,
        coveredStates,
        followUpsDue,
        closeQueue,
        nba,
        now,
        today: todayStr,
        limit: 10,
      });
    }
  } catch (e: any) {
    console.warn('[admin/today] dial band failed:', e?.message);
    dial = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // BAND 3b — REPLIES WAITING (CRM-parity C3): staged/escalated Conversations
  // rows, previously visible only as Telegram cards that scroll away.
  // ════════════════════════════════════════════════════════════════════════
  let replies: any = null;
  try {
    if (waitingReplies) {
      replies = (waitingReplies as any[])
        .slice()
        .sort(
          (a, b) =>
            (Date.parse(String(b['Timestamp'] || '')) || 0) -
            (Date.parse(String(a['Timestamp'] || '')) || 0),
        )
        .slice(0, 8)
        .map((c: any) => {
          const ts = Date.parse(String(c['Timestamp'] || ''));
          return {
            id: String(c.id),
            from: String(c['From'] || '').trim(),
            senderType: str(c['Sender Type']),
            subject: String(c['Subject'] || '').trim(),
            aiSummary: String(c['AI Summary'] || '').trim(),
            stagedPreview: String(c['Staged Reply'] || '').trim().slice(0, 240),
            replyStatus: str(c['Reply Status']),
            sendable: isReplySendable(c['Reply Status'], c['Staged Reply']),
            ageHours: Number.isFinite(ts)
              ? Math.max(0, Math.floor((now - ts) / 3_600_000))
              : null,
          };
        });
    }
  } catch (e: any) {
    console.warn('[admin/today] replies band failed:', e?.message);
    replies = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // BAND 4 — THE ONE MOVE: one sentence from the supply×demand cross
  // ════════════════════════════════════════════════════════════════════════
  let oneMove: string | null = null;
  try {
    if (consumers && ranchers) {
      // Same cross command-center's `unlock` section computes: qualified
      // buyers per state vs 6-gate operational coverage.
      const demandByState: Record<string, number> = {};
      for (const c of consumers) {
        const qualified = str(c['Status']) === 'Approved' && !!c['Qualified At'];
        if (!qualified) continue;
        const st = normalizeState(c['State']);
        if (!st) continue;
        demandByState[st] = (demandByState[st] || 0) + 1;
      }
      const uncovered = Object.entries(demandByState)
        .filter(([state]) => !coveredStates.has(state))
        .sort((a, b) => b[1] - a[1]);

      if (uncovered.length > 0) {
        const [state, buyers] = uncovered[0];
        oneMove = `${state} has ${buyers} qualified buyer${buyers === 1 ? '' : 's'} and no operational rancher — 1 signed rancher there ≈ +$162/mo recurring.`;
      } else if (money && money.stuckCount > 0) {
        oneMove = `${money.stuckCount} paid deposit${money.stuckCount === 1 ? ' is' : 's are'} waiting on a rancher accept — chase that before anything else.`;
      } else if (obligations && obligations.summary.pinnedCount > 0) {
        // Money already collected with no machine left to chase it beats every
        // growth move on the board.
        const oldest = obligations.rows.find((r) => r.pinned);
        oneMove = `${obligations.summary.pinnedCount} paid order${obligations.summary.pinnedCount === 1 ? '' : 's'} nobody is chasing any more — start with ${oldest ? oldest.ranchName : 'the oldest'} (${oldest ? Math.floor(oldest.ageHours / 24) : '?'}d).`;
      } else if (dial && dial.length > 0) {
        oneMove = `Work the dial list top-down — ${dial[0].name} (${dial[0].state || '?'}) first.`;
      } else {
        oneMove = 'All clear — no uncovered demand, no stuck money. Recruit supply.';
      }
    }
  } catch (e: any) {
    console.warn('[admin/today] one-move band failed:', e?.message);
    oneMove = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // BAND 5 — SUPPLY: payable (6-gate) · signed but stuck · in onboarding
  // ════════════════════════════════════════════════════════════════════════
  let supply: any = null;
  try {
    if (ranchers) {
      const isParkedRecord = (r: any): boolean =>
        str(r['Verification Status']) === REMOVED_VERIFICATION_STATUS ||
        PARKED_ACTIVE_STATUSES.has(str(r['Active Status']));

      // The REAL count — every gate in lib/rancherEligibility, not the
      // 2-gate Active-Status count that overstates it.
      const payable = ranchers.filter((r: any) => isRancherOperationalForBuyers(r)).length;
      const signedStuck = ranchers.filter(
        (r: any) =>
          !isBrokerRancher(r) &&
          !isParkedRecord(r) &&
          r['Agreement Signed'] === true &&
          !isRancherOperationalForBuyers(r),
      ).length;
      const inOnboarding = ranchers.filter((r: any) => {
        if (isBrokerRancher(r) || isParkedRecord(r)) return false;
        if (r['Agreement Signed'] === true) return false;
        const onboarding = str(r['Onboarding Status']);
        return !!onboarding && onboarding !== 'Live';
      }).length;

      supply = {
        payable,
        signedStuck,
        inOnboarding,
        coveredStates: [...coveredStates].sort(),
      };
    }
  } catch (e: any) {
    console.warn('[admin/today] supply band failed:', e?.message);
    supply = null;
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    operatorDay: todayStr,
    money,
    obligations,
    health,
    dial,
    replies,
    oneMove,
    supply,
  });
}
