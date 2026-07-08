// app/api/rancher/push/subscribe/route.ts
//
// Rancher PWA push registration. POST stores the browser's PushSubscription
// on the rancher's row (dedupe by endpoint, 5-device cap); DELETE removes
// one endpoint (the dashboard's "turn off notifications"). Auth mirrors
// every other rancher route: requireRancher session, writes scoped to the
// caller's own row — a rancher can never touch another rancher's devices.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import {
  parseSubscriptions,
  addSubscription,
  removeSubscription,
  pushConfigured,
  type StoredPushSubscription,
} from '@/lib/rancherPush';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function validSubscription(body: any): StoredPushSubscription | null {
  const endpoint = String(body?.endpoint || '');
  const p256dh = String(body?.keys?.p256dh || '');
  const auth = String(body?.keys?.auth || '');
  if (!endpoint.startsWith('https://') || endpoint.length > 1000) return null;
  if (!p256dh || !auth || p256dh.length > 300 || auth.length > 100) return null;
  return { endpoint, keys: { p256dh, auth } };
}

export async function POST(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  if (!pushConfigured()) {
    return NextResponse.json({ error: 'push not configured' }, { status: 503 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }

  const sub = validSubscription(body);
  if (!sub) return NextResponse.json({ error: 'invalid subscription' }, { status: 400 });

  try {
    const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
    const next = addSubscription(parseSubscriptions(rancher?.['Push Subscriptions']), sub);
    await updateRecord(TABLES.RANCHERS, session.rancherId, {
      'Push Subscriptions': JSON.stringify(next),
    });
    return NextResponse.json({ ok: true, devices: next.length });
  } catch (e: any) {
    console.error('[rancher/push] subscribe failed:', e?.message);
    return NextResponse.json({ error: 'could not save — try again' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }
  const endpoint = String(body?.endpoint || '');
  if (!endpoint) return NextResponse.json({ error: 'endpoint required' }, { status: 400 });

  try {
    const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
    const next = removeSubscription(parseSubscriptions(rancher?.['Push Subscriptions']), endpoint);
    await updateRecord(TABLES.RANCHERS, session.rancherId, {
      'Push Subscriptions': next.length ? JSON.stringify(next) : '',
    });
    return NextResponse.json({ ok: true, devices: next.length });
  } catch (e: any) {
    console.error('[rancher/push] unsubscribe failed:', e?.message);
    return NextResponse.json({ error: 'could not save — try again' }, { status: 500 });
  }
}
