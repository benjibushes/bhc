// app/api/rancher/onboarding-status/route.ts
//
// "What do I still have to do to go live?" — answered from ONE place.
//
// The setup wizard, the rancher dashboard, and admin all previously implied
// their own answer to this, which is how a rancher could finish every screen
// and still not be routable. This endpoint returns lib/onboardingPaths'
// verdict verbatim, so every surface tells the rancher the same story and the
// money model is stated in exactly one set of words (MONEY_MODEL).
//
// Auth = requireRancher; only the session's own row is read. Read-only — it
// never mutates, so polling it is free of side effects.

import { NextResponse } from 'next/server';
import { requireRancher } from '@/lib/rancherAuth';
import { getRecordById, TABLES } from '@/lib/airtable';
import { evaluateOnboarding, MONEY_MODEL } from '@/lib/onboardingPaths';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId).catch(() => null);
  if (!rancher) {
    return NextResponse.json({ error: 'rancher not found' }, { status: 404 });
  }

  const state = evaluateOnboarding(rancher);
  return NextResponse.json({
    path: state.path,
    requirements: state.requirements,
    nextAction: state.nextAction,
    readyToGoLive: state.readyToGoLive,
    isLive: state.isLive,
    moneyModel: MONEY_MODEL,
  });
}
