import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { geocodeRancher } from '@/lib/geocode';

// Same cookie the magic-link verify flow uses (lib/rancherAuth.ts line 17).
// We mint this when GET succeeds so the wizard URL ALSO bootstraps the
// rancher-session cookie — without it, every downstream auth-gated route
// (/api/rancher/tier/select, /api/rancher/connect/start, etc.) would
// reject the wizard's calls and the rancher would hit a login wall.
const BHC_RANCHER_COOKIE = 'bhc-rancher-auth';

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
  'Cal.com Slug',
  'Logo URL',
  'Website',
  'Tagline',
  'About Text',
  'Video URL',
  'Quarter Price',
  'Quarter Deposit',
  'Quarter Processing Fee',
  'Quarter lbs',
  'Quarter Payment Link',
  'Half Price',
  'Half Deposit',
  'Half Processing Fee',
  'Half lbs',
  'Half Payment Link',
  'Whole Price',
  'Whole Deposit',
  'Whole Processing Fee',
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

  // 2026-06-09 fix: bootstrap the rancher-session cookie on wizard load.
  //
  // BEFORE this fix:
  //   - Wizard URL had rancher-setup JWT (60d) — enough to load + edit
  //     rancher data via this endpoint.
  //   - But /api/rancher/tier/select, /api/rancher/connect/start, and
  //     /api/rancher/legacy-upgrade all use `requireRancher()` which reads
  //     the `bhc-rancher-auth` cookie. No cookie = 401.
  //   - Rancher clicks "Pick Operator" → new tab opens
  //     /partner/checkout/operator → page sees no session → shows "Log in"
  //     button → rancher has to do a magic-link email round-trip.
  //   - This was the SECOND auth dead-end in the upgrade flow (after the
  //     wizard step-7 race fix). Both together would have killed Jesse's
  //     migration test.
  //
  // The fix: when the wizard URL is loaded with a valid rancher-setup JWT,
  // mint a SHORT-LIVED rancher-session cookie scoped to the same rancher.
  // This gives the same browser session immediate access to all downstream
  // auth-gated endpoints WITHOUT compromising security:
  //   - The rancher-setup JWT is the source of truth — it's what proves
  //     "this person is the rancher" via the send-v2-upgrade email
  //   - The cookie expires when the rancher-setup JWT does (60d max)
  //   - The cookie scope is exactly the same as a magic-link verify cookie
  //     would issue (same JWT signing secret, same type='rancher-session')
  //   - Set HttpOnly + SameSite=Lax to prevent XSS / cross-site-injection
  const sessionToken = jwt.sign(
    {
      type: 'rancher-session',
      rancherId: rancher.id,
      email: rancher['Email'] || '',
      name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
      ranchName: rancher['Ranch Name'] || '',
      state: rancher['State'] || '',
    },
    JWT_SECRET,
    { expiresIn: '60d' },
  );
  try {
    const cookieStore = await cookies();
    cookieStore.set({
      name: BHC_RANCHER_COOKIE,
      value: sessionToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 24 * 60 * 60, // 60 days
    });
  } catch (e) {
    // Cookie set failed (likely RSC + headers-already-sent edge case).
    // Non-fatal — wizard still loads. Rancher would only see the issue if
    // they then try to open a checkout tab; they'd have to re-login.
    console.warn('[setup/GET] cookie set failed (continuing):', (e as any)?.message);
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
  // Cal.com Slug — normalize + validate. Strip the cal.com URL prefix the
  // wizard already auto-strips on the client, plus any leading/trailing
  // slashes. Allowed shape: alphanumeric, dash, underscore, dot, slash.
  // Anything else (spaces, @, special chars) is almost certainly a paste
  // error and would render as a broken cal.com link in every buyer intro
  // email — reject with a friendly message instead of writing garbage.
  // Empty string is OK (rancher hasn't set one yet).
  if ('Cal.com Slug' in updates) {
    const raw = String(updates['Cal.com Slug'] || '')
      .trim()
      .replace(/^https?:\/\/(www\.)?cal\.com\//i, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (raw.length === 0) {
      updates['Cal.com Slug'] = '';
    } else {
      if (raw.length > 120) {
        return NextResponse.json({
          error: 'Cal.com slug looks too long — paste just the part after cal.com/ (e.g. "yourname/buyhalfcow-intro").',
        }, { status: 400 });
      }
      if (!/^[a-zA-Z0-9._\-\/]+$/.test(raw)) {
        return NextResponse.json({
          error: 'Cal.com slug can only contain letters, numbers, dashes, underscores, dots, and slashes. Paste just the part after cal.com/.',
        }, { status: 400 });
      }
      updates['Cal.com Slug'] = raw;
    }
  }

  // Money fields — coerce to number + reject negatives. These render verbatim
  // on the buyer deposit page and feed the deposit/balance math; a string or a
  // negative price (no min on the wizard inputs before this) would either make
  // Airtable choke or publish broken/negative pricing that 409s checkout. Same
  // gate the landing-page editor route already enforces.
  const MONEY_FIELDS = [
    'Quarter Price', 'Quarter Deposit', 'Quarter Processing Fee', 'Quarter lbs',
    'Half Price', 'Half Deposit', 'Half Processing Fee', 'Half lbs',
    'Whole Price', 'Whole Deposit', 'Whole Processing Fee', 'Whole lbs',
  ];
  for (const key of MONEY_FIELDS) {
    if (key in updates && updates[key] !== null && updates[key] !== '') {
      const num = parseFloat(String(updates[key]));
      if (isNaN(num) || num < 0) {
        return NextResponse.json(
          { error: `${key} must be a valid number of zero or more.` },
          { status: 400 },
        );
      }
      updates[key] = num;
    } else if (updates[key] === '') {
      // Empty string from a cleared input → null so Airtable clears the cell
      // instead of rejecting a blank number.
      updates[key] = null;
    }
  }

  // Per-cut deposit validation. The deposit is the buyer's upfront reserve
  // payment in the tier_v2 Stripe Connect model; app/api/checkout/deposit
  // charges it (defaulting to the full price when unset). A deposit of 0/
  // negative or one that exceeds the listed price would publish broken
  // checkout math, so enforce 0 < Deposit ≤ Price here (mirrors the wizard's
  // client-side gate). When the same PATCH includes the matching Price we
  // validate against it; otherwise we fall back to the stored Price so a
  // single-field deposit save is still bounded.
  const DEPOSIT_CUTS: Array<'Quarter' | 'Half' | 'Whole'> = ['Quarter', 'Half', 'Whole'];
  let currentForDeposits: any = null;
  for (const cut of DEPOSIT_CUTS) {
    const depKey = `${cut} Deposit`;
    if (!(depKey in updates)) continue;
    const dep = updates[depKey];
    if (dep === null) continue; // cleared → charge full price upfront, allowed
    const depNum = Number(dep);
    if (!Number.isFinite(depNum) || depNum <= 0) {
      return NextResponse.json(
        { error: `${depKey} must be greater than 0, or cleared to charge the full price upfront.` },
        { status: 400 },
      );
    }
    const priceKey = `${cut} Price`;
    let priceNum: number;
    if (priceKey in updates && updates[priceKey] !== null) {
      priceNum = Number(updates[priceKey]);
    } else {
      // Price not in this PATCH — read the stored value once (lazy) so a
      // standalone deposit update is still bounded by the existing price.
      if (currentForDeposits === null) {
        try {
          currentForDeposits = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
        } catch {
          currentForDeposits = {};
        }
      }
      priceNum = Number(currentForDeposits?.[priceKey]);
    }
    if (Number.isFinite(priceNum) && priceNum > 0 && depNum > priceNum) {
      return NextResponse.json(
        { error: `${depKey} can't exceed the ${cut} Price.` },
        { status: 400 },
      );
    }
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
