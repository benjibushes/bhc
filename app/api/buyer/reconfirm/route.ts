// app/api/buyer/reconfirm/route.ts
//
// FRESHNESS RE-CONFIRM (2026-07-06, conversion slice 2): the one-click "yes,
// still looking" landing for the sendStillLookingReconfirm email. A stale
// qualification (>28d) blocks routing (matching/suggest GUARD-2b); this click
// re-stamps Qualified At = now (same score — the buyer already earned it; the
// click is an explicit still-in-the-market confirmation, logged in Notes) so
// the lead routes with a same-day stamp.
//
// GET because it's an email link (one tap). SAFE for scanners/prefetchers to
// hit: re-stamping Qualified At on an already-qualified buyer is idempotent in
// effect (routes sooner — the buyer's own stated wish) and destroys nothing.
// Token = the standard signed member-login JWT (14d expiry) — unguessable, so
// only the emailed buyer can trigger it.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  let consumerId = '';
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded?.type !== 'member-login' || !decoded?.consumerId) throw new Error('wrong type');
    consumerId = String(decoded.consumerId);
  } catch {
    // Bad/expired token → home, never an error page from an email click.
    return NextResponse.redirect(`${SITE_URL}/access`, 302);
  }

  let statePrefill = '';
  try {
    const buyer: any = await getRecordById(TABLES.CONSUMERS, consumerId);
    if (buyer) {
      statePrefill = String(buyer['State'] || '').trim();
      const prevQualifiedAt = String(buyer['Qualified At'] || '');
      await updateRecord(TABLES.CONSUMERS, consumerId, {
        'Qualified At': new Date().toISOString(),
        'Notes': `${String(buyer['Notes'] || '')}\n[RECONFIRM ${new Date().toISOString()}] buyer one-clicked "still looking" (prev Qualified At: ${prevQualifiedAt || 'n/a'})`.trim(),
      });
    }
  } catch (e: any) {
    // Non-fatal — the buyer still lands somewhere warm; ops can re-stamp.
    console.warn('[buyer/reconfirm] re-stamp failed:', e?.message);
  }

  // Land on /access with the welcome-back flags: the page shows a
  // "welcome back — you're confirmed still looking" banner and prefills the
  // state dropdown. The quiz itself re-runs on purpose — freshness is the
  // point of this rail, so matching uses the buyer's CURRENT answers.
  const params = new URLSearchParams({ resume: '1', reconfirmed: '1' });
  if (statePrefill) params.set('state', statePrefill);
  return NextResponse.redirect(`${SITE_URL}/access?${params.toString()}`, 302);
}
