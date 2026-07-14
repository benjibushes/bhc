import { NextResponse } from 'next/server';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

// SECURITY (2026-07-14): the old fallback 'bhc-backfill-secret-change-me'
// made every backfill token FORGEABLE whenever JWT_SECRET was unset — a
// grep-able constant in a public repo. lib/secrets requireEnv fails loud
// instead (route 500s until the env is set), which is the correct failure.
import { JWT_SECRET } from '@/lib/secrets';

export async function POST(request: Request) {
  try {
    let parsedBody: any;
    try { parsedBody = await request.json(); } catch { return NextResponse.json({ valid: false, error: 'Invalid request body' }); }
    const { token } = parsedBody;

    if (!token) {
      return NextResponse.json({ valid: false, error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      email: string;
      consumerId: string;
      type: string;
    };

    if (decoded.type !== 'backfill') {
      return NextResponse.json({ valid: false, error: 'Invalid token type' });
    }

    const consumer: any = await getRecordById(TABLES.CONSUMERS, decoded.consumerId);

    return NextResponse.json({
      valid: true,
      name: consumer['Full Name'] || '',
      email: consumer['Email'] || decoded.email,
      state: consumer['State'] || '',
    });
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return NextResponse.json({ valid: false, error: 'Token expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return NextResponse.json({ valid: false, error: 'Invalid token' });
    }
    return NextResponse.json({ valid: false, error: 'Validation failed' });
  }
}
