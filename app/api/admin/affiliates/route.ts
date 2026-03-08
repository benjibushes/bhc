import { NextResponse } from 'next/server';
import { getAllRecords, createRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const records = await getAllRecords(TABLES.AFFILIATES);
    const affiliates = records.map((record: any) => ({
      id: record.id,
      name: record['Name'] || '',
      email: record['Email'] || '',
      code: record['Code'] || '',
      status: record['Status'] || 'Active',
      created_at: record['Created'] || record.createdTime || '',
    }));
    return NextResponse.json(affiliates);
  } catch (error: any) {
    console.error('API error fetching affiliates:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, email, code } = body;

    if (!name || !email || !code) {
      return NextResponse.json({ error: 'Name, email, and code are required' }, { status: 400 });
    }

    const normalizedCode = String(code).trim().toLowerCase().replace(/\s+/g, '-');
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await getAllRecords(TABLES.AFFILIATES);
    const codeExists = (existing as any[]).some(
      (r) => (r['Code'] || '').toLowerCase() === normalizedCode
    );
    const emailExists = (existing as any[]).some(
      (r) => (r['Email'] || '').toLowerCase() === normalizedEmail
    );

    if (codeExists) {
      return NextResponse.json({ error: 'This affiliate code is already in use' }, { status: 409 });
    }
    if (emailExists) {
      return NextResponse.json({ error: 'This email is already registered as an affiliate' }, { status: 409 });
    }

    const record = await createRecord(TABLES.AFFILIATES, {
      'Name': name.trim(),
      'Email': normalizedEmail,
      'Code': normalizedCode,
      'Status': 'Active',
    });

    return NextResponse.json({
      success: true,
      affiliate: {
        id: record.id,
        name: name.trim(),
        email: normalizedEmail,
        code: normalizedCode,
        status: 'Active',
      },
    }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating affiliate:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
