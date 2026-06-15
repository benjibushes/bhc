import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramUpdate } from '@/lib/telegram';
import { sendRancherLaunchWarmup, sendRancherLaunchWarmupNudge } from '@/lib/email';
import { normalizeState, normalizeStates } from '@/lib/states';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { withCronRun } from '@/lib/cronRun';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
import { JWT_SECRET } from '@/lib/secrets';

// Global per-run caps — protects sender reputation during mass re-engagement.
// 100/day warmups × 7 days clears a ~700-waitlist backlog without burst-flagging.
// Trust-Mode drain branch still respects this cap; throttled branches will be
// well under it by design.
const WARMUP_CAP_PER_RUN = 100;
const NUDGE_CAP_PER_RUN = 50;
const DEFAULT_WEEKLY_INTRO_PACE = 5;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Outer per-run ceiling on TOTAL records touched (warmups + nudges).
// Layered on top of the per-phase caps above; whichever binds first wins.
// Protects against cohort-growth runaway under paid-scale.
//
// Bumped 2026-05-27 from 25 → 100. With 1533 buyers + 679 stuck-warmed cohort,
// the 25/day ceiling was draining the backlog at 25 records/day total — making
// WARMUP_CAP_PER_RUN=100 + NUDGE_CAP_PER_RUN=50 effectively dead code (the
// 25-ceiling bound first on every run). 100/day aligns with WARMUP_CAP_PER_RUN
// so the per-phase + outer caps now agree, drain rate quadruples.
const MAX_PER_RUN = 100;

