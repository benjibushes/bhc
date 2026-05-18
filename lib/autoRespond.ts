// AI-drafted auto-reply for inbound buyer emails classified ghost or
// scheduling. Sends back to the original sender so the buyer doesn't
// sit waiting. Conservative trigger.

import { sendEmail } from './email';
import { callClaude } from './ai';

const SYSTEM = `You are an AI assistant drafting a SHORT reply on behalf
of Ben (the BuyHalfCow operator) to a buyer who emailed back. Tone:
warm, concise, no marketing speak. Sign off "— Ben". One paragraph.
No bullet lists. No "circle back". Acknowledge their message specifically.
If they asked about scheduling: tell them the rancher will reach out
within 48 hours. If they said they never heard from the rancher: apologize
and say we are routing them to a backup rancher.`;

export async function maybeAutoRespond(opts: {
  to: string;
  subject: string;
  bodyContext: string;
  category: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const body = opts.bodyContext.slice(0, 2000);
  let draft = '';
  try {
    draft = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      system: SYSTEM,
      user: `Category: ${opts.category}\nBuyer email:\n${body}`,
      maxTokens: 300,
    });
  } catch {
    return { sent: false, reason: 'classify-failed' };
  }
  if (!draft || draft.length < 20) return { sent: false, reason: 'empty-draft' };
  try {
    await sendEmail({
      to: opts.to,
      subject: `Re: ${opts.subject}`.slice(0, 200),
      html: `<p>${draft.replace(/\n/g, '<br>')}</p>`,
    } as any);
    return { sent: true };
  } catch (e: any) {
    return { sent: false, reason: e?.message || 'send-failed' };
  }
}
