// POST /api/partner/represent — notify-only rancher signup for the BROKER RAIL.
//
// PUBLIC endpoint (no auth). A rancher agrees to be REPRESENTED: BHC sells his
// beef, collects the buyer's deposit as its commission, and emails him each
// order. He installs nothing, logs into nothing, and is never invoiced.
//
// WHAT THIS DELIBERATELY DOES NOT DO — every one of these would drag a
// represented rancher onto the platform he explicitly isn't on:
//   • NO `Active Status`            → left EMPTY. Never routable. This is the
//                                     primary routing block; the explicit
//                                     `Broker Rail` exclusions in
//                                     lib/rancherEligibility et al are the belt.
//   • NO Stripe Connect             → no account create, no onboarding link.
//   • NO `Slug` / `Page Live`       → no public page, no marketplace listing,
//                                     no map pin, no sitemap entry.
//   • NO onboarding wizard email    → no setup link, no drip, no chase. The
//                                     onboarding crons exclude Broker Rail.
//   • NO `Onboarding Status` / `Self-Submitted At` → setting either would pull
//                                     him into the onboarding + drip crons.
//   • NO geocode                    → lat/lng absent keeps him off /map even
//                                     if the map's formula ever loosens.
//
// The page states the commission math in plain language BEFORE submit, and the
// confirmation email restates it — the rancher's agreement to fund the
// commission out of his price must exist in writing, not be discovered later.

import { NextResponse } from 'next/server';
import { createRecord, updateRecord, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendBrokerRepresentConfirmation } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { BROKER_RAIL_FIELD, BROKER_BALANCE_NOTE_FIELD, BROKER_BALANCE_NOTE_FALLBACK } from '@/lib/brokerRail';
import { formatPhoneInput, isValidUsPhone } from '@/lib/phoneFormat';
import { normalizeState } from '@/lib/states';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s);
}

