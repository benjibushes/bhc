import { NextRequest, NextResponse } from 'next/server';
import Airtable from 'airtable';

const apiKey = process.env.AIRTABLE_API_KEY;
const baseId = process.env.AIRTABLE_BASE_ID;
const base = new Airtable({ apiKey: apiKey || '' }).base(baseId || '');

// POST /api/unsubscribe — one-click unsubscribe (RFC 8058)
// Also handles GET for email-client List-Unsubscribe header clicks
export async function POST(req: NextRequest) {
  return handleUnsubscribe(req);
}

export async function GET(req: NextRequest) {
  return handleUnsubscribe(req);
}

async function handleUnsubscribe(req: NextRequest) {
  const url = new URL(req.url);
  let email = url.searchParams.get('email');

  // Also check form body for POST requests
  if (!email && req.method === 'POST') {
    try {
      const body = await req.text();
      const params = new URLSearchParams(body);
      email = params.get('List-Unsubscribe') || params.get('email');
    } catch {
      // ignore parse errors
    }
  }

  if (!email) {
    return NextResponse.json({ error: 'Email required' }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Find consumer by email
    const records = await base('Consumers')
      .select({
        filterByFormula: `LOWER({Email}) = "${normalizedEmail.replace(/"/g, '\\"')}"`,
        maxRecords: 1,
      })
      .firstPage();

    if (records.length > 0) {
      await base('Consumers').update(records[0].id, {
        'Unsubscribed': true,
        'Unsubscribed At': new Date().toISOString(),
      });
    }

    // Also check Affiliates table
    const affiliateRecords = await base('Affiliates')
      .select({
        filterByFormula: `LOWER({Email}) = "${normalizedEmail.replace(/"/g, '\\"')}"`,
        maxRecords: 1,
      })
      .firstPage();

    if (affiliateRecords.length > 0) {
      await base('Affiliates').update(affiliateRecords[0].id, {
        'Unsubscribed': true,
      });
    }

    // For RFC 8058 one-click, return 200
    if (req.method === 'POST') {
      return NextResponse.json({ success: true });
    }

    // For GET, redirect to the unsubscribe confirmation page
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
    return NextResponse.redirect(`${siteUrl}/unsubscribe?success=true&email=${encodeURIComponent(normalizedEmail)}`);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 });
  }
}
