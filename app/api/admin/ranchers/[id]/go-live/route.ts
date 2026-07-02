import { NextResponse, NextRequest } from 'next/server';
import { goLiveRancher } from '@/lib/goLiveRancher';
import { isMaintenanceMode } from '@/lib/maintenance';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 60;

// Thin wrapper over the ONE go-live rail (lib/goLiveRancher.ts).
// Pre-fix, this route gated Stripe Connect but never Agreement Signed and
// never emailed the rancher — while the PATCH "Mark Live" rail gated nothing
// and skipped the waitlist blast. Both now share goLiveRancher(): identical
// gates (agreement + Connect-for-tier_v2 + verification-not-pending, all
// force-overridable), identical 4-field write, identical side effects
// (warmup + waitlist blast + go-live email + Telegram note), idempotent.
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Auth: requireAdmin() — bhc-admin-auth cookie OR x-admin-password.
    const unauthorized = await requireAdmin(request);
    if (unauthorized) return unauthorized;

    // Honor global maintenance mode. Audit finding 2026-05-20 #39: go-live
    // bypassed MAINTENANCE_MODE → could trigger 50-buyer warmup blast +
    // matching cycle even when the platform was paused.
    if (isMaintenanceMode()) {
      return NextResponse.json(
        { error: 'Platform in maintenance mode — go-live deferred. Unset MAINTENANCE_MODE first.' },
        { status: 503 },
      );
    }

    const { id } = await context.params;

    // Force override: ?force=1 / ?force=true or JSON body { force: true }.
    let force = false;
    try {
      const url = new URL(request.url);
      force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
    } catch { /* ignore */ }
    if (!force) {
      try {
        const body = await request.clone().json();
        if (body && (body.force === true || body.force === '1')) force = true;
      } catch { /* no/!json body — fine */ }
    }

    const result = await goLiveRancher(id, { force, actor: 'admin-go-live' });

    if (!result.ok) {
      const status = result.code === 'rancher_not_found' ? 404 : 409;
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status },
      );
    }

    return NextResponse.json({
      success: true,
      matched: result.matched,
      alreadyLive: result.alreadyLive,
    });
  } catch (error: any) {
    console.error('Error setting rancher page live:', error);
    return NextResponse.json({ error: error.message || 'Failed to go live' }, { status: 500 });
  }
}
