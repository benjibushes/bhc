import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAllRecords, getRecordById, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { normalizeAffiliateCode } from '@/lib/affiliates';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

import { JWT_SECRET } from '@/lib/secrets';
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

    const rawCode = affiliate['Code'] || '';
    if (!rawCode) {
      return NextResponse.json({ error: 'Affiliate code not configured' }, { status: 400 });
    }
    const code = normalizeAffiliateCode(rawCode);

    const safeCode = escapeAirtableValue(String(code));
    const consumerFilter = `{Referred By} = "${safeCode}"`;
    const rancherFilter = `{Referred By} = "${safeCode}"`;

    const [consumers, ranchers] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS, consumerFilter).catch(() => []),
      getAllRecords(TABLES.RANCHERS, rancherFilter).catch(() => []),
    ]);

    const referredConsumerIds = new Set((consumers as any[]).map((c: any) => c.id));
    const referredRancherIds = new Set((ranchers as any[]).map((r: any) => r.id));

    // Count Closed Won deals attributed to this affiliate's referred buyers.
    // Counts only — no dollar amounts surfaced. Affiliates evangelize the
    // mission, not chase commissions. Showing $ would create the wrong
    // incentive + the wrong expectation.
    let referrals: any[] = [];
    try {
      referrals = (await getAllRecords(TABLES.REFERRALS)) as any[];
    } catch {
      referrals = [];
    }

    let closedWonCount = 0;
    const recentCloses: Array<{ id: string; buyer: string; closedAt: string }> = [];
    for (const ref of referrals) {
      if ((ref['Status'] || '') !== 'Closed Won') continue;
      const buyerIds: string[] = ref['Buyer'] || [];
      if (!Array.isArray(buyerIds) || !buyerIds.some((b) => referredConsumerIds.has(b))) continue;
      closedWonCount++;
      recentCloses.push({
        id: ref.id,
        buyer: ref['Buyer Name'] || '',
        closedAt: ref['Closed At'] || '',
      });
    }
    recentCloses.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());

    const clicks = Number(affiliate['Click Count']) || 0;
    const signups = referredConsumerIds.size + referredRancherIds.size;
    const conversionPct = clicks > 0 ? Math.round((signups / clicks) * 1000) / 10 : 0;

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
      stats: {
        clicks,
        signups,
        conversionPct,
        closedWonCount,
        lastClickAt: affiliate['Last Click At'] || null,
      },
      referredConsumersCount: referredConsumers.length,
      referredRanchersCount: referredRanchers.length,
      referredConsumers,
      referredRanchers,
      recentCloses: recentCloses.slice(0, 20),
    });
  } catch (error: any) {
    console.error('Affiliate dashboard error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
