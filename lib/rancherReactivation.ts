// lib/rancherReactivation.ts
//
// Shared core for the Rancher Reactivation Campaign FIRST-TOUCH send.
//
// One responsibility: pull all ranchers → segment → send the warm/cold
// first-touch emails (Tier A first), capped at `cap`, with the EXACT
// suppression / dedupe / stamp / audit behavior the daily cron relies on.
//
// Two callers share this:
//   1. app/api/cron/rancher-reactivation — the scheduled driver. Passes the
//      8/run cap, keeps its own flag/date gate + reminder + dormant logic.
//      It reuses the SegmentResult this function returns so it doesn't
//      re-fetch / re-segment.
//   2. app/api/admin/rancher-reactivation/send-now — the one-click operator
//      button. Passes a large cap (send all eligible first-touches), runs
//      ungated (the authenticated admin click IS the authorization), and
//      uses actor 'manual' for the audit trail.
//
// dryRun=true does NOT send, stamp, or log anything — it only segments and
// reports who WOULD be sent (used by the admin "Preview" button + any test).

import { getAllRecords, createRecord, updateRecord, TABLES } from '@/lib/airtable';
import {
  sendRancherReactivationWarm,
  sendRancherReactivationCold,
} from '@/lib/email';
import { logAuditEntry, type AuditActor } from '@/lib/auditLog';
import {
  segmentRanchers,
  type ReactivationRancher,
  type SegmentResult,
} from '@/lib/rancherReactivationSegment';

export interface RunReactivationSendOptions {
  /** Reference time. Injectable for deterministic preview/tests. */
  now?: Date;
  /** When true: segment + report only. No send, no Airtable write, no audit. */
  dryRun?: boolean;
  /** Max FIRST-TOUCH sends this run (Tier A first, then Tier B). */
  cap: number;
  /**
   * Audit-log actor for each stamped send. 'cron' for the scheduled driver,
   * 'manual' for the operator button. Defaults to 'cron'.
   */
  actor?: AuditActor;
  /** Audit-log tool tag. Defaults to 'rancher-reactivation'. */
  tool?: string;
}

export interface RunReactivationSendResult {
  /** First-touch emails actually sent (non-suppressed, confirmed). 0 in dryRun. */
  sent: number;
  /** Queued-but-not-sent this run: suppressed sends + send failures. 0 in dryRun. */
  skipped: number;
  /** How many Tier A first-touches were queued this run (≤ cap share). */
  tierACounted: number;
  /** How many Tier B first-touches were queued this run. */
  tierBCounted: number;
  /** Ranch names in the first-touch queue (what was / would be contacted). */
  names: string[];
  /** Per-rancher failure/suppression reasons (empty in dryRun). */
  failures: string[];
  /** Echoes the dryRun flag so callers can branch on it. */
  dryRun: boolean;
  /**
   * The SegmentResult used this run — so the cron can run its reminder +
   * dormant passes against the SAME segmentation without re-fetching.
   */
  segment: SegmentResult;
  /** The first-touch queue (Tier A first), sliced to `cap`. */
  firstTouchQueue: ReactivationRancher[];
}

/** Send one campaign email by tier. Mirrors the cron's original sendByTier.
 *  `campaign` (when set) is threaded to Email Sends.Campaign so the console
 *  can attribute engagement back to the reactivation Campaigns row. */
async function sendByTier(
  r: ReactivationRancher,
  campaign?: string,
): Promise<{ success: boolean; suppressed?: boolean; reason?: string }> {
  if (r.tier === 'A') {
    return sendRancherReactivationWarm({
      firstName: r.firstName,
      ranchName: r.ranchName,
      state: r.state,
      email: r.email,
      campaign,
    });
  }
  return sendRancherReactivationCold({
    firstName: r.firstName,
    ranchName: r.ranchName,
    email: r.email,
    campaign,
  });
}

/**
 * Run the FIRST-TOUCH reactivation send.
 *
 * Behavior is identical to the loop the cron previously had inline:
 *   - getAllRecords(RANCHERS) → segmentRanchers(now)
 *   - firstTouchQueue = [...tierAToSend, ...tierBToSend].slice(0, cap)
 *   - for each: send by tier; on suppressed/unconfirmed/throw → record a
 *     failure and skip the stamp; on success → stamp Airtable
 *     (Last Campaign Email Sent At + Campaign Tier + Campaign Touch Count++)
 *     and log an audit entry with the original cron's reverseAction shape.
 *
 * The cron keeps its OWN reminder + dormant passes (it reads `segment` off
 * the result). The admin button only first-touches, capped large.
 */
