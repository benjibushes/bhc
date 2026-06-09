import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { createRecord, getAllRecords, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendRancherApplyAutoApproved } from '@/lib/email';
import { JWT_SECRET } from '@/lib/secrets';

// POST /api/apply — public endpoint.
//
// Pre-wizard fit-check form. Captures rancher's qualification context
// (volume band, biggest constraint, channels, deposit-capability) +
// basic contact. On success:
//
//   • Creates Airtable Ranchers record w/ Status='Pending',
//     Onboarding Status='Lead', Pricing Model defaults to 'tier_v2'
//     (new ranchers get deposit-direct path; can be downgraded by Ben).
//   • Mints rancher-setup JWT (60d) → returns wizard URL.
//   • Fires Telegram alert tagged w/ qualification score so Ben can
//     prioritize the high-volume + high-intent apps.
//
// Auto-qualification logic:
//   high-volume (25-100 or 100+ head) + accepts deposits = HOT LEAD
//   moderate volume (5-25) = standard
//   <5 head = manual review flag (still gets wizard but Ben triages)
//
// Anti-abuse:
//   • Honeypot field 'fax' — submit-with-non-empty drops silently.
//   • Email dedupe — existing rancher w/ same email is updated, not duped.
//   • Rate limit per IP (basic — Vercel KV would be tighter, fine for v1).

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

type VolumeBand = '<5' | '5-25' | '25-100' | '100+';
type Constraint = 'more_buyers' | 'better_pricing' | 'easier_logistics' | 'brand_visibility' | 'all_above';

interface ApplyBody {
  operatorName?: string;
  ranchName?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  headPerYear?: VolumeBand;
  constraint?: Constraint;
  channels?: string[];
  acceptsDeposits?: 'yes' | 'no';
  website?: string;
  notes?: string;
  fax?: string; // honeypot
}

function isHotLead(body: ApplyBody): boolean {
  return (
    (body.headPerYear === '25-100' || body.headPerYear === '100+') &&
    body.acceptsDeposits === 'yes'
  );
}

function needsManualReview(body: ApplyBody): boolean {
  return body.headPerYear === '<5';
}

