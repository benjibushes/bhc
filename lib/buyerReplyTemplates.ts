// lib/buyerReplyTemplates.ts — the buyer sales arm's answers.
//
// When a family replies to a BuyHalfCow email, the machine answers the common
// questions in Ben's voice from a fixed template bank — NOT freestyle LLM
// prose (same lesson the rancher outreach machine learned: model-written
// "answers" read like a bot and drift off-message). One template per objection
// category, slot-filled from the referral context, run through a voice guard.
//
// Categories the machine ANSWERS (returns text): price, distance, timing, cut,
// scheduling, quality, capacity, ghost. Categories it does NOT (returns null →
// escalate to Ben): ready-to-buy (→ call), propose-close-won (→ close), other,
// none, and anything with blocking sentiment.

import { SHARE_WEIGHTS } from './beefWeights';

export type BuyerObjection =
  | 'price'
  | 'distance'
  | 'timing'
  | 'cut'
  | 'ghost'
  | 'ready-to-buy'
  | 'scheduling'
  | 'capacity'
  | 'quality'
  | 'other'
  | 'none';

export interface BuyerReplyContext {
  firstName?: string;
  rancherName?: string;
  state?: string;
  depositUrl?: string; // buyer's own deposit page, if a deposit-capable referral exists
  calLink?: string; // book-a-call link
}

// Corporate / bot tells BHC bans (docs/BHC.md ANTI-PATTERNS + bhc-marketing).
const BANNED = [
  'synergy',
  'seamless',
  'leverage',
  'circle back',
  'touch base',
  'best-in-class',
  'ecosystem',
  'stakeholder',
  'curate',
  'holistic',
  'revolutionary',
  'disrupt',
  'i hope this email finds you',
  'i hope this finds you',
  'per my last email',
  'as per',
  'kindly',
  'at your earliest convenience',
  'do not hesitate',
  "don't hesitate",
  'guaranteed leads',
];

/** Returns the offending phrase if the text breaks Ben's buyer voice, else null. */
export function violatesBuyerVoice(text: string): string | null {
  const t = String(text || '').toLowerCase();
  for (const p of BANNED) if (t.includes(p)) return p;
  const words = String(text || '').trim().split(/\s+/).length;
  if (words > 130) return `too long (${words} words)`;
  if (words < 15) return `too short (${words} words)`;
  if ((text.match(/!/g) || []).length > 1) return 'exclamation overload';
  if (!/—\s*ben\s*$/i.test(String(text || '').trim())) return 'missing "— Ben" sign-off';
  return null;
}

function firstNameOf(ctx: BuyerReplyContext): string {
  const n = String(ctx.firstName || '').trim().split(/\s+/)[0];
  return n ? `${n},` : 'hey,';
}

function rancher(ctx: BuyerReplyContext): string {
  return String(ctx.rancherName || '').trim() || 'your rancher';
}

// The one CTA line, chosen by what the buyer can actually do next: pay a
// deposit (hottest) or book a call. Always present so every answer moves
// toward the close.
function ctaLine(ctx: BuyerReplyContext): string {
  if (ctx.depositUrl) {
    return `when you're ready, here's your spot: ${ctx.depositUrl}`;
  }
  if (ctx.calLink) {
    return `want to talk it through? grab 15 minutes with me: ${ctx.calLink}`;
  }
  return `just reply here and I'll sort it out with you.`;
}

type Builder = (ctx: BuyerReplyContext) => string;

// Campaign-rewrite (2026-08-18): these fire with no human review, so every
// number is weights-only from SHARE_WEIGHTS (lib/beefWeights — the one truth
// table) and every price defers to the ranch's own page. The old price reply
// asserted $1,000–$1,400 halves at $7–$9/lb against live network quarters of
// $740–$2,200 (quoting prices ranches didn't set), plus a "no middleman
// markup" claim that collides with buyer-pays-on-top on Connect.
const TEMPLATES: Partial<Record<BuyerObjection, Builder>> = {
  price: (ctx) =>
    `${firstNameOf(ctx)} good question on price. every ranch sets its own price, so I won't quote a number ${rancher(ctx)} didn't set. what I can tell you: a quarter comes back around ${SHARE_WEIGHTS.quarter.lbs} of beef and a half around ${SHARE_WEIGHTS.half.lbs}, cut the way you want it, and you buy direct from the ranch at the ranch's own price. ${ctaLine(ctx)}\n\n— Ben`,

  distance: (ctx) =>
    `${firstNameOf(ctx)} on distance, most folks pick up from ${rancher(ctx)} or a nearby locker, and a lot of ranchers will meet partway or help coordinate. tell me your town and I'll tell you exactly how the handoff would work. ${ctaLine(ctx)}\n\n— Ben`,

  timing: (ctx) =>
    `${firstNameOf(ctx)} totally fine to buy on your own timeline. ${rancher(ctx)} works in batches, so the sooner you reserve the sooner you lock a spot in the next one. no rush from me, just don't want you to miss the window. ${ctaLine(ctx)}\n\n— Ben`,

  cut: (ctx) =>
    `${firstNameOf(ctx)} you get a say in the cuts. a half comes back around ${SHARE_WEIGHTS.half.lbs} of steaks, roasts, and ground, and you tell the processor how to break it down (thickness, ground ratio, roasts vs steaks). ${rancher(ctx)} walks you through the cut sheet. ${ctaLine(ctx)}\n\n— Ben`,

  quality: (ctx) =>
    `${firstNameOf(ctx)} fair to ask. ${rancher(ctx)} is a real family ranch I work with myself, not a label on a grocery shelf. you'll know the animal and how it was raised, and you buy straight from them. that's the whole point of what we do. ${ctaLine(ctx)}\n\n— Ben`,

  capacity: (ctx) =>
    `${firstNameOf(ctx)} a half is a lot of beef, so freezer space is worth checking. figure ${SHARE_WEIGHTS.half.cuFt} for a half, which is chest freezer territory, and a quarter runs ${SHARE_WEIGHTS.quarter.cuFt} if you want to start smaller. happy to help you size it. ${ctaLine(ctx)}\n\n— Ben`,

  scheduling: (ctx) =>
    `${firstNameOf(ctx)} let's get a time down. ${rancher(ctx)} will coordinate pickup once you reserve, and if you'd rather just talk it through with me first that works too. ${ctaLine(ctx)}\n\n— Ben`,

  ghost: (ctx) =>
    `${firstNameOf(ctx)} sorry you haven't heard back yet, that's on me to fix. I'll nudge ${rancher(ctx)} today, and if they're slammed I'll line up another ranch near you so you're not left waiting. give me a day. ${ctaLine(ctx)}\n\n— Ben`,
};

/**
 * Draft a buyer reply for an objection category. Returns the text (Ben's
 * voice, voice-guard-clean) or null if the category isn't machine-handleable
 * (ready-to-buy / close / other / none / unknown) — the caller escalates
 * those to Ben instead of answering.
 */
export function draftBuyerReply(
  category: BuyerObjection,
  ctx: BuyerReplyContext,
): { text: string } | null {
  const builder = TEMPLATES[category];
  if (!builder) return null;
  const text = builder(ctx);
  if (violatesBuyerVoice(text)) return null; // never ship an off-voice answer
  return { text };
}

/** The categories the machine answers on its own. */
export const MACHINE_HANDLED: BuyerObjection[] = [
  'price',
  'distance',
  'timing',
  'cut',
  'quality',
  'capacity',
  'scheduling',
  'ghost',
];
