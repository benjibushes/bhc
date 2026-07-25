// lib/rancherSetupLinkSend.ts
//
// The ONE way a setup link reaches a rancher whose record was matched by
// something the submitter did not prove they control (team email, phone,
// ranch+state, website host). See lib/rancherSetupLinkDelivery.ts for the
// decision and the vulnerability it closes; this file is the I/O half.
//
// Three doors call it — /api/apply, /api/prospects/self-submit,
// /api/partners — so the rule, the throttle and the operator signal are
// provably identical at every entrance. Composes existing helpers only
// (rateLimit, guardedSend via lib/email, updateRecord); no new infrastructure.
//
// TWO RULES THIS FILE ENFORCES THAT A CALLER MUST NOT RE-IMPLEMENT:
//
//   1. The link goes to the address ALREADY ON THE RECORD, read by this
//      function from the record it is handed. Never to a submitted address.
//      Callers that also repair contact fields must pass the record as it
//      was BEFORE that repair, or they mail the link to whoever just
//      rewrote the row.
//
//   2. The email body carries the RECORD's own Ranch/Operator names, never
//      the submitter's input — the recipient is the real rancher, and
//      attacker-controlled strings must not be rendered into their inbox.

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './secrets';
import { rateLimit } from './rateLimit';
import { sendRancherApplyAutoApproved } from './email';
import { updateRecord, TABLES } from './airtable';
import {
  normalizeRancherEmail,
  setupLinkResendKey,
  SETUP_LINK_RESEND_LIMIT,
} from './rancherSetupLinkDelivery';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

/** Mint the 60-day rancher-setup wizard URL. Throws on a signing failure. */
export function mintRancherSetupUrl(rancherId: string): string {
  const token = jwt.sign({ type: 'rancher-setup', rancherId }, JWT_SECRET, {
    expiresIn: '60d',
  });
  return `${SITE_URL}/rancher/setup?token=${token}`;
}

export type SetupLinkSendOutcome =
  | 'sent'
  | 'no-email-on-file'
  | 'throttled'
  | 'send-failed'
  | 'mint-failed';

export interface SetupLinkSendResult {
  outcome: SetupLinkSendOutcome;
  /** Operator-facing detail (a suppression reason, a thrown message). */
  detail?: string;
}

/**
 * Mail the setup link to the address already on the rancher's record.
 *
 * Bounded by a per-RECORD 2-per-24h limiter (keyed on the record, not the
 * caller's IP, so rotating IPs can't bomb one rancher's inbox) on top of
 * guardedSend's own per-recipient frequency cap.
 *
 * NEVER throws — every door calls this on a path that must still return its
 * neutral 200. A genuine send failure is PERSISTED on the record
 * (`Welcome Email Failed At`, the existing queryable "this rancher has no
 * copy of their setup link" field) so a stranded rancher is findable in one
 * filter rather than living in a log line.
 */
export async function emailSetupLinkToOwner(record: {
  id: string;
  [field: string]: any;
}): Promise<SetupLinkSendResult> {
  const onFileEmail = String(record['Email'] || '').trim();
  if (!normalizeRancherEmail(onFileEmail)) {
    return { outcome: 'no-email-on-file' };
  }

  const throttle = await rateLimit(setupLinkResendKey(record.id), SETUP_LINK_RESEND_LIMIT);
  if (!throttle.ok) return { outcome: 'throttled' };

  let wizardUrl: string;
  try {
    wizardUrl = mintRancherSetupUrl(record.id);
  } catch (e: any) {
    return { outcome: 'mint-failed', detail: e?.message || 'unknown' };
  }

  // Record's own names — see rule 2 at the top of this file.
  const ranchName = String(record['Ranch Name'] || record['Operator Name'] || 'your ranch');
  const operatorName = String(record['Operator Name'] || record['Ranch Name'] || 'there');

  let result: { success: boolean; suppressed?: boolean; reason?: string };
  try {
    result = await sendRancherApplyAutoApproved({
      operatorName,
      ranchName,
      email: onFileEmail,
      wizardUrl,
      // No fit-check answers on this path — conservative, never "hot".
      score: 0,
      hotLead: false,
    });
  } catch (e: any) {
    result = { success: false, reason: e?.message || 'send threw' };
  }

  if (result.success) return { outcome: 'sent' };

  const detail = result.reason || (result.suppressed ? 'suppressed' : 'send failed');
  try {
    await updateRecord(TABLES.RANCHERS, record.id, {
      'Welcome Email Failed At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn('[setup-link-send] failure stamp failed (non-fatal):', e?.message);
  }
  return { outcome: 'send-failed', detail };
}

/** One-line operator-facing summary for the Telegram alert each door fires. */
export function describeSetupLinkSend(r: SetupLinkSendResult): string {
  switch (r.outcome) {
    case 'sent':
      return '📧 Setup link emailed to the address ON FILE (submitter did not prove control — no link in their browser).';
    case 'no-email-on-file':
      return '⚠️ NO email on file — nobody got a setup link. Reach out by phone.';
    case 'throttled':
      return 'ℹ️ Setup link NOT re-sent (already sent to the address on file in the last 24h). Possible probing — check the submitter below.';
    case 'mint-failed':
      return `⚠️ Setup link mint FAILED (${r.detail || 'unknown'}) — send one manually.`;
    case 'send-failed':
      return `⚠️ Setup link email ${r.detail ? `FAILED (${r.detail})` : 'FAILED'} — stamped Welcome Email Failed At; send it manually.`;
  }
}