export async function POST(request: Request) {
  // Public endpoint — cap abuse. Fails OPEN (Redis absent) so a real rancher
  // is never wrongly bounced.
  const rl = await rateLimit(`partner-represent:${getRequestIp(request)}`, {
    requests: 5,
    window: '15m',
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many submissions — give it a few minutes and try again.' },
      { status: 429 },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Honeypot — bots fill hidden fields; humans never see this one.
  if (String(body?.website_url || '').trim()) {
    return NextResponse.json({ ok: true });
  }

  const ranchName = String(body?.ranchName || '').trim();
  const contactName = String(body?.contactName || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const phoneRaw = String(body?.phone || '').trim();
  const state = normalizeState(body?.state) || '';
  const sells = String(body?.sells || '').trim();
  const balanceNote = String(body?.balanceNote || '').trim();
  // The rancher must actively accept the commission terms shown on the page.
  const agreed = body?.agreedToCommission === true;

  if (!ranchName) return NextResponse.json({ error: 'Ranch name is required' }, { status: 400 });
  if (!contactName) return NextResponse.json({ error: 'Your name is required' }, { status: 400 });
  if (!isValidEmail(email)) return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  // Phone + State are OPTIONAL (2026-08-02 friction cut): the broker rail is a
  // one-page speed play and email is the rail's only required channel — the
  // existing-rancher branch below never wrote either field anyway. When
  // provided they're still recorded (formatted when parseable, else as typed
  // so nothing the rancher gave us is lost).
  if (!agreed) {
    // The whole rail depends on this agreement being explicit and recorded.
    return NextResponse.json(
      { error: 'Please confirm you understand how BuyHalfCow is paid before submitting.' },
      { status: 400 },
    );
  }

  const phone = phoneRaw ? (isValidUsPhone(phoneRaw) ? formatPhoneInput(phoneRaw) : phoneRaw) : '';

  // Dedupe by email. This matches ANY row in the Ranchers table, not just
  // broker rows — and that table holds prospects and half-onboarded leads Ben
  // entered by hand. The old behaviour returned {ok:true,duplicate:true} and
  // RETURNED HERE, before writing Broker Rail, before the balance note, before
  // the confirmation email, and before the Telegram. The rancher was told he
  // was represented, nothing was written, and Ben never found out. Now an
  // existing row is UPGRADED onto the broker rail and still alerts.
  let existingId = '';
  let alreadyBroker = false;
  try {
    const existing: any[] = await getAllRecords(
      TABLES.RANCHERS,
      `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
    );
    if (existing.length > 0) {
      existingId = existing[0].id;
      alreadyBroker = !!existing[0].fields?.[BROKER_RAIL_FIELD];
    }
  } catch (e: any) {
    // A dedupe read failure must not block a real signup; worst case is a
    // duplicate row an operator merges.
    console.warn('[partner/represent] dedupe read failed (continuing):', e?.message);
  }

  const nowIso = new Date().toISOString();
  const fields: Record<string, any> = {
    'Ranch Name': ranchName,
    'Operator Name': contactName,
    Email: email,
    // Phone/State only when provided — never write blanks into the record.
    ...(phone ? { Phone: phone } : {}),
    ...(state ? { State: state } : {}),
    // THE rail flag. Everything downstream keys off this.
    [BROKER_RAIL_FIELD]: true,
    [BROKER_BALANCE_NOTE_FIELD]: balanceNote || BROKER_BALANCE_NOTE_FALLBACK,
    // Written proof of the terms he accepted, on the record itself — the
    // commission agreement must be auditable without digging through email.
    'Ops Notes (Internal)': [
      `[BROKER RAIL] Represented seller signed up ${nowIso}.`,
      `Agreed: BHC collects the buyer deposit as its full commission; rancher collects (price - deposit) direct from the buyer and nets that amount.`,
      sells ? `Sells: ${sells}` : '',
      `Balance collection: ${balanceNote || BROKER_BALANCE_NOTE_FALLBACK}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
  if (sells) fields['Beef Types'] = sells;
  // NOTE the absences: Active Status, Onboarding Status, Slug, Page Live,
  // Self-Submitted At, Verification Status, Agreement Signed, Latitude,
  // Longitude. See the file header — each one is a deliberate omission.

  let rancherId = '';
  try {
    if (existingId) {
      // Upgrade the existing row onto the broker rail. Ranch Name / Operator
      // Name / Phone / State are left ALONE — an operator may have corrected
      // them by hand and the signup form should not clobber that. The rail
      // flag, the balance note and the written agreement are what must land.
      await updateRecord(TABLES.RANCHERS, existingId, {
        [BROKER_RAIL_FIELD]: true,
        [BROKER_BALANCE_NOTE_FIELD]: balanceNote || BROKER_BALANCE_NOTE_FALLBACK,
        'Ops Notes (Internal)': fields['Ops Notes (Internal)'],
        ...(sells ? { 'Beef Types': sells } : {}),
      });
      rancherId = existingId;
    } else {
      const created: any = await createRecord(TABLES.RANCHERS, fields);
      rancherId = created?.id || '';
    }
  } catch (e: any) {
    console.error('[partner/represent] rancher write failed:', e?.message);
    return NextResponse.json(
      { error: 'We could not save that. Please try again, or email hello@buyhalfcow.com.' },
      { status: 502 },
    );
  }

  // Confirmation email restating the money terms. Best-effort — a send failure
  // must not lose a signup that already saved.
  try {
    await sendBrokerRepresentConfirmation({
      ranchName,
      contactName,
      email,
      balanceNote: balanceNote || BROKER_BALANCE_NOTE_FALLBACK,
    });
  } catch (e: any) {
    console.error('[partner/represent] confirmation email failed:', e?.message);
  }

  // Operator alert — Ben needs prices before he can sell this ranch at all.
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      [
        existingId
          ? `🤝 <b>EXISTING RANCH MOVED TO BROKER RAIL</b>${alreadyBroker ? ' (re-submitted)' : ''}`
          : `🤝 <b>NEW REPRESENTED RANCH</b>`,
        '',
        state ? `${ranchName} — ${state}` : ranchName,
        phone ? `${contactName} · ${phone}` : contactName,
        `Email: ${email}`,
        sells ? `Sells: ${sells}` : '',
        '',
        `<b>Next: set Quarter/Half/Whole Price AND Deposit on this record.</b>`,
        `Broker checkout refuses any cut without both (the deposit IS your commission and is never derived).`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } catch {}

  return NextResponse.json({
    ok: true,
    rancherId,
    duplicate: !!existingId,
    message: "You're set up. We'll email you the moment a share sells.",
  });
}
