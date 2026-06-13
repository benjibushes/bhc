import { NextResponse } from 'next/server';
import { createRecord, getAllRecords, escapeAirtableValue, findOrCreateRancherByEmail } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendPartnerConfirmation, sendAdminAlert } from '@/lib/email';
import { sendTelegramPartnerAlert } from '@/lib/telegram';
import { validateAffiliateRefForSignup } from '@/lib/affiliates';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { normalizeState } from '@/lib/states';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';

export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com'];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

export async function POST(request: Request) {
  try {
    // Stricter than buyer signup — fires onboarding emails. #10.
    const ip = getRequestIp(request);
    const rlMin = await rateLimit(`partner:${ip}`, { requests: 2, window: '1m' });
    if (!rlMin.ok) {
      return NextResponse.json(
        { error: 'Too many partner applications from this network — wait a minute.' },
        { status: 429 },
      );
    }
    const rlHour = await rateLimit(`partner-hr:${ip}`, { requests: 10, window: '1h' });
    if (!rlHour.ok) {
      return NextResponse.json(
        { error: 'Too many partner applications from this network in the past hour. Email ben@buyhalfcow.com if this is wrong.' },
        { status: 429 },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { partnerType, ref } = body;
    // Pull whichever email + phone the body carries (rancher/brand/land each
    // carry `email`/`phone` as the primary contact). validateAffiliateRefForSignup
    // uses them to block self-referral; safe to pass undefined. Phone match
    // closes the `me+sock@x.com` loophole — an affiliate trying to refer
    // themselves under a fresh email but the same phone is rejected.
    const partnerEmail = typeof body?.email === 'string' ? body.email : undefined;
    const partnerPhoneRaw = typeof body?.phone === 'string' ? body.phone : undefined;
    const referredBy = await validateAffiliateRefForSignup(ref, {
      email: partnerEmail,
      phone: partnerPhoneRaw,
    });

    if (!partnerType) {
      return NextResponse.json({ error: 'Partner type is required' }, { status: 400 });
    }

    let record;
    let tableName;

    if (partnerType === 'rancher') {
      const { ranchName, operatorName, email, phone, state, acreage, beefTypes, monthlyCapacity, certifications, operationDetails, callScheduled, ranchTourInterested, ranchTourAvailability } = body;

      if (!ranchName || !operatorName || !email || !state || !beefTypes) {
        return NextResponse.json({ error: 'Missing required fields for rancher' }, { status: 400 });
      }

      if (!isValidEmail(email)) {
        return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
      }

      // Widened dedupe (2026-06-09): exact-email match only meant Jesse
      // Zimmerman could open a 2nd record for Renick Valley Meats by using
      // jesse@renickvalley.com while Jesse Gajewski's row used
      // renickvalley@gmail.com. Now also match by phone OR by
      // (Ranch Name + State) so a 2nd team member can't fork. Returns the
      // matched record id in the error body so the operator can manually
      // merge if needed.
      //
      // 2026-06-13: routed through the shared findOrCreateRancherByEmail guard
      // (lookup mode) so /apply, /prospects/self-submit, /partners, and login
      // all normalize + match identically. This branch additionally gains a
      // Team Emails match (a teammate already listed on the canonical row no
      // longer forks a 2nd row). Behavior preserved: still returns 409 on any
      // match. matchedBy now reports the exact signal that fired.
      try {
        const { record: match, matchedBy } = await findOrCreateRancherByEmail(
          email,
          {},
          {
            phone: phone || undefined,
            ranchName: ranchName || undefined,
            state: normalizeState(state) || state || undefined,
            createIfMissing: false,
          },
        );
        if (match) {
          return NextResponse.json(
            {
              error:
                'This ranch is already in our system. Check your inbox for your confirmation OR email ben@buyhalfcow.com if you need access.',
              existingId: match.id,
              matchedBy: matchedBy || 'unknown',
            },
            { status: 409 },
          );
        }
      } catch (e) {
        console.error('Error checking duplicate rancher:', e);
      }

      tableName = TABLES.RANCHERS;
      const rancherFields: any = {
        'Ranch Name': ranchName,
        'Operator Name': operatorName,
        'Email': email,
        'Phone': phone || '',
        'State': normalizeState(state) || state,
        'Beef Types': beefTypes,
        'Monthly Capacity': parseInt(monthlyCapacity) || 0,
        'Certifications': certifications || '',
        'Operation Details': operationDetails || '',
        'Acreage': parseInt(acreage) || 0,
        'Status': 'Pending',
        // 2026-06-09 fix: was empty, causing wizard to misroute new ranchers
        // into the legacy upgrade flow instead of the standard new-rancher
        // path. /api/apply already sets this; /api/partners must match so
        // every new rancher signup path defaults to the new payout model.
        'Pricing Model': 'tier_v2',
      };
      if (referredBy) rancherFields['Referred By'] = referredBy;

      // Add call scheduled if confirmed
      if (callScheduled) {
        rancherFields['Call Scheduled'] = true;
      }

      // Add ranch tour fields if provided
      if (ranchTourInterested) {
        rancherFields['Ranch Tour Interested'] = true;
        if (ranchTourAvailability) {
          rancherFields['Ranch Tour Availability'] = ranchTourAvailability;
        }
      }

      record = await createRecord(tableName, rancherFields);

      // Send confirmation email
      await sendPartnerConfirmation({
        type: 'rancher',
        name: operatorName,
        email,
      });

      // AUTO-SEND ONBOARDING DOCS IMMEDIATELY.
      // Previously Ben had to tap a Telegram button to manually send the
      // agreement + info packet. Now fires automatically so the rancher can
      // self-serve sign + set up their profile without waiting on a human.
      // If the onboarding-docs send fails we loudly alert admin over Telegram
      // — silent failure here used to strand ranchers at "signed up, expected
      // an email, never got one" with no recovery path.
      try {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
        const res = await fetch(`${siteUrl}/api/ranchers/${record.id}/send-onboarding`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
          },
          body: JSON.stringify({
            confirmedCapacity: parseInt(monthlyCapacity) || 10,
            includeVerification: true,
          }),
        });
        if (!res.ok) {
          // send-onboarding already fired a Telegram alert when it failed.
          // Still log here so the partner-signup request shows the error.
          const errBody = await res.json().catch(() => ({}));
          console.error('Auto-send onboarding returned non-ok:', res.status, errBody);
        }
      } catch (e) {
        // Network/DNS/etc — send-onboarding didn't run at all. Alert admin.
        console.error('Auto-send onboarding error:', e);
        try {
          const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `⚠️ <b>Auto-send onboarding FAILED</b> for new rancher ${ranchName} (${email})\nManually trigger from admin dashboard or call /api/ranchers/${record.id}/send-onboarding.`
          );
        } catch {}
      }

      // Send admin alert
      await sendAdminAlert({
        type: 'rancher',
        name: ranchName,
        email,
        details: {
          Operator: operatorName,
          State: normalizeState(state) || state,
          'Beef Types': beefTypes,
          'Monthly Capacity': monthlyCapacity,
        },
      });

      try {
        await sendTelegramPartnerAlert({
          type: 'rancher',
          recordId: record.id,
          name: `${operatorName} — ${ranchName}`,
          email,
          state,
          details: `🥩 <b>Beef:</b> ${beefTypes}\n📦 <b>Capacity:</b> ${monthlyCapacity || 'N/A'}/mo${callScheduled ? '\n📅 Call scheduled' : ''}\n📧 Onboarding docs auto-sent`,
        });
      } catch (e) {
        console.error('Telegram rancher alert error:', e);
      }
    }

    // Handle Brand application
    else if (partnerType === 'brand') {
      const { brandName, contactName, email, phone, website, productType, discountOffered, promotionDetails } = body;

      if (!brandName || !contactName || !email || !productType) {
        return NextResponse.json({ error: 'Missing required fields for brand' }, { status: 400 });
      }

      if (!isValidEmail(email)) {
        return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
      }

      // Dedupe by email. Audit finding 2026-05-20 #48: previously brand
      // resubmits created duplicate rows + double partner-confirmation
      // emails.
      try {
        const existing = await getAllRecords(
          TABLES.BRANDS,
          `LOWER({Email}) = "${escapeAirtableValue(email.trim().toLowerCase())}"`
        );
        if (existing.length > 0) {
          return NextResponse.json({
            error: 'A brand application with this email already exists. We\'ll follow up — check your inbox or email ben@buyhalfcow.com.',
          }, { status: 409 });
        }
      } catch (e) {
        // Table may not exist or rate-limited — continue rather than block signup
        console.error('Brand dedupe check failed:', e);
      }

      tableName = TABLES.BRANDS;
      const brandFields: Record<string, unknown> = {
        'Brand Name': brandName,
        'Contact Name': contactName,
        'Email': email,
        'Phone': phone || '',
        'Website': website || '',
        // Final-sweep fix (2026-06-10): schema fields are `Product Category` +
        // `Proposed Discount` — old names were silent-stripped on every brand
        // application, losing both values.
        'Product Category': productType,
        'Proposed Discount': discountOffered ? parseInt(discountOffered) : 0,
        'Partnership Goals': promotionDetails || '',
        'Featured': false,
        'Status': 'Pending',
      };
      if (referredBy) brandFields['Referred By'] = referredBy;
      record = await createRecord(tableName, brandFields);

      // Send confirmation email
      await sendPartnerConfirmation({
        type: 'brand',
        name: contactName,
        email,
      });

      // Send admin alert
      await sendAdminAlert({
        type: 'brand',
        name: brandName,
        email,
        details: {
          Contact: contactName,
          Category: productType,
          Website: website || 'Not provided',
          'Discount Offered': discountOffered ? `${discountOffered}%` : 'Not specified',
        },
      });

      try {
        await sendTelegramPartnerAlert({
          type: 'brand',
          recordId: record.id,
          name: `${brandName} (${contactName})`,
          email,
          details: `📦 <b>Category:</b> ${productType}\n🌐 ${website || 'No website'}\n💰 <b>Discount:</b> ${discountOffered ? `${discountOffered}%` : 'TBD'}`,
        });
      } catch (e) {
        console.error('Telegram brand alert error:', e);
      }
    }

    // Handle Land Seller application
    else if (partnerType === 'land') {
      const { sellerName, email, phone, propertyType, acreage, state, propertyLocation, askingPrice, description, zoning, utilities } = body;

      if (!sellerName || !email || !propertyType || !state) {
        return NextResponse.json({ error: 'Missing required fields for land seller' }, { status: 400 });
      }

      if (!isValidEmail(email)) {
        return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
      }

      // Dedupe by email. Same rationale as brand branch (#48).
      try {
        const existing = await getAllRecords(
          TABLES.LAND_DEALS,
          `LOWER({Email}) = "${escapeAirtableValue(email.trim().toLowerCase())}"`
        );
        if (existing.length > 0) {
          return NextResponse.json({
            error: 'A land application with this email already exists. We\'ll follow up — check your inbox or email ben@buyhalfcow.com.',
          }, { status: 409 });
        }
      } catch (e) {
        console.error('Land dedupe check failed:', e);
      }

      tableName = TABLES.LAND_DEALS;
      const landFields: Record<string, unknown> = {
        'Seller Name': sellerName,
        'Email': email,
        'Phone': phone || '',
        'Property Type': propertyType,
        'Acreage': parseInt(acreage) || 0,
        'State': normalizeState(state) || state,
        'Property Location': propertyLocation || '',
        // Final-sweep fix (2026-06-10): schema field is `Price` — `Asking
        // Price` was stripped, so every land deal lost its price.
        'Price': askingPrice || '',
        'Description': description || '',
        'Zoning': zoning || '',
        'Utilities': utilities || '',
        'Status': 'Pending',
      };
      if (referredBy) landFields['Referred By'] = referredBy;
      record = await createRecord(tableName, landFields);

      // Send confirmation email
      await sendPartnerConfirmation({
        type: 'land',
        name: sellerName,
        email,
      });

      // Send admin alert
      await sendAdminAlert({
        type: 'land',
        name: sellerName,
        email,
        details: {
          'Property Type': propertyType,
          Acreage: acreage,
          Location: `${state}${propertyLocation ? `, ${propertyLocation}` : ''}`,
          Price: askingPrice || 'Not specified',
        },
      });

      try {
        await sendTelegramPartnerAlert({
          type: 'land',
          recordId: record.id,
          name: sellerName,
          email,
          state,
          details: `🏞️ <b>Type:</b> ${propertyType}\n📐 <b>Acreage:</b> ${acreage || 'N/A'}\n📍 ${state}${propertyLocation ? `, ${propertyLocation}` : ''}\n💰 ${askingPrice || 'Price TBD'}`,
        });
      } catch (e) {
        console.error('Telegram land alert error:', e);
      }
    }

    else {
      return NextResponse.json({ error: 'Invalid partner type' }, { status: 400 });
    }

    // ── Funnel telemetry — partner_signup ────────────────────────────────
    // Audit 6 P0: B-side leads (rancher/brand/land) fired zero analytics.
    // Captures partnerType + state for /funnel dashboard segmentation.
    // Non-fatal — failure here doesn't break the signup flow.
    const partnerStateRaw =
      typeof body?.state === 'string' ? body.state : '';
    const partnerStateNorm = partnerStateRaw
      ? normalizeState(partnerStateRaw) || partnerStateRaw
      : '';
    await funnelRecord({
      stage: 'partner_signup',
      ...(partnerType === 'rancher' ? { rancherId: record.id } : {}),
      metadata: {
        partnerType,
        state: partnerStateNorm,
        recordId: record.id,
        tableName,
      },
    });

    // ── Meta Conversions API: server-side `Lead` event ──────────────────
    // Client Pixel loses 30-50% of events to iOS 14.5+ ATT + adblockers.
    // event_id=record.id pairs the server CAPI fire with the client
    // partner_submit_success fire on /partner so Meta dedupes. Restores
    // attribution for rancher/brand/land paid ad optimization.
    const capiIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const capiUserAgent = request.headers.get('user-agent') || undefined;
    const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(request);
    const partnerEmailNorm =
      typeof body?.email === 'string' ? body.email : undefined;
    const partnerPhone =
      typeof body?.phone === 'string' ? body.phone : undefined;
    // Best-effort first/last name split — rancher uses operatorName,
    // brand uses contactName, land uses sellerName.
    const rawName =
      (partnerType === 'rancher' && typeof body?.operatorName === 'string'
        ? body.operatorName
        : partnerType === 'brand' && typeof body?.contactName === 'string'
          ? body.contactName
          : partnerType === 'land' && typeof body?.sellerName === 'string'
            ? body.sellerName
            : '') || '';
    const nameParts = rawName.trim().split(/\s+/).filter(Boolean);
    fireCapi([
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: `${SITE_URL}/partner`,
        event_id: metaEventId(record.id),
        action_source: 'website',
        user_data: buildUserData({
          email: partnerEmailNorm,
          phone: partnerPhone,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' ') || undefined,
          state: partnerStateNorm || undefined,
          ip: capiIp,
          userAgent: capiUserAgent,
          fbp: capiFbp,
          fbc: capiFbc,
        }),
        custom_data: {
          content_name: 'BHC Partner Signup',
          content_category: partnerType,
        },
      },
    ]).catch((e) => console.error('[meta-capi] partner lead fire failed:', e));

    return NextResponse.json({ success: true, partner: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating partner:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
