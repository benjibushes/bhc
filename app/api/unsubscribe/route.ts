import { NextRequest, NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { invalidateSuppressionCache } from '@/lib/email';

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
  const safeEmail = escapeAirtableValue(normalizedEmail);

  try {
    // Use lib helpers — updateRecord strips unknown Airtable fields so we
    // never 422 because of schema drift (fix 2026-05-20: previous raw
    // base().update() on Affiliates threw because table has no Unsubscribed
    // field, burning the whole request as 500).
    const consumers = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${safeEmail}"`,
    );
    if (consumers.length > 0) {
      await updateRecord(TABLES.CONSUMERS, (consumers[0] as any).id, {
        'Unsubscribed': true,
        'Unsubscribed At': new Date().toISOString(),
      });
    }

    const ranchers = await getAllRecords(
      TABLES.RANCHERS,
      `LOWER({Email}) = "${safeEmail}"`,
    );
    if (ranchers.length > 0) {
      await updateRecord(TABLES.RANCHERS, (ranchers[0] as any).id, {
        'Unsubscribed': true,
      });
    }

    try {
      const affiliates = await getAllRecords(
        TABLES.AFFILIATES,
        `LOWER({Email}) = "${safeEmail}"`,
      );
      if (affiliates.length > 0) {
        await updateRecord(TABLES.AFFILIATES, (affiliates[0] as any).id, {
          'Status': 'Inactive',
        });
      }
    } catch (affErr) {
      console.error('Unsubscribe affiliate update (non-fatal):', affErr);
    }

    // Invalidate suppression cache so the next email send sees this address
    // as blocked immediately (prevents the 5-minute lag window where they'd
    // still get the next batch).
    invalidateSuppressionCache();

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
