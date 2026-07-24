// lib/zipGatherCampaign.ts
//
// ZIP-GATHERING CAMPAIGN (2026-07-23) — DARK by default, gated on Ben.
//
// Problem: ~248 legacy TX WAITING buyers have no ZIP, so neither the
// nearest-rancher sort (#452) nor the exclusive-ZIP gate (PR #462) can place
// them — a Houston buyer who'd be Thomas Cattle's exact customer is invisible.
//
// This module is the PURE core of a one-touch "confirm your delivery ZIP" ask:
//   (a) selectZipGatherAudience — area-code pre-filtered shortlist (offline),
//   (b) buildZipConfirmMessage  — TCPA/CAN-SPAM-safe copy, one-tap confirm link.
// The confirmed ZIP then flows through the SAME exclusive-ZIP gate as everyone
// else (lib/exclusiveZip) — this campaign never routes anyone; it only fills in
// the missing ZIP so the existing gate can do its job.
//
// Nothing here sends. The cron (app/api/cron/zip-gather) wires these behind an
// env flag Ben flips; default is dry-run (audience + copy, zero sends).

import { normalizeState } from './states';
import { normalizeZip } from './zipFormat';
import { metroFromPhone, type TxMetro } from './areaCodeMetro';

export interface ZipGatherConfig {
  /** Display name of the exclusive supplier the ask is for (e.g. "Thomas Cattle & Catering"). */
  supplierName: string;
  /** Which metros to include. Defaults to both Houston + Austin. */
  metros?: TxMetro[];
}

export interface ZipGatherCandidate {
  id: string;
  email: string;
  firstName: string;
  phone: string;
  metro: TxMetro;
}

/** First name from a "Full Name" cell, or a safe "there" fallback. */
function firstNameOf(fullName: unknown): string {
  return String(fullName || '').trim().split(/\s+/)[0] || 'there';
}

/**
 * Shortlist the WAITING, no-ZIP, TX buyers whose PHONE puts them in the
 * supplier's metro — the people it's worth asking to confirm a ZIP.
 *
 * Deliberately conservative (this is a real send Ben signs off on):
 *   - State must normalize to TX (the pool the founder scoped).
 *   - Buyer Stage must be WAITING (not already matched/closed).
 *   - No valid ZIP yet (nothing to gather otherwise).
 *   - Phone area code ∈ requested metros (the relevance pre-filter).
 *   - A real Email, and NOT suppressed (unsub/bounce/complaint) — CAN-SPAM.
 * A buyer failing any check is dropped, never messaged.
 */
export function selectZipGatherAudience(
  consumers: any[],
  config: ZipGatherConfig,
): ZipGatherCandidate[] {
  const metros: TxMetro[] = config.metros && config.metros.length > 0
    ? config.metros
    : ['houston', 'austin'];
  const out: ZipGatherCandidate[] = [];
  for (const c of consumers || []) {
    if (!c) continue;
    if (normalizeState(c['State']) !== 'TX') continue;
    if (String(c['Buyer Stage'] || '').trim().toUpperCase() !== 'WAITING') continue;
    if (normalizeZip(c['Zip']) !== null) continue; // already has a usable ZIP
    // Never message a suppressed contact.
    if (c['Unsubscribed'] || c['Bounced'] || c['Complained']) continue;
    const email = String(c['Email'] || '').trim();
    if (!email) continue;
    const metro = metroFromPhone(c['Phone']);
    if (!metro || !metros.includes(metro)) continue;
    out.push({
      id: c.id,
      email,
      firstName: firstNameOf(c['Full Name']),
      phone: String(c['Phone'] || '').trim(),
      metro,
    });
  }
  return out;
}

export interface ZipConfirmMessage {
  /** Email subject (email channel only). */
  subject?: string;
  /** Plain-text body — the whole SMS, or the text part of the email. */
  text: string;
  /** HTML body (email channel only). */
  html?: string;
}

/**
 * Build the TCPA/CAN-SPAM-safe "confirm your delivery ZIP" message.
 *
 * SMS: names BuyHalfCow (sender identity) + the supplier, one confirm link,
 *      and a "Reply STOP to opt out" — the pieces a compliant A2P message needs.
 * Email: subject + short founder-voice body + a single confirm button; the
 *        List-Unsubscribe header is added by the send layer (guardedSend).
 */
export function buildZipConfirmMessage(opts: {
  firstName: string;
  supplierName: string;
  metro: TxMetro;
  confirmUrl: string;
  channel: 'email' | 'sms';
}): ZipConfirmMessage {
  const { firstName, supplierName, confirmUrl, channel } = opts;
  if (channel === 'sms') {
    // Kept short + single-link. Identity + opt-out are the compliance must-haves.
    const text =
      `BuyHalfCow: ${firstName}, ${supplierName} can now deliver near you. ` +
      `Confirm your delivery ZIP so we can match you: ${confirmUrl} ` +
      `Reply STOP to opt out.`;
    return { text };
  }
  const subject = `Confirm your delivery ZIP so ${supplierName} can serve you`;
  const text =
    `Hi ${firstName},\n\n` +
    `${supplierName} is now serving buyers near you — but I need your delivery ZIP ` +
    `to confirm you're in their area and get you matched.\n\n` +
    `Confirm your ZIP (one tap): ${confirmUrl}\n\n` +
    `— Ben, BuyHalfCow`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>Hi ${escapeHtml(firstName)},</p>
      <p><strong>${escapeHtml(supplierName)}</strong> is now serving buyers near you — I just need your delivery ZIP to confirm you're in their area and get you matched.</p>
      <p style="margin:28px 0">
        <a href="${confirmUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600">
          confirm your ZIP →
        </a>
      </p>
      <p style="font-size:13px;color:#5A5752;line-height:1.6">One tap — it takes a few seconds and puts you in line for a local delivery slot. If the timing's wrong, just ignore this.</p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}
