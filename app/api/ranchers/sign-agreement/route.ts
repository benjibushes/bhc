import { NextResponse } from 'next/server';
import { getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

function verifySigningToken(token: string) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'agreement-signing') return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const decoded = verifySigningToken(token);
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired signing link. Please contact support@buyhalfcow.com.' }, { status: 401 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    if (rancher['Agreement Signed']) {
      return NextResponse.json({
        already_signed: true,
        signed_at: rancher['Agreement Signed At'] || '',
        rancher_name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
      });
    }

    return NextResponse.json({
      already_signed: false,
      rancher_name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
      ranch_name: rancher['Ranch Name'] || '',
      state: rancher['State'] || '',
      email: rancher['Email'] || '',
    });
  } catch (error: any) {
    console.error('Sign agreement GET error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { token, signatureName, agreedToTerms } = body;

    if (!token || !signatureName || !agreedToTerms) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (signatureName.trim().length < 2) {
      return NextResponse.json({ error: 'Please enter your full legal name' }, { status: 400 });
    }

    const decoded = verifySigningToken(token);
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired signing link. Please contact support@buyhalfcow.com.' }, { status: 401 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    if (rancher['Agreement Signed']) {
      return NextResponse.json({ error: 'Agreement has already been signed', already_signed: true }, { status: 400 });
    }

    const now = new Date().toISOString();
    await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
      'Agreement Signed': true,
      'Agreement Signed At': now,
      'Signature Name': signatureName.trim(),
      'Onboarding Status': 'Agreement Signed',
    });

    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    try {
      await sendTelegramUpdate(
        `✍️ <b>Agreement signed!</b>\n\n` +
        `<b>${rancherName}</b> (${rancher['State'] || 'Unknown'})\n` +
        `Signed as: ${signatureName.trim()}\n` +
        `Time: ${new Date(now).toLocaleString('en-US', { timeZone: 'America/Denver' })}\n\n` +
        `Next step: Verification`
      );
    } catch {
      // Non-fatal
    }

    return NextResponse.json({
      success: true,
      message: 'Agreement signed successfully',
      signed_at: now,
    });
  } catch (error: any) {
    console.error('Sign agreement POST error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
