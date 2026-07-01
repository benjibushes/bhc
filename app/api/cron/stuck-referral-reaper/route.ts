// app/api/cron/stuck-referral-reaper/route.ts
//
// STUCK-REFERRAL REAPER — unblocks referrals waiting on a rancher who never
// responded, and normalizes legacy status values.
//
// THE LEAK:
//   Direct rancher-page order requests (/api/orders/request) create a Referral
//   with Status='Pending' + Approval Status='Pending Rancher Response'. The
//   rancher is supposed to accept/decline from their dashboard. If they ghost,
//   the referral rots: the buyer is waiting, no one is matched, and the lead
//   silently dies. There's no backstop today.
//
// THE REAPER (daily):
//   1. NORMALIZE: any Referral with Status='Pending' (a legacy/non-canonical
//      value) is rewritten to the canonical 'Pending Approval' so the rest of
//      the funnel + admin views treat it consistently. Pure bookkeeping.
//
//   2. REAP STUCK: Referrals with Approval Status='Pending Rancher Response'
//      older than STUCK_DAYS get closed-lost + the buyer is sent a soft
//      "we're searching for another rancher" note (sendRerouteNotification's
//      no-new-match branch — never framed as rejection). A Telegram card is
//      fired so the operator can hand-reassign to another in-state rancher.
//
// WHY NOT AUTO-REASSIGN HERE:
//   Auto-picking "another in-state rancher" is exactly the misroute class that
//   burned us on 2026-05-06 (109 stale pushes, TX→OK misroutes). Rancher
//   selection depends on capacity, tier, Connect-readiness, and per-rancher
//   routing flags that this cron has no business re-deriving blind. So the
//   reaper does the SAFE half (stop the rot + tell the buyer + alert ops) and
//   leaves reassignment to the operator (one-tap from the Telegram card / desk).
//   The buyer email deliberately uses the "we're searching" branch so we never
//   promise a rancher we haven't actually picked.
//
// IDEMPOTENCY:
//   Closing a referral flips it out of 'Pending Rancher Response', so the next
//   run won't re-select it. Normalization is naturally idempotent (a row that's
//   already 'Pending Approval' isn't matched by the {Status}="Pending" query).

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';
import { sendRerouteNotification } from '@/lib/email';

export const maxDuration = 60;

const DAY_MS = 86_400_000;

// A referral pending the rancher's response longer than this is considered
// abandoned-by-rancher and gets reaped.
export const STUCK_DAYS = Number(process.env.STUCK_REFERRAL_STUCK_DAYS || 5);
// Per-run cap so a backlog never blows past maxDuration.
const MAX_PER_RUN = Number(process.env.STUCK_REFERRAL_MAX_PER_RUN || 25);
const NORMALIZE_PER_RUN = Number(process.env.STUCK_REFERRAL_NORMALIZE_PER_RUN || 50);

// The non-canonical status emitted by /api/orders/request that we normalize.
export const LEGACY_PENDING_STATUS = 'Pending';
export const CANONICAL_PENDING_STATUS = 'Pending Approval';
// The approval-status marker for "rancher hasn't responded yet".
export const PENDING_RANCHER_APPROVAL = 'Pending Rancher Response';

function toMs(v: unknown): number {
  if (!v) return 0;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

export interface StuckReferralLike {
  'Approval Status'?: unknown;
  Status?: unknown;
  'Created At'?: unknown;
  _createdTime?: unknown;
}

export interface StuckOptions {
  now?: number;
  stuckDays?: number;
}

/** Age of the referral in ms, preferring Created At, falling back to _createdTime. */
export function referralAgeMs(ref: StuckReferralLike, now: number = Date.now()): number {
  const created = toMs(ref['Created At']) || toMs(ref._createdTime);
  if (!created) return -1;
  return now - created;
}

/**
 * Pure predicate — is this referral a stuck "pending rancher response" that
 * should be reaped? Side-effect-free for unit testing.
 */
export function isStuckPendingRancher(ref: StuckReferralLike, opts: StuckOptions = {}): boolean {
  const now = opts.now ?? Date.now();
  const stuckDays = opts.stuckDays ?? STUCK_DAYS;

  if (String(ref['Approval Status'] || '') !== PENDING_RANCHER_APPROVAL) return false;

  // Never reap something already closed.
  const status = String(ref.Status || '');
  if (status === 'Closed Won' || status === 'Closed Lost' || status === 'Refunded') return false;

  const age = referralAgeMs(ref, now);
  if (age < 0) return false; // unknown age — don't reap blindly
  return age > stuckDays * DAY_MS;
}

export function selectStuckPendingRancher<T extends StuckReferralLike>(
  refs: T[],
  opts: StuckOptions = {},
): T[] {
  return refs.filter((r) => isStuckPendingRancher(r, opts));
}

/** Pure predicate — does this referral's Status need canonicalizing? */
export function needsStatusNormalize(ref: StuckReferralLike): boolean {
  return String(ref.Status || '') === LEGACY_PENDING_STATUS;
}

interface ReaperResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown: Record<string, number>;
}

