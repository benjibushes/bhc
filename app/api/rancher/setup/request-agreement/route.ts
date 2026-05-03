import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { sendPipelineUpdateEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

// Self-serve onboarding wizard — final step ("send me the agreement").
//
// Rancher has filled in their page details via the wizard. Now they request
// the agreement. We mint a fresh `rancher-agreement-signing` JWT (separate
// type, used by /rancher/sign-agreement) and email them the signing link
// directly. NO Ben-in-the-loop required.
//
// Why a separate token: the setup token is read/write on rancher fields. The
// agreement-signing token grants the binary "I agree" → flips Agreement Signed.
// Different power scopes, different expiries, different audit trails.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'rancher-setup' || !decoded.rancherId) throw new Error('bad token');
  } catch {
    return NextResponse.json({ error: 'Invalid or expired setup link' }, { status: 401 });
  }

  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
  }

  if (rancher['Agreement Signed']) {
    return NextResponse.json(
      { success: true, alreadySigned: true, message: 'Agreement already on file' },
      { status: 200 }
    );
  }

  const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'rancher';
  const operatorName = rancher['Operator Name'] || ranchName;
  const email = (rancher['Email'] || '').toString().trim();
  if (!email) {
    return NextResponse.json(
      { error: 'Email missing on rancher record — fix in step 1 first' },
      { status: 400 }
    );
  }

  // Mint signing token. Same shape as send-onboarding's signing JWT so
  // /rancher/sign-agreement can consume it without changes.
  const signingToken = jwt.sign(
    { type: 'agreement-signing', rancherId: decoded.rancherId, email: email.toLowerCase() },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  const signingLink = `${SITE_URL}/rancher/sign-agreement?token=${signingToken}`;

  // Stamp Onboarding Status so Ben knows this rancher self-served past the
  // page-edit step. Don't flip Agreement Signed — that's the user's job at
  // the next step.
  try {
    await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
      'Onboarding Status': 'Docs Sent',
      'Docs Sent At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[setup/request-agreement] status flip failed:', e?.message);
  }

  // Two modes:
  //   • Default (no header) — email the rancher the signing link. This is
  //     the legacy flow if a rancher ever lands on a non-wizard surface.
  //   • Inline (X-Inline-Sign: 1) — return the signing token in the response
  //     so the wizard can sign in-place. NO email round-trip. This is the
  //     boom-boom-bam flow.
  const inline = req.headers.get('x-inline-sign') === '1';
  if (inline) {
    // Telegram alert anyway — Ben sees this, no Ben action required.
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚀 <b>Self-serve onboarding hit step 4 (inline)</b>\n\n` +
            `Ranch: ${ranchName}\n` +
            `Operator: ${operatorName}\n` +
            `Email: ${email}\n\n` +
            `<i>They're signing the agreement in-flow right now. Page goes live as soon as they hit submit.</i>`
        );
      }
    } catch {}
    return NextResponse.json({
      success: true,
      mode: 'inline',
      signingToken,
      signingLink,
    });
  }

  // Email mode — sendPipelineUpdateEmail picks the right copy template based
  // on Onboarding Status. "Docs Sent" gets the "your agreement is ready,
  // sign here" framing with the signingLink CTA.
  try {
    await sendPipelineUpdateEmail({
      operatorName,
      ranchName,
      email,
      rancherId: decoded.rancherId,
      onboardingStatus: 'Docs Sent',
      signingLink,
    });
  } catch (e: any) {
    console.error('[setup/request-agreement] email failed:', e?.message);
    return NextResponse.json({ error: 'Email send failed — try again' }, { status: 500 });
  }

  // Telegram alert — Ben sees the rancher self-served past the manual call.
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `✅ <b>Self-serve onboarding hit step 4</b>\n\n` +
          `Ranch: ${ranchName}\n` +
          `Operator: ${operatorName}\n` +
          `Email: ${email}\n\n` +
          `<i>They filled out their page themselves and just requested the agreement. Signing email is on its way. No call needed unless they ask.</i>`
      );
    }
  } catch (e: any) {
    console.error('[setup/request-agreement] telegram failed:', e?.message);
  }

  return NextResponse.json({ success: true, message: 'Agreement signing email sent' });
}