function qualificationScore(body: ApplyBody): number {
  let score = 0;
  if (body.headPerYear === '100+') score += 4;
  else if (body.headPerYear === '25-100') score += 3;
  else if (body.headPerYear === '5-25') score += 2;
  else if (body.headPerYear === '<5') score += 1;
  if (body.acceptsDeposits === 'yes') score += 2;
  if ((body.channels?.length || 0) >= 2) score += 1;
  if (body.website) score += 1;
  if (body.constraint === 'more_buyers' || body.constraint === 'brand_visibility') score += 1;
  return score;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function POST(req: Request) {
  let body: ApplyBody = {};
  try {
    body = (await req.json()) as ApplyBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Honeypot — silent drop, return success to confuse bots.
  if (body.fax && body.fax.trim().length > 0) {
    return NextResponse.json({ ok: true, manualReview: true });
  }

  // Required fields
  if (
    !body.operatorName?.trim() ||
    !body.ranchName?.trim() ||
    !body.email?.trim() ||
    !body.state ||
    !body.headPerYear ||
    !body.constraint
  ) {
    return NextResponse.json(
      { error: 'Name, ranch, email, state, volume, and constraint are required.' },
      { status: 400 }
    );
  }
  if (!isValidEmail(body.email.trim())) {
    return NextResponse.json({ error: 'Please enter a valid email.' }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();

  // Dedupe by email — if a rancher already exists with this email, return
  // their existing wizard URL instead of creating a duplicate.
  try {
    const existing = (await getAllRecords(TABLES.RANCHERS)) as any[];
    const match = existing.find(
      (r) => String(r['Email'] || '').trim().toLowerCase() === email
    );
    if (match) {
      const existingToken = jwt.sign(
        { type: 'rancher-setup', rancherId: match.id },
        JWT_SECRET,
        { expiresIn: '60d' }
      );
      return NextResponse.json({
        ok: true,
        existing: true,
        wizardUrl: `${SITE_URL}/rancher/setup?token=${existingToken}`,
        manualReview: false,
      });
    }
  } catch (e: any) {
    console.warn('[apply] dedupe lookup failed (continuing):', e?.message);
  }

  // Build qualification + Notes payload
  const hot = isHotLead(body);
  const manualReview = needsManualReview(body);
  const score = qualificationScore(body);
  const channelsList = (body.channels || []).join(', ') || 'none specified';
  const constraintLabel: Record<Constraint, string> = {
    more_buyers: 'Finding more buyers',
    better_pricing: 'Better pricing / margins',
    easier_logistics: 'Easier logistics & fulfillment',
    brand_visibility: 'Brand visibility',
    all_above: 'All of the above',
  };

  const opDetails = [
    `[APPLY ${new Date().toISOString().slice(0, 10)}]`,
    `Volume: ${body.headPerYear} head/year`,
    `Constraint: ${constraintLabel[body.constraint]}`,
    `Channels: ${channelsList}`,
    `Accepts deposits online: ${body.acceptsDeposits || 'not specified'}`,
    body.website ? `Website: ${body.website}` : null,
    body.notes ? `Notes: ${body.notes}` : null,
    `Qualification score: ${score}/9`,
    hot ? '🔥 HOT LEAD' : manualReview ? '⚠️ MANUAL REVIEW (<5 head)' : '✓ Standard',
  ]
    .filter(Boolean)
    .join('\n');

  // Create Airtable record. Default Pricing Model to 'tier_v2' for new
  // ranchers — gets them on the deposit-direct path. Ben can downgrade
  // to legacy during review if needed.
  let rancherId: string;
  try {
    const created = await createRecord(TABLES.RANCHERS, {
      'Operator Name': body.operatorName.trim(),
      'Ranch Name': body.ranchName.trim(),
      Email: email,
      Phone: body.phone?.trim() || '',
      City: body.city?.trim() || '',
      State: body.state,
      Status: 'Pending',
      'Pricing Model': 'tier_v2',
      'Operation Details': opDetails,
    });
    rancherId = (created as any).id;
  } catch (e: any) {
    console.error('[apply] Airtable create failed:', e?.message);
    return NextResponse.json(
      { error: 'Could not save your application. Please try again or email ben@buyhalfcow.com.' },
      { status: 500 }
    );
  }

  // Mint wizard token (60d). All approved applicants get the wizard link —
  // manual-review flagged ones still get it but Ben sees the warning in
  // Telegram and can hold a discovery call before they proceed.
  const wizardToken = jwt.sign(
    { type: 'rancher-setup', rancherId },
    JWT_SECRET,
    { expiresIn: '60d' }
  );
  const wizardUrl = `${SITE_URL}/rancher/setup?token=${wizardToken}`;

  // Fire the auto-approval welcome email. Carries the wizard URL so the
  // rancher can resume even after closing the browser tab. Non-fatal —
  // log + continue if Resend hiccups (rancher still has URL in client
  // response + Telegram alert lets Ben follow up manually).
  try {
    await sendRancherApplyAutoApproved({
      operatorName: body.operatorName.trim(),
      ranchName: body.ranchName.trim(),
      email,
      wizardUrl,
      score,
      hotLead: hot,
    });
  } catch (e: any) {
    console.warn('[apply] auto-approved welcome email failed (non-fatal):', e?.message);
  }

  // Telegram alert — tier the emoji + label so Ben can triage at a glance
  try {
    const emoji = hot ? '🔥🔥🔥' : manualReview ? '⚠️' : '🆕';
    const tier = hot ? 'HOT LEAD' : manualReview ? 'MANUAL REVIEW' : 'NEW APPLICATION';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `${emoji} <b>${tier}</b> · /apply\n\n` +
        `<b>${body.operatorName}</b> · ${body.ranchName} (${body.state})\n` +
        `${email}${body.phone ? ` · ${body.phone}` : ''}\n\n` +
        `Volume: <b>${body.headPerYear}</b> head/year\n` +
        `Constraint: ${constraintLabel[body.constraint]}\n` +
        `Channels: ${channelsList}\n` +
        `Deposits online: ${body.acceptsDeposits || '?'}\n` +
        `Score: ${score}/9${body.website ? ` · ${body.website}` : ''}\n\n` +
        `<i>Pricing Model defaulted to tier_v2. Wizard token minted — they'll be redirected.</i>\n\n` +
        `Rancher ${rancherId}`
    );
  } catch (e: any) {
    console.warn('[apply] Telegram alert failed (non-fatal):', e?.message);
  }

  return NextResponse.json({
    ok: true,
    wizardUrl,
    manualReview,
    rancherId,
  });
}