export async function runReactivationSend(
  opts: RunReactivationSendOptions,
): Promise<RunReactivationSendResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const cap = opts.cap;
  const actor: AuditActor = opts.actor ?? 'cron';
  const tool = opts.tool ?? 'rancher-reactivation';

  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const seg = segmentRanchers(ranchers, now);

  // First-touch queue: Tier A first, then Tier B, sliced to the cap.
  const firstTouchQueue: ReactivationRancher[] = [
    ...seg.tierAToSend,
    ...seg.tierBToSend,
  ].slice(0, cap);

  const tierACounted = firstTouchQueue.filter((r) => r.tier === 'A').length;
  const tierBCounted = firstTouchQueue.filter((r) => r.tier === 'B').length;
  const names = firstTouchQueue.map((r) => r.ranchName);

  // ── DRY RUN — report only, no side-effects ──────────────────────────
  if (dryRun) {
    return {
      sent: 0,
      skipped: 0,
      tierACounted,
      tierBCounted,
      names,
      failures: [],
      dryRun: true,
      segment: seg,
      firstTouchQueue,
    };
  }

  let sent = 0;
  const failures: string[] = [];

  // ── Campaigns lifecycle (REAL sends only) ───────────────────────────
  // Mirror the broadcast route (app/api/admin/broadcast/route.ts:171-264):
  // reserve a Campaigns row at Status='Sending' BEFORE the loop, finalize
  // it at the end. This is what surfaces the reactivation send in the
  // campaign console. The campaign NAME is threaded into each email send
  // (Email Sends.Campaign) so engagement ties back to this row.
  //
  // One row per send invocation (the daily cron at cap 8 writes one row per
  // tick — keeps it simple and the console shows each wave distinctly).
  // Reservation failure is non-fatal: we still send (the audit log + per-
  // rancher stamps remain the source of truth for what went out).
  const campaignName = `Rancher Reactivation ${now.toISOString().slice(0, 10)}`;
  let reservedCampaignId: string | null = null;
  try {
    const reserved: any = await createRecord(TABLES.CAMPAIGNS, {
      'Campaign Name': campaignName,
      'Audience': 'ranchers-reactivation',
      'Sent At': now.toISOString(),
      'Recipients': firstTouchQueue.length,
      'Status': 'Sending',
      'Sent': 0,
      'Failed': 0,
    });
    reservedCampaignId = reserved?.id || null;
  } catch (e: any) {
    console.warn('[reactivation] campaign reservation skipped:', e?.message);
  }

  // Stamp Airtable after a successful (non-suppressed) send. nextTouchCount is
  // the value to write (first touch → 1). Identical to the cron's stampSend.
  async function stampSend(r: ReactivationRancher, nextTouchCount: number): Promise<void> {
    const prevTouch = r.touchCount;
    await updateRecord(TABLES.RANCHERS, r.id, {
      'Last Campaign Email Sent At': now.toISOString(),
      'Campaign Tier': r.tier,
      'Campaign Touch Count': nextTouchCount,
    });
    await logAuditEntry({
      actor,
      tool,
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

  // ── FIRST TOUCHES (capped, Tier A first) ────────────────────────────
  for (const r of firstTouchQueue) {
    try {
      const res = await sendByTier(r, campaignName);
      if (res?.suppressed) {
        failures.push(`${r.ranchName}: send suppressed — ${res.reason || 'unknown'}`);
        continue;
      }
      if (!res?.success) {
        failures.push(`${r.ranchName}: send not confirmed`);
        continue;
      }
      await stampSend(r, (r.touchCount || 0) + 1);
      sent++;
    } catch (e: any) {
      failures.push(`${r.ranchName}: send failed — ${e?.message || 'unknown'}`);
    }
  }

  // ── Finalize the reserved Campaigns row ─────────────────────────────
  // Mirror the broadcast route: 'Partial' if any queued send failed/was
  // suppressed, else 'Sent'. failures.length == queued - sent.
  if (reservedCampaignId) {
    const failedCount = failures.length;
    const finalStatus = failedCount > 0 ? 'Partial' : 'Sent';
    try {
      await updateRecord(TABLES.CAMPAIGNS, reservedCampaignId, {
        'Status': finalStatus,
        'Sent': sent,
        'Failed': failedCount,
        'Sent At': now.toISOString(),
      });
    } catch (e: any) {
      console.warn('[reactivation] campaign finalize failed (non-fatal):', e?.message);
    }
  }

  return {
    sent,
    skipped: failures.length,
    tierACounted,
    tierBCounted,
    names,
    failures,
    dryRun: false,
    segment: seg,
    firstTouchQueue,
  };
}
