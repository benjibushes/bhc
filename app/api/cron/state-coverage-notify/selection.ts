// app/api/cron/state-coverage-notify/selection.ts
//
// Pure selection logic for the state-coverage-notify cron (Wave 2
// buyer-comms, 2026-08-01). Dependency-light so it unit-tests without
// Airtable: the cron does the reads, computes the operational covered-state
// set (lib/rancherEligibility), and hands the rows here.
//
// A waitlist row is a Consumers record created by /api/waitlist
// (Source='relaunch_waitlist') — the "no rancher in your state yet, we'll
// email you when there is" capture. This helper answers: which of those
// buyers should get their ONE "your area opened" email this run?

import { normalizeState } from '@/lib/states';

export interface WaitlistRowLike {
  id: string;
  Email?: unknown;
  'Full Name'?: unknown;
  State?: unknown;
  Notes?: unknown;
  Unsubscribed?: unknown;
  Bounced?: unknown;
  Complained?: unknown;
}

/**
 * Durable once-ever marker (audit-D fix, 2026-08-02). The cron appends this
 * into the consumer row's Notes after a send (or a send-layer suppression), and
 * selection skips any row carrying it. This is the repo's hard-rule-2 anchor —
 * send truth persisted on the record — and it fixes BOTH audit findings at
 * once: (a) cap starvation — notified rows leave the eligible pool, so the
 * per-run cap walks the tail instead of re-selecting the same first 50 forever;
 * (b) the Redis claimOnce belt degrades OPEN and expires at 365d — the Notes
 * stamp neither errors nor expires.
 */
export const AREA_OPENED_MARKER = '[AREA-OPENED';

export interface StateCoverageTarget {
  consumerId: string;
  email: string;
  firstName: string;
  /** Normalized 2-letter code — also what the email displays. */
  state: string;
}

export const DEFAULT_NOTIFY_CAP = 50;

/**
 * Select waitlist buyers whose captured state is now operationally covered.
 *
 * Rules:
 *   - must have a deliverable email and a normalizable State;
 *   - state must be in `coveredStates` (2-letter codes);
 *   - Unsubscribed / Bounced / Complained rows are excluded (the send-side
 *     suppression list is the belt; this keeps them out of the claim loop
 *     entirely so a suppressed buyer never burns a Redis claim);
 *   - rows already stamped with AREA_OPENED_MARKER in Notes are excluded
 *     (the durable once-ever anchor — see the marker's doc block);
 *   - capped at `cap` per run (default 50) — because notified rows leave the
 *     pool via the Notes stamp, the cap now genuinely walks the tail.
 *
 * The cron's Redis claimOnce remains as a same-run/racing-runs belt; the
 * Notes stamp is the durable anchor. This function stays deterministic and
 * side-effect free.
 */
export function selectStateCoverageTargets(
  rows: WaitlistRowLike[],
  coveredStates: ReadonlySet<string>,
  cap: number = DEFAULT_NOTIFY_CAP,
): StateCoverageTarget[] {
  const out: StateCoverageTarget[] = [];
  for (const row of rows || []) {
    if (out.length >= cap) break;
    if (!row || !row.id) continue;
    if (row.Unsubscribed || row.Bounced || row.Complained) continue;
    // Already notified (durable Notes stamp) — out of the pool forever, so
    // buyers past the cap are reached on subsequent runs.
    if (String(row.Notes || '').includes(AREA_OPENED_MARKER)) continue;

    const email = String(row.Email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;

    const state = normalizeState(row.State);
    if (!state || !coveredStates.has(state)) continue;

    // '(waitlist signup)' is the placeholder name the capture writes when
    // the form had no name — never greet a buyer with it.
    const fullName = String(row['Full Name'] || '')
      .replace('(waitlist signup)', '')
      .trim();
    const firstName = fullName.split(/\s+/)[0] || '';

    out.push({ consumerId: row.id, email, firstName, state });
  }
  return out;
}
