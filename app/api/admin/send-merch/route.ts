import { NextResponse } from 'next/server';
import { sendMerchEmail } from '@/lib/email';
import { requireAdmin } from '@/lib/adminAuth';

export async function POST(request: Request) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { name, email } = await request.json();
    if (!name || !email) {
      return NextResponse.json({ error: 'name and email are required' }, { status: 400 });
    }
    const result = await sendMerchEmail({ firstName: name.split(' ')[0] || name, email });
    if (!result.success) {
      return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to send merch email' }, { status: 500 });
  }
}
