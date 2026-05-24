import { NextResponse } from 'next/server';
import { createRecord, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// Public-facing self-serve affiliate signup. Surfaced on the /access thank-you
// state — every quiz completer becomes a potential affiliate with one click.
//
// Distinct from /api/admin/affiliates (admin-only, manual onboarding) and from
// generateAffiliateCode() in lib/affiliates.ts (name-prefixed slug). This
// endpoint mints a 6-char uppercase alphanumeric code to keep share links
// short + tweet-friendly + brand-anonymous.
//
// Idempotent by email: re-submitting returns the same code, so refreshing the
// thank-you card or double-tapping the button never creates duplicates.

const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomCode(len = 6): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  }
  return out;
}

async function generateUniqueCode(): Promise<string> {
  // One retry on collision. 36^6 = 2.2B keyspace — a second collision in
  // back-to-back rolls means the random source is broken, not the keyspace.
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = randomCode();
    try {
      const existing = await getAllRecords(
        TABLES.AFFILIATES,
        `LOWER({Code}) = "${escapeAirtableValue(candidate.toLowerCase())}"`,
      );
      if (existing.length === 0) return candidate;
    } catch {
      // Table missing / rate-limited — fall back to unchecked candidate.
      return candidate;
    }
  }
  // Pathological — wedge a timestamp suffix to guarantee uniqueness.
  return `${randomCode(3)}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

function validateEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

export async function POST(request: Request) {
  try {
    const ip = getRequestIp(request);
    const perMin = await rateLimit(`affiliates:signup:min:${ip}`, { requests: 5, window: '1m' });
    if (!perMin.ok) {
      return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
    }
    const perHr = await rateLimit(`affiliates:signup:hr:${ip}`, { requests: 30, window: '1h' });
    if (!perHr.ok) {
      return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
    }

    const body = await request.json().catch(() => ({}));
    const rawEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const fullName = typeof body?.fullName === 'string' ? body.fullName.trim().slice(0, 100) : '';
    const consumerRecordId =
      typeof body?.consumerRecordId === 'string' && body.consumerRecordId.startsWith('rec')
        ? body.consumerRecordId
        : '';

    if (!rawEmail || !validateEmail(rawEmail)) {
      return NextResponse.json({ error: 'Valid email required.' }, { status: 400 });
    }

    // Idempotency: same email -> existing code. Avoids duplicate Affiliate
    // rows when users double-tap the button or revisit the thank-you state.
    try {
      const existing = await getAllRecords(
        TABLES.AFFILIATES,
        `LOWER({Email}) = "${escapeAirtableValue(rawEmail)}"`,
      );
      if (existing.length > 0) {
        const aff = existing[0] as any;
        const code = String(aff['Code'] || '').trim();
        if (code) {
          return NextResponse.json({
            ok: true,
            code,
            shareUrl: `${SITE_URL}/access?ref=${encodeURIComponent(code)}`,
            existing: true,
          });
        }
      }
    } catch {
      // Affiliates table missing — fall through to create attempt below.
    }

    const code = await generateUniqueCode();

    const fields: Record<string, any> = {
      'Email': rawEmail,
      'Code': code,
      'Status': 'Active',
      'Created At': new Date().toISOString(),
    };
    if (fullName) {
      // Support both common field names — createRecord auto-strips whichever
      // doesn't exist in the live Airtable schema.
      fields['Full Name'] = fullName;
      fields['Name'] = fullName;
    }
    if (consumerRecordId) {
      fields['Linked Consumer'] = [consumerRecordId];
    }

    try {
      await createRecord(TABLES.AFFILIATES, fields);
    } catch (err: any) {
      console.error('[affiliates/signup] create failed:', err?.message);
      return NextResponse.json({ error: 'Failed to create affiliate.' }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      code,
      shareUrl: `${SITE_URL}/access?ref=${encodeURIComponent(code)}`,
      existing: false,
    });
  } catch (error: any) {
    console.error('[affiliates/signup] error:', error?.message);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
