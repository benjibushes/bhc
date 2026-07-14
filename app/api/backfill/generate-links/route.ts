import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 60;

// SECURITY (2026-07-14): the old fallback 'bhc-backfill-secret-change-me'
// made every backfill token FORGEABLE whenever JWT_SECRET was unset — a
// grep-able constant in a public repo. lib/secrets requireEnv fails loud
// instead (route 500s until the env is set), which is the correct failure.
import { JWT_SECRET } from '@/lib/secrets';
const EXPIRY_DAYS = parseInt(process.env.BACKFILL_LINK_EXPIRY_DAYS || '30');

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json().catch(() => ({}));
    const { limit } = body;

    const consumers = await getAllRecords(TABLES.CONSUMERS);

    const needsBackfill = consumers.filter((c: any) =>
      !c['Order Type'] && !c['Budget'] && c['Email']
    );

    const toProcess = limit ? needsBackfill.slice(0, limit) : needsBackfill;
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

    const links = toProcess.map((consumer: any) => {
      const token = jwt.sign(
        {
          email: consumer['Email'],
          consumerId: consumer.id,
          type: 'backfill',
        },
        JWT_SECRET,
        { expiresIn: `${EXPIRY_DAYS}d` }
      );

      const link = `${siteUrl}/update-profile?token=${token}`;

      return {
        id: consumer.id,
        name: consumer['Full Name'] || '',
        email: consumer['Email'],
        state: consumer['State'] || '',
        link,
      };
    });

    // Generate CSV
    const csvHeader = 'Name,Email,State,Update Link';
    const csvRows = links.map(l =>
      `"${l.name}","${l.email}","${l.state}","${l.link}"`
    );
    const csv = [csvHeader, ...csvRows].join('\n');

    return NextResponse.json({
      success: true,
      totalNeedingBackfill: needsBackfill.length,
      linksGenerated: links.length,
      links,
      csv,
    });
  } catch (error: any) {
    console.error('Error generating backfill links:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
