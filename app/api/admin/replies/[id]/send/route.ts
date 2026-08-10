// app/api/admin/replies/[id]/send/route.ts
//
// The one-tap Send on a cockpit "Replies waiting" row (cockpit CRM-parity,
// docs/ADAPTIVE-MARKETING-DESIGN.md §3.5 C3).
//
// [id] is a Conversations record id whose row the resend-inbound webhook
// staged (Reply Status='staged' + Staged Reply draft). This endpoint REUSES
// the Telegram bsend rail — lib/stagedReply.sendStagedReply is the single
// claim/sanitize/thread/send/stamp path — it builds no new send machinery.
//
// Mirrors the desk's mutation idiom (app/api/admin/follow-ups/[id]):
// requireAdmin, validate, act, structured JSON out.
//
// DOUBLE-SEND SAFETY: claimStagedReplySend shares the Telegram handler's
// per-conversation Redis claim key, so a cockpit tap and a Telegram tap on
// the same conversation can never both send. Fail-closed on Redis error.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { claimStagedReplySend, sendStagedReply } from '@/lib/stagedReply';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const a = await requireAdmin(req);
  if (a) return a;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ ok: false, error: 'missing id' }, { status: 400 });
  }

  const claimed = await claimStagedReplySend(id);
  if (!claimed) {
    // Already sending/sent from either surface — not an error worth a red
    // toast; the row will read 'sent' on the next poll.
    return NextResponse.json({ ok: false, error: 'already sending or sent', deduped: true }, { status: 409 });
  }

  try {
    const result = await sendStagedReply(id);
    if (result.status === 'not-found') {
      return NextResponse.json({ ok: false, error: 'conversation not found' }, { status: 404 });
    }
    if (result.status === 'already-sent') {
      return NextResponse.json({ ok: true, alreadySent: true });
    }
    if (result.status === 'no-draft') {
      return NextResponse.json(
        { ok: false, error: 'no staged draft or buyer email on record' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, sentTo: result.to });
  } catch (e: any) {
    console.error('[admin/replies/send] send failed:', e?.message || e);
    return NextResponse.json({ ok: false, error: 'send failed' }, { status: 500 });
  }
}
