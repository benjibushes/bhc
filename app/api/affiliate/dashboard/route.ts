import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAllRecords, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-affiliate-auth');

    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (decoded.type !== 'affiliate-session') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const affiliate = await getRecordById(TABLES.AFFILIATES, decoded.affiliateId) as any;
    if (!affiliate) {
      return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });
    }

    const status = (affiliate['Status'] || '').toLowerCase();
    if (status !== 'active') {
      return NextResponse.json({ error: 'Your affiliate account is not active' }, { status: 403 });
    }

    const code = affiliate['Code'] || '';
    if (!code) {
      return NextResponse.json({ error: 'Affiliate code not configured' }, { status: 400 });
    }

    const safeCode = String(code).replace(/"/g, '');
    const consumerFilter = `{Referred By} = "${safeCode}"`;
    const rancherFilter = `{Referred By} = "${safeCode}"`;

    const [consumers, ranchers] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS, consumerFilter).catch(() => []),
      getAllRecords(TABLES.RANCHERS, rancherFilter).catch(() => []),
    ]);

    const referredConsumers = (consumers as any[]).map((c) => ({
      id: c.id,
      name: c['Full Name'] || '',
      state: c['State'] || '',
      created: c['Created'] || c.createdTime || '',
    }));

    const referredRanchers = (ranchers as any[]).map((r) => ({
      id: r.id,
      name: r['Operator Name'] || r['Ranch Name'] || '',
      state: r['State'] || '',
      created: r['Created'] || r.createdTime || '',
    }));

    const buyerLink = `${SITE_URL}/access?ref=${encodeURIComponent(code)}`;
    const rancherLink = `${SITE_URL}/partner?ref=${encodeURIComponent(code)}`;

    return NextResponse.json({
      code,
      links: {
        buyer: buyerLink,
        rancher: rancherLink,
      },
      referredConsumersCount: referredConsumers.length,
      referredRanchersCount: referredRanchers.length,
      referredConsumers,
      referredRanchers,
    });
  } catch (error: any) {
    console.error('Affiliate dashboard error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
