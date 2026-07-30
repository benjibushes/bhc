// lib/smsKeywords.ts — carrier keyword classification + the replies we owe.
//
// EXTRACTED from app/api/webhooks/twilio-sms/route.ts (2026-07-30) so the
// provider-neutral inbound route (app/api/webhooks/sms) enforces the IDENTICAL
// rules. STOP/HELP handling is a CTIA/TCPA obligation — it cannot be allowed to
// drift between the Twilio route and the neutral one, so there is now exactly
// one copy and both routes call it.
//
// IMPORT-CLEAN by design (same contract as lib/smsFlag.ts): no airtable, no
// twilio, no env. Pure functions, fully unit-tested.

export type SmsKeyword = 'stop' | 'start' | 'help' | 'other';

export const BRAND = 'BuyHalfCow';
export const SUPPORT_EMAIL = 'hello@buyhalfcow.com';

// Twilio's standard opt-out / opt-in / help keyword sets (case-insensitive,
// whitespace-trimmed, punctuation stripped). Kept as a pure function so it's
// unit-testable without HTTP. The first non-empty token decides — carriers
// treat "STOP please" the same as "STOP".
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stopn']);
const START_WORDS = new Set(['start', 'unstop', 'yes', 'unsubscribe-stop', 'resume']);
const HELP_WORDS = new Set(['help', 'info']);

export function classifyKeyword(body: string | null | undefined): SmsKeyword {
  if (!body) return 'other';
  // Strip everything but letters so "STOP." / "Stop!" / " stop " all match,
  // then take the first whitespace-delimited token of the original-trimmed body.
  const firstToken = String(body).trim().split(/\s+/)[0] || '';
  const word = firstToken.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 'other';
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  if (HELP_WORDS.has(word)) return 'help';
  return 'other';
}

/**
 * The reply text a keyword earns, or null for "send nothing".
 *
 * HELP must carry brand + contact + rates + opt-out per CTIA guidelines.
 * STOP deliberately returns null: Twilio injects its own carrier-mandated STOP
 * confirmation, and texting someone who JUST opted out is the one thing worse
 * than not confirming. On providers that do not auto-confirm, enable the
 * vendor's own opt-out handling (see docs/SMS-PROVIDER-SETUP.md) rather than
 * sending from here.
 */
export function replyTextFor(keyword: SmsKeyword): string | null {
  if (keyword === 'help') {
    return `${BRAND}: half-cow beef matching. Help: ${SUPPORT_EMAIL}. Msg & data rates may apply. Reply STOP to cancel.`;
  }
  if (keyword === 'start') {
    return `${BRAND}: you're re-subscribed. Reply STOP to cancel, HELP for help.`;
  }
  return null;
}

/** True when the keyword changes a consumer's opt-in state in Airtable. */
export function keywordMutatesConsent(keyword: SmsKeyword): boolean {
  return keyword === 'stop' || keyword === 'start';
}
