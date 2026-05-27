// /api/wholesale/signup — Wholesale buyer (restaurants, butchers, distributors)
// application intake. Lands in Inquiries table w/ Interest Type='Wholesale'
// (reusing the existing table avoids a schema migration; structured wholesale
// context lives in Notes). Fires sendAdminAlert (type='consumer' — closest
// existing type, Notes describes wholesale context) + Telegram update.
//
// Rate limit: 3/min/IP + 20/hr/IP (lower than retail signup — wholesale
// volume is far lower so spam concerns are different).
// Idempotent by email — re-submits return ok:true with "already on list".
import { NextResponse } from 'next/server';
import {
  createRecord,
  getAllRecords,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { sendAdminAlert } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { normalizeState } from '@/lib/states';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData } from '@/lib/metaCapi';

export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = [
    'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
    'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com',
    '10minutemail.com', 'trashmail.com',
  ];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

interface WholesaleSignupBody {
  businessName?: string;
  businessType?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  state?: string;
  monthlyVolume?: string;
  cutsOfInterest?: string[];
  timeline?: string;
  notes?: string;
}

export async function POST(request: Request) {
  try {
    const ip = getRequestIp(request);
    const rlMin = await rateLimit(`wholesale:${ip}`, { requests: 3, window: '1m' });
    if (!rlMin.ok) {
      return NextResponse.json(
        { error: 'Too many submissions from this network — wait a minute and try again.' },
        { status: 429 },
      );
    }
    const rlHour = await rateLimit(`wholesale-hr:${ip}`, { requests: 20, window: '1h' });
    if (!rlHour.ok) {
      return NextResponse.json(
        { error: 'Too many submissions from this network in the past hour. Email ben@buyhalfcow.com if this is wrong.' },
        { status: 429 },
      );
    }

    let body: WholesaleSignupBody;
    try {
      body = (await request.json()) as WholesaleSignupBody;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const businessName = (body.businessName || '').toString().trim();
    const businessType = (body.businessType || '').toString().trim();
    const contactName = (body.contactName || '').toString().trim();
    const email = (body.email || '').toString().trim().toLowerCase();
    const phone = (body.phone || '').toString().trim();
    const stateRaw = (body.state || '').toString().trim();
    const monthlyVolume = (body.monthlyVolume || '').toString().trim();
    const cutsOfInterest = Array.isArray(body.cutsOfInterest)
      ? body.cutsOfInterest.map((c) => String(c)).filter(Boolean)
      : [];
    const timeline = (body.timeline || '').toString().trim();
    const notes = (body.notes || '').toString().trim().slice(0, 500);

    if (!businessName) {
      return NextResponse.json({ error: 'Business name is required.' }, { status: 400 });
    }
    if (!contactName) {
      return NextResponse.json({ error: 'Contact name is required.' }, { status: 400 });
    }
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: 'Valid email is required.' }, { status: 400 });
    }
    if (!phone) {
      return NextResponse.json({ error: 'Phone number is required.' }, { status: 400 });
    }
    const state = normalizeState(stateRaw);
    if (!state) {
      return NextResponse.json({ error: 'Valid state is required.' }, { status: 400 });
    }

    // Idempotency check — Wholesale rows in Inquiries are scoped by
    // Interest Type='Wholesale' + Consumer Email match. Re-submits return
    // ok:true w/ "already on list" so the form succeeds gracefully.
    try {
      const existing = await getAllRecords(
        TABLES.INQUIRIES,
        `AND({Interest Type} = "Wholesale", LOWER({Consumer Email}) = "${escapeAirtableValue(email).toLowerCase()}")`,
      );
      if (Array.isArray(existing) && existing.length > 0) {
        return NextResponse.json({
          ok: true,
          message: "You're already on our wholesale list. Ben will reach out shortly.",
          alreadyOnList: true,
        });
      }
    } catch (e: any) {
      // Idempotency lookup is best-effort — don't block submission on
      // Airtable hiccups. Worst case is a duplicate row that ops dedupes.
      console.warn('[wholesale/signup] idempotency lookup failed:', e?.message);
    }

    // Structured Notes payload — captures the full wholesale context in
    // the existing Inquiries schema without a new column for every field.
    const structuredNotes = [
      `WHOLESALE APPLICATION`,
      `Business: ${businessName}`,
      `Business Type: ${businessType || 'Not specified'}`,
      `Contact: ${contactName}`,
      `Phone: ${phone}`,
      `State: ${state}`,
      `Monthly Volume: ${monthlyVolume || 'Not specified'}`,
      `Cuts of Interest: ${cutsOfInterest.length > 0 ? cutsOfInterest.join(', ') : 'Not specified'}`,
      `Timeline: ${timeline || 'Not specified'}`,
      notes ? `Notes: ${notes}` : '',
    ].filter(Boolean).join('\n');

    const inquiryFields: Record<string, any> = {
      'Consumer Name': contactName,
      'Consumer Email': email,
      'Consumer Phone': phone,
      'Ranch Name': businessName, // co-opting field for business name (no schema change)
      'Message': structuredNotes,
      'Notes': structuredNotes,
      'Interest Type': 'Wholesale',
      'Status': 'New',
      'Sale Amount': 0,
      'Commission Amount': 0,
      'Source': 'wholesale_form',
    };

    let recordId = '';
    try {
      const record = await createRecord(TABLES.INQUIRIES, inquiryFields);
      recordId = record?.id || '';
    } catch (e: any) {
      console.error('[wholesale/signup] Airtable create failed:', e?.message);
      return NextResponse.json(
        { error: 'Could not save your application. Please try again or email ben@buyhalfcow.com.' },
        { status: 500 },
      );
    }

    // Fire admin alert email — type='consumer' is the closest existing
    // template type. Notes field in details makes the wholesale context
    // unambiguous to the operator.
    try {
      await sendAdminAlert({
        type: 'consumer',
        name: `${contactName} (${businessName})`,
        email,
        details: {
          'Application Type': 'WHOLESALE',
          'Business Name': businessName,
          'Business Type': businessType || 'Not specified',
          'Phone': phone,
          'State': state,
          'Monthly Volume': monthlyVolume || 'Not specified',
          'Cuts of Interest': cutsOfInterest.join(', ') || 'Not specified',
          'Timeline': timeline || 'Not specified',
          'Notes': notes || '(none)',
          'Inquiry Record': recordId,
        },
      });
    } catch (e: any) {
      console.warn('[wholesale/signup] admin email failed (non-fatal):', e?.message);
    }

    // Telegram alert — wholesale-specific copy so the operator can triage
    // at a glance. Uses sendTelegramUpdate which targets the admin chat.
    try {
      const tgMsg =
        `NEW WHOLESALE APPLICATION: ${businessName} (${state}) ` +
        `wants ${monthlyVolume || 'unspecified volume'} — ` +
        `${contactName} ${email} ${phone}`;
      await sendTelegramUpdate(tgMsg);
    } catch (e: any) {
      console.warn('[wholesale/signup] telegram failed (non-fatal):', e?.message);
    }

    // ── Funnel telemetry — wholesale_submit ─────────────────────────────
    // Audit 6 P1: wholesale buyers ($5-15k AOV) need funnel segmentation
    // alongside retail. Non-fatal — failure here doesn't break flow.
    await funnelRecord({
      stage: 'wholesale_submit',
      metadata: {
        businessName,
        businessType,
        state,
        monthlyVolume,
        timeline,
        recordId,
      },
    });

    // ── Meta Conversions API: server-side `Lead` event ──────────────────
    // Audit 6 P1: client already fires wholesale_submit_success but iOS
    // 14.5+ ATT loses 30-50% of client events. Server CAPI mirrors with
    // event_id=recordId so Meta dedupes client+server fires. Restores
    // attribution for wholesale paid-ad ROAS measurement.
    const capiIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const capiUserAgent = request.headers.get('user-agent') || undefined;
    const nameParts = contactName.trim().split(/\s+/).filter(Boolean);
    fireCapi([
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: `${SITE_URL}/wholesale`,
        event_id: recordId,
        action_source: 'website',
        user_data: buildUserData({
          email,
          phone,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' ') || undefined,
          state,
          ip: capiIp,
          userAgent: capiUserAgent,
        }),
        custom_data: {
          content_name: businessName,
          content_category: 'wholesale',
        },
      },
    ]).catch((e) =>
      console.error('[meta-capi] wholesale lead fire failed:', e),
    );

    // E-4 audit fix: return recordId so the client wholesale_submit_success
    // Pixel fire can pass event_id=recordId, matching the server CAPI Lead
    // fire above. Without this the client+server fires are seen by Meta
    // as two distinct events → double-count + no dedup attribution.
    return NextResponse.json({
      ok: true,
      message:
        "We've received your application. Ben will personally reach out within 24-48 hours with verified ranchers in your state matching your volume + timeline.",
      recordId,
    });
  } catch (error: any) {
    console.error('[wholesale/signup] unexpected error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal server error' },
      { status: 500 },
    );
  }
}
