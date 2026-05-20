import { NextResponse } from 'next/server';
import { recordAffiliateClick } from '@/lib/affiliates';

export const maxDuration = 15;

// Fire-and-forget click counter for affiliate links. Called from the client
// when /access or /partner page loads with `?ref=CODE` in the URL. The page
// uses sessionStorage to de-dupe so a single visit only counts once per
// browser session — refresh the tab and you'll be counted again, but
// reloading mid-session won't.
//
// Inputs: `?ref=CODE` query param OR `{ ref: CODE }` JSON body.
// Returns: `{ ok: boolean }`. Never errors — click-tracking failures must
// not break the landing page render.
//
// Inputs are length-bounded and validated in lib/affiliates.ts. Codes that
// don't exist or whose Status != 'Active' silently no-op.

async function handle(req: Request): Promise<Response> {
  try {
    let ref: string | null = null;
    const url = new URL(req.url);
    ref = url.searchParams.get('ref');
    if (!ref && req.method === 'POST') {
      try {
        const body = await req.json();
        if (typeof body?.ref === 'string') ref = body.ref;
      } catch {}
    }
    if (!ref) return NextResponse.json({ ok: false });
    const ok = await recordAffiliateClick(ref);
    return NextResponse.json({ ok });
  } catch (e: any) {
    // Never throw upstream. Click tracking is best-effort.
    return NextResponse.json({ ok: false });
  }
}

export const GET = handle;
export const POST = handle;
