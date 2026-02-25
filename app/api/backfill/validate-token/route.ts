import { NextResponse } from 'next/server';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-backfill-secret-change-me';

export async function POST(request: Request) {
  try {
    const { token } = await request.json();

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
