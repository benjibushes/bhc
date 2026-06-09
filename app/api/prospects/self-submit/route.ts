import { NextResponse } from 'next/server';
import {
  createRecord,
  getAllRecords,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import {
  sendRancherSelfSubmitWelcome,
  sendRancherCommunityIntro,
} from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { geocodeRancher } from '@/lib/geocode';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Public endpoint — no auth. Two paths converge here:
//
//   submitterType: 'self'      → rancher adds themselves
//   submitterType: 'community' → fan/customer/neighbor flags a rancher they know
//
// Both result in a Prospect record on the map (yellow pin signal = the
// `Self-Submitted At` field being non-null). They are NOT routed buyers
// until Verification Status flips to "Verified" via the existing
// onboarding flow (call → agreement → live). The
// isRancherOperationalForBuyers gate enforces this — see
// lib/rancherEligibility.ts.
//
// What this endpoint does:
//   1. Validate (different required fields per path)
//   2. Honeypot drop
//   3. Dedupe by website host + (ranch name + state)
//   4. Geocode city + state via Nominatim (best-effort; missing coords are OK,
//      they just won't show on the map until Ben backfills)
//   5. Insert Airtable record with Verification Status = "Prospect",
//      Source Type = "manual-add" (we couldn't add a `self-submit` option
//      to the singleSelect via metadata API — schema:write was blocked),
//      Self-Submitted At = now, Notes carrying submitter context
//   6. Fire welcome / intro email
//   7. Telegram alert to Ben so he can call within 48h

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s);
}

function isValidZip(s: string): boolean {
  return /^\d{5}$/.test(s.trim());
}

function slugify(s: string, suffix?: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return suffix ? `${base}-${suffix}` : base;
}

