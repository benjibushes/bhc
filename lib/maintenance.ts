// Single-switch maintenance mode for the BHC platform.
//
// When MAINTENANCE_MODE=true in Vercel env vars:
//   - Homepage (/) renders the waitlist capture page instead of the full marketing site
//   - /api/waitlist accepts lead captures into Airtable (Source='relaunch_waitlist')
//   - All crons early-return without sending email / matching
//   - /api/matching/suggest returns 503 (no matching until maintenance off)
//   - /api/consumers POST still creates the consumer record but DOES NOT
//     fire downstream email/telegram/matching side effects
//
// When off (default), everything runs normally.
//
// Flip with a single env var change + redeploy — no code changes needed.
// Existing member/rancher logins keep working throughout maintenance.
export function isMaintenanceMode(): boolean {
  return (process.env.MAINTENANCE_MODE || '').toLowerCase() === 'true';
}

// Helper for crons — returns a JSON response for early exit.
// Usage: `if (isMaintenanceMode()) return maintenanceResponse('cron-name');`
export function maintenanceResponse(label: string) {
  return new Response(
    JSON.stringify({
      success: true,
      paused: true,
      reason: `MAINTENANCE_MODE is ON — ${label} skipped.`,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
