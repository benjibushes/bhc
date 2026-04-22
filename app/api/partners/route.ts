import { NextResponse } from 'next/server';
import { createRecord, getAllRecords, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendPartnerConfirmation, sendAdminAlert } from '@/lib/email';
import { sendTelegramPartnerAlert } from '@/lib/telegram';

export const maxDuration = 60;

async function validateAffiliateRef(ref: string | undefined): Promise<boolean> {
  if (!ref || typeof ref !== 'string' || ref.length > 50) return false;
  const code = ref.trim();
  if (!code) return false;
  try {
    const affiliates = await getAllRecords(TABLES.AFFILIATES, `AND({Code} = "${escapeAirtableValue(code)}", {Status} = "Active")`);
    return affiliates.length > 0;
  } catch {
    return false;
  }
}

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com'];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

export async function POST(request: Request) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { partnerType, ref } = body;
    const referredBy = ref && (await validateAffiliateRef(ref)) ? ref.trim() : '';

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

      try {
        const existing = await getAllRecords(TABLES.RANCHERS, `{Email} = "${escapeAirtableValue(email.trim().toLowerCase())}"`);
        if (existing.length > 0) {
          return NextResponse.json({ error: 'This email is already registered. Check your inbox for your confirmation.' }, { status: 409 });
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
        'State': state,
        'Beef Types': beefTypes,
        'Monthly Capacity': parseInt(monthlyCapacity) || 0,
        'Certifications': certifications || '',
        'Operation Details': operationDetails || '',
        'Acreage': parseInt(acreage) || 0,
        'Status': 'Pending',
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
          State: state,
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

      tableName = TABLES.BRANDS;
      const brandFields: Record<string, unknown> = {
        'Brand Name': brandName,
        'Contact Name': contactName,
        'Email': email,
        'Phone': phone || '',
        'Website': website || '',
        'Product Type': productType,
        'Discount Offered (%)': discountOffered ? parseInt(discountOffered) : 0,
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

      tableName = TABLES.LAND_DEALS;
      const landFields: Record<string, unknown> = {
        'Seller Name': sellerName,
        'Email': email,
        'Phone': phone || '',
        'Property Type': propertyType,
        'Acreage': parseInt(acreage) || 0,
        'State': state,
        'Property Location': propertyLocation || '',
        'Asking Price': askingPrice || '',
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

    return NextResponse.json({ success: true, partner: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating partner:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
