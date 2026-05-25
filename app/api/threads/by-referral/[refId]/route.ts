// Lookup-or-create the thread for a buyer's referral.
// Buyer-only endpoint — the buyer-side ask form calls this to get a thread
// ID before posting messages. Auto-creates the thread on first call so the
// buyer doesn't need a separate "open conversation" step.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getOrCreateThreadForReferral, listThreadMessages } from '@/lib/contracts/threads';
import { getRecordById, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_req: Request, { params }: { params: Promise<{ refId: string }> }) {
  const ck = await cookies();
  const buyerCk = ck.get('bhc-member-auth');
  if (!buyerCk?.value) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let decoded: any;
  try {
    decoded = jwt.verify(buyerCk.value, JWT_SECRET);
  } catch {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 });
  }
  if (decoded.type !== 'member-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const { refId } = await params;
  let ref: any;
  try {
    ref = await getRecordById(TABLES.REFERRALS, refId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!ref) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerIds: string[] = ref['Buyer'] || [];
  if (!buyerIds.includes(decoded.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
  const rancherId = rancherIds[0];
  if (!rancherId) {
    return NextResponse.json({ error: 'No rancher assigned to this referral yet' }, { status: 409 });
  }

  const { id, isNew } = await getOrCreateThreadForReferral(refId, decoded.consumerId, rancherId);
  const messages = await listThreadMessages(id);
  // Fetch rancher name for the UI header.
  let rancherName = '';
  try {
    const r: any = await getRecordById(TABLES.RANCHERS, rancherId);
    rancherName = r?.['Operator Name'] || r?.['Ranch Name'] || '';
  } catch {}

  return NextResponse.json({ threadId: id, isNew, messages, rancherName });
}
