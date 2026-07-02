import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
// "Wants a call" lands on the on-site /book page (rancher-onboarding event,
// resolved live via getOperatorBookingUrl). The old CALENDLY_LINK env pointed
// at a deleted Calendly event and its fallback (/call) was a 404.
const RANCHER_BOOK_CALL_URL = `${SITE_URL}/book?purpose=rancher`;

// ── PRE-FLIP GUARD (finding 4, 2026-07-01): GET no longer mutates. ─────────
// Corporate mail scanners (SafeLinks / Mimecast) prefetch every GET link in
// the check-in email — the old GET-mutating handler let a scanner silently
// stamp "Confirmed" / "Wants Call" or, worst, PAUSE the rancher ('out' →
// Active Status=Paused, cutting off all new leads) without a human click.
// Now: GET validates the token and renders a ONE-TAP confirm page; the POST
// from that form performs the exact same mutation + redirect the GET used to.
// URLs stay stable — the email links are unchanged.

const VALID_ACTIONS = new Set(['confirm', 'call', 'out']);

function verifyCheckinToken(token: string | null): { rancherId: string } | null {
  if (!token) return null;
  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (decoded?.type !== 'rancher-checkin' || !decoded.rancherId) return null;
  return { rancherId: decoded.rancherId };
}

// Minimal on-brand confirm page (mirrors quick-action / decline page styling).
function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — BuyHalfCow</title><style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:32px}
.box{max-width:560px;margin:80px auto 0;background:#fff;padding:48px 40px;border:1px solid #A7A29A}
h1{font-family:Georgia,serif;font-size:28px;margin:0 0 16px;line-height:1.3}
p{margin:14px 0;color:#2A2A2A}
form{margin-top:24px}
button[type=submit]{padding:14px 32px;background:#0E0E0E;color:#F4F1EC;border:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;cursor:pointer;width:100%}
.muted{color:#A7A29A;font-size:12px;margin-top:30px}
</style></head><body><div class="box">${body}<p class="muted">— Benjamin · BuyHalfCow</p></div></body></html>`;
}

// The mutation the old GET performed — now fired ONLY from the confirm POST.
// Behavior (field writes, Telegram, redirect targets) is byte-for-byte the
// same as the pre-conversion handler; only the trigger moved from GET to POST.
async function applyCheckin(action: string, rancherId: string): Promise<NextResponse> {
  const now = new Date().toISOString();
  try {
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
    if (!rancher) {
      return NextResponse.redirect(`${SITE_URL}?error=not-found`, 303);
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
      return NextResponse.redirect(`${SITE_URL}/rancher/login?checkin=confirmed`, 303);

    } else if (action === 'call') {
      // They want a call — update and notify
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Last Check In': now,
        'Check In Response': 'Wants Call',
      });

      await sendTelegramUpdate(
        `📞 <b>CHECK-IN: WANTS CALL</b>\n\n🤠 ${name} (${ranchName}) has questions\nEmail: ${rancher['Email'] || 'N/A'}\nPhone: ${rancher['Phone'] || 'N/A'}\nOnboarding: ${rancher['Onboarding Status'] || 'Unknown'}\n\nReach out today!`
      );

      // Redirect to the on-site booking page (rancher-onboarding event)
      return NextResponse.redirect(RANCHER_BOOK_CALL_URL, 303);

    } else {
      // action === 'out' — not interested — mark as declined. Active
      // Status="Paused" (not the non-existent "Inactive"). Matching engine
      // already filters on activeStatus === 'Active' so this correctly stops
      // new leads.
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Last Check In': now,
        'Check In Response': 'Declined',
        'Active Status': 'Paused',
      });

      await sendTelegramUpdate(
        `🔴 <b>CHECK-IN: DECLINED</b>\n\n${name} (${ranchName}) is not interested right now.\nMarked as Paused. Resume with /resume ${rancher['Slug'] || rancherId}.`
      );

      return NextResponse.redirect(`${SITE_URL}?checkin=acknowledged`, 303);
    }
  } catch (error: any) {
    console.error('Check-in response error:', error);
    return NextResponse.redirect(`${SITE_URL}?error=server-error`, 303);
  }
}

// GET — validate + render the one-tap confirm page. NO writes on GET.
export async function GET(request: Request) {
  const { searchParams, pathname } = new URL(request.url);
  const token = searchParams.get('token');
  const action = searchParams.get('action');

  if (!token || !action) {
    return NextResponse.redirect(`${SITE_URL}?error=invalid-link`);
  }
  const decoded = verifyCheckinToken(token);
  if (!decoded) {
    return NextResponse.redirect(`${SITE_URL}?error=expired-link`);
  }
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.redirect(`${SITE_URL}?error=invalid-action`);
  }

  const formAction = `${pathname}?token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}`;
  const page =
    action === 'confirm'
      ? htmlPage('Still in?', `<h1>Still in? One tap to confirm.</h1>
<p>This tells us you're still on board so we keep everything moving for you.</p>
<form method="post" action="${formAction}"><button type="submit">✓ Yes — I'm still in</button></form>`)
      : action === 'call'
      ? htmlPage('Book a call', `<h1>Want to talk it through?</h1>
<p>One tap and we'll take you straight to the booking page — pick any time that works.</p>
<form method="post" action="${formAction}"><button type="submit">📞 Yes — book a call</button></form>`)
      : htmlPage('Pause new leads?', `<h1>Not right now?</h1>
<p>One tap to confirm and we'll pause new buyer leads for your ranch. You can come back any time — just reply to the email.</p>
<form method="post" action="${formAction}"><button type="submit">Confirm — pause for now</button></form>`);

  return new NextResponse(page, { headers: { 'content-type': 'text/html' } });
}

// POST — the confirm form lands here; performs the original mutation.
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const action = searchParams.get('action');

  if (!token || !action) {
    return NextResponse.redirect(`${SITE_URL}?error=invalid-link`, 303);
  }
  const decoded = verifyCheckinToken(token);
  if (!decoded) {
    return NextResponse.redirect(`${SITE_URL}?error=expired-link`, 303);
  }
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.redirect(`${SITE_URL}?error=invalid-action`, 303);
  }

  return applyCheckin(action, decoded.rancherId);
}
