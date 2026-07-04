// app/api/gear/route.ts
//
// Tiny public reader for the affiliate-products layer (Move 1). Lets the
// client-side GearBlock (e.g. the /member dashboard, which is a 'use client'
// tree that can't take server-fed props) fetch the already-selected product
// list. Selection runs SERVER-SIDE via selectGear so the ordering + compliance
// rules live in exactly one place.
//
//   GET /api/gear?stage=waiting|delivered&cut=quarter|half|whole
//     -> { products: GearProduct[] }  (already filtered/sorted/capped)
//
// Only whitelisted, non-sensitive product fields are returned (never
// Commission Note — that's BHC-internal). Empty catalog / any error → { products: [] }
// so the block renders nothing gracefully.

import { NextRequest, NextResponse } from 'next/server';
import { getGearCatalog, selectGear, type GearCut, type GearStage } from '@/lib/gear';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CUTS: GearCut[] = ['quarter', 'half', 'whole'];
const STAGES: GearStage[] = ['waiting', 'delivered'];

export async function GET(request: NextRequest) {
  try {
    const stageRaw = String(request.nextUrl.searchParams.get('stage') || 'waiting').toLowerCase();
    const cutRaw = String(request.nextUrl.searchParams.get('cut') || '').toLowerCase();
    const stage: GearStage = (STAGES as string[]).includes(stageRaw) ? (stageRaw as GearStage) : 'waiting';
    const cut: GearCut | null = (CUTS as string[]).includes(cutRaw) ? (cutRaw as GearCut) : null;

    const catalog = await getGearCatalog();
    const picked = selectGear(catalog, { cut, stage });

    // Client-safe projection — drop internal fields (Commission Note) and
    // normalize to what GearBlock renders.
    const products = picked.map((p) => ({
      id: p.id,
      Name: p.Name || '',
      Category: p.Category || 'other',
      'Affiliate URL': p['Affiliate URL'] || '',
      Network: p.Network || 'direct',
      'Image URL': p['Image URL'] || '',
      Blurb: p.Blurb || '',
    }));

    return NextResponse.json({ products });
  } catch (e: any) {
    console.error('[/api/gear] failed (returning empty):', e?.message || e);
    return NextResponse.json({ products: [] });
  }
}
