// Identity fallback for inbound replies that arrive WITHOUT a reply-context
// token (the "unknown sender" rows).
//
// THE SECOND BLINDNESS (2026-08-03): the tagged Reply-To path
// (ref-<id>@replies…) is authoritative but frequently missing — most
// buyer-facing sends fall back to inbox@replies… and people reply to old
// threads, so the webhook had no idea WHO was writing. The existing
// findReferralByBuyerEmail fallback only helps when the sender has a
// Referral. This module adds the last rung: match the bare From address
// against Consumers, then Ranchers (case-insensitive, exact-address), so the
// row is linked + typed even with no referral.
//
// HARD RULE: the token path is PRIMARY. applyIdentityFallback is a pure
// guard that refuses to touch anything when a token-derived context or any
// already-resolved link exists — the fallback can only ever FILL a blank,
// never overwrite.

import type { ReplyContext } from '@/lib/replyAddressing';

export interface IdentityMatch {
  senderType: 'buyer' | 'rancher';
  consumerId?: string;
  rancherId?: string;
}

export interface InboundLinks {
  referralId?: string;
  consumerId?: string;
  rancherId?: string;
  threadId?: string;
}

/** Extract the bare lowercased address from "Name <addr@host>" or "addr@host". */
export function bareEmail(raw: unknown): string {
  const s = String(raw || '').toLowerCase().trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

type LookupFn = (
  tableName: string,
  filterByFormula: string,
  opts?: { maxRecords?: number },
) => Promise<Array<Record<string, any>>>;

async function defaultLookup(
  tableName: string,
  filterByFormula: string,
  opts?: { maxRecords?: number },
): Promise<Array<Record<string, any>>> {
  const { getAllRecords } = await import('@/lib/airtable');
  return (await getAllRecords(tableName, filterByFormula, opts)) as Array<Record<string, any>>;
}

/**
 * Match a bare From address against Consumers first, then Ranchers.
 * Consumers wins ties (a person present in both tables is treated as the
 * buyer — the safer read for downstream copy). Exact-address match only:
 * bare equality or the address inside a "Name <addr>" wrapper — mirrors
 * findReferralByBuyerEmail's anti-substring pattern (ben@x vs rueben@x).
 * Read-only; returns null when nothing matches or on lookup failure.
 */
export async function matchSenderByEmail(
  fromEmail: string,
  deps?: { lookup?: LookupFn; consumersTable?: string; ranchersTable?: string },
): Promise<IdentityMatch | null> {
  const e = bareEmail(fromEmail).replace(/"/g, '');
  if (!e || !e.includes('@')) return null;
  const lookup = deps?.lookup || defaultLookup;
  const consumersTable = deps?.consumersTable || 'Consumers';
  const ranchersTable = deps?.ranchersTable || 'Ranchers';
  const formula = `OR(LOWER(TRIM({Email})) = "${e}", FIND("<${e}>", LOWER({Email})) > 0)`;

  try {
    const consumers = await lookup(consumersTable, formula, { maxRecords: 2 });
    if (consumers.length > 0 && consumers[0]?.id) {
      return { senderType: 'buyer', consumerId: String(consumers[0].id) };
    }
  } catch (err: any) {
    console.warn('[inbound-identity] consumer lookup failed:', err?.message || err);
  }
  try {
    const ranchers = await lookup(ranchersTable, formula, { maxRecords: 2 });
    if (ranchers.length > 0 && ranchers[0]?.id) {
      return { senderType: 'rancher', rancherId: String(ranchers[0].id) };
    }
  } catch (err: any) {
    console.warn('[inbound-identity] rancher lookup failed:', err?.message || err);
  }
  return null;
}

/**
 * Pure guard: apply an identity match to the resolved links ONLY when there
 * is no token-derived context and nothing is already linked. The token path
 * (and the referral-by-buyer-email fallback that runs before this) always
 * wins — the fallback fills blanks, never overwrites.
 */
export function applyIdentityFallback(args: {
  context: ReplyContext | null;
  links: InboundLinks;
  match: IdentityMatch | null;
}): { links: InboundLinks; applied: boolean } {
  const { context, links, match } = args;
  if (context) return { links, applied: false }; // token-derived context is authoritative
  if (links.referralId || links.consumerId || links.rancherId || links.threadId) {
    return { links, applied: false }; // something already resolved this sender
  }
  if (!match) return { links, applied: false };
  const next: InboundLinks = { ...links };
  if (match.senderType === 'buyer' && match.consumerId) next.consumerId = match.consumerId;
  if (match.senderType === 'rancher' && match.rancherId) next.rancherId = match.rancherId;
  const applied = next.consumerId !== links.consumerId || next.rancherId !== links.rancherId;
  return { links: next, applied };
}
