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
  // Rancher-editable: their REQUESTED states. Routing only fires from
  // "Routing States" which is admin-controlled (Ben). Rancher edits
  // Preferred → Ben reviews + promotes into Routing.
  'Preferred States',
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
  // Stage-3 Task 11B — fulfillment + refund policy (shown to buyers verbatim)
  'Fulfillment Types',
  'Pickup City',
  'Delivery Radius Miles',
  'Shipping Lead Time Days',
  'Refund Policy',
  'Fulfillment Cost Notes',
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
    // Wizard reads this as fallback proof the call happened — covers
    // ranchers whose Onboarding Status got bumped to a non-canonical
    // value (e.g. "Docs Sent") while skipping past "Call Complete".
    callCompletedAt: rancher['Call Completed At'] || '',
    // Stage-3 Task 11 — surface tier subscription state so the wizard's
    // Pick-Your-Plan step can detect when checkout completed.
    Tier: rancher['Tier'] || '',
    'Subscription Status': rancher['Subscription Status'] || '',
    'Pricing Model': rancher['Pricing Model'] || '',
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

  // Stage-3 Task 11B — server-side validation for fulfillment fields. These
  // render verbatim on the buyer deposit page; the client-side gate alone is
  // not enough since a buggy or malicious client can still write garbage.
  if ('Refund Policy' in updates) {
    const policy = String(updates['Refund Policy'] || '').trim();
    if (policy.length < 20 || policy.length > 500) {
      return NextResponse.json({
        error: 'Refund Policy must be 20–500 characters.',
      }, { status: 400 });
    }
    updates['Refund Policy'] = policy;
  }
  if ('Delivery Radius Miles' in updates) {
    const v = Number(updates['Delivery Radius Miles']);
    if (!Number.isInteger(v) || v <= 0 || v > 500) {
      return NextResponse.json({
        error: 'Delivery Radius Miles must be a positive whole number ≤ 500.',
      }, { status: 400 });
    }
    updates['Delivery Radius Miles'] = v;
  }
  if ('Shipping Lead Time Days' in updates) {
    const v = Number(updates['Shipping Lead Time Days']);
    if (!Number.isInteger(v) || v <= 0 || v > 180) {
      return NextResponse.json({
        error: 'Shipping Lead Time Days must be a positive whole number ≤ 180.',
      }, { status: 400 });
    }
    updates['Shipping Lead Time Days'] = v;
  }
  if ('Fulfillment Cost Notes' in updates) {
    const notes = String(updates['Fulfillment Cost Notes'] || '').trim().slice(0, 500);
    updates['Fulfillment Cost Notes'] = notes;
  }
  if ('Pickup City' in updates) {
    const city = String(updates['Pickup City'] || '').trim().slice(0, 100);
    updates['Pickup City'] = city;
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
