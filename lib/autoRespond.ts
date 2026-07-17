// Buyer sales arm — the machine's reply to an inbound buyer email.
//
// REWRITTEN 2026-07-16 (Ben's "next hire"): the old version freestyled a
// Haiku paragraph and sent it immediately with no voice guard and no human
// gate — the exact "doesn't feel human" failure the rancher outreach machine
// was rebuilt to kill. This version answers from the Ben-voice template bank
// (lib/buyerReplyTemplates), voice-guards every send, and runs on a dial:
//
//   BUYER_AUTORESPOND = off       → machine never answers (Ben handles all)
//                     | assisted  → machine STAGES a draft (default); Ben
//                                   one-taps Send from Telegram / the console
//                     | auto      → machine sends the answer itself
//
// Only machine-handleable objection categories are answered (price, distance,
// timing, cut, quality, capacity, scheduling, ghost). ready-to-buy and
// close-won never come here — they escalate.

import { sendEmail } from './email';
import { draftBuyerReply, MACHINE_HANDLED, type BuyerObjection, type BuyerReplyContext } from './buyerReplyTemplates';

export type AutoRespondMode = 'off' | 'assisted' | 'auto';

export function autoRespondMode(): AutoRespondMode {
  // Default AUTO (Ben, 2026-07-17: "flip everything, make it live") — the
  // machine sends template objection answers to buyers itself instead of
  // staging them. Templates only, voice-guarded, STOP-guarded, Message-Id
  // claimed; anything off-template still escalates to Ben. Set
  // BUYER_AUTORESPOND=assisted (stage + one-tap) or off to dial back.
  const m = String(process.env.BUYER_AUTORESPOND || 'auto').toLowerCase();
  return m === 'off' || m === 'assisted' ? (m as AutoRespondMode) : 'auto';
}

export interface AutoRespondResult {
  mode: AutoRespondMode;
  handled: boolean; // did the machine produce an answer for this category
  sent: boolean; // did we actually email it (auto mode only)
  staged: boolean; // is there a draft for Ben to one-tap (assisted mode)
  draft?: string; // the Ben-voice answer text
  reason?: string;
}

export async function maybeAutoRespond(opts: {
  to: string;
  subject: string;
  category: string;
  ctx: BuyerReplyContext;
  inReplyTo?: string;
}): Promise<AutoRespondResult> {
  const mode = autoRespondMode();
  const category = opts.category as BuyerObjection;

  if (!MACHINE_HANDLED.includes(category)) {
    return { mode, handled: false, sent: false, staged: false, reason: 'not machine-handled' };
  }

  const drafted = draftBuyerReply(category, opts.ctx);
  if (!drafted) {
    return { mode, handled: false, sent: false, staged: false, reason: 'template/voice-guard rejected' };
  }
  const draft = drafted.text;

  if (mode === 'off') {
    return { mode, handled: true, sent: false, staged: false, draft, reason: 'autorespond off' };
  }

  if (mode === 'assisted') {
    // Stage only — the webhook persists the draft to the Conversations row
    // and cards it to Telegram for a one-tap Send. No email leaves here.
    return { mode, handled: true, sent: false, staged: true, draft };
  }

  // auto: send it ourselves, threaded into the buyer's conversation.
  try {
    await sendEmail({
      to: opts.to,
      subject: `Re: ${opts.subject}`.slice(0, 200),
      html: `<p>${draft.replace(/\n/g, '<br>')}</p>`,
      ...(opts.inReplyTo ? { headers: { 'In-Reply-To': opts.inReplyTo, References: opts.inReplyTo } } : {}),
    } as any);
    return { mode, handled: true, sent: true, staged: false, draft };
  } catch (e: any) {
    return { mode, handled: true, sent: false, staged: false, draft, reason: e?.message || 'send-failed' };
  }
}
