// app/api/cron/rancher-reactivation/route.ts
//
// RANCHER REACTIVATION — daily, staggered "book a v2 call or remove yourself"
// campaign for ~44 dormant legacy ranchers (not live / not getting leads).
//
// Runs 10:00 MT on weekdays (16:00 UTC, see vercel.json). Each tick:
//   1. HARD GATE: no-op + early return unless RANCHER_REACTIVATION_ENABLED ===
//      'true' AND today >= CAMPAIGN_START_DATE. The campaign ships inert; Ben
//      arms it by flipping the flag. Until then this writes nothing + sends
//      nothing (just a 'success' Cron Runs row noting the no-op).
//   2. segmentRanchers(allRanchers, now) → tierAToSend / tierBToSend /
//      reminders / toMarkDormant (audience + cadence live in lib/, not here).
//   3. Send to at most 8 UNTOUCHED ranchers per tick, Tier A first then B.
//      Each send → stamp Last Campaign Email Sent At + Campaign Tier +
//      increment Campaign Touch Count, and log an audit entry.
//   4. +5d-no-booking ranchers get ONE reminder (Touch Count → 2). Reminders
//      are NOT counted against the 8/day first-touch cap.
//   5. +10d-silent (>=2 touches, no booking) → mark dormant:
//      Claim Status = removed-on-request. Stop.
//   6. Telegram operator digest.
//
// "Remove me" in the email = the EXISTING one-click unsubscribe flow, which
// sets Unsubscribed=true; the send layer + segmentation both suppress those,
// so a removed rancher drops out on the next tick automatically.
//
// Mirrors app/api/cron/migration-deadline/route.ts (auth, withCronRun,
// sequential per-record try/catch, Telegram digest, GET+POST, maxDuration).

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import {
  sendRancherReactivationWarm,
  sendRancherReactivationCold,
} from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { logAuditEntry } from '@/lib/auditLog';
import { type ReactivationRancher } from '@/lib/rancherReactivationSegment';
import { runReactivationSend } from '@/lib/rancherReactivation';

export const maxDuration = 180;

// Max FIRST-TOUCH sends per daily tick (sanity pace). Reminders + dormant
// marking are not subject to this cap.
const DAILY_SEND_CAP = 8;

// STATUS GUARD (P1 2026-06-23). The segmentation (lib/rancherReactivationSegment)
// reads Active Status ONLY for tier assignment — it never excludes Paused /
// Non-Compliant / Removed ranchers, so a paused legacy rancher (not in the
// hardcoded EXCLUDE_RANCHER_IDS allowlist) can still receive a reminder. The
// ReactivationRancher objects the segment returns DON'T carry Active Status, so
// we re-read it from Airtable here (one fetch) and skip those ids on the
// route-reachable send path (reminders). Mirrors the
// ['Paused','Non-Compliant'] guard used in rancher-followup/onboarding-drip,
// plus 'Removed' per this fix's spec.
const BLOCKED_ACTIVE_STATUSES = new Set(['Paused', 'Non-Compliant', 'Removed']);

function readActiveStatus(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '').trim();
  }
  return String(v).trim();
}

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

/**
 * Campaign armed? Requires the explicit enable flag AND today on/after the
 * configured start date. Returns a reason string when NOT armed (for the
 * Cron Runs note), or null when armed.
 */
function notArmedReason(now: Date): string | null {
  if (process.env.RANCHER_REACTIVATION_ENABLED !== 'true') {
    return 'flag off (RANCHER_REACTIVATION_ENABLED !== "true")';
  }
  const startRaw = process.env.CAMPAIGN_START_DATE;
  if (!startRaw) {
    return 'CAMPAIGN_START_DATE unset';
  }
  const startMs = new Date(startRaw).getTime();
  if (!Number.isFinite(startMs)) {
    return `CAMPAIGN_START_DATE invalid ("${startRaw}")`;
  }
  if (now.getTime() < startMs) {
    return `before CAMPAIGN_START_DATE (${startRaw})`;
  }
  return null;
}

/** Send one campaign email by tier. Returns the guardedSend-style result. */
async function sendByTier(
  r: ReactivationRancher,
): Promise<{ success: boolean; suppressed?: boolean; reason?: string }> {
  if (r.tier === 'A') {
    return sendRancherReactivationWarm({
      firstName: r.firstName,
      ranchName: r.ranchName,
      state: r.state,
      email: r.email,
    });
  }
  return sendRancherReactivationCold({
    firstName: r.firstName,
    ranchName: r.ranchName,
    email: r.email,
  });
}

