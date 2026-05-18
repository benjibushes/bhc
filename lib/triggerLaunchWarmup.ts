// Fire-and-forget trigger for /api/cron/rancher-launch-warmup.
//
// Call this immediately after flipping a rancher to Page Live / Active so
// their state's Waitlisted buyers get warmed up within seconds — instead
// of waiting up to 24h for the scheduled cron at 13:30 UTC.
//
// The cron is idempotent (per-buyer Warmup Sent At filter + per-rancher
// 24h cooldown via Warmup Last Batch At), so multiple back-to-back
// triggers are safe.
//
// Auth: passes CRON_SECRET via query param (same path the cron header
// also accepts).

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export function triggerLaunchWarmup(reason: string): void {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.warn(`[triggerLaunchWarmup] CRON_SECRET unset — cannot fire (reason: ${reason})`);
    return;
  }
  try {
    fetch(`${SITE_URL}/api/cron/rancher-launch-warmup?secret=${encodeURIComponent(cronSecret)}`, {
      method: 'GET',
      headers: { 'x-trigger-reason': reason.slice(0, 100) },
    }).catch((e) => {
      console.error(`[triggerLaunchWarmup] background fetch error (${reason}):`, e?.message);
    });
  } catch (e: any) {
    console.error(`[triggerLaunchWarmup] threw (${reason}):`, e?.message);
  }
}
