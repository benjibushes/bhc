// lib/quickActionHttp.ts
//
// HTTP status mapping for the rancher quick-action rail
// (app/api/rancher/quick-action/route.ts). Wave 2 rancher-UX: that route
// used to answer HTTP 200 on EVERY outcome — expired token, ownership
// mismatch, deposit-locked refusal, even a failed Airtable write all looked
// like success to anything that isn't a human reading the HTML (dead-man
// checks, uptime probes, log-based alerting). The rendered page is unchanged;
// only the status line now tells the truth.
//
// Pure + import-free so the colocated test never drags in the route's
// Next/Airtable/secrets chain (the same constraint every lib test here
// documents).

/** Machine-readable failure classes applyAction can produce. */
export type QuickActionFailureKind =
  | 'not-found' // referral row missing
  | 'not-owner' // token's rancher no longer owns the referral
  | 'locked' // deposit-lock / engaged-lock refusal — valid request, refused state
  | 'bad-input' // missing/invalid form input (e.g. sale amount)
  | 'not-ready' // account precondition missing (e.g. no locked commission rate)
  | 'write-failed'; // upstream write (Airtable/contract) failed

export interface QuickActionResult {
  ok: boolean;
  message: string;
  failureKind?: QuickActionFailureKind;
}

/** Status for the final applyAction result page. */
export function quickActionHttpStatus(result: QuickActionResult): number {
  if (result.ok) return 200;
  switch (result.failureKind) {
    case 'not-found':
      return 404;
    case 'not-owner':
      return 403;
    case 'locked':
      return 409;
    case 'bad-input':
      return 400;
    case 'not-ready':
      return 409;
    case 'write-failed':
      return 502;
    default:
      // Unclassified failure — still an error, never a 200.
      return 500;
  }
}

/** Status for an unverifiable quick-action token (expired/forged/absent). */
export const QUICK_ACTION_INVALID_TOKEN_STATUS = 401;

/** Status for an action name outside the allowed set. */
export const QUICK_ACTION_BAD_ACTION_STATUS = 400;
