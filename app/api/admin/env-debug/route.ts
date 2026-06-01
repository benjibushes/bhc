// TEMP debug endpoint — admin-only. Returns boolean state of select feature
// flags so we can verify env vars without dumping secrets. DELETE AFTER USE.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // requireAdmin via header for ops-only access
  const auth = request.headers.get('x-admin-password');
  if (auth !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const v = process.env.STRIPE_CONNECT_ENABLED;
  return NextResponse.json({
    STRIPE_CONNECT_ENABLED_isSet: typeof v !== 'undefined',
    STRIPE_CONNECT_ENABLED_isTrue: v === 'true',
    STRIPE_CONNECT_ENABLED_length: typeof v === 'string' ? v.length : null,
    STRIPE_CONNECT_ENABLED_charCodes: typeof v === 'string' ? Array.from(v).map((c) => c.charCodeAt(0)) : null,
  });
}
