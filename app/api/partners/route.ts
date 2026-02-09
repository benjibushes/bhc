import { NextResponse } from 'next/server';
import { createRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendPartnerConfirmation, sendAdminAlert } from '@/lib/email';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { partnerType } = body;

    if (!partnerType) {
      return NextResponse.json({ error: 'Partner type is required' }, { status: 400 });
    }

    let record;
    let tableName;

    // Handle Rancher application
    if (partnerType === 'rancher') {
      const { ranchName, operatorName, email, phone, state, beefTypes, monthlyCapacity, certifications, operationDetails, callScheduled, ranchTourInterested, ranchTourAvailability } = body;

      if (!ranchName || !operatorName || !email || !state || !beefTypes) {
        return NextResponse.json({ error: 'Missing required fields for rancher' }, { status: 400 });
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
        'Status': 'Pending',
      };

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
    }

    // Handle Brand application
    else if (partnerType === 'brand') {
      const { brandName, contactName, email, phone, website, productCategory, proposedDiscount, partnershipGoals } = body;

      if (!brandName || !contactName || !email || !productCategory) {
        return NextResponse.json({ error: 'Missing required fields for brand' }, { status: 400 });
      }

      tableName = TABLES.BRANDS;
      record = await createRecord(tableName, {
        'Brand Name': brandName,
        'Contact Name': contactName,
        'Email': email,
        'Phone': phone || '',
        'Website': website || '',
        'Product Category': productCategory,
        'Proposed Discount': proposedDiscount || '',
        'Partnership Goals': partnershipGoals || '',
        'Featured': false,
        'Status': 'Pending',
      });

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
          Category: productCategory,
          Website: website || 'Not provided',
          'Proposed Discount': proposedDiscount || 'Not specified',
        },
      });
    }

    // Handle Land Seller application
    else if (partnerType === 'land') {
      const { sellerName, email, phone, propertyType, acreage, state, county, price, propertyDescription } = body;

      if (!sellerName || !email || !propertyType || !state) {
        return NextResponse.json({ error: 'Missing required fields for land seller' }, { status: 400 });
      }

      tableName = TABLES.LAND_DEALS;
      record = await createRecord(tableName, {
        'Seller Name': sellerName,
        'Email': email,
        'Phone': phone || '',
        'Property Type': propertyType,
        'Acreage': parseInt(acreage) || 0,
        'State': state,
        'County': county || '',
        'Price': parseInt(price) || 0,
        'Description': propertyDescription || '',
        'Status': 'Pending',
      });

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
          Location: `${state}, ${county}`,
          Price: price ? `$${price}` : 'Not specified',
        },
      });
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
