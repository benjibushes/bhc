// lib/smsInboundHandler.ts — the Airtable half of inbound SMS keyword handling.
//
// EXTRACTED VERBATIM from app/api/webhooks/twilio-sms/route.ts (2026-07-30).
// Both inbound routes now call this, so a buyer who texts STOP is opted out
// identically whether the message arrived via Twilio, Telnyx, Plivo or
// Bandwidth. That is a legal obligation, not a convenience — it must not be
// possible for a provider swap to leave one route enforcing it and the other not.
//
// WRITES (Consumers): `Unsubscribed`, `SMS Opt-In`, `SMS Opt-In At`.
// These are the same three fields, with the same semantics, that the Twilio
// route wrote before the extraction (see docs/WRITE-MAP.md).
//
// Pure keyword logic lives in lib/smsKeywords.ts (import-clean); this module is
// the side-effecting half and is re-exported from there for callers that want
// both.

import { getAllRecords, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { normalizeToE164 } from '@/lib/phoneE164';
import type { SmsKeyword } from '@/lib/smsKeywords';

export { classifyKeyword, replyTextFor, keywordMutatesConsent, BRAND, SUPPORT_EMAIL } from '@/lib/smsKeywords';
export type { SmsKeyword } from '@/lib/smsKeywords';

export interface InboundKeywordOutcome {
  /** Consumer whose consent state we flipped, or null when nothing matched. */
  consumerId: string | null;
  /** True when an Airtable write actually landed. */
  updated: boolean;
}

/**
 * Apply a STOP/START keyword to the matching Consumer's opt-in state.
 *
 * STOP  → Unsubscribed=true  + SMS Opt-In=false
 * START → Unsubscribed=false + SMS Opt-In=true + re-stamp SMS Opt-In At
 * HELP / other → no mutation.
 *
 * Best-effort and FAIL-OPEN by design: a no-match (a stranger texting the line)
 * or an Airtable hiccup returns `{ consumerId: null, updated: false }` rather
 * than throwing, so an inbound webhook never retry-storms. The carrier-level
 * opt-out is enforced by the provider regardless of what happens here.
 *
 * @param logTag prefix for log lines so twilio-sms vs sms routes stay distinguishable.
 */
export async function applyInboundKeyword(input: {
  from: string;
  keyword: SmsKeyword;
  logTag?: string;
}): Promise<InboundKeywordOutcome> {
  const tag = input.logTag || 'sms-inbound';
  const { keyword } = input;
  if (keyword !== 'stop' && keyword !== 'start') {
    return { consumerId: null, updated: false };
  }

  const e164 = normalizeToE164(input.from);
  if (!e164) return { consumerId: null, updated: false };

  try {
    const consumer = await findConsumerByPhone(e164, input.from, tag);
    if (!consumer) {
      console.log(`[${tag}] no consumer matched for inbound`, { keyword });
      return { consumerId: null, updated: false };
    }
    if (keyword === 'stop') {
      await updateRecord(TABLES.CONSUMERS, consumer.id, {
        'Unsubscribed': true,
        'SMS Opt-In': false,
      });
      console.log(`[${tag}] STOP → opted out ${consumer.id}`);
    } else {
      // re-opt-in: clear suppression + re-stamp consent evidence.
      await updateRecord(TABLES.CONSUMERS, consumer.id, {
        'Unsubscribed': false,
        'SMS Opt-In': true,
        'SMS Opt-In At': new Date().toISOString(),
      });
      console.log(`[${tag}] START → re-opted-in ${consumer.id}`);
    }
    return { consumerId: consumer.id, updated: true };
  } catch (e: any) {
    // Never let an Airtable hiccup turn into a provider retry storm.
    console.error(`[${tag}] consumer update failed:`, e?.message || e);
    return { consumerId: null, updated: false };
  }
}

// Find a Consumer by phone. We match on the normalized E.164 form but our DB
// stores phones in mixed formats (raw form input), so we query a few common
// representations. Best-effort, fail-open (returns null on error).
export async function findConsumerByPhone(
  e164: string,
  raw: string,
  logTag = 'sms-inbound',
): Promise<{ id: string } | null> {
  const digits = e164.replace(/\D/g, ''); // e.g. 15551234567
  const tenDigit = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  // Candidate stored formats to OR-match against the Phone column.
  const candidates = Array.from(
    new Set(
      [e164, raw.trim(), digits, tenDigit].filter((v) => v && v.length >= 7),
    ),
  );
  const clauses = candidates
    .map((c) => `{Phone} = "${escapeAirtableValue(c)}"`)
    .join(', ');
  // Also catch records whose stored phone, with non-digits stripped, ends with
  // the 10-digit national number — covers "(555) 123-4567" style storage.
  const formula = `OR(${clauses}, RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone}, "-", ""), " ", ""), "(", ""), ")", ""), 10) = "${escapeAirtableValue(tenDigit)}")`;
  try {
    const rows = (await getAllRecords(TABLES.CONSUMERS, formula)) as any[];
    if (rows.length > 0) return { id: rows[0].id };
  } catch (e: any) {
    console.error(`[${logTag}] findConsumerByPhone failed:`, e?.message || e);
  }
  return null;
}
