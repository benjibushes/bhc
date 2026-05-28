import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { requireAdmin } from '@/lib/adminAuth';

// POST /api/admin/ranchers/[id]/impersonate
//
// Admin "view dashboard as rancher" tool. Mints a real rancher-session JWT
// for the target rancher and sets the bhc-rancher-auth cookie so the
// admin's browser is treated as that rancher. Browser then visits /rancher
// and sees the rancher's dashboard with their real data.
//
// Security:
//   - Admin cookie OR x-internal-secret required.
//   - Telegram audit alert fires on every impersonation so it's never silent.
//   - Session JWT is shorter-lived than the normal rancher session (4h)
//     so a forgotten browser tab can't compromise a rancher account.
//   - Token includes impersonatedBy field so downstream logs distinguish
//     real rancher activity from admin impersonation.

export const maxDuration = 30;

const RANCHER_AUTH_COOKIE = 'bhc-rancher-auth';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Auth: requireAdmin() handles bhc-admin-auth cookie + x-admin-password.
    // x-internal-secret stays for cron-style internal callers.
    const internalHeader = request.headers.get('x-internal-secret') || '';
    const isInternal = INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
    if (!isInternal) {
      const unauthorized = await requireAdmin(request);
      if (unauthorized) return unauthorized;
    }
    const cookieStore = await cookies();

    const { id } = await context.params;
    if (!id || !id.startsWith('rec')) {
      return NextResponse.json({ error: 'Invalid rancher id' }, { status: 400 });
    }

    let rancher: any;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, id);
    } catch {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }
    if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

    const sessionToken = jwt.sign(
      {
        type: 'rancher-session',
        rancherId: rancher.id,
        email: rancher['Email'] || '',
        name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
        ranchName: rancher['Ranch Name'] || '',
        state: rancher['State'] || '',
        impersonatedBy: 'admin',
        impersonatedAt: Date.now(),
      },
      JWT_SECRET,
      { expiresIn: '4h' } // shorter than normal 30d session
    );

    cookieStore.set(RANCHER_AUTH_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 4,
      path: '/',
    });

    // Audit trail — every impersonation pings Telegram. If someone hijacks
    // the admin cookie and starts viewing rancher dashboards, the alert
    // is the catch.
    try {
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown';
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🕵️ <b>ADMIN IMPERSONATION</b>\n\nAdmin started viewing dashboard as <b>${name}</b>.\n4h session. If this wasn't you, rotate ADMIN_PASSWORD immediately.`
      );
    } catch {}

    return NextResponse.json({
      success: true,
      redirectTo: '/rancher',
      rancher: { id: rancher.id, name: rancher['Operator Name'] || rancher['Ranch Name'] || '' },
    });
  } catch (error: any) {
    console.error('impersonate error:', error);
    return NextResponse.json({ error: 'Could not impersonate rancher' }, { status: 500 });
  }
}