function hostOf(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(
      /^www\./,
      ''
    );
  } catch {
    return '';
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const submitterType = body.submitterType === 'community' ? 'community' : 'self';
  const ranchName = String(body.ranchName || '').trim();
  const operatorName = String(body.operatorName || '').trim();
  const rancherEmail = String(body.rancherEmail || '').trim().toLowerCase();
  const rancherPhone = String(body.rancherPhone || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || '').trim().toUpperCase();
  const zip = String(body.zip || '').trim().slice(0, 5);
  const website = String(body.website || '').trim();
  const primaryProduct = String(body.primaryProduct || 'Beef').trim() || 'Beef';
  const notes = String(body.notes || '').trim();
  const submitterName = String(body.submitterName || '').trim();
  const submitterEmail = String(body.submitterEmail || '').trim().toLowerCase();
  const relationship = String(body.relationship || '').trim();
  const honeypot = String(body.website2 || '');

  // Honeypot — silent success. Bots think it worked, humans never see this field.
  if (honeypot) {
    return NextResponse.json({ success: true, dedupe: false });
  }

  // ── Validate per path ──
  if (!ranchName || ranchName.length < 2) {
    return NextResponse.json({ error: 'Ranch name is required' }, { status: 400 });
  }
  if (!city || !state) {
    return NextResponse.json({ error: 'City and state are required' }, { status: 400 });
  }
  if (state.length !== 2) {
    return NextResponse.json({ error: 'Use 2-letter state abbreviation' }, { status: 400 });
  }
  if (zip && !isValidZip(zip)) {
    return NextResponse.json({ error: 'ZIP must be 5 digits' }, { status: 400 });
  }

  if (submitterType === 'self') {
    if (!operatorName) {
      return NextResponse.json({ error: 'Your name is required' }, { status: 400 });
    }
    if (!isValidEmail(rancherEmail)) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
    }
  } else {
    if (!submitterName) {
      return NextResponse.json({ error: 'Your name is required' }, { status: 400 });
    }
    if (!isValidEmail(submitterEmail)) {
      return NextResponse.json({ error: 'Your email is required' }, { status: 400 });
    }
    // For community submissions, rancher email is OPTIONAL — fan may not know it.
    if (rancherEmail && !isValidEmail(rancherEmail)) {
      return NextResponse.json({ error: 'Rancher email looks invalid' }, { status: 400 });
    }
  }

  // ── Dedupe ──
  const websiteHost = website ? hostOf(website) : '';
  const safeRanch = escapeAirtableValue(ranchName);
  const safeState = escapeAirtableValue(state);
  let existing: any[] = [];
  try {
    // Match on (Ranch Name + State) OR (Website host) — either signal blocks dupe.
    const filter = websiteHost
      ? `OR(AND(LOWER({Ranch Name}) = "${safeRanch.toLowerCase()}", {State} = "${safeState}"), FIND("${escapeAirtableValue(
          websiteHost
        )}", LOWER({Website})) > 0)`
      : `AND(LOWER({Ranch Name}) = "${safeRanch.toLowerCase()}", {State} = "${safeState}")`;
    existing = (await getAllRecords(TABLES.RANCHERS, filter)) as any[];
  } catch (e) {
    console.error('[self-submit] dedupe lookup failed (continuing):', e);
  }

  if (existing.length > 0) {
    // Don't overwrite a verified record. Tell user it's already there.
    const dup = existing[0];
    const status = (dup['Verification Status'] || '').toString();
    return NextResponse.json(
      {
        success: true,
        dedupe: true,
        existingStatus: status,
        message:
          status === 'Verified'
            ? `${ranchName} is already a verified BuyHalfCow partner.`
            : `${ranchName} is already on the map — we'll reach out.`,
      },
      { status: 200 }
    );
  }

  // ── Geocode (best effort) — ZIP-first for ~3-5 mi accuracy, city+state fallback (~city centroid). ──
  const coords = await geocodeRancher({ zip, city, state });

  // ── Build Notes payload — submitter context lives here so we don't bloat schema ──
  const submittedAt = new Date().toISOString();
  const noteLines = [
    `[${submitterType}-submit ${submittedAt.slice(0, 10)}]`,
    submitterType === 'self'
      ? `Self-submitted by ${operatorName} <${rancherEmail}>${rancherPhone ? ` · ${rancherPhone}` : ''}`
      : `Community-submitted by ${submitterName} <${submitterEmail}>${
          relationship ? ` · ${relationship}` : ''
        }`,
    notes ? `Notes: ${notes}` : '',
  ].filter(Boolean);
  const composedNotes = noteLines.join('\n');

  // ── Insert ──
  const slug = slugify(ranchName, state.toLowerCase());
  const fields: Record<string, any> = {
    'Ranch Name': ranchName,
    'Operator Name': operatorName || ranchName,
    'Email': rancherEmail || '',
    'Phone': rancherPhone || '',
    'City': city,
    'State': state,
    'Zip': zip || '',
    'Website': website || '',
    'Primary Product': primaryProduct,
    'Slug': slug,
    'Verification Status': 'Prospect',
    'Source Type': 'manual-add', // schema:write blocked self-submit option; Self-Submitted At is the canonical marker
    'Self-Submitted At': submittedAt,
    'Self-Submit Drip Stage': 'welcome-sent',
    'Notes': composedNotes,
    'Public Map Hidden': false,
    // 2026-06-09 fix: was empty, causing wizard to misroute self-submitted
    // ranchers into the legacy upgrade flow. /api/apply + /api/partners
    // both default to tier_v2 now — keep self-submit consistent so every
    // new rancher signup path defaults to the new payout model.
    'Pricing Model': 'tier_v2',
  };
  if (coords) {
    fields['Latitude'] = coords.lat;
    fields['Longitude'] = coords.lng;
  }

  let created: any;
  try {
    created = await createRecord(TABLES.RANCHERS, fields);
  } catch (e) {
    console.error('[self-submit] Airtable create failed:', e);
    return NextResponse.json(
      { error: 'Could not save submission — try again' },
      { status: 500 }
    );
  }

  // ── P1-5: funnel telemetry + Meta CAPI Lead ────────────────────────────
  // /partner POST fires both (T1 commit 608535b) but /api/prospects/self-submit
  // was attribution-blind: paid traffic to /map/add-a-rancher fired ZERO
  // funnel events + ZERO CAPI Lead. Same shape as /api/partners so the
  // funnel dashboard + Meta Ads optimizer get the leads.
  try {
    await funnelRecord({
      stage: 'partner_signup',
      rancherId: created.id,
      metadata: {
        source: 'self-submit',
        submitterType,
        partnerType: 'rancher',
        state,
        recordId: created.id,
      },
    });
  } catch (e) {
    console.error('[funnel] self-submit fire failed:', e);
  }

  // CAPI Lead — fire-and-forget. Client Pixel loses ~30-50% to ATT/adblock;
  // server fire restores attribution. event_id=created.id dedupes against
  // any client fire on the success page.
  const capiIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const capiUserAgent = req.headers.get('user-agent') || undefined;
  const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(req);
  const capiEmail = rancherEmail || submitterEmail || undefined;
  const capiNameParts = (operatorName || submitterName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  fireCapi([
    {
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: `${SITE_URL}/map/add-a-rancher`,
      event_id: created.id,
      action_source: 'website',
      user_data: buildUserData({
        email: capiEmail,
        phone: rancherPhone || undefined,
        firstName: capiNameParts[0],
        lastName: capiNameParts.slice(1).join(' ') || undefined,
        state: state || undefined,
        ip: capiIp,
        userAgent: capiUserAgent,
        fbp: capiFbp,
        fbc: capiFbc,
      }),
      custom_data: {
        content_name: 'BHC Rancher Self-Submit',
        content_category: 'rancher-self-submit',
      },
    },
  ]).catch((e) => console.error('[capi] self-submit fire failed:', e));

  // ── Fire welcome / intro email (best effort) ──
  try {
    if (submitterType === 'self') {
      await sendRancherSelfSubmitWelcome({
        to: rancherEmail,
        ranchName,
        operatorName,
        rancherId: created.id,
      });
    } else if (rancherEmail) {
      // Community submit, rancher email known — send the soft intro.
      await sendRancherCommunityIntro({
        to: rancherEmail,
        ranchName,
        operatorName: operatorName || 'there',
        submitterName,
        relationship,
      });
    }
    // Community submit with no rancher email → Ben handles outreach manually
    // via Telegram alert below.
  } catch (e) {
    console.error('[self-submit] welcome email failed (non-blocking):', e);
  }

  // ── Telegram alert with one-tap action buttons ──
  // Buttons:
  //   📞 Call Now    → opens tel: link if phone present, else copies email
  //   ✉️ Onboard     → fires `ronboard_<recordId>` callback (existing handler
  //                    in app/api/webhooks/telegram/route.ts:1078 sends docs)
  //   🗺 View on map → opens public listing
  //   🚫 Block       → flips Public Map Hidden=true (handled by selfblock_)
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      const header =
        submitterType === 'self'
          ? '🟡 SELF-SUBMIT (rancher added themselves)'
          : '🟡 COMMUNITY-SUBMIT (someone flagged a rancher)';
      const lines = [
        header,
        `Ranch: ${ranchName}`,
        `City/State: ${city}, ${state}`,
        operatorName ? `Operator: ${operatorName}` : '',
        rancherEmail ? `Rancher email: ${rancherEmail}` : '(no rancher email on file)',
        rancherPhone ? `Rancher phone: ${rancherPhone}` : '',
        website ? `Website: ${website}` : '',
        submitterType === 'community'
          ? `Submitted by: ${submitterName} <${submitterEmail}>${relationship ? ` · ${relationship}` : ''}`
          : '',
        notes ? `Form notes: ${notes}` : '',
        coords ? `Coords: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : '⚠️ No geocode — manual coords needed',
        `Airtable: ${created.id}`,
      ].filter(Boolean);

      // Inline keyboard rows. Telegram URL buttons reject `tel:` and `mailto:`
      // schemes (only http/https/tg allowed) — sending those returns 400 Bad
      // Request and silently kills the entire alert. Phone + email live in
      // the message body where Telegram apps render them as tap-to-call /
      // tap-to-email automatically.
      const buttons: any[][] = [];
      if (rancherEmail) {
        buttons.push([
          { text: '✉️ Onboard (send docs)', callback_data: `ronboard_${created.id}` },
        ]);
      }
      buttons.push([
        { text: '🗺 View listing', url: `https://www.buyhalfcow.com/ranchers/${slug}` },
        { text: '🚫 Block', callback_data: `selfblock_${created.id}` },
      ]);

      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'), {
        inline_keyboard: buttons,
      });
    }
  } catch (e) {
    console.error('[self-submit] telegram alert failed (non-blocking):', e);
  }

  // ── Mint setup magic link + return it in response so the form can
  // immediately redirect into the wizard (no email round-trip required).
  // We still send the welcome email as backup so the rancher has a link to
  // come back to later, but the primary flow is instant: submit → wizard.
  let setupUrl = '';
  if (submitterType === 'self') {
    try {
      const jwtMod = await import('jsonwebtoken');
      const { JWT_SECRET } = await import('@/lib/secrets');
      const token = jwtMod.default.sign(
        { type: 'rancher-setup', rancherId: created.id },
        JWT_SECRET,
        { expiresIn: '60d' }
      );
      setupUrl = `${SITE_URL}/rancher/setup?token=${token}`;
    } catch (e) {
      console.error('[self-submit] setup token mint failed:', e);
    }
  }

  return NextResponse.json({
    success: true,
    slug,
    geocoded: !!coords,
    setupUrl, // empty string for community-submits (rancher isn't on the form)
  });
}
