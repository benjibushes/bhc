import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') || '').trim().toLowerCase();
    if (!q) return NextResponse.json({ results: [] });

    const [consumers, ranchers] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS).catch(() => [] as any[]),
      getAllRecords(TABLES.RANCHERS).catch(() => [] as any[]),
    ]);

    const matchConsumer = (c: any) => {
      const name = (c['Full Name'] || '').toLowerCase();
      const email = (c['Email'] || '').toLowerCase();
      const phone = String(c['Phone'] || '').toLowerCase();
      return name.includes(q) || email.includes(q) || phone.includes(q);
    };

    const matchRancher = (r: any) => {
      const ranch = (r['Ranch Name'] || '').toLowerCase();
      const op = (r['Operator Name'] || '').toLowerCase();
      const email = (r['Email'] || '').toLowerCase();
      const slug = (r['Slug'] || '').toLowerCase();
      return ranch.includes(q) || op.includes(q) || email.includes(q) || slug.includes(q);
    };

    const consumerHits = (consumers as any[]).filter(matchConsumer).slice(0, 8).map((c: any) => ({
      type: 'consumer' as const,
      id: c.id,
      name: c['Full Name'] || '(no name)',
      subtitle: [c['Email'], c['State'], c['Referral Status']?.name || c['Referral Status']]
        .filter(Boolean)
        .join(' · '),
    }));

    const rancherHits = (ranchers as any[]).filter(matchRancher).slice(0, 8).map((r: any) => ({
      type: 'rancher' as const,
      id: r.id,
      name: r['Ranch Name'] || r['Operator Name'] || '(no name)',
      subtitle: [r['Operator Name'], r['State'], r['Active Status']?.name || r['Active Status']]
        .filter(Boolean)
        .join(' · '),
    }));

    return NextResponse.json({ results: [...rancherHits, ...consumerHits] });
  } catch (error: any) {
    console.error('Admin search error:', error);
    return NextResponse.json({ results: [], error: error.message }, { status: 500 });
  }
}
