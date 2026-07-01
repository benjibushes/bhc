import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { invalidateSuppressionCache } from '@/lib/email';
import { JWT_SECRET } from '@/lib/secrets';

// POST /api/unsubscribe — one-click unsubscribe (RFC 8058)
// Also handles GET for email-client List-Unsubscribe header clicks
// Accepts either:
//   - ?token=<JWT> (preferred, protects PII in URL)
//   - ?email=<email> (legacy, deprecated ~2026-06-26, kept for 30d inbox link compatibility)
export async function POST(req: NextRequest) {
  return handleUnsubscribe(req);
}

export async function GET(req: NextRequest) {
  return handleUnsubscribe(req);
}

async function handleUnsubscribe(req: NextRequest) {
  const url = new URL(req.url);
  let email: string | null = null;

  // Prefer token-based unsubscribe (no PII in URL)
  const token = url.searchParams.get('token');
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (decoded.type === 'unsubscribe' && decoded.email) {
        email = decoded.email;
      }
    } catch (err) {
      console.warn('Token verification failed:', err instanceof Error ? err.message : err);
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
    }
  }

  // Fallback: legacy ?email= parameter (kept for 30 days, deprecation log)
  if (!email) {
    email = url.searchParams.get('email');
    if (email) {
      console.warn(`[DEPRECATION] Legacy ?email= unsubscribe used: ${email}. Migrate to token-based links.`);
    }
  }

  // Also check form body for POST requests (List-Unsubscribe-Post)
  if (!email && req.method === 'POST') {
    try {
      const body = await req.text();
      const params = new URLSearchParams(body);
      email = params.get('List-Unsubscribe') || params.get('email') || params.get('token');
      if (email && params.has('token')) {
        try {
          const decoded = jwt.verify(email, JWT_SECRET) as any;
          if (decoded.type === 'unsubscribe' && decoded.email) {
            email = decoded.email;
          }
        } catch {
          email = null;
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  if (!email) {
    return NextResponse.json({ error: 'Token or email required' }, { status: 400 });
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

    invalidateSuppressionCache();

    if (req.method === 'POST') {
      return NextResponse.json({ success: true });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
    return NextResponse.redirect(`${siteUrl}/unsubscribe?success=true&email=${encodeURIComponent(normalizedEmail)}`);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 });
  }
}
