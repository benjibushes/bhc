// app/api/admin/cal/ensure-event/route.ts
//
// Operator self-service for the booking-link incident (2026-06-14). The
// resolver in lib/calBooking.ts reads the operator's LIVE Cal event via
// CAL_API_KEY. This endpoint is the diagnostic + repair tool behind it:
//
//   GET  → reports the operator's Cal username + every event type (with
//          hidden/length) so the operator can SEE what's live. If at least
//          one non-hidden event exists it returns the link the resolver
//          would use.
//   GET ?create=1 → if NO non-hidden event exists, POSTs a fresh
//          'BuyHalfCow Call' 15-min event type so the dead-link state
//          self-heals in one click. Returns the raw Cal response either way
//          so the operator can read the exact API error if it fails.
//
// Auth mirrors app/api/admin/ranchers/[id]/send-v2-upgrade: accept the
// x-internal-secret header (for scripted/internal callers) OR a normal admin
// session via requireAdmin.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

function calHeaders(apiKey: string, json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'cal-api-version': CAL_API_VERSION,
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// Same shape-normalizer the resolver uses — Cal's /event-types response comes
// back in several shapes depending on account/plan.
function extractEventTypes(json: any): any[] {
  if (!json) return [];
  const data = json.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.eventTypeGroups)) {
    const out: any[] = [];
    for (const group of data.eventTypeGroups) {
      if (group && Array.isArray(group.eventTypes)) out.push(...group.eventTypes);
    }
    return out;
  }
  if (Array.isArray(json.event_types)) return json.event_types;
  if (data && Array.isArray(data.eventTypes)) return data.eventTypes;
  return [];
}

function extractUsername(json: any): string {
  const d = json?.data ?? json;
  const user = d?.user ?? d;
  return String(user?.username || '').trim();
}

export async function GET(req: Request) {
  // Auth: internal secret header OR admin session.
  const internalHeader = req.headers.get('x-internal-secret') || '';
  const isInternal = !!INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
  if (!isInternal) {
    const unauthorized = await requireAdmin(req);
    if (unauthorized) return unauthorized;
  }

  const apiKey = process.env.CAL_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json({ ok: false, note: 'CAL_API_KEY not set' });
  }

  const { searchParams } = new URL(req.url);
  const wantCreate = searchParams.get('create') === '1';

  // 1) Who is the operator on Cal?
  let username = '';
  try {
    const meRes = await fetch(`${CAL_API_BASE}/me`, { headers: calHeaders(apiKey) });
    if (!meRes.ok) {
      const raw = await meRes.text().catch(() => '');
      return NextResponse.json({
        ok: false,
        step: 'me',
        status: meRes.status,
        raw: raw.slice(0, 500),
      });
    }
    username = extractUsername(await meRes.json());
  } catch (e: any) {
    return NextResponse.json({ ok: false, step: 'me', error: e?.message || 'fetch failed' });
  }
  if (!username) {
    return NextResponse.json({ ok: false, step: 'me', note: 'no username on Cal /me response' });
  }

  // 2) List event types.
  let events: any[] = [];
  let listRaw = '';
  try {
    const etRes = await fetch(`${CAL_API_BASE}/event-types`, { headers: calHeaders(apiKey) });
    listRaw = await etRes.text().catch(() => '');
    if (!etRes.ok) {
      return NextResponse.json({
        ok: false,
        step: 'event-types',
        username,
        status: etRes.status,
        raw: listRaw.slice(0, 500),
      });
    }
    let parsed: any = null;
    try { parsed = JSON.parse(listRaw); } catch { parsed = null; }
    events = extractEventTypes(parsed);
  } catch (e: any) {
    return NextResponse.json({ ok: false, step: 'event-types', username, error: e?.message || 'fetch failed' });
  }

  const summarized = events.map((e) => ({
    title: String(e?.title || ''),
    slug: String(e?.slug || ''),
    hidden: e?.hidden === true,
    lengthInMinutes: Number(e?.lengthInMinutes ?? e?.length ?? 0),
  }));
  const firstLive = events.find((e) => e && e.hidden !== true);
  const firstLiveSlug = String(firstLive?.slug || '').trim();

  // 3a) A live event already exists — nothing to create.
  if (firstLive && firstLiveSlug) {
    return NextResponse.json({
      ok: true,
      created: false,
      username,
      link: `https://cal.com/${username}/${firstLiveSlug}`,
      events: summarized,
      raw: listRaw.slice(0, 500),
    });
  }

  // 3b) No live event. Without ?create=1 we just report the dead state.
  if (!wantCreate) {
    return NextResponse.json({
      ok: false,
      created: false,
      username,
      note: 'no non-hidden event type — pass ?create=1 to auto-create one',
      events: summarized,
      raw: listRaw.slice(0, 500),
    });
  }

  // 3c) Self-heal: create the canonical BuyHalfCow Call event type.
  try {
    const createRes = await fetch(`${CAL_API_BASE}/event-types`, {
      method: 'POST',
      headers: calHeaders(apiKey, true),
      body: JSON.stringify({
        lengthInMinutes: 15,
        title: 'BuyHalfCow Call',
        slug: 'buyhalfcow',
      }),
    });
    const createRaw = await createRes.text().catch(() => '');
    if (!createRes.ok) {
      return NextResponse.json({
        ok: false,
        created: false,
        username,
        status: createRes.status,
        raw: createRaw.slice(0, 500),
      });
    }
    let createdJson: any = null;
    try { createdJson = JSON.parse(createRaw); } catch { createdJson = null; }
    const createdSlug =
      String(createdJson?.data?.slug || createdJson?.slug || 'buyhalfcow').trim();
    return NextResponse.json({
      ok: true,
      created: true,
      username,
      link: `https://cal.com/${username}/${createdSlug}`,
      raw: createRaw.slice(0, 500),
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      created: false,
      username,
      error: e?.message || 'create failed',
    });
  }
}
