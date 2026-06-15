// app/api/rancher/white-glove/route.ts
//
// F8 — Rancher opts in to $497 White Glove Onboarding. Returns Stripe URL.
// Gated by ENABLE_WHITE_GLOVE flag.

import { NextRequest, NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import {
  createWhiteGloveCheckoutSession,
  isWhiteGloveEnabled,
  hasWhiteGlove,
} from '@/lib/whiteGlove';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isWhiteGloveEnabled()) {
    return NextResponse.json({ ok: false, error: 'feature disabled' }, { status: 404 });
  }

  const auth = await requireRancher(req);
  if (!('session' in auth)) {
    // requireRancher returns a NextResponse on failure
    return auth;
  }

  const rancherId = auth.session.rancherId;
  const rancher = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
  if (!rancher) {
    return NextResponse.json({ ok: false, error: 'rancher not found' }, { status: 404 });
  }

  if (hasWhiteGlove(rancher)) {
    return NextResponse.json({ ok: true, alreadyPaid: true });
  }

  const origin = new URL(req.url).origin;
  const successUrl = `${origin}/rancher/setup?wg=paid`;
  const cancelUrl = `${origin}/rancher/setup?wg=cancel`;

  try {
    const result = await createWhiteGloveCheckoutSession({
      rancherId,
      rancherEmail: String((rancher as any)['Email'] || ''),
      ranchName: String((rancher as any)['Ranch Name'] || 'ranch'),
      successUrl,
      cancelUrl,
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: 'checkout failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, url: result.url, sessionId: result.sessionId });
  } catch (e: any) {
    console.error('[white-glove] checkout error:', e?.message);
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
