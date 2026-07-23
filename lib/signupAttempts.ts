import { createRecord } from './airtable';

// Signup Attempts (tblDDpQaVPwIIuSXz) — the failed-submit beacon's trace trail
// (Justin incident 2026-07-23: a rancher failed in the pre-record-write window
// of /api/apply and NOTHING was written or alerted). Every door failure that
// writes no Ranchers row still leaves a queryable row here. Referenced by raw
// table id on purpose — it is a beacon-only sink, NOT part of the money/pipeline
// registry in lib/airtable TABLES.
const SIGNUP_ATTEMPTS_TABLE = 'tblDDpQaVPwIIuSXz';

export type SignupDoor = 'apply' | 'self-submit';
export type SignupOutcome =
  | 'created'
  | 'rejected-validation'
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'honeypot'
  | 'network-error';

export interface SignupAttemptInput {
  email?: string;
  ranchName?: string;
  state?: string;
  phone?: string;
  ip?: string;
  door: SignupDoor;
  outcome: SignupOutcome;
  reason?: string;
}

/**
 * Pure payload builder — maps a beacon/catch report onto the exact Airtable
 * field names on the Signup Attempts table. Summary is the primary field,
 * "<email> · <ranch> · <outcome>", so the grid reads at a glance. No I/O here
 * (unit-tested).
 */
export function buildSignupAttemptFields(input: SignupAttemptInput): Record<string, any> {
  const email = String(input.email || '').trim();
  const ranch = String(input.ranchName || '').trim();
  return {
    Summary: `${email} · ${ranch} · ${input.outcome}`,
    Email: email,
    'Ranch Name': ranch,
    State: String(input.state || '').trim(),
    Phone: String(input.phone || '').trim(),
    IP: String(input.ip || '').trim(),
    Door: input.door,
    Outcome: input.outcome,
    Reason: String(input.reason || '').trim(),
  };
}

/**
 * Pure mapper — derive a Signup Attempts Outcome from the client-reported
 * {status, reason} a beacon carries. reason wins over status because a fetch
 * that threw (network abort, client timeout) has no HTTP status. Kept here (not
 * in the route) so it is testable under the lib test glob.
 */
export function outcomeFromReport(status: unknown, reason: unknown): SignupOutcome {
  const r = String(reason || '').toLowerCase();
  if (r.includes('timeout') || r.includes('timed out')) return 'timeout';
  if (r.includes('network') || r.includes('abort') || r.includes('failed to fetch')) {
    return 'network-error';
  }
  const s = Number(status);
  if (s === 429) return 'rate-limited';
  if (s >= 400 && s < 500) return 'rejected-validation';
  if (s >= 500) return 'server-error';
  // No usable status and no network/timeout marker → a beacon fired from a
  // catch with status 0. Record it as a network failure rather than dropping it.
  return 'network-error';
}

/**
 * Fire-and-forget writer. NEVER throws into the caller — a beacon endpoint or a
 * route catch must not fail because the trace write failed. createRecord already
 * strips unknown fields + retries; we only add the swallow.
 */
export async function logSignupAttempt(input: SignupAttemptInput): Promise<void> {
  try {
    await createRecord(SIGNUP_ATTEMPTS_TABLE, buildSignupAttemptFields(input));
  } catch (err: any) {
    console.error('[signupAttempts] failed to log attempt:', err?.message || err);
  }
}
