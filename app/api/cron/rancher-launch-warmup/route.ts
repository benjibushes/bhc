import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendTelegramUpdate } from '@/lib/telegram';
import { sendRancherLaunchWarmup, sendRancherLaunchWarmupNudge } from '@/lib/email';
import { normalizeState, normalizeStates } from '@/lib/states';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

// Global per-run caps — protects sender reputation during mass re-engagement.
// 100/day warmups × 7 days clears a ~700-waitlist backlog without burst-flagging.
const WARMUP_CAP_PER_RUN = 100;
const NUDGE_CAP_PER_RUN = 50;

function buildEngageUrl(consumerId: string): string {
  const token = jwt.sign({ type: 'warmup-engage', consumerId }, JWT_SECRET, { expiresIn: '30d' });
  return `${SITE_URL}/api/warmup/engage?token=${token}`;
}

// Runs daily at 8am MT (14:00 UTC).
// Two phases:
//   Phase 1 — for each rancher that just went live (Page Live=true, Launch Warmup Triggered=false),
//     find Waitlisted buyers in their States Served and send the warmup email.
//   Phase 2 — nudge any buyer whose Warmup Sent At is 7+ days old and who hasn't engaged or matched.
async function handler(request: Request) {
  try {
    if (isMaintenanceMode()) return maintenanceResponse('rancher-launch-warmup');

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

    // ── PHASE 1: Initial warmup to newly-live ranchers' waitlisted buyers ──
    const ranchers = await getAllRecords(
      TABLES.RANCHERS,
      'AND({Page Live} = TRUE(), NOT({Launch Warmup Triggered}))'
    ) as any[];

    const waitlistedBuyers = await getAllRecords(
      TABLES.CONSUMERS,
      '{Referral Status} = "Waitlisted"'
    ) as any[];

    let warmupsSent = 0;
    let warmupsSkipped = 0;
    const ranchersProcessed: string[] = [];

    outer: for (const rancher of ranchers) {
      if (warmupsSent >= WARMUP_CAP_PER_RUN) break;

      const rancherStates = new Set(
        normalizeStates(rancher['States Served'] || rancher['State'] || '')
      );
      const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'A verified ranch';

      // Eligible buyers: Waitlisted, not unsubscribed/bounced, IN-STATE only,
      // and no warmup already sent for this round.
      // Ships Nationwide path removed — every rancher routes only to their
      // declared States Served (local-only routing policy).
      const eligible = waitlistedBuyers.filter((b: any) => {
        if (b['Unsubscribed'] || b['Bounced']) return false;
        if (b['Warmup Sent At']) return false;
        const buyerState = normalizeState(b['State']);
        if (!buyerState) return false;
        return rancherStates.has(buyerState);
      });

      for (const buyer of eligible) {
        if (warmupsSent >= WARMUP_CAP_PER_RUN) break outer;
        try {
          const email = (buyer['Email'] || '').trim();
          if (!email) { warmupsSkipped++; continue; }
          const first = String(buyer['Full Name'] || '').split(' ')[0] || '';
          const engageUrl = buildEngageUrl(buyer.id);

          await sendRancherLaunchWarmup({
            email,
            firstName: first,
            ranchName,
            buyerState: normalizeState(buyer['State']),
            engageUrl,
          });

          await updateRecord(TABLES.CONSUMERS, buyer.id, {
            'Warmup Sent At': new Date().toISOString(),
            'Warmup Stage': 'sent',
          });

          warmupsSent++;
        } catch (e: any) {
          console.error(`Warmup error for buyer ${buyer.id}:`, e.message);
          warmupsSkipped++;
        }
      }

      // Mark rancher as processed even if we didn't hit every buyer — the
      // remaining buyers will be picked up by the nurture drip. Re-firing
      // on this rancher would duplicate-warm the already-warmed ones.
      try {
        await updateRecord(TABLES.RANCHERS, rancher.id, {
          'Launch Warmup Triggered': true,
        });
        ranchersProcessed.push(ranchName);
      } catch (e) {
        console.error('Error marking rancher warmup-triggered:', e);
      }
    }

    // ── PHASE 2: Day 7 nudge to anyone who didn't engage or match ───────────
    let nudgesSent = 0;
    const now = Date.now();
    const nudgeCandidates = waitlistedBuyers.filter((b: any) => {
      if (b['Unsubscribed'] || b['Bounced']) return false;
      if (b['Warmup Engaged At']) return false;
      const stage = b['Warmup Stage']?.name || b['Warmup Stage'];
      if (stage === 'nudged' || stage === 'matched' || stage === 'dropped') return false;
      const sentAt = b['Warmup Sent At'];
      if (!sentAt) return false;
      const days = (now - new Date(sentAt).getTime()) / DAY_MS;
      return days >= 7;
    });

    for (const buyer of nudgeCandidates) {
      if (nudgesSent >= NUDGE_CAP_PER_RUN) break;
      try {
        const email = (buyer['Email'] || '').trim();
        if (!email) continue;
        const first = String(buyer['Full Name'] || '').split(' ')[0] || '';
        const buyerState = normalizeState(buyer['State']);

        // Find a live rancher serving this state to personalize the nudge
        // (local-only — Ships Nationwide is no longer honored for routing).
        const activeRancher = ranchers.find((r: any) => {
          const states = new Set(normalizeStates(r['States Served'] || r['State'] || ''));
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
        ranchersProcessed.length > 0 ? `🤠 Triggered for: ${ranchersProcessed.join(', ')}` : '',
        `<i>Engaged buyers will get matched first in the next batch-approve run.</i>`,
      ].filter(Boolean).join('\n');
      await sendTelegramUpdate(lines);
    }

    return NextResponse.json({
      success: true,
      warmupsSent,
      warmupsSkipped,
      nudgesSent,
      ranchersProcessed: ranchersProcessed.length,
    });
  } catch (error: any) {
    console.error('Rancher-launch-warmup cron error:', error);
    await sendTelegramUpdate(`⚠️ Rancher launch warmup cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
