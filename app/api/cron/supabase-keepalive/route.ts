// Daily Supabase keep-alive cron.
//
// 2026-08-06 incident: the free-tier Supabase project auto-paused after ~7
// days without API traffic, which silently killed rancher PASSWORD login
// for everyone (magic-link kept working — it never touches Supabase). This
// cron sends one authenticated REST ping per day so the project always
// counts as active and can never auto-pause again.
//
// The ping doubles as a health probe: if Supabase is paused/unreachable it
// fires a deduped operator signal so Ben hears about it the same day, not
// when the next rancher's login fails.

import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 30;

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial' | 'error'; recordsTouched: number; notes: string }> {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  // Build-dark safe: no Supabase env = nothing to keep alive. Report it so
  // the Cron Runs row is honest rather than a silent green.
  if (!url || !anonKey) {
    return { status: 'partial', recordsTouched: 0, notes: 'supabase env unset — nothing pinged' };
  }

  // An authenticated /auth/v1/health request goes through the project's API
  // gateway, which is exactly the traffic the auto-pause counter watches.
  let ok = false;
  let detail = '';
  try {
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(10_000),
    });
    ok = res.ok;
    detail = `http ${res.status}`;
  } catch (e: any) {
    detail = e?.message || 'fetch failed';
  }

  if (!ok) {
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: 'Supabase unreachable — password login is DOWN',
        detail:
          `The daily keep-alive ping to Supabase failed (${detail}). ` +
          `Rancher password login fails while this lasts (magic-link is unaffected). ` +
          `Check https://supabase.com/dashboard/project/vwxpzuysmmavuyjdnqmw — if the project is paused, hit Restore.`,
        dedupeKey: 'supabase-keepalive-down',
        dedupeWindowMs: 12 * 60 * 60 * 1000,
      });
    } catch {
      /* alert is best-effort */
    }
    return { status: 'error', recordsTouched: 0, notes: `supabase ping failed: ${detail}` };
  }

  return { status: 'success', recordsTouched: 0, notes: `supabase alive (${detail})` };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('supabase-keepalive', realHandler)(request);
}

export const GET = authedHandler;
