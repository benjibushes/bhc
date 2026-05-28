// POST /api/admin/referrals/bulk-approve
//
// P1 audit fix (D-2). /admin/referrals had no granular bulk select — the
// only bulk action was an all-or-nothing "Approve All Pending" button on
// /admin. Operator had to click Approve on each pending row individually.
//
// Behavior:
//   - Body: { ids: string[] }                 (Airtable referral record ids)
//   - For each id: PATCH /api/referrals/:id/approve (reuses single-approve
//     logic — same capacity check, same intro-email, same telegram alert)
//   - Continues on individual failure — returns per-id outcome.
//   - All-or-nothing is the wrong tradeoff here: if 1 of 12 fails (rancher
//     at capacity), the other 11 should still go through. Operator sees
//     the failure summary and can manually reassign the stuck one.
//
// Auth: requireAdmin (Clerk session OR x-admin-password).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 60;

interface BulkApproveResult {
  id: string;
  ok: boolean;
  message?: string;
  error?: string;
}

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0) : null;
  if (!ids || ids.length === 0) {
    return NextResponse.json({ error: 'ids[] required (non-empty string array)' }, { status: 400 });
  }
  // Sanity cap — guards against an accidental "select all 5000 referrals" click.
  if (ids.length > 100) {
    return NextResponse.json({ error: 'Too many ids — max 100 per call' }, { status: 400 });
  }

  // Forward admin auth (Clerk cookie or x-admin-password header) on to the
  // single-approve endpoint we're delegating to.
  const cookie = request.headers.get('cookie') || '';
  const adminPw = request.headers.get('x-admin-password') || '';
  const origin = new URL(request.url).origin;

  const results: BulkApproveResult[] = [];
  let approved = 0;
  let failed = 0;

  // Sequential — Airtable's per-table rate limit + the in-route capacity
  // re-read makes parallel risky for race conditions on the same rancher.
  // 12 approvals × ~600ms each ≈ 7s, well under the 60s max.
  for (const id of ids) {
    try {
      const res = await fetch(`${origin}/api/referrals/${id}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(adminPw ? { 'x-admin-password': adminPw } : {}),
        },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        failed++;
        results.push({ id, ok: false, error: payload?.error || `HTTP ${res.status}` });
      } else {
        approved++;
        results.push({ id, ok: true, message: payload?.message });
      }
    } catch (e: any) {
      failed++;
      results.push({ id, ok: false, error: e?.message || 'Network error' });
    }
  }

  return NextResponse.json({
    success: failed === 0,
    approved,
    failed,
    total: ids.length,
    results,
  });
}
