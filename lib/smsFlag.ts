// lib/smsFlag.ts — THE single source of truth for the platform-wide SMS gate.
//
// F3 (go-to-market systematic debug 2026-07-01): the ENABLE_SMS gate had a
// split brain — lib/smsEvents.ts required ENABLE_SMS === '1' while
// demand-router + orphan-checkout-reaper required === 'true'. NO single env
// value lit the whole channel: '1' left the crons dark, 'true' left every
// buyer-journey event dark. On go-live day the operator flips ONE value and
// half the channel stays silently off.
//
// Fix: every ENABLE_SMS check routes through smsEnabled(). Accepts '1' or
// 'true' (case-insensitive, trimmed) so BOTH historical values work; anything
// else — '', unset, '0', 'false', garbage — is off. Pinned in smsFlag.test.ts.
//
// IMPORT-CLEAN by design: this module must never import anything (twilio,
// airtable, env-validating secrets). It is pulled in by webhooks, crons, and
// unit tests that must not drag side-effectful modules along.

/**
 * Platform-wide SMS feature gate. Pure: reads only the env object it is given
 * (defaults to process.env), no other module state.
 */
export function smsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.ENABLE_SMS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
