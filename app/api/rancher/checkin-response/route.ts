import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const CALENDLY_LINK = process.env.CALENDLY_LINK || 'https://buyhalfcow.com/call';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const action = searchParams.get('action');

  if (!token || !action) {
    return NextResponse.redirect(`${SITE_URL}?error=invalid-link`);
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return NextResponse.redirect(`${SITE_URL}?error=expired-link`);
  }

  if (decoded.type !== 'rancher-checkin') {
    return NextResponse.redirect(`${SITE_URL}?error=invalid-link`);
  }

  const rancherId = decoded.rancherId;
  const now = new Date().toISOString();

  try {
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
    if (!rancher) {
      return NextResponse.redirect(`${SITE_URL}?error=not-found`);
    }

    const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const ranchName = rancher['Ranch Name'] || name;

    if (action === 'confirm') {
      // They're still in — update status and notify admin
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Last Check In': now,
        'Check In Response': 'Confirmed',
      });

      await sendTelegramUpdate(
        `🟢 <b>CHECK-IN: CONFIRMED</b>\n\n🤠 ${name} (${ranchName}) is still in!\nOnboarding: ${rancher['Onboarding Status'] || 'Unknown'}\n\nReady to move forward — follow up ASAP.`
      );

      // Redirect to a thank-you page or their dashboard login
      return NextResponse.redirect(`${SITE_URL}/rancher/login?checkin=confirmed`);

    } else if (action === 'call') {
      // They want a call — update and notify
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Last Check In': now,
        'Check In Response': 'Wants Call',
      });

      await sendTelegramUpdate(
        `📞 <b>CHECK-IN: WANTS CALL</b>\n\n🤠 ${name} (${ranchName}) has questions\nEmail: ${rancher['Email'] || 'N/A'}\nPhone: ${rancher['Phone'] || 'N/A'}\nOnboarding: ${rancher['Onboarding Status'] || 'Unknown'}\n\nReach out today!`
      );

      // Redirect to Calendly or a confirmation page
      return NextResponse.redirect(CALENDLY_LINK);

    } else if (action === 'out') {
      // Not interested — mark as declined
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Last Check In': now,
        'Check In Response': 'Declined',
        'Active Status': 'Inactive',
      });

      await sendTelegramUpdate(
        `🔴 <b>CHECK-IN: DECLINED</b>\n\n${name} (${ranchName}) is not interested right now.\nMarked as Inactive.`
      );

      return NextResponse.redirect(`${SITE_URL}?checkin=acknowledged`);

    } else {
      return NextResponse.redirect(`${SITE_URL}?error=invalid-action`);
    }
  } catch (error: any) {
    console.error('Check-in response error:', error);
    return NextResponse.redirect(`${SITE_URL}?error=server-error`);
  }
}
