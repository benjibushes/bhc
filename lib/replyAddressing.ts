// Reply-To addressing scheme for inbound capture.
//
// Every outbound BHC email gets a Reply-To pointing at replies.buyhalfcow.com
// with a context-encoded tag, so when a buyer or rancher replies, the inbound
// webhook can thread the reply back to the right Airtable record.
//
// ADDRESS FORMAT: <prefix>-<airtableRecordId>@replies.buyhalfcow.com
//
// Prefix table:
//   ref     → Referral (highest-context: buyer + rancher already paired)
//   usr     → Consumer (buyer-side, no active referral yet)
//   rnc     → Rancher (rancher-side, e.g. onboarding/launch warmup replies)
//   inq     → Inquiry (rancher-page contact form replies)
//   thread  → Thread (buyer↔rancher message thread; inbound replies post into the thread)
//
// Why prefixed (not raw record IDs): record IDs all start with "rec" but
// Airtable doesn't have a global lookup — you have to know which TABLE to
// query. The prefix tells the inbound webhook which table to hit, O(1).
//
// FALLBACK: if REPLIES_DOMAIN env var isn't set (e.g. local dev without
// inbound configured), Reply-To falls through to the legacy ben@<sending-domain>
// pattern from lib/email.ts. Code never breaks if inbound isn't wired up.

export const REPLIES_DOMAIN = process.env.REPLIES_DOMAIN || 'replies.buyhalfcow.com';

export type ReplyContextType = 'ref' | 'usr' | 'rnc' | 'inq' | 'thread';

export interface ReplyContext {
  type: ReplyContextType;
  recordId: string;
}

/**
 * Generate a tagged Reply-To address for an outbound email.
 * Pass the most specific context available (prefer 'ref' over 'usr'/'rnc').
 *
 * Example:
 *   replyToFor('ref', 'rec123abc') → 'ref-rec123abc@replies.buyhalfcow.com'
 */
export function replyToFor(type: ReplyContextType, recordId: string): string {
  if (!recordId) {
    // No context — return a generic "inbox" address that still routes through
    // the inbound webhook but won't thread to a specific record.
    return `inbox@${REPLIES_DOMAIN}`;
  }
  return `${type}-${recordId}@${REPLIES_DOMAIN}`;
}

/**
 * Parse an inbound recipient address back into a context. Returns null if
 * the address doesn't match our format (e.g. a forwarded email from elsewhere).
 *
 * Accepts variations:
 *   "ref-rec123abc@replies.buyhalfcow.com"
 *   "Some Name <ref-rec123abc@replies.buyhalfcow.com>"
 *   "REF-rec123abc@REPLIES.buyhalfcow.com" (case-insensitive)
 */
export function parseReplyAddress(rawAddress: string): ReplyContext | null {
  if (!rawAddress) return null;
  // Strip any "Name <addr>" wrapping
  const match = rawAddress.match(/<?([^@<>\s]+)@([^>\s]+)>?/);
  if (!match) return null;
  const localPart = match[1].toLowerCase();
  const domain = match[2].toLowerCase();

  // Only accept addresses on our replies domain (ignore forwarded externals)
  if (!domain.endsWith(REPLIES_DOMAIN.toLowerCase())) return null;

  // Special inbox bucket — no specific record context
  if (localPart === 'inbox') return null;

  // Prefix-record format
  const prefixMatch = localPart.match(/^(ref|usr|rnc|inq|thread)-(rec[a-z0-9]+)$/i);
  if (!prefixMatch) return null;

  const type = prefixMatch[1].toLowerCase() as ReplyContextType;
  const recordId = prefixMatch[2];
  return { type, recordId };
}

/**
 * The "to" field on inbound emails may contain an array. This finds the first
 * recipient whose address parses as a BHC reply context. Useful when an email
 * was sent to multiple people including BHC.
 */
export function findReplyContext(toAddresses: string[] | string | undefined): ReplyContext | null {
  if (!toAddresses) return null;
  const arr = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
  for (const addr of arr) {
    const ctx = parseReplyAddress(addr);
    if (ctx) return ctx;
  }
  return null;
}
