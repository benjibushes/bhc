import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { geocodeRancher } from '@/lib/geocode';
import { requireAdmin } from '@/lib/adminAuth';

// POST /api/admin/ranchers/[id]/regeocode
//
// Admin-only endpoint that re-geocodes a rancher's current Zip / City / State
// and writes fresh Latitude + Longitude to Airtable. The map pin on the public
// rancher directory reflects these coords, so stale or missing pins can be fixed
// here without touching the rancher's own setup flow.
//
// Defensive: if geocode returns null (bad ZIP, unrecognised city, provider down)
// we return an error WITHOUT wiping the existing coordinates. Existing pins are
// always preserved on geocode failure.
//
// Triggered by the "↻ Regeocode pin" button in the admin rancher detail page.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const unauthorized = await requireAdmin(request);
    if (unauthorized) return unauthorized;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'Missing rancher id' }, { status: 400 });
    }

    let rancher: any;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, id);
    } catch {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const zip = String(rancher?.['Zip'] || '').trim().slice(0, 5);
    const city = String(rancher?.['City'] || '').trim();
    const state = String(rancher?.['State'] || '').trim();

    if (!zip && !city && !state) {
      return NextResponse.json(
        { error: 'Rancher has no Zip, City, or State — nothing to geocode' },
        { status: 400 }
      );
    }

    const coords = await geocodeRancher({ zip, city, state });

    if (!coords) {
      // Do NOT wipe existing coords — return an error so the admin knows.
      return NextResponse.json(
        {
          error: 'Geocode returned no result — existing pin preserved. Check that Zip / City / State are correct.',
          zip,
          city,
          state,
        },
        { status: 422 }
      );
    }

    try {
      await updateRecord(TABLES.RANCHERS, id, {
        Latitude: coords.lat,
        Longitude: coords.lng,
      });
    } catch (e: any) {
      console.error('[regeocode] Airtable write failed:', e?.message);
      return NextResponse.json(
        { error: `Airtable write failed: ${e?.message || 'unknown'}` },
        { status: 500 }
      );
    }

    const ranchName = String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || id);

    return NextResponse.json({
      ok: true,
      rancherId: id,
      ranchName,
      source: coords.source,
      lat: coords.lat,
      lng: coords.lng,
      zip,
      city,
      state,
      message: `Pin updated for ${ranchName} via ${coords.source} (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`,
    });
  } catch (error: any) {
    console.error('[regeocode] error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