function buildEngageUrl(consumerId: string): string {
  const token = jwt.sign({ type: 'warmup-engage', consumerId }, JWT_SECRET, { expiresIn: '30d' });
  return `${SITE_URL}/api/warmup/engage?token=${token}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

// Priority score for buyers — higher = sent first. The throttle batches
// dailyBatch buyers per rancher per day, so without ordering we'd warm
// stale records before fresh hot leads. This prioritizes:
//   - Already self-flagged ready-to-buy
//   - Already engaged with a previous warmup (re-firing on hot leads is fine)
//   - Buyer Stage already READY (rancher exists, signaled they want match)
//   - Recently active (Last Login At is reserved for a future field; null-safe)
//   - Newer signups (still in their post-signup intent window)
//   - Penalty for very stale signups (>90d quiet)
function priorityScore(buyer: any): number {
  let s = 0;
  if (buyer['Ready to Buy']) s += 100;
  if (buyer['Warmup Engaged At']) s += 80;
  const stageRaw = buyer['Buyer Stage'];
  const stage = typeof stageRaw === 'object' ? stageRaw?.name : stageRaw;
  if (stage === 'READY') s += 60;
  const lastLogin = buyer['Last Login At'];
  if (lastLogin) {
    const ms = new Date(lastLogin).getTime();
    if (!Number.isNaN(ms) && Date.now() - ms < 14 * DAY_MS) s += 50;
  }
  const createdRaw = buyer['Created At'] || buyer['Created'] || buyer.createdTime || buyer._createdTime || 0;
  const createdMs = createdRaw ? new Date(createdRaw).getTime() : 0;
  if (createdMs > 0) {
    const days = (Date.now() - createdMs) / DAY_MS;
    if (days < 30) s += 30;
    if (days > 90) s -= 20;
  }
  return s;
}

// Runs daily at 8am MT (14:00 UTC).
//
// Two paths per rancher:
//
//   A. Trust Mode = TRUE  → legacy one-shot drain. Rancher has earned full
//      pipe (>=5 closes OR Onboarding Phase Until passed; cron at
//      /api/cron/rancher-trust-promotion flips this).
//
//   B. Trust Mode = FALSE → batched throttle. Sends Math.ceil(weekly/7)
//      buyers per day, prioritized by priorityScore(). Per-rancher 24h
//      cooldown enforced via Warmup Last Batch At. Closes Stage 1 gap
//      noted in changelog Section 7 by filtering on Buyer Stage instead
//      of Referral Status.
//
// Phase 2 (Day-7 nudge) runs after Phase 1 regardless of mode and
// is unchanged from the pre-throttle implementation.
async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string; skipReasonBreakdown?: Record<string, number> }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const skipReasons: Record<string, number> = {};

  {
    // ── PHASE 1: warmup to operationally-Live ranchers' waitlisted buyers ──
    // Pull all operational ranchers — Trust Mode promotion cron may have
    // flipped some to legacy-drain since yesterday; we evaluate per rancher.
    // Prior implementation filtered on `NOT({Launch Warmup Triggered})`, but
    // that flag was a pre-throttle one-shot signal. Throttle mode revisits
    // each rancher daily until their state's WAITING/READY queue is drained.
    const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
    const ranchers = allRanchers.filter((r: any) => {
      if (!isRancherOperationalForBuyers(r)) {
        skipReasons['rancher-not-operational'] = (skipReasons['rancher-not-operational'] || 0) + 1;
        return false;
      }
      return true;
    });

    let warmupsSent = 0;
    let warmupsSkipped = 0;
    const ranchersProcessed: string[] = [];
    const trustDrainRanchers: string[] = [];
    const throttledRanchers: Array<{ name: string; sent: number; cap: number }> = [];

    outer: for (const rancher of ranchers) {
      if (warmupsSent >= WARMUP_CAP_PER_RUN) break;
      if (warmupsSent >= MAX_PER_RUN) {
        console.log(`[rancher-launch-warmup] hit MAX_PER_RUN=${MAX_PER_RUN} (warmups), stopping phase 1`);
        break;
      }

      const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'A verified ranch';
      // Single source of truth for "what states does this rancher serve?" —
      // same helper used by matching/suggest. Respects Admin Approved
      // Multi-State gate. Without this, launch-warmup uses raw States Served
      // while matching uses Routing States, causing newly-live ranchers
      // (whose States Served is empty post-multi-state-gate ship) to never
      // warm up their states' Waitlisted buyers.
      const rancherStatesArr = getOperationalServedStates(rancher);
      if (rancherStatesArr.length === 0) continue;
      const rancherStates = new Set(rancherStatesArr);

      const trustMode = !!rancher['Trust Mode'];

      if (trustMode) {
        // ── Trust Mode branch: legacy one-shot drain ───────────────────────
        // Mirrors pre-throttle behavior: pull every Waitlisted buyer in the
        // rancher's served states and warm them all (subject to global cap).
        // Once drained for this rancher we set Launch Warmup Triggered=true
        // so we don't re-fire on already-warmed buyers (their Warmup Sent At
        // also gates them, but the flag preserves the prior op semantics).
        // NOTE: Trust Mode used to one-shot per rancher via `Launch Warmup
        // Triggered` flag. That assumption was wrong — new Waitlisted buyers
        // keep arriving in the rancher's state and never got warmed up
        // because the flag blocked the whole iteration. The per-buyer
        // `Warmup Sent At` filter below (line 140-area) already prevents
        // double-warming, so the rancher-level flag is redundant + harmful.
        // We still STAMP the flag after first drain (preserves audit
        // history + back-compat with /admin views), but we no longer GATE
        // future runs on it.

        // Pull Waitlisted buyers, scoped to this rancher's states.
        const waitlistedBuyers = await getAllRecords(
          TABLES.CONSUMERS,
          '{Referral Status} = "Waitlisted"'
        ) as any[];

        const eligible = waitlistedBuyers.filter((b: any) => {
          if (b['Unsubscribed'] || b['Bounced']) {
            skipReasons['bounced-unsub'] = (skipReasons['bounced-unsub'] || 0) + 1;
            return false;
          }
          if (b['Warmup Sent At']) {
            skipReasons['already-warmed'] = (skipReasons['already-warmed'] || 0) + 1;
            return false;
          }
          const buyerState = normalizeState(b['State']);
          if (!buyerState) return false;
          if (!rancherStates.has(buyerState)) {
            skipReasons['out-of-state'] = (skipReasons['out-of-state'] || 0) + 1;
            return false;
          }
          return true;
        });

        let ranchSent = 0;
        for (const buyer of eligible) {
          if (warmupsSent >= WARMUP_CAP_PER_RUN) break outer;
          if (warmupsSent >= MAX_PER_RUN) {
            console.log(`[rancher-launch-warmup] hit MAX_PER_RUN=${MAX_PER_RUN} (trust-drain), stopping`);
            break outer;
          }
          try {
            const email = (buyer['Email'] || '').trim();
            if (!email) { warmupsSkipped++; continue; }
            const first = String(buyer['Full Name'] || '').split(' ')[0] || '';
            const engageUrl = buildEngageUrl(buyer.id);

            // Idempotency hardening (P2-H 2026-05-27): stamp dedup field
            // BEFORE the email send. Trust Mode has no cohort-level cooldown
            // (unlike the throttled branch's Warmup Last Batch At gate), so a
            // post-send stamp failure here would let next run re-warm the
            // same buyer. Preemptive stamp + clear-on-send-failure makes the
            // worst-case "send + no stamp" → "no send, no duplicate" instead.
            const stampedAt = nowISO();
            try {
              await updateRecord(TABLES.CONSUMERS, buyer.id, {
                'Warmup Sent At': stampedAt,
                'Warmup Stage': 'sent',
              });
            } catch (e: any) {
              console.error(`[trust-drain] preemptive stamp failed for buyer ${buyer.id} — skipping send:`, e?.message);
              warmupsSkipped++;
              skipReasons['stamp-failed'] = (skipReasons['stamp-failed'] || 0) + 1;
              continue;
            }

            try {
              await sendRancherLaunchWarmup({
                email,
                firstName: first,
                ranchName,
                buyerState: normalizeState(buyer['State']),
                engageUrl,
              });
            } catch (sendErr: any) {
              // Best-effort rollback so next run gets another shot.
              console.error(`[trust-drain] send failed after stamp for buyer ${buyer.id} — clearing stamp:`, sendErr?.message);
              try {
                await updateRecord(TABLES.CONSUMERS, buyer.id, {
                  'Warmup Sent At': null,
                  'Warmup Stage': null,
                });
              } catch (clearErr: any) {
                // Stamp left in place — operator alert via cronRun partial signal.
                console.error(`[trust-drain] stamp clear failed for buyer ${buyer.id}:`, clearErr?.message);
              }
              warmupsSkipped++;
              skipReasons['send-failed'] = (skipReasons['send-failed'] || 0) + 1;
              continue;
            }

            warmupsSent++;
            ranchSent++;
          } catch (e: any) {
            console.error(`Trust-drain warmup error for buyer ${buyer.id}:`, e.message);
            warmupsSkipped++;
          }
        }

        try {
          await updateRecord(TABLES.RANCHERS, rancher.id, {
            'Launch Warmup Triggered': true,
            'Warmup Last Batch At': nowISO(),
          });
          ranchersProcessed.push(ranchName);
          trustDrainRanchers.push(`${ranchName} (drained ${ranchSent})`);
        } catch (e) {
          console.error('Error marking rancher warmup-triggered:', e);
        }
        continue;
      }

      // ── Throttled branch: batched onboarding pace ──────────────────────
      // 24h per-rancher cooldown
      const lastBatchRaw = rancher['Warmup Last Batch At'];
      if (lastBatchRaw) {
        const lastMs = new Date(lastBatchRaw).getTime();
        if (!Number.isNaN(lastMs) && Date.now() - lastMs < COOLDOWN_MS) {
          skipReasons['dedupe-recent-warmup'] = (skipReasons['dedupe-recent-warmup'] || 0) + 1;
          continue;
        }
      }

      const weeklyPace = Number(rancher['Onboarding Intro Pace']) || DEFAULT_WEEKLY_INTRO_PACE;
      const dailyBatch = Math.max(1, Math.ceil(weeklyPace / 7));

      // Build per-state Buyer Stage filter. Multi-state ranchers OR each
      // state. Filter on Buyer Stage (not Referral Status) — closes the
      // Stage 1 gap where buyers without a Referral Status row never got
      // picked up.
      const stateConds = rancherStatesArr
        .map((s) => `UPPER({State})='${escapeAirtableValue(s)}'`)
        .join(',');
      const stateOr = rancherStatesArr.length === 1
        ? stateConds
        : `OR(${stateConds})`;

      const formula = `AND(
        OR({Buyer Stage}='WAITING',{Buyer Stage}='READY'),
        ${stateOr},
        NOT({Warmup Sent At}),
        {Status}='Approved',
        NOT({Unsubscribed}),
        NOT({Bounced}),
        NOT({Complained}),
        {Buyer Health}!='Non-Responsive'
      )`.replace(/\s+/g, ' ');

      let candidates: any[] = [];
      try {
        candidates = await getAllRecords(TABLES.CONSUMERS, formula) as any[];
      } catch (e: any) {
        console.error(`[throttle] candidate fetch failed for ${ranchName}:`, e?.message);
        continue;
      }

      const ranked = candidates
        .map((c) => ({ rec: c, score: priorityScore(c) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, dailyBatch);

      let ranchSent = 0;
      for (const { rec } of ranked) {
        if (warmupsSent >= WARMUP_CAP_PER_RUN) break outer;
        if (warmupsSent >= MAX_PER_RUN) {
          console.log(`[rancher-launch-warmup] hit MAX_PER_RUN=${MAX_PER_RUN} (throttled), stopping`);
          break outer;
        }
        try {
          const email = (rec['Email'] || '').trim();
          if (!email) { warmupsSkipped++; continue; }
          const first = String(rec['Full Name'] || '').split(' ')[0] || '';
          const engageUrl = buildEngageUrl(rec.id);

          // Idempotency hardening (P2-H 2026-05-27): stamp dedup field
          // BEFORE the email send. Throttled branch has a 24h cohort
          // cooldown (Warmup Last Batch At) as primary safety net, but
          // the same stamp-then-send pattern from the Trust Mode branch
          // gives defense-in-depth + keeps the two code paths consistent.
          // Buyer Stage flip: WAITING → READY (rancher just became visible to
          // them; we're not yet at MATCHED — that requires a YES click).
          const stampedAt = nowISO();
          try {
            await updateRecord(TABLES.CONSUMERS, rec.id, {
              'Warmup Sent At': stampedAt,
              'Warmup Stage': 'sent',
              'Buyer Stage': 'READY',
              'Buyer Stage Updated At': stampedAt,
            });
          } catch (e: any) {
            console.error(`[throttle] preemptive stamp failed for buyer ${rec.id} — skipping send:`, e?.message);
            warmupsSkipped++;
            skipReasons['stamp-failed'] = (skipReasons['stamp-failed'] || 0) + 1;
            continue;
          }

          try {
            await sendRancherLaunchWarmup({
              email,
              firstName: first,
              ranchName,
              buyerState: normalizeState(rec['State']),
              engageUrl,
            });
          } catch (sendErr: any) {
            // Best-effort rollback — clear stamp + restore Buyer Stage so next
            // run picks them up. Note: 24h cohort cooldown will still gate the
            // whole rancher's queue for 24h, so retry doesn't happen sooner
            // than that anyway.
            console.error(`[throttle] send failed after stamp for buyer ${rec.id} — clearing stamp:`, sendErr?.message);
            try {
              await updateRecord(TABLES.CONSUMERS, rec.id, {
                'Warmup Sent At': null,
                'Warmup Stage': null,
                'Buyer Stage': 'WAITING',
                'Buyer Stage Updated At': nowISO(),
              });
            } catch (clearErr: any) {
              console.error(`[throttle] stamp clear failed for buyer ${rec.id}:`, clearErr?.message);
            }
            warmupsSkipped++;
            skipReasons['send-failed'] = (skipReasons['send-failed'] || 0) + 1;
            continue;
          }

          warmupsSent++;
          ranchSent++;
        } catch (e: any) {
          console.error(`[throttle] warmup error for buyer ${rec.id}:`, e.message);
          warmupsSkipped++;
        }
      }

      // Stamp the cooldown even if no candidates — prevents rerunning the
      // same query in the same 24h window.
      try {
        await updateRecord(TABLES.RANCHERS, rancher.id, {
          'Warmup Last Batch At': nowISO(),
        });
      } catch (e) {
        console.error('[throttle] cooldown stamp failed:', e);
      }

      if (ranchSent > 0) {
        ranchersProcessed.push(ranchName);
        throttledRanchers.push({ name: ranchName, sent: ranchSent, cap: dailyBatch });
      }
    }

    // ── PHASE 2: Day-7 nudge to anyone who didn't engage or match ───────────
    // Unchanged from pre-throttle implementation. Pull Waitlisted buyers
    // (covers both branches — throttled buyers also have Referral Status
    // since the Stage 1 migration kept Referral Status populated).
    const waitlistedForNudges = await getAllRecords(
      TABLES.CONSUMERS,
      '{Referral Status} = "Waitlisted"'
    ) as any[];

    let nudgesSent = 0;
    const now = Date.now();
    const nudgeCandidates = waitlistedForNudges.filter((b: any) => {
      if (b['Unsubscribed'] || b['Bounced']) {
        skipReasons['bounced-unsub'] = (skipReasons['bounced-unsub'] || 0) + 1;
        return false;
      }
      if (b['Warmup Engaged At']) {
        skipReasons['already-warmed'] = (skipReasons['already-warmed'] || 0) + 1;
        return false;
      }
      const stage = b['Warmup Stage']?.name || b['Warmup Stage'];
      if (stage === 'nudged' || stage === 'matched' || stage === 'dropped') {
        skipReasons['already-warmed'] = (skipReasons['already-warmed'] || 0) + 1;
        return false;
      }
      const sentAt = b['Warmup Sent At'];
      if (!sentAt) return false;
      const days = (now - new Date(sentAt).getTime()) / DAY_MS;
      return days >= 7;
    });

    for (const buyer of nudgeCandidates) {
      if (nudgesSent >= NUDGE_CAP_PER_RUN) break;
      if (warmupsSent + nudgesSent >= MAX_PER_RUN) {
        console.log(`[rancher-launch-warmup] hit MAX_PER_RUN=${MAX_PER_RUN} (combined), stopping phase 2`);
        break;
      }
      try {
        const email = (buyer['Email'] || '').trim();
        if (!email) continue;
        const first = String(buyer['Full Name'] || '').split(' ')[0] || '';
        const buyerState = normalizeState(buyer['State']);

        // Find a live rancher serving this state to personalize the nudge
        // (local-only — Ships Nationwide is no longer honored for routing).
        const activeRancher = ranchers.find((r: any) => {
          // Same canonical source as Phase 1 + matching/suggest. Reading raw
          // States Served here let newly-live ranchers fall through and
          // nudges showed "our new rancher" instead of the actual ranch name.
          const states = new Set(getOperationalServedStates(r));
          return states.has(buyerState);
        }) || null;
        const ranchName = activeRancher?.['Ranch Name']
          || activeRancher?.['Operator Name']
          || 'our new rancher';

        const engageUrl = buildEngageUrl(buyer.id);
        await sendRancherLaunchWarmupNudge({ email, firstName: first, ranchName, engageUrl });
        await updateRecord(TABLES.CONSUMERS, buyer.id, { 'Warmup Stage': 'nudged' });
        nudgesSent++;
      } catch (e: any) {
        console.error(`Warmup nudge error for buyer ${buyer.id}:`, e.message);
      }
    }

    // ── Summary telegram ────────────────────────────────────────────────────
    if (warmupsSent > 0 || nudgesSent > 0 || ranchersProcessed.length > 0) {
      const lines = [
        `🔥 <b>Rancher Launch Warmup</b>`,
        warmupsSent > 0 ? `📨 ${warmupsSent} warmup emails sent` : '',
        nudgesSent > 0 ? `👉 ${nudgesSent} Day-7 nudges sent` : '',
        throttledRanchers.length > 0
          ? `⏱️ Throttled: ${throttledRanchers.map(t => `${t.name} ${t.sent}/${t.cap}`).join(', ')}`
          : '',
        trustDrainRanchers.length > 0
          ? `🎓 Trust drain: ${trustDrainRanchers.join(', ')}`
          : '',
        `<i>Engaged buyers will get matched first in the next batch-approve run.</i>`,
      ].filter(Boolean).join('\n');
      await sendTelegramUpdate(lines);
    }

  return {
    status: warmupsSkipped > 0 ? 'partial' : 'success',
    recordsTouched: warmupsSent + nudgesSent,
    notes: `warmups=${warmupsSent} nudges=${nudgesSent} ranchers=${ranchersProcessed.length} skipped=${warmupsSkipped}`,
    skipReasonBreakdown: Object.keys(skipReasons).length ? skipReasons : undefined,
  };
  }
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('rancher-launch-warmup', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
