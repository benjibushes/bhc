import { NextResponse } from 'next/server';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendAffiliateInvite } from '@/lib/email';
import { requireAdmin } from '@/lib/adminAuth';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await params;
    const affiliate = await getRecordById(TABLES.AFFILIATES, id) as any;

    if (!affiliate) {
      return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });
    }

    const name = affiliate['Name'] || '';
    const email = affiliate['Email'] || '';
    const code = affiliate['Code'] || '';

    if (!email || !code) {
      return NextResponse.json({ error: 'Affiliate missing email or code' }, { status: 400 });
    }

    const status = (affiliate['Status'] || '').toLowerCase();
    if (status !== 'active') {
      return NextResponse.json({ error: 'Can only send invite to active affiliates' }, { status: 400 });
    }

    const buyerLink = `${SITE_URL}/access?ref=${encodeURIComponent(code)}`;
    const rancherLink = `${SITE_URL}/partner?ref=${encodeURIComponent(code)}`;
    const loginRequestUrl = `${SITE_URL}/affiliate/login`;

    await sendAffiliateInvite({
      email,
      name,
      code,
      loginRequestUrl,
      buyerLink,
      rancherLink,
    });

    return NextResponse.json({ success: true, message: 'Invite sent' });
  } catch (error: any) {
    console.error('API error sending affiliate invite:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