async function realHandler(_request: Request): Promise<CronResult> {
  const now = new Date();

  // ── HARD GATE — campaign ships inert ────────────────────────────────
  const blocked = notArmedReason(now);
  if (blocked) {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `no-op: ${blocked}`,
    };
  }

  // ── FIRST TOUCHES (capped at DAILY_SEND_CAP, Tier A first) ──────────
  // Shared with the operator's one-click send-now button. This does the
  // getAllRecords → segment → send → stamp → audit work; we reuse the
  // returned segment for the reminder + dormant passes below (no re-fetch).
  const run = await runReactivationSend({
    now,
    dryRun: false,
    cap: DAILY_SEND_CAP,
    actor: 'cron',
    tool: 'rancher-reactivation',
  });
  const seg = run.segment;
  const firstTouchQueue = run.firstTouchQueue;

  let sent = run.sent;
  let remindersSent = 0;
  let dormantMarked = 0;
  const failures: string[] = [...run.failures];

  // STATUS GUARD (P1): build the set of rancher ids whose Active Status is
  // Paused / Non-Compliant / Removed so we can skip reminder sends to them.
  // (Non-fatal if the fetch fails — we fall back to the prior behavior rather
  // than block the whole reminder pass.)
  const blockedRancherIds = new Set<string>();
  try {
    const allRanchersForGuard = (await getAllRecords(TABLES.RANCHERS)) as any[];
    for (const r of allRanchersForGuard) {
      if (BLOCKED_ACTIVE_STATUSES.has(readActiveStatus(r['Active Status']))) {
        blockedRancherIds.add(r.id);
      }
    }
  } catch (e: any) {
    console.warn('[rancher-reactivation] status-guard rancher fetch failed (non-fatal):', e?.message);
  }
  let remindersBlockedByStatus = 0;

  // Stamp Airtable after a successful (non-suppressed) send. nextTouchCount is
  // the value to write (reminder → 2). Used by the reminder pass below; the
  // first-touch stamping happens inside runReactivationSend.
  async function stampSend(r: ReactivationRancher, nextTouchCount: number): Promise<void> {
    const prevTouch = r.touchCount;
    await updateRecord(TABLES.RANCHERS, r.id, {
      'Last Campaign Email Sent At': now.toISOString(),
      'Campaign Tier': r.tier,
      'Campaign Touch Count': nextTouchCount,
    });
    await logAuditEntry({
      actor: 'cron',
      tool: 'rancher-reactivation',
      targetType: 'Rancher',
      targetId: r.id,
      args: { tier: r.tier, email: r.email, touch: nextTouchCount, kind: nextTouchCount >= 2 ? 'reminder' : 'first' },
      result: { sent: true },
      reverseAction: {
        type: 'airtable-update',
        table: TABLES.RANCHERS,
        recordId: r.id,
        // Restore prior campaign state. Email itself is un-sendable (noop is
        // covered by the stamp revert — operator can re-send manually if needed).
        fields: {
          'Campaign Touch Count': prevTouch || null,
        },
      },
    });
  }

  // ── REMINDERS (+5d, no booking; bumps Touch Count → 2) ──────────────
  for (const r of seg.reminders) {
    try {
      // STATUS GUARD (P1): never re-email a Paused / Non-Compliant / Removed
      // rancher. The segment doesn't filter these (it reads Active Status only
      // for tier assignment), so enforce it here on the route-reachable path.
      if (blockedRancherIds.has(r.id)) {
        remindersBlockedByStatus++;
        continue;
      }
      const res = await sendByTier(r);
      if (res?.suppressed) {
        failures.push(`${r.ranchName}: reminder suppressed — ${res.reason || 'unknown'}`);
        continue;
      }
      if (!res?.success) {
        failures.push(`${r.ranchName}: reminder not confirmed`);
        continue;
      }
      // Reminder is the 2nd touch regardless of prior count math.
      await stampSend(r, Math.max((r.touchCount || 0) + 1, 2));
      remindersSent++;
    } catch (e: any) {
      failures.push(`${r.ranchName}: reminder failed — ${e?.message || 'unknown'}`);
    }
  }

  // ── DORMANT (+10d silent, >=2 touches) → close listing ──────────────
  for (const d of seg.toMarkDormant) {
    try {
      await updateRecord(TABLES.RANCHERS, d.id, {
        'Claim Status': 'removed-on-request',
      });
      await logAuditEntry({
        actor: 'cron',
        tool: 'rancher-reactivation',
        targetType: 'Rancher',
        targetId: d.id,
        args: { tier: d.tier, email: d.email, kind: 'mark-dormant' },
        result: { claimStatus: 'removed-on-request' },
        reverseAction: {
          type: 'airtable-update',
          table: TABLES.RANCHERS,
          recordId: d.id,
          fields: { 'Claim Status': null },
        },
      });
      dormantMarked++;
    } catch (e: any) {
      failures.push(`${d.ranchName}: dormant-mark failed — ${e?.message || 'unknown'}`);
    }
  }

  // ── Operator digest ─────────────────────────────────────────────────
  if (sent > 0 || remindersSent > 0 || dormantMarked > 0 || failures.length > 0) {
    try {
      const lines: string[] = [
        '🐄 <b>RANCHER REACTIVATION DAILY</b>',
        '',
        `First touches sent: ${sent} (cap ${DAILY_SEND_CAP})`,
        `Reminders sent: ${remindersSent}${remindersBlockedByStatus > 0 ? ` (${remindersBlockedByStatus} skipped: paused/non-compliant/removed)` : ''}`,
        `Marked dormant: ${dormantMarked}`,
        '',
        `Eligible — Tier A: ${seg.counts.tierAEligible} · Tier B: ${seg.counts.tierBEligible}`,
        `Queued first-touch this tick: ${firstTouchQueue.length}`,
      ];
      if (failures.length > 0) {
        lines.push('', '<b>Failures:</b>', ...failures.slice(0, 8).map((f) => `• ${f}`));
      }
      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'));
    } catch {}
  }

  const status: CronResult['status'] = failures.length > 0 ? 'partial' : 'success';
  return {
    status,
    recordsTouched: sent + remindersSent + dormantMarked,
    notes: `sent=${sent} reminders=${remindersSent} dormant=${dormantMarked} statusBlocked=${remindersBlockedByStatus} failures=${failures.length} (Aelig=${seg.counts.tierAEligible} Belig=${seg.counts.tierBEligible})`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('rancher-reactivation', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
