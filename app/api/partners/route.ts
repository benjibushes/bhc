import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { createRecord, getAllRecords, escapeAirtableValue, findOrCreateRancherByEmail } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendPartnerConfirmation, sendAdminAlert, sendRancherApplyAutoApproved } from '@/lib/email';
import { JWT_SECRET } from '@/lib/secrets';
import { sendTelegramPartnerAlert, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { formatPhoneInput } from '@/lib/phoneFormat';
import { validateAffiliateRefForSignup } from '@/lib/affiliates';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { normalizeState } from '@/lib/states';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';
import {
  decideSetupLinkDelivery,
  SETUP_LINK_EMAILED_MESSAGE,
} from '@/lib/rancherSetupLinkDelivery';
import {
  emailSetupLinkToOwner,
  describeSetupLinkSend,
  mintRancherSetupUrl,
  type SetupLinkSendResult,
} from '@/lib/rancherSetupLinkSend';

export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com'];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

export async function POST(request: Request) {
  // Hoisted so the outer catch can fire a rescue signal carrying the actual
  // submission (the /api/apply pattern). Without it a throw anywhere in the
  // rancher path left nothing but a console.error nobody watches — the exact
  // trace desert that made "Justin" invisible.
  let rescueBody: any = {};
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
    rescueBody = body;
    const { partnerType, ref } = body;
    // Pull whichever email + phone the body carries (rancher/brand each
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
    // Set on the rancher path only — returned to the client so /partner can
    // offer "finish setup now" alongside the booking CTA (same two-path
    // success state as /apply).
    let rancherWizardUrl: string | undefined;

    if (partnerType === 'rancher') {
      const { ranchName, operatorName, email, state, acreage, beefTypes, monthlyCapacity, certifications, operationDetails, callScheduled, ranchTourInterested, ranchTourAvailability } = body;
      // Canonical `(406) 555-1234`, country code stripped rather than
      // truncated (lib/phoneFormat). Also makes the phone leg of the dedupe
      // below actually fire — findOrCreateRancherByEmail compares raw digits,
      // so `1 (406) 555-1234` used to miss a record stored as `4065551234`
      // and fork a duplicate rancher.
      const phone = formatPhoneInput(body?.phone);

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
          // DUPLICATE RESCUE (2026-07-24) — this used to be a hard 409 with no
          // wizard URL and no next step, thrown AFTER ten required fields
          // (acreage, monthly head count, a prose textarea, a legal checkbox).
          // A returning rancher who never finished setup filled the whole form
          // and hit a wall telling them to email us. Both other doors already
          // rescue duplicates into the wizard (/api/apply's `!created` branch,
          // the map self-submit's dedupeResponse); this one now does too.
          //
          // The Verified/Removed gate is lifted straight from self-submit's
          // dedupeResponse: NEVER hand a setup link for a verified (live)
          // ranch's record to whoever typed its name and state. Those get a
          // login pointer instead — the magic link goes to the email already
          // on file, so only the real owner can act on it.
          const verificationStatus = String(match['Verification Status'] || '');
          const rescuable =
            verificationStatus !== 'Verified' && verificationStatus !== 'Removed';

          // …and the SAME reasoning applies below the Verified line (security
          // fix 2026-07-24). The dedupe also matches on (ranch name + state),
          // which is PUBLIC — every ranch is on /map with a page at
          // /ranchers/<slug> — so this rescue would hand a 60-day setup token
          // for an unverified ranch's record (its prices, fulfillment settings
          // and Stripe Connect entry point) to anyone who typed a name and a
          // state. Only an exact match on the record's own primary Email
          // proves control. Every other tier still gets rescued — the link is
          // just MAILED to the address on file instead of returned here, and
          // the response points at the login, whose magic link also goes to
          // that address. Decision is pure + unit-tested in
          // lib/rancherSetupLinkDelivery.
          const delivery = decideSetupLinkDelivery({
            matchedBy,
            submittedEmail: email,
            recordEmail: match['Email'],
          });

          let rescueWizardUrl = '';
          let sendResult: SetupLinkSendResult | null = null;
          if (rescuable && delivery === 'return-token') {
            try {
              rescueWizardUrl = mintRancherSetupUrl(match.id);
            } catch (e: any) {
              console.error('[partners] duplicate-rescue token mint failed:', e?.message);
            }
          } else if (rescuable) {
            sendResult = await emailSetupLinkToOwner(match);
          }

          try {
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `↩️ <b>EXISTING rancher re-applied</b> · /partner\n\n` +
                `<b>${operatorName}</b> · ${ranchName} (${state})\n` +
                `${email}${phone ? ` · ${phone}` : ''}\n` +
                `Matched by: ${matchedBy || '?'} · Verification: ${verificationStatus || '(blank)'}\n\n` +
                (sendResult
                  ? describeSetupLinkSend(sendResult)
                  : rescueWizardUrl
                    ? `<i>Verified by email — sent straight into the setup wizard for the existing record.</i>`
                    : rescuable
                      ? `⚠️ <i>Setup link mint FAILED — send them one manually.</i>`
                      : `<i>Verified/removed record — pointed at rancher login, no setup link issued.</i>`) +
                `\n\nRancher ${match.id}`,
            );
          } catch (e: any) {
            console.warn('[partners] duplicate Telegram alert failed (non-fatal):', e?.message);
          }

          // `matchedBy` is deliberately NOT echoed back: telling an anonymous
          // caller which field hit turns this into an enumeration oracle
          // ("is this phone / this ranch name in your system?"). It stays in
          // the operator alert above.
          return NextResponse.json(
            {
              success: true,
              existing: true,
              ...(rescueWizardUrl
                ? { wizardUrl: rescueWizardUrl }
                : { loginUrl: `${SITE_URL}/rancher/login` }),
              message: rescueWizardUrl
                ? 'You are already in our system — pick up where you left off.'
                : sendResult
                  ? SETUP_LINK_EMAILED_MESSAGE
                  : 'This ranch is already set up with us. Log in to your dashboard, or email ben@buyhalfcow.com if you need a hand.',
            },
            { status: 200 },
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
        // 2026-06-09: must never be empty (a blank value misrouted the wizard).
        // 2026-07-21: default flipped tier_v2 → legacy — the Stripe-Connect
        // SSN wall killed 73% of cold signups; legacy goes live on e-sign +
        // slug + price + own payment link. /api/apply + self-submit default
        // to legacy too; /api/partners must match so every new rancher
        // signup path defaults to the same model.
        'Pricing Model': 'legacy',
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

      // ENTRY-RAIL CONSOLIDATION (2026-07-01): the rancher path now mints the
      // setup-wizard link and auto-approves, exactly like /api/apply — ONE
      // rail for every rancher application. This replaces the retired
      // agreement-first flow (sendPartnerConfirmation type='rancher' +
      // auto-fired /api/ranchers/[id]/send-onboarding packet). send-onboarding
      // survives as an admin/Telegram resend tool only — no automatic flow
      // calls it anymore.
      const wizardToken = jwt.sign(
        { type: 'rancher-setup', rancherId: record.id },
        JWT_SECRET,
        { expiresIn: '60d' }
      );
      rancherWizardUrl = `${SITE_URL}/rancher/setup?token=${wizardToken}`;

      // Auto-approval welcome email carrying the wizard URL. Non-fatal on
      // Resend hiccup, but loudly alerted — the client response still carries
      // wizardUrl, and Ben can follow up from the Telegram alert.
      try {
        const emailRes = await sendRancherApplyAutoApproved({
          operatorName,
          ranchName,
          email,
          wizardUrl: rancherWizardUrl,
          // /partner's long-form application doesn't collect the /apply
          // fit-check answers (volume band + deposits), so no hot-lead
          // scoring here — conservative default, Ben triages via Telegram.
          score: 0,
          hotLead: false,
        });
        // guardedSend does NOT throw on suppression/failure — it returns
        // {success:false}. Either way the rancher has NO link in their
        // inbox; route to the same Telegram fallback below.
        if (!emailRes.success) {
          throw new Error(emailRes.reason || (emailRes.suppressed ? 'suppressed' : 'send failed'));
        }
      } catch (e: any) {
        console.error('[partners] auto-approved welcome email failed:', e?.message);
        try {
          const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `⚠️ <b>Wizard welcome email FAILED</b> for new rancher ${ranchName} (${email})\nWizard link: ${rancherWizardUrl}\nSend it manually or resend docs from the admin dashboard.`
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
          details: `🥩 <b>Beef:</b> ${beefTypes}\n📦 <b>Capacity:</b> ${monthlyCapacity || 'N/A'}/mo${callScheduled ? '\n📅 Call scheduled' : ''}\n🪄 Setup-wizard link auto-sent`,
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
    // attribution for rancher/brand paid ad optimization.
    const capiIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const capiUserAgent = request.headers.get('user-agent') || undefined;
    const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(request);
    const partnerEmailNorm =
      typeof body?.email === 'string' ? body.email : undefined;
    const partnerPhone =
      typeof body?.phone === 'string' ? body.phone : undefined;
    // Best-effort first/last name split — rancher uses operatorName,
    // brand uses contactName.
    const rawName =
      (partnerType === 'rancher' && typeof body?.operatorName === 'string'
        ? body.operatorName
        : partnerType === 'brand' && typeof body?.contactName === 'string'
          ? body.contactName
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

    return NextResponse.json(
      {
        success: true,
        partner: record,
        ...(rancherWizardUrl ? { wizardUrl: rancherWizardUrl } : {}),
      },
      { status: 201 },
    );
  } catch (error: any) {
    console.error('API error creating partner:', error);
    // LOUD RESCUE on the rancher door (2026-07-24) — parity with /api/apply's
    // pre-write failure signal. Supply is the constraint: a rancher who filled
    // this long form and hit a throw must leave a trail Ben can act on in ~60s,
    // not just a line in a Vercel log. Deduped per email so a bad ship can't
    // flood him. Never throws into the response.
    if (rescueBody?.partnerType === 'rancher') {
      try {
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: `Signup create FAILED · /partner · ${rescueBody?.ranchName || '(no ranch)'} (${rescueBody?.state || '?'})`,
          detail:
            `A rancher's /partner application threw — nothing was saved. ` +
            `Hand-create the Ranchers row + send the wizard link.\n\n` +
            `Operator: ${rescueBody?.operatorName || '(none)'}\n` +
            `Ranch: ${rescueBody?.ranchName || '(none)'}\n` +
            `Email: ${rescueBody?.email || '(none)'}\n` +
            `Phone: ${rescueBody?.phone || '(none)'}\n` +
            `State: ${rescueBody?.state || '(none)'}\n` +
            `Error: ${error?.message || 'unknown'}`,
          dedupeKey: `signup-create-fail:partner:${String(rescueBody?.email || 'unknown').toLowerCase()}`,
        });
      } catch (sigErr: any) {
        console.error('[partners] rescue operator signal failed:', sigErr?.message);
      }
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
