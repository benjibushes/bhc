import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { geocodeRancher } from '@/lib/geocode';

// Self-serve rancher setup wizard — backing API.
//
// Token: JWT with type='rancher-setup', rancherId, 60d expiry. Issued in the
// self-submit welcome email. Single endpoint, two methods:
//
//   GET  /api/rancher/setup?token=...
//     → Returns the editable rancher fields so the wizard can pre-fill
//
//   PATCH /api/rancher/setup?token=...
//     → Updates allowed fields. Whitelist enforced server-side so a malicious
//       client can't flip Verification Status, Page Live, etc. — those flip
//       only via the agreement-signing flow.
//
// Why not require a full member-session login? Magic-link tokens are how the
// rest of the rancher onboarding works (sign-agreement, claim, remove-me).
// The token IS the auth. Loses access automatically at 60 days.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Whitelist — only these fields can be set via the self-serve wizard. Critical
// state fields (Verification Status, Page Live, Active Status, Onboarding
// Status, Agreement Signed, Trust Mode, Self-Submit Drip Stage, etc.) are
// excluded so the wizard can't bypass the formal go-live gate.
const ALLOWED_FIELDS = new Set([
  'Email',
  'Phone',
  'City',
  'State',
  'Zip',
  'States Served',
  'Beef Types',
  'Logo URL',
  'Website',
  'Tagline',
  'About Text',
  'Video URL',
  'Quarter Price',
  'Quarter lbs',
  'Quarter Payment Link',
  'Half Price',
  'Half lbs',
  'Half Payment Link',
  'Whole Price',
  'Whole lbs',
  'Whole Payment Link',
  'Tier Specialty',
  'Custom Notes',
  'Google Reviews URL',
  'Facebook URL',
  'Instagram URL',
  'Processing Facility',
  'Next Processing Date',
  'Reserve Link',
  'Gallery Photos',
  'Testimonials',
  'Custom Products',
  'Certifications',
]);

function verifyToken(token: string): { rancherId: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'rancher-setup' || !decoded.rancherId) return null;
    return { rancherId: decoded.rancherId };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  const decoded = verifyToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid or expired setup link' }, { status: 401 });
  }

  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
  }

  // Don't leak unrelated fields. Build a minimal response from the whitelist
  // plus a few read-only context fields.
  const out: Record<string, any> = {
    id: rancher.id,
    ranchName: rancher['Ranch Name'] || '',
    operatorName: rancher['Operator Name'] || '',
    slug: rancher['Slug'] || '',
    verificationStatus: rancher['Verification Status'] || '',
    agreementSigned: !!rancher['Agreement Signed'],
    pageLive: !!rancher['Page Live'],
    onboardingStatus: rancher['Onboarding Status'] || '',
  };
  for (const f of ALLOWED_FIELDS) {
    if (rancher[f] !== undefined) out[f] = rancher[f];
  }
  return NextResponse.json({ success: true, rancher: out });
}

export async function PATCH(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  const decoded = verifyToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid or expired setup link' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Strip everything not on the whitelist. Quietly drop disallowed fields.
  const updates: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_FIELDS.has(k)) updates[k] = v;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  // If ZIP / City / State changed, re-geocode and store fresh lat/lng so the
  // public map reflects the rancher's chosen location accurately. ZIP-first
  // for ~3-5 mi accuracy; falls back to city centroid if zippopotam misses.
  const locationChanged =
    'Zip' in updates || 'City' in updates || 'State' in updates;
  if (locationChanged) {
    try {
      // Read existing record to fill in any unchanged location fields.
      const current: any = await getRecordById(
        TABLES.RANCHERS,
        decoded.rancherId
      );
      const zip =
        ('Zip' in updates ? String(updates['Zip'] || '') : current?.['Zip'] || '')
          .toString()
          .trim()
          .slice(0, 5);
      const city =
        'City' in updates
          ? String(updates['City'] || '')
          : current?.['City'] || '';
      const state =
        'State' in updates
          ? String(updates['State'] || '')
          : current?.['State'] || '';
      const coords = await geocodeRancher({ zip, city, state });
      if (coords) {
        updates['Latitude'] = coords.lat;
        updates['Longitude'] = coords.lng;
      }
    } catch (e: any) {
      // Non-fatal — keep the field updates, skip the lat/lng refresh.
      console.warn('[rancher/setup] re-geocode skipped:', e?.message);
    }
  }

  try {
    await updateRecord(TABLES.RANCHERS, decoded.rancherId, updates);
    return NextResponse.json({ success: true, updated: Object.keys(updates) });
  } catch (e: any) {
    console.error('[rancher/setup] update failed:', e?.message);
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}
