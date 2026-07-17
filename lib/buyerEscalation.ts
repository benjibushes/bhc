// lib/buyerEscalation.ts — the "escalate to a call ONLY when they're ready
// to buy" logic for the buyer sales arm.
//
// A ready-to-buy reply is the one signal the machine does NOT answer on its
// own — it hands the buyer to Ben. How HOT that handoff is comes from the
// platform's own purchase-readiness ladder (buyer-email audit 2026-07-16):
//
//   Deposit Paid At        → already a customer (this is a close, not a lead)
//   Deposit Link Opened At  → "the single hottest signal" per the codebase
//   Qualified At / Response Ack At → committed, quiz done
//   (none)                  → warm intent, no proof yet
//
// The machine emails the buyer the fastest path to purchase (their deposit
// link if they have one, else a call link) and fires a tiered Telegram card
// so Ben calls the hottest ones first.

import { type BuyerReplyContext } from './buyerReplyTemplates';

export interface IntentSignals {
  qualifiedAt?: string;
  responseAckAt?: string;
  referralStatus?: string;
  depositLinkOpenedAt?: string;
  depositPaidAt?: string;
}

export type ReadinessTier = 'closing' | 'hot' | 'warm';

export function readinessTier(sig: IntentSignals): ReadinessTier {
  if (String(sig.depositPaidAt || '').trim()) return 'closing';
  if (String(sig.depositLinkOpenedAt || '').trim()) return 'hot';
  if (String(sig.qualifiedAt || '').trim() || String(sig.responseAckAt || '').trim()) return 'hot';
  return 'warm';
}

export function tierEmoji(tier: ReadinessTier): string {
  return tier === 'closing' ? '💰' : tier === 'hot' ? '🔥' : '🌡️';
}

/**
 * The email the machine sends a ready-to-buy buyer: the fastest path to
 * purchase. Ben-voice, one CTA, signed. Never freestyle — a fixed shape so a
 * "I'm ready" reply always gets an immediate, on-brand next step even before
 * Ben picks up the phone.
 */
export function readyToBuyEmail(ctx: BuyerReplyContext): { subject: string; text: string } {
  const first = String(ctx.firstName || '').trim().split(/\s+/)[0];
  const hi = first ? `${first},` : 'hey,';
  const rancher = String(ctx.rancherName || '').trim() || 'your rancher';
  if (ctx.depositUrl) {
    return {
      subject: `you're ready — here's your spot with ${rancher}`,
      text:
        `${hi} love it. here's your spot with ${rancher}, this reserves it and I'll make sure they take it from there: ${ctx.depositUrl}\n\n` +
        `if you'd rather talk it through first, just say the word and I'll call you.\n\n— Ben`,
    };
  }
  return {
    subject: `you're ready — let's lock it in`,
    text:
      `${hi} love it. give me 15 minutes and we'll lock in your beef with ${rancher}${ctx.calLink ? `: ${ctx.calLink}` : ''}.\n\n` +
      `or just reply with a couple times that work and I'll call you.\n\n— Ben`,
  };
}
