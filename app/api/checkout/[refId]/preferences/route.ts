// app/api/checkout/[refId]/preferences/route.ts
//
// Flawless-handoff (2026-06-27): structured post-deposit preference capture.
//
// The buyer just paid a deposit. This endpoint records HOW they want their
// beef (delivery vs pickup, target window, cut-sheet notes) so the rancher has
// it before the first call. Two persistence sinks, both idempotent:
//   1. Seeds/uses the buyer↔rancher thread (getOrCreateThreadForReferral) with
//      a structured first message so it EMAIL-MIRRORS to the rancher (same
//      Reply-To thread pipeline the ask form uses).
//   2. Stamps the preferences onto the Referral (Buyer Fulfillment Pref /
//      Window Pref / Cut Notes + Buyer Preferences Set At) so the rancher
//      dashboard + admin can see them at a glance.
//
// Auth: buyer session (bhc-member-auth cookie) — the SAME gate as the deposit
// page + /api/threads/by-referral. That cookie is itself issued from the
// referral's magic-link / warmup-engage token, so "buyer session OR the
// referral's own token" both resolve through this one check. Ownership is then
// verified against the referral's Buyer link.
//
// Idempotent: a second submit updates the stamped fields but does NOT post a
// duplicate thread message (keyed on Buyer Preferences Set At being unset).

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { resolveDepositAuth } from '@/lib/buyerAuth';
import { getOrCreateThreadForReferral, postMessage } from '@/lib/contracts/threads';
import { sendEmail } from '@/lib/email';
import { rateLimit } from '@/lib/rateLimit';
import {
  validatePreferences,
  formatPreferencesMessage,
  preferencesToReferralFields,
} from '@/lib/preferences';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// GET — prefill data for the preferences form: rancher name + any already-saved
// preferences (so a returning buyer sees their last answers). Buyer-session +
// ownership gated, identical to the POST.
export async function GET(req: Request, { params }: { params: Promise<{ refId: string }> }) {
  const { refId } = await params;
  // Member session OR this referral's deposit grant (campaign 1-tap link).
  const session = await resolveDepositAuth(req, refId);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let ref: any;
  try {
    ref = await getRecordById(TABLES.REFERRALS, refId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!ref) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerIds: string[] = ref['Buyer'] || [];
  if (!buyerIds.includes(session.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
  const rancherId = rancherIds[0];
  let rancherName = 'your rancher';
  if (rancherId) {
    try {
      const r: any = await getRecordById(TABLES.RANCHERS, rancherId);
      rancherName = String(r?.['Operator Name'] || r?.['Ranch Name'] || 'your rancher');
    } catch {}
  }

  const fulfillmentRaw = String(ref['Buyer Fulfillment Pref'] || '').toLowerCase();
  return NextResponse.json({
    rancherName,
    alreadyCaptured: !!ref['Buyer Preferences Set At'],
    preferences: {
      fulfillment: fulfillmentRaw === 'delivery' ? 'delivery' : fulfillmentRaw === 'pickup' ? 'pickup' : '',
      window: String(ref['Buyer Window Pref'] || ''),
      cutNotes: String(ref['Buyer Cut Notes'] || ''),
    },
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ refId: string }> }) {
  const { refId } = await params;
  // Member session OR this referral's deposit grant (campaign 1-tap link).
  const session = await resolveDepositAuth(req, refId);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Anti-spam: 6 submits / 60s per buyer. Generous (this is a one-shot form)
  // but stops a runaway client from flooding the thread/rancher inbox.
  const rl = await rateLimit(`prefs:${session.consumerId}`, { requests: 6, window: '1m' });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Slow down — too many submissions. Wait a minute and try again.' },
      { status: 429 },
    );
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validated = validatePreferences(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const prefs = validated.value;

  // Load + own-check the referral.
  let ref: any;
  try {
    ref = await getRecordById(TABLES.REFERRALS, refId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!ref) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerIds: string[] = ref['Buyer'] || [];
  if (!buyerIds.includes(session.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
  const rancherId = rancherIds[0];
  if (!rancherId) {
    return NextResponse.json({ error: 'No rancher assigned to this referral yet' }, { status: 409 });
  }

  // Idempotency anchor: if preferences were already captured, update the stamped
  // fields (buyer may have refined them) but skip the duplicate thread message.
  const alreadyCaptured = !!ref['Buyer Preferences Set At'];
  const nowIso = new Date().toISOString();

  // 1) Stamp the Referral. Non-fatal individually but if this throws we surface
  //    a 500 so the buyer retries — the form's whole job is to record this.
  try {
    await updateRecord(TABLES.REFERRALS, refId, {
      ...preferencesToReferralFields(prefs, nowIso),
      'Last Buyer Activity At': nowIso,
    });
  } catch (e: any) {
    console.error('[checkout/preferences] referral stamp failed:', e?.message);
    return NextResponse.json({ error: 'Could not save preferences. Please try again.' }, { status: 500 });
  }

  // 2) Seed the thread with the structured message so it mirrors to the rancher.
  //    Skip on a repeat submit so we don't spam a duplicate into the thread.
  let threadId: string | null = null;
  let messagePosted = false;
  if (!alreadyCaptured) {
    try {
      const { id } = await getOrCreateThreadForReferral(refId, session.consumerId, rancherId);
      threadId = id;
      // Prefer the session name; fall back to the referral's Buyer Name so the
      // deposit-grant path (campaign link — session.name is empty) still
      // personalizes the rancher-facing message.
      const nameForGreeting = String(session.name || ref['Buyer Name'] || '').trim();
      const firstName = nameForGreeting.split(/\s+/)[0] || '';
      const messageBody = formatPreferencesMessage(prefs, { buyerFirstName: firstName });
      await postMessage({
        threadId: id,
        senderType: 'buyer',
        senderId: session.consumerId,
        body: messageBody,
        sentVia: 'web',
      });
      messagePosted = true;

      // Email-mirror to the rancher — same pattern as the thread message route.
      // Non-fatal: the message is already persisted in the thread + stamped on
      // the referral; an email failure must not fail the request.
      try {
        const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
        const rancherEmail = String(rancher?.['Email'] || '').trim();
        if (rancherEmail) {
          const safeBody = messageBody.replace(/</g, '&lt;').replace(/\n/g, '<br>');
          await sendEmail({
            to: rancherEmail,
            subject: 'Buyer preferences — how they want their beef',
            html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:36px;border:1px solid #A7A29A;background:#fff;line-height:1.6;color:#0E0E0E">
              <p style="margin:0 0 16px;color:#6B4F3F;font-size:14px;">Your buyer just shared how they'd like their order handled:</p>
              <div style="background:#F4F1EC;padding:16px;border-left:3px solid #6B4F3F;margin:16px 0;">${safeBody}</div>
              <p style="margin-top:24px;font-size:12px;color:#A7A29A;">Reply to this email to respond — it lands in the BuyHalfCow thread for both of you.</p>
            </div>`,
            // Dedicated whitelisted template (NOT generic 'sendEmail') so this
            // customer-driven handoff mirror is never silently dropped by the
            // 3/week frequency cap — the rancher may have had other emails this
            // week (intro, deposit-paid alert).
            templateName: 'sendRancherBuyerPreferences',
            _replyContext: { type: 'thread', recordId: id },
          });
        }
      } catch (e: any) {
        console.warn('[checkout/preferences] rancher email mirror failed (non-fatal):', e?.message);
      }
    } catch (e: any) {
      // Thread seed failed — the referral is still stamped, so the rancher will
      // see preferences on the dashboard. Log + return ok with a soft flag.
      console.warn('[checkout/preferences] thread seed failed (non-fatal):', e?.message);
    }
  }

  return NextResponse.json({
    ok: true,
    alreadyCaptured,
    threadId,
    messagePosted,
  });
}