async function realHandler(_request: Request): Promise<ReaperResult> {
  if (isMaintenanceMode()) {
    return {
      status: 'maintenance-blocked',
      recordsTouched: 0,
      notes: 'MAINTENANCE_MODE=true',
      skipReasonBreakdown: {},
    };
  }

  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
  const now = Date.now();
  const breakdown: Record<string, number> = {};
  const bump = (k: string) => {
    breakdown[k] = (breakdown[k] || 0) + 1;
  };
  const errors: string[] = [];
  let touched = 0;

  // ── STEP 1: normalize legacy Status='Pending' → 'Pending Approval' ──────────
  // Bounded per-run so a one-time backfill of legacy rows can't blow the budget;
  // remaining rows drain on subsequent runs.
  try {
    const legacy = (await getAllRecords(
      TABLES.REFERRALS,
      `{Status} = "${LEGACY_PENDING_STATUS}"`,
    )) as any[];
    for (const ref of legacy.slice(0, NORMALIZE_PER_RUN)) {
      try {
        await updateRecord(TABLES.REFERRALS, ref.id, { Status: CANONICAL_PENDING_STATUS });
        touched++;
        bump('status_normalized');
      } catch (e: any) {
        bump('normalize_failed');
        errors.push(`${ref.id}: normalize (${e?.message?.slice(0, 60)})`);
      }
    }
  } catch (e: any) {
    bump('normalize_query_failed');
    errors.push(`normalize query: ${e?.message?.slice(0, 80)}`);
  }

  // ── STEP 2: reap stuck 'Pending Rancher Response' referrals ────────────────
  let pending: any[] = [];
  try {
    pending = (await getAllRecords(
      TABLES.REFERRALS,
      `{Approval Status} = "${PENDING_RANCHER_APPROVAL}"`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: touched,
      notes: `pending query failed: ${e?.message?.slice(0, 160) || 'unknown'}`,
      skipReasonBreakdown: breakdown,
    };
  }

  const stuck = selectStuckPendingRancher(pending, { now });
  const targets = stuck.slice(0, MAX_PER_RUN);

  for (const ref of targets) {
    const referralId = ref.id as string;
    const ageDays = Math.floor(referralAgeMs(ref, now) / DAY_MS);
    const buyerName = String(ref['Buyer Name'] || '').trim() || 'a buyer';
    const buyerState = String(ref['Buyer State'] || ref['State'] || '').trim();

    const rancherIds: string[] = (ref['Rancher'] || ref['Suggested Rancher'] || []) as string[];
    const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
    let rancher: any = null;
    if (rancherId) {
      rancher = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
    }
    const rancherName = String(
      rancher?.['Operator Name'] || rancher?.['Ranch Name'] || 'the rancher',
    ).trim();

    // Close the deal out so it stops rotting + won't be re-selected next run.
    // Stamp a reason so the admin desk shows WHY it closed.
    try {
      await updateRecord(TABLES.REFERRALS, referralId, {
        Status: 'Closed Lost',
        'Approval Status': 'rancher-no-response',
        'Closed At': new Date().toISOString(),
        Notes:
          (ref['Notes'] ? `${String(ref['Notes'])}\n\n` : '') +
          `[stuck-referral-reaper] Rancher ${rancherName} did not respond within ${STUCK_DAYS}d — auto-closed for operator reassignment.`,
      });
    } catch (e: any) {
      bump('close_write_failed');
      errors.push(`${referralId}: close (${e?.message?.slice(0, 60)})`);
      continue;
    }
    touched++;
    bump('reaped');

    // Soft buyer heads-up — "we're searching" branch (no new rancher promised).
    const buyerEmail = String(ref['Buyer Email'] || '').trim();
    if (buyerEmail) {
      const firstName = buyerName.split(' ')[0] || 'there';
      try {
        await sendRerouteNotification({
          firstName,
          email: buyerEmail,
          state: buyerState || 'your state',
          // No newRancherName → uses the "we're working on your match" copy.
          loginUrl: `${SITE_URL}/member`,
        });
        bump('buyer_notified');
      } catch (e: any) {
        // Non-fatal — the deal is already closed + operator gets the Telegram card.
        console.warn(
          `[stuck-referral-reaper] buyer notify failed for ${referralId}: ${e?.message?.slice(0, 80)}`,
        );
      }
    } else {
      bump('buyer_email_missing');
    }

    // Operator card — one-tap reassignment lives in the admin desk; we hand the
    // operator the context to pick the right in-state rancher safely.
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⏳ <b>Stuck referral reaped (${ageDays}d no response)</b>\n\n` +
            `${buyerName}${buyerState ? ` · ${buyerState}` : ''} → ${rancherName}\n` +
            `Rancher never accepted the direct order. Auto-closed Lost; buyer told we're searching.\n\n` +
            `Reassign to another ${buyerState || 'in-state'} rancher from the desk:\n` +
            `${SITE_URL}/admin/desk/${referralId}`,
        );
      }
    } catch {}
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: touched,
    notes:
      `stuck=${stuck.length} reaped=${targets.length} touched=${touched} ` +
      `errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
    skipReasonBreakdown: breakdown,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('stuck-referral-reaper', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
