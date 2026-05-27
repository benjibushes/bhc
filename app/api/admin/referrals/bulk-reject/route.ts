// POST /api/admin/referrals/bulk-reject
//
// P1 audit fix (D-2). Companion to bulk-approve.
// Sets Status='Closed Lost' on each referral via the single-referral PATCH
// (which fires buyer status sync, capacity DECR, and any side effects).
//
// Body: { ids: string[] }
// Auth: requireAdmin

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 60;

interface BulkRejectResult {
  id: string;
  ok: boolean;
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
  if (ids.length > 100) {
    return NextResponse.json({ error: 'Too many ids — max 100 per call' }, { status: 400 });
  }

  const cookie = request.headers.get('cookie') || '';
  const adminPw = request.headers.get('x-admin-password') || '';
  const origin = new URL(request.url).origin;

  const results: BulkRejectResult[] = [];
  let rejected = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const res = await fetch(`${origin}/api/referrals/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(adminPw ? { 'x-admin-password': adminPw } : {}),
        },
        body: JSON.stringify({ status: 'Closed Lost' }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        failed++;
        results.push({ id, ok: false, error: payload?.error || `HTTP ${res.status}` });
      } else {
        rejected++;
        results.push({ id, ok: true });
      }
    } catch (e: any) {
      failed++;
      results.push({ id, ok: false, error: e?.message || 'Network error' });
    }
  }

  return NextResponse.json({
    success: failed === 0,
    rejected,
    failed,
    total: ids.length,
    results,
  });
}
