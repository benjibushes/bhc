import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Check admin auth cookie
    const cookieStore = await cookies();
    const authCookie = cookieStore.get('bhc-admin-auth');

    if (authCookie?.value !== 'authenticated') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;

    await updateRecord(TABLES.RANCHERS, id, { 'Page Live': true });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error setting rancher page live:', error);
    return NextResponse.json({ error: error.message || 'Failed to go live' }, { status: 500 });
  }
}
