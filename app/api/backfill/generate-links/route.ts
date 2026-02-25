import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-backfill-secret-change-me';
const EXPIRY_DAYS = parseInt(process.env.BACKFILL_LINK_EXPIRY_DAYS || '30');

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { limit } = body;

    const consumers = await getAllRecords(TABLES.CONSUMERS);

    const needsBackfill = consumers.filter((c: any) =>
      !c['Order Type'] && !c['Budget Range'] && c['Email']
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
