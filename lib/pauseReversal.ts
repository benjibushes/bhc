// lib/pauseReversal.ts
//
// THE ASYMMETRY THIS CLOSES (pause-asymmetry sweep 2026-07-25):
// four code paths write Active Status='Paused'; zero ever wrote it back. The
// machine pauses itself automatically and resumes itself never. A rancher who
// fixes the exact thing they were paused for stays dark forever.
//
// This is the ONE reversal that is safe to automate: the migration-deadline
// cron's own pause, once its own stated reason has demonstrably expired. The
// full provenance / single-use / scope-fence argument lives next to the pure
// predicate in lib/connectResync.ts — read that before touching this.
//
// Everything here is the impure half (Airtable read/write + audit log) kept
// OUT of connectResync.ts so that module stays zero-import and unit-testable.
// The decisions themselves are pure and tested in lib/connectResync.test.ts.
//
// Callers: app/api/cron/stripe-reconcile · app/api/webhooks/stripe-connect ·
// app/api/rancher/connect/status. All three previously fired a loud
// "UPGRADE COMPLETE — UNPAUSE …" card with a one-tap button; they now call
// this first and only fall back to the card when it declines. That keeps PR
// #488's button working for every case this cannot prove, while making sure a
// rancher auto-resumed here never ALSO gets a redundant "tap to unpause".

import { updateRecord, TABLES } from './airtable';
import { getMaxActiveReferrals } from './rancherCapacity';
import { logAuditEntry, buildAirtableUpdateReverse } from './auditLog';
import {
  shouldAutoResumePausedOverdue,
  buildPausedOverdueResumeFields,
} from './connectResync';

export interface AutoResumeResult {
  /** True only when Airtable was actually written. */
  resumed: boolean;
  /** The Active Status written. Null when nothing was written. */
  newStatus: 'Active' | 'At Capacity' | null;
  /** Why it declined / what it did — for the caller's operator message. */
  reason: string;
}

/** Unwrap an Airtable single-select that may arrive as {name} or a bare string. */
function sel(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in (v as any)) return String((v as any).name ?? '');
  return String(v ?? '');
}

/**
 * Reverse the migration-deadline cron's own pause when its reason has expired.
 *
 * IDEMPOTENT by construction: the write sets Migration Status='completed',
 * which consumes the provenance marker, so a second call (webhook retry, next
 * nightly run, dashboard poll) returns resumed=false. That single-use property
 * is also what guarantees this can never override a pause a HUMAN sets later.
 *
 * NEVER THROWS — a failure here must not roll back the caller's Connect status
 * write, and must not 500 a Stripe webhook. On failure it returns resumed=false
 * so the caller falls through to the one-tap operator card, which is exactly
 * the pre-2026-07-25 behaviour.
 *
 * Sends NO buyer or rancher email. The only side effects are one Airtable
 * field write and one audit-log row.
 *
 * @param connectIsActive LIVE Connect truth from Stripe, not the Airtable cache.
 */
export async function autoResumePausedOverdue(
  rancher: any,
  connectIsActive: boolean,
): Promise<AutoResumeResult> {
  const rancherId: string = rancher?.id;
  if (!rancherId) return { resumed: false, newStatus: null, reason: 'no rancher id' };

  const activeStatus = sel(rancher['Active Status']);
  const decision = shouldAutoResumePausedOverdue({
    connectIsActive,
    pricingModel: sel(rancher['Pricing Model']),
    migrationStatus: sel(rancher['Migration Status']),
    activeStatus,
  });

  if (!decision) {
    return {
      resumed: false,
      newStatus: null,
      reason: 'not a machine-set migration-deadline pause with an expired reason',
    };
  }

  const cap = getMaxActiveReferrals(rancher);
  const held = Number(rancher['Current Active Referrals']) || 0;
  const fields = buildPausedOverdueResumeFields({ heldReferrals: held, maxReferrals: cap });

  try {
    await updateRecord(TABLES.RANCHERS, rancherId, fields);
  } catch (e: any) {
    console.error('[pauseReversal] auto-resume write failed:', e?.message);
    return { resumed: false, newStatus: null, reason: `write failed: ${e?.message || 'unknown'}` };
  }

  // Real reverse action — this is a genuine Airtable flip, not the
  // reverseAction:{type:'noop'} the deauthorize path records. Restores BOTH
  // fields so undoing the resume also restores the provenance marker.
  await logAuditEntry({
    actor: 'cron',
    tool: 'auto-resume-paused-overdue',
    targetType: 'Rancher',
    targetId: rancherId,
    args: { connectIsActive, trigger: 'migration-deadline pause reason expired' },
    result: {
      previousActiveStatus: activeStatus,
      previousMigrationStatus: sel(rancher['Migration Status']),
      newStatus: fields['Active Status'],
      capacity: `${held}/${cap}`,
    },
    reverseAction: buildAirtableUpdateReverse(TABLES.RANCHERS, rancherId, {
      'Active Status': activeStatus || null,
      'Migration Status': sel(rancher['Migration Status']) || null,
    }),
  }).catch((e: any) =>
    console.error('[pauseReversal] audit log failed (non-fatal):', e?.message),
  );

  return {
    resumed: true,
    newStatus: fields['Active Status'],
    reason: `migration complete (tier_v2 + Connect live) — capacity ${held}/${cap}`,
  };
}
