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

  const [consumers, ranchers, referrals, payments, rancherOrders, cronRuns, probes] =
    await Promise.all([
      safe(() => adminSnapshotTable(TABLES.CONSUMERS) as Promise<any[]>, 'consumers'),
      safe(() => adminSnapshotTable(TABLES.RANCHERS) as Promise<any[]>, 'ranchers'),
      safe(() => adminSnapshotTable(TABLES.REFERRALS) as Promise<any[]>, 'referrals'),
      safe(() => adminSnapshotTable(TABLES.PAYMENTS) as Promise<any[]>, 'payments'),
      safe(() => adminSnapshotTable(TABLES.RANCHER_ORDERS) as Promise<any[]>, 'rancherOrders'),
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
    ]);

  // ── Coverage — the 6-gate canon, shared by bands 3/4/5 ──────────────────
  const coveredStates = new Set<string>();
  if (ranchers) {
    for (const r of ranchers) {
      if (!isRancherOperationalForBuyers(r)) continue;
      for (const s of getOperationalServedStates(r)) coveredStates.add(s);
    }
  }

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
      const paymentByReferralId = new Map<string, any>();
      for (const p of payments as any[]) {
        const rid = String(p['Referral Id Text'] || '');
        if (!rid) continue;
        const existing = paymentByReferralId.get(rid);
        const flagged =
          p['Refunded At'] ||
          String(p['Status'] || '').toLowerCase() === 'refunded' ||
          String(p['Dispute Status'] || '').trim();
        if (!existing || flagged) paymentByReferralId.set(rid, p);
      }
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
  // BAND 3 — DIAL LIST: one merged, supply-gated ranking (max 10)
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

      dial = buildCockpitDialList({
        buyers,
        stuckRanchers: stuckQueue.rows,
        coveredStates,
        limit: 10,
      });
    }
  } catch (e: any) {
    console.warn('[admin/today] dial band failed:', e?.message);
    dial = null;
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
    health,
    dial,
    oneMove,
    supply,
  });
}
