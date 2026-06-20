// app/api/admin/migration/route.ts
//
// GET — read-only snapshot of the tier_v2 migration funnel across all
// ranchers. Drives /admin/migration tracker page.
//
// Returns: per-rancher status, days-left, completion %, paused-overdue
// count. Tells the operator at-a-glance who's done, who's at risk, who
// hasn't even been invited yet.

import { NextResponse, NextRequest } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireRole } from '@/lib/adminAuth';

export const maxDuration = 30;

interface MigrationRancher {
  id: string;
  name: string;
  email: string;
  state: string;
  pricingModel: string;
  migrationStatus: string;
  migrationDeadline: string;
  daysLeft: number | null;
  inviteSentAt: string;
  callBookedAt: string;
  subscriptionStatus: string;
  connectStatus: string;
  connectAccountId: string;
  activeStatus: string;
}

export async function GET(request: NextRequest) {
  // Opened to 'onboarding' partner: migration read + upgrade-invite sends.
  const __authResp = await requireRole(request, ['admin', 'onboarding']);
  if (__authResp) return __authResp;

  const all: any[] = await getAllRecords(TABLES.RANCHERS);

  // Only Active OR Paused ranchers are in-scope. New leads that never
  // went Live shouldn't pollute the migration funnel.
  const inScope = all.filter((r) => {
    const status = String(r['Active Status'] || '');
    return status === 'Active' || status === 'Paused' || status === 'At Capacity';
  });

  const ranchers: MigrationRancher[] = inScope.map((r: any) => {
    const deadlineRaw = r['Migration Deadline'] || '';
    const deadlineMs = deadlineRaw ? new Date(deadlineRaw).getTime() : 0;
    const daysLeft = deadlineMs ? Math.ceil((deadlineMs - Date.now()) / (24 * 60 * 60 * 1000)) : null;
    return {
      id: r.id,
      name: r['Operator Name'] || r['Ranch Name'] || r.id,
      email: r['Email'] || '',
      state: r['State'] || '',
      pricingModel: String(r['Pricing Model'] || 'legacy').toLowerCase(),
      migrationStatus: String(r['Migration Status'] || 'not_invited'),
      migrationDeadline: deadlineRaw,
      daysLeft,
      inviteSentAt: r['V2 Upgrade Invite Sent At'] || '',
      callBookedAt: r['Migration Call Booked At'] || '',
      subscriptionStatus: String(r['Subscription Status'] || ''),
      connectStatus: String(r['Stripe Connect Status'] || ''),
      connectAccountId: String(r['Stripe Connect Account Id'] || ''),
      activeStatus: String(r['Active Status'] || ''),
    };
  });

  // Summary funnel counts.
  const total = ranchers.length;
  const completed = ranchers.filter((r) => r.pricingModel === 'tier_v2' || r.migrationStatus === 'completed').length;
  const notInvited = ranchers.filter((r) => r.migrationStatus === 'not_invited').length;
  const invited = ranchers.filter((r) => r.migrationStatus === 'invited').length;
  const callScheduled = ranchers.filter((r) => r.migrationStatus === 'call_scheduled').length;
  const upgrading = ranchers.filter((r) => r.migrationStatus === 'upgrading').length;
  const pausedOverdue = ranchers.filter((r) => r.migrationStatus === 'paused_overdue').length;
  const atRisk = ranchers.filter(
    (r) => r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 3 && r.pricingModel !== 'tier_v2',
  ).length;

  return NextResponse.json({
    summary: {
      total,
      completed,
      completionPct: total > 0 ? Math.round((completed / total) * 100) : 0,
      notInvited,
      invited,
      callScheduled,
      upgrading,
      pausedOverdue,
      atRisk,
    },
    ranchers: ranchers.sort((a, b) => {
      // Sort: at-risk first, then by days-left ascending, then by name.
      const aRisk = a.daysLeft !== null && a.daysLeft <= 3 && a.pricingModel !== 'tier_v2' ? 0 : 1;
      const bRisk = b.daysLeft !== null && b.daysLeft <= 3 && b.pricingModel !== 'tier_v2' ? 0 : 1;
      if (aRisk !== bRisk) return aRisk - bRisk;
      const aDays = a.daysLeft === null ? 999 : a.daysLeft;
      const bDays = b.daysLeft === null ? 999 : b.daysLeft;
      if (aDays !== bDays) return aDays - bDays;
      return a.name.localeCompare(b.name);
    }),
  });
}

// POST — bulk-send v2 upgrade invites to all not_invited ranchers.
// Body: { exclude?: string[] } — array of rancher IDs to skip (e.g. test
// excludes for already-handled people).
export async function POST(request: NextRequest) {
  // Opened to 'onboarding' partner: migration read + upgrade-invite sends.
  const __authResp = await requireRole(request, ['admin', 'onboarding']);
  if (__authResp) return __authResp;

  let body: any = {};
  try {
    body = await request.json();
  } catch {}
  const excludeIds = new Set<string>(Array.isArray(body.exclude) ? body.exclude : []);

  const all: any[] = await getAllRecords(TABLES.RANCHERS);
  const targets = all.filter((r: any) => {
    if (excludeIds.has(r.id)) return false;
    const status = String(r['Active Status'] || '');
    if (status !== 'Active' && status !== 'At Capacity') return false;
    const pm = String(r['Pricing Model'] || 'legacy').toLowerCase();
    if (pm === 'tier_v2') return false;
    const ms = String(r['Migration Status'] || 'not_invited');
    // Only 'not_invited' — match the page's confirm + button exactly. Re-engaging
    // paused/overdue ranchers is a separate flow (reactivation); they must never
    // be silently swept into a "Bulk Invite Not-Invited" action the operator
    // approved by count.
    if (ms !== 'not_invited') return false;
    return true;
  });

  // Fire send-v2-upgrade for each. Sequential — small N + Airtable rate-limit safe.
  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
  const internalSecret = process.env.INTERNAL_API_SECRET || '';
  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
  for (const r of targets) {
    const name = r['Operator Name'] || r['Ranch Name'] || r.id;
    try {
      const res = await fetch(`${SITE_URL}/api/admin/ranchers/${r.id}/send-v2-upgrade`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret,
        },
      });
      results.push({ id: r.id, name, ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` });
    } catch (e: any) {
      results.push({ id: r.id, name, ok: false, error: e?.message || 'unknown' });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    targetCount: targets.length,
    sent,
    failed,
    results,
  });
}
