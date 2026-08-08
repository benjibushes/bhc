// app/api/marketing/keep/route.ts
//
// P5′ SUNSET keep-me landing: the one-click "keep me on the list" link inside
// the marketing-sunset re-permission email. Follows the buyer/reconfirm +
// warmup/engage pattern — a signed one-purpose JWT (type 'sunset-keep', 90d)
// so the link can't be enumerated.
//
// The click IS an email click, so it stamps the SAME truth the Resend webhook
// would ('Last Email Clicked At') plus a [SUNSET-KEEP] Notes marker — both
// are what lib/marketingSunset.decideSunset reads as engagement, which stops
// the 30-day suppression clock. Direct-stamped (not webhook-reliant) because
// Resend click-tracking coverage must never decide whether we keep a
// permission the buyer explicitly gave.
//
// GET because it's an email link (one tap). SAFE for scanners/prefetchers:
// re-stamping "keep me" on someone already on the list is idempotent in
// effect and destroys nothing — the failure direction of a phantom click is
// KEEPING a subscriber, never suppressing one (same reasoning as
// buyer/reconfirm's GET).

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { SUNSET_KEEP_MARKER } from '@/lib/marketingSunset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  let consumerId = '';
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded?.type !== 'sunset-keep' || !decoded?.consumerId) throw new Error('wrong type');
    consumerId = String(decoded.consumerId);
  } catch {
    // Bad/expired token → home, never an error page from an email click.
    return NextResponse.redirect(`${SITE_URL}/`, 302);
  }

  try {
    const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId);
    if (consumer) {
      const today = new Date().toISOString().slice(0, 10);
      const line = `${SUNSET_KEEP_MARKER} ${today}] buyer one-clicked "keep me on the list" (marketing-sunset)`;
      const existing = String(consumer['Notes'] || '');
      await updateRecord(TABLES.CONSUMERS, consumerId, {
        'Last Email Clicked At': new Date().toISOString(),
        Notes: existing.includes(line) ? existing : existing ? `${existing}\n${line}` : line,
      });
    }
  } catch (e: any) {
    // Non-fatal — the confirmation still renders; the webhook click stamp is
    // the backup truth if Resend click-tracking catches this hop.
    console.warn('[marketing/keep] stamp failed:', e?.message);
  }

  // Tiny inline confirmation — no dedicated page exists for this and a
  // redirect-to-homepage would leave the click feeling ignored.
  return new NextResponse(
    `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>You're on the list — BuyHalfCow</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F4F1EC;color:#0E0E0E;margin:0;padding:40px 20px;">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #A7A29A;padding:40px;">
    <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;">you're staying on the list.</h1>
    <p style="line-height:1.6;">good — you'll keep getting ranch updates. nothing else to do.</p>
    <p style="margin:28px 0;"><a href="${SITE_URL}/shop" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600;">see what's fresh &rarr;</a></p>
    <p style="font-size:12px;color:#A7A29A;">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
  </div>
</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
