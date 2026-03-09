import { NextResponse } from 'next/server';
import { getAllRecords, createRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendAffiliateWelcome } from '@/lib/email';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function generateCode(name: string): string {
  const base = (name.split(' ')[0] || 'bhc').toLowerCase().replace(/[^a-z]/g, '');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}${suffix}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, email } = body;

    if (!name || !email) {
      return NextResponse.json({ error: 'name and email are required' }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if affiliate already exists
    let existing: any[] = [];
    try {
      existing = await getAllRecords(TABLES.AFFILIATES, `LOWER({Email}) = "${normalizedEmail}"`);
    } catch {
      // Affiliates table may not exist yet
    }

    if (existing.length > 0) {
      const aff = existing[0] as any;
      return NextResponse.json({
        exists: true,
        code: aff['Code'],
        status: aff['Status'],
        message: `${name} is already an affiliate with code: ${aff['Code']}`,
      });
    }

    const code = generateCode(name);

    await createRecord(TABLES.AFFILIATES, {
      'Name': name,
      'Email': normalizedEmail,
      'Code': code,
      'Status': 'Active',
    });

    const buyerLink = `${SITE_URL}/access?ref=${encodeURIComponent(code)}`;
    const rancherLink = `${SITE_URL}/partner?ref=${encodeURIComponent(code)}`;
    const dashboardUrl = `${SITE_URL}/affiliate`;

    try {
      await sendAffiliateWelcome({ name, email: normalizedEmail, code, dashboardUrl, buyerLink, rancherLink });
    } catch (e) {
      console.error('Failed to send affiliate welcome email (non-fatal):', e);
    }

    return NextResponse.json({ success: true, code, buyerLink, rancherLink, dashboardUrl,
      message: `${name} is now an affiliate with code: ${code}` });
  } catch (error: any) {
    console.error('Error creating affiliate:', error);
    if (error.message?.includes('TABLE_NOT_FOUND') || error.message?.includes('Could not find')) {
      return NextResponse.json({
        error: 'Affiliates table not found in Airtable. Create a table named "Affiliates" with fields: Name, Email, Code, Status.',
      }, { status: 500 });
    }
    return NextResponse.json({ error: error.message || 'Failed to create affiliate' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const affiliates = await getAllRecords(TABLES.AFFILIATES);
    return NextResponse.json(
      (affiliates as any[]).map(a => ({
        id: a.id,
        name: a['Name'] || '',
        email: a['Email'] || '',
        code: a['Code'] || '',
        status: a['Status'] || '',
      }))
    );
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
