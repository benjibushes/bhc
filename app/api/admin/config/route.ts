// GET  /api/admin/config — return current operator config
// POST /api/admin/config — save partial update, return new config

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAdminConfig, saveAdminConfig, ADMIN_CONFIG_DEFAULTS } from '@/lib/adminConfig';
import type { AdminConfig } from '@/lib/adminConfig';

export const maxDuration = 30;

export async function GET(request: Request) {
  const __auth = await requireAdmin(request);
  if (__auth) return __auth;

  try {
    const config = await getAdminConfig();
    return NextResponse.json({ config, defaults: ADMIN_CONFIG_DEFAULTS });
  } catch (err: any) {
    console.error('[/api/admin/config GET]', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to load config' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const __auth = await requireAdmin(request);
  if (__auth) return __auth;

  let body: Partial<AdminConfig>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate: every supplied value must be a finite positive number
  const ALLOWED_KEYS: Array<keyof AdminConfig> = [
    'stallThresholdDays',
    'highIntentCutoff',
    'migrationDeadlineDays',
    'capacityWarningPct',
  ];

  const updates: Partial<AdminConfig> = {};
  for (const key of ALLOWED_KEYS) {
    if (!(key in body)) continue;
    const val = (body as any)[key];
    const num = Number(val);
    if (!isFinite(num) || num < 0) {
      return NextResponse.json(
        { error: `Invalid value for ${key}: must be a non-negative number` },
        { status: 400 },
      );
    }
    (updates as any)[key] = num;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  try {
    const config = await saveAdminConfig(updates);
    return NextResponse.json({ config, defaults: ADMIN_CONFIG_DEFAULTS });
  } catch (err: any) {
    console.error('[/api/admin/config POST]', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to save config' },
      { status: 500 },
    );
  }
}
