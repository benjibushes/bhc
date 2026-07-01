// app/go/[code]/route.ts
//
// Short-link redirect for rancher self-serve setup.
//
//   buyhalfcow.com/go/<code>  ->  302  ->  /rancher/setup?token=<60d JWT>
//
// Why this exists: the raw setup link is a ~230-char URL (it carries a signed
// rancher-setup JWT). Pasting that into an SMS looks like phishing and tanks
// trust + deliverability. This route lets us send a short, on-brand link
// instead — while keeping the auth token off the wire and out of the repo.
//
// How it stays safe:
//   - <code> is an unguessable 6-char code stored ONLY in Airtable
//     (Ranchers."Setup Short Code"), never committed to this public repo.
//   - The setup token is minted fresh at click time (never stored), so it
//     can't leak from Airtable and can't expire before the rancher taps it.
//   - Unknown / missing code -> 302 home (no 404 enumeration signal).
//
// This mirrors the token shape minted by
// app/api/admin/ranchers/[id]/send-v2-upgrade/route.ts so the wizard treats
// a /go click identically to the email "Set it up myself" button.

import { NextRequest, NextResponse } from 'next/server';
import { getAllRecords, TABLES, escapeAirtableValue } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ code: string }> }
) {
  const { code } = await context.params;

  // Codes are [a-z0-9] only; sanitize to keep the formula injection-proof
  // even though escapeAirtableValue also runs below.
  const clean = (code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!clean) return NextResponse.redirect(`${SITE_URL}/`, 302);

  let rancherId = '';
  try {
    const recs = await getAllRecords(
      TABLES.RANCHERS,
      `{Setup Short Code} = "${escapeAirtableValue(clean)}"`
    );
    if (Array.isArray(recs) && recs.length > 0 && recs[0]?.id) {
      rancherId = recs[0].id as string;
    }
  } catch (e: any) {
    console.error('[/go] lookup failed:', e?.message || e);
  }

  // Unknown code -> home (don't reveal whether a code exists).
  if (!rancherId) return NextResponse.redirect(`${SITE_URL}/`, 302);

  const token = jwt.sign(
    { type: 'rancher-setup', rancherId },
    JWT_SECRET,
    { expiresIn: '60d' }
  );
  return NextResponse.redirect(`${SITE_URL}/rancher/setup?token=${token}`, 302);
}
