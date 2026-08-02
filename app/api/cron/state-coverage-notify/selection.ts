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
  Unsubscribed?: unknown;
  Bounced?: unknown;
  Complained?: unknown;
}

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
 *   - capped at `cap` per run (default 50) — the rest ride the next run.
 *
 * Per-buyer once-ever dedupe is NOT here: it is the cron's Redis claimOnce
 * (Consumers has no free field to stamp and new Airtable fields are not an
 * option). This function must stay deterministic and side-effect free.
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
