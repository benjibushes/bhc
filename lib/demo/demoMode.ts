// ─────────────────────────────────────────────────────────────────────────
// DEMO MODE — the single, safety-critical gate. LOCAL ONLY.
//
// ⚠️  THIS FLAG IS NEVER SET IN VERCEL / PRODUCTION.  ⚠️
//
// It exists so the founder can run the WHOLE platform locally against
// in-memory FAKE data (`NEXT_PUBLIC_DEMO_MODE=true npm run dev`) to
// screen-record rancher-onboarding tutorials — with ZERO external calls
// (no Airtable, Stripe, Resend, Twilio, or Telegram).
//
// Production safety contract:
//   • Do NOT add NEXT_PUBLIC_DEMO_MODE or DEMO_MODE to vercel.json, .env,
//     or any committed config. It is a runtime flag you type on the CLI.
//   • When neither env var is 'true', isDemoMode() returns false and every
//     demo branch elsewhere is an inert early-return that never executes —
//     production behaves byte-identically to before this file existed.
//   • Nothing else can flip this true. No cookie, no header, no DB row.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The ONE truth for "are we in local demo mode?".
 *
 * True ONLY when an operator explicitly exports NEXT_PUBLIC_DEMO_MODE='true'
 * or DEMO_MODE='true' before starting the dev server. Any other value
 * (undefined, '', 'false', '1', 'yes', 'TRUE'…) → false. The strict
 * === 'true' comparison is the production-safety pin: an accidental or
 * partial value can never enable demo mode.
 */
export function isDemoMode(): boolean {
  return (
    process.env.NEXT_PUBLIC_DEMO_MODE === 'true' ||
    process.env.DEMO_MODE === 'true'
  );
}

// One-time loud banner so nobody records a "live" demo without realizing the
// data is fake. Guarded so it prints at most once per process, and only when
// the flag is actually on — in production this block is never reached.
let _bannerShown = false;
export function announceDemoModeOnce(): void {
  if (_bannerShown || !isDemoMode()) return;
  _bannerShown = true;
  // ANSI red so it's impossible to miss in the dev-server log.
  const red = '\x1b[41m\x1b[1m\x1b[37m';
  const reset = '\x1b[0m';
  // eslint-disable-next-line no-console
  console.log(
    `\n${red} 🐮  DEMO MODE ACTIVE — FAKE DATA, NO EXTERNAL CALLS (local only) ${reset}\n` +
      `   Airtable / Stripe / Resend / Twilio / Telegram are all no-ops.\n` +
      `   This flag is NEVER set in Vercel. See lib/demo/demoMode.ts\n`,
  );
}

// Announce on module import when active. Import is a no-op in prod (flag off).
announceDemoModeOnce();
