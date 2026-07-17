// POST /api/guide/signup — the quiz-free lead-magnet capture (reach lever #2).
//
// Reach research (2026-07-06): every list-capture surface sat BEHIND the $2k
// quiz — 40k followers, ~1,966 owned. This is the first email-only door:
// trade "The Real Cost of a Half Cow" guide for an email (+ optional SMS
// opt-in), landing the contact in the SAME Consumers pipeline every flow
// already reads (waiting-activation, shop-drop, nurture, recovery).
//
// Public endpoint → rate-limited, honeypot-checked, formula-injection-safe.
// The guide is delivered by email ('halfcow_guide', whitelisted — it IS the
// thing they asked for). Consumer upsert mirrors orders/request: find by
// email; SMS Opt-In only ever flips false→true.

import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { normalizeState } from '@/lib/states';
import { sendEmail } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function guideHtml(firstName: string): string {
  const f = firstName || 'there';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
    <p>hey ${f},</p>
    <p>here's the honest math on a half cow — the version nobody selling you one will give you.</p>
    <h2 style="font-family:Georgia,serif;font-size:20px;margin:24px 0 8px">the real cost</h2>
    <p style="font-size:14.5px;line-height:1.6">a half beef typically runs <strong>$3,000&ndash;3,700 all-in</strong> (animal + processing) and lands <strong>180&ndash;220 lbs</strong> of packaged beef in your freezer. ranchers quote it at <strong>$8&ndash;11 per pound of hanging weight</strong> &mdash; blended out, about $14&ndash;20 per pound in your freezer, and every pound costs the same whether it's ground chuck or tenderloin. the same grass-fed cuts bought &agrave; la carte run $9&ndash;35/lb.</p>
    <h2 style="font-family:Georgia,serif;font-size:20px;margin:24px 0 8px">the honest part</h2>
    <p style="font-size:14.5px;line-height:1.6">roughly <strong>40&ndash;50% arrives as ground and stew</strong> &mdash; you're stocking a freezer, not buying a box of ribeyes. you'll also want <strong>~8&ndash;10 cubic feet of freezer space</strong> (a $200&ndash;300 chest freezer pays for itself in the first fill).</p>
    <h2 style="font-family:Georgia,serif;font-size:20px;margin:24px 0 8px">how it works on buyhalfcow</h2>
    <p style="font-size:14.5px;line-height:1.6">a small deposit reserves your share with a named, verified ranch &mdash; fully refundable until the rancher accepts. you pay the balance at final weight. the rancher you buy from is a real family you can meet, not a warehouse.</p>
    <p style="margin:24px 0"><a href="${SITE_URL}/access?utm_source=email&utm_medium=guide&utm_campaign=halfcow-guide" style="display:inline-block;padding:13px 26px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-size:14px;font-weight:600">see if a share fits — 90-second quiz &rarr;</a></p>
    <p style="font-size:13px;color:#5A5752">not ready for a freezer full? start smaller &mdash; <a href="${SITE_URL}/shop?utm_source=email&utm_medium=guide&utm_campaign=halfcow-guide" style="color:#6B4F3F">jerky and boxes from the same ranches, shipped to your door</a>.</p>
    <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
  </div>`;
}

export async function POST(request: Request) {
  const ip = getRequestIp(request);
  const rl = await rateLimit(`guide:signup:${ip}`, { requests: 6, window: '1m' });
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many requests — try again in a minute.' }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  // Honeypot — bots fill every field; humans never see this one.
  if (typeof body?.website === 'string' && body.website.trim() !== '') {
    return NextResponse.json({ ok: true }); // silent success for bots
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const fullName = String(body?.fullName || '').trim().slice(0, 100);
  const phone = String(body?.phone || '').trim().slice(0, 30);
  const state = normalizeState(String(body?.state || '')) || '';
  const wantsSms = body?.smsOptIn === true && phone.length > 0;
  if (!email.includes('@') || email.length > 254) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  }

  // Find-or-create the Consumer (mirrors orders/request; SMS Opt-In only ever
  // flips false→true — an unchecked box is not a revocation).
  let consumerId = '';
  try {
    const existing: any[] = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
    );
    if (existing.length > 0) {
      consumerId = existing[0].id;
      const patch: Record<string, any> = {};
      if (wantsSms && (existing[0] as any)['SMS Opt-In'] !== true) {
        patch['SMS Opt-In'] = true;
        patch['SMS Opt-In At'] = new Date().toISOString();
      }
      if (phone && !(existing[0] as any)['Phone']) patch['Phone'] = phone;
      if (state && !(existing[0] as any)['State']) patch['State'] = state;
      if (Object.keys(patch).length > 0) {
        await updateRecord(TABLES.CONSUMERS, consumerId, patch).catch(() => {});
      }
    } else {
      const created: any = await createRecord(TABLES.CONSUMERS, {
        'Full Name': fullName || email.split('@')[0],
        Email: email,
        Phone: phone,
        State: state,
        Segment: 'Beef Buyer',
        'Lead Source': 'halfcow-guide',
        // ADOPT INTO THE LIVE DRIP (2026-07-17, revenue-path audit): without
        // these two stamps a guide lead was a terminal orphan — 'Lead Source'
        // is written here and read by NOTHING, and a row with no Status and no
        // Buyer Stage is invisible to every cron (abandoned-quiz-nudge needs
        // Status='Approved'; waiting-activation reads Buyer Stage). The lead
        // got exactly one email in their lifetime and then went dark forever.
        // Status+Stage make the already-built, already-live, already-whitelisted
        // 4-touch abandoned-quiz drip pick them up with zero new code — which
        // is what this route's own header always claimed it did.
        Status: 'Approved',
        'Buyer Stage': 'NEW',
        ...(wantsSms ? { 'SMS Opt-In': true, 'SMS Opt-In At': new Date().toISOString() } : {}),
      });
      consumerId = created?.id || '';
    }
  } catch (e: any) {
    return NextResponse.json({ error: 'Could not save your spot — try again.' }, { status: 502 });
  }

  // Deliver the goods — this email IS the product they asked for.
  const first = (fullName || '').split(/\s+/)[0] || '';
  const sent = await sendEmail({
    to: email,
    subject: 'the real cost of a half cow — the honest math',
    html: guideHtml(first),
    templateName: 'halfcow_guide',
  }).catch(() => null);

  return NextResponse.json({ ok: true, delivered: !!sent?.success, consumerId: consumerId ? true : false });
}
