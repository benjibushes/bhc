// app/api/qualify/[consumerId]/reservation-hold/route.ts
//
// F7 — Buyer requests $49 reservation hold checkout. Returns Stripe URL.
// Gated by ENABLE_RESERVATION_HOLD env flag. When off → 404.

import { NextRequest, NextResponse } from 'next/server';
import { getRecord, TABLES } from '@/lib/airtable';
import {
  createHoldCheckoutSession,
  isReservationHoldEnabled,
  hasReservationHold,
} from '@/lib/reservationHold';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ consumerId: string }> }
) {
  if (!isReservationHoldEnabled()) {
    return NextResponse.json({ ok: false, error: 'feature disabled' }, { status: 404 });
  }

  const { consumerId } = await params;
  if (!consumerId) {
    return NextResponse.json({ ok: false, error: 'missing consumerId' }, { status: 400 });
  }

  const consumer = await getRecord(TABLES.CONSUMERS, consumerId).catch(() => null);
  if (!consumer) {
    return NextResponse.json({ ok: false, error: 'consumer not found' }, { status: 404 });
  }

  // Idempotency: already paid
  if (hasReservationHold(consumer)) {
    return NextResponse.json({ ok: true, alreadyPaid: true });
  }

  const origin = new URL(req.url).origin;
  const successUrl = `${origin}/qualify/${consumerId}?hold=paid`;
  const cancelUrl = `${origin}/qualify/${consumerId}?hold=cancel`;

  try {
    const result = await createHoldCheckoutSession({
      consumerId,
      consumerEmail: String((consumer as any)['Email'] || ''),
      buyerName: String((consumer as any)['Full Name'] || 'buyer'),
      successUrl,
      cancelUrl,
    });
    if (!result) {
      return NextResponse.json(
        { ok: false, error: 'checkout creation failed' },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, url: result.url, sessionId: result.sessionId });
  } catch (e: any) {
    console.error('[reservation-hold] checkout error:', e?.message);
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
