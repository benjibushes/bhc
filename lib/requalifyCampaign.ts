// Pure half of the requalification campaign sender (route:
// app/api/campaign/requalify-send). Template is the Ben-approved copy from
// docs/marketing/email-quiz-resume.md — quiz-incomplete variant, pinned to
// Champion Valley. Body validation is strict: recipients carry ONLY
// email/name/state, so the endpoint can never be used to send arbitrary
// content. The CAN-SPAM footer + unsubscribe link are appended downstream by
// the guarded rail — do not add them here (double-footer).

export const MAX_BATCH = 60;

export interface RequalifyRecipient { email: string; name: string; state: string }

const RANCH_NAME = 'Champion Valley Farm';
const RANCH_SLUG = 'champion-valley-farm';

export function requalifyCta(state: string): string {
  const st = /^[A-Za-z]{2}$/.test(state) ? state.toLowerCase() : 'xx';
  return `https://www.buyhalfcow.com/access?rancher=${RANCH_SLUG}&utm_source=email&utm_medium=drip&utm_campaign=waiting-wake-${st}`;
}

export function renderRequalifyEmail(name: string, state: string): { subject: string; html: string } {
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  const st = /^[A-Za-z]{2}$/.test(state) ? state.toUpperCase() : 'your state';
  const cta = requalifyCta(state);
  return {
    subject: `${first}, there's a ranch for you now`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#2b2b2b;font-size:16px;line-height:1.6">
<p>${first} — you signed up for the waitlist a while back and then heard nothing from me. That silence was real: we didn't have a ranch serving ${st}, and I wasn't going to send you hype about beef you couldn't buy.</p>
<p>That changed. We now have a ranch serving ${st} — ${RANCH_NAME}. One thing stands between you and a match: the 90 second quiz you started. Finish it and we route you to your rancher.</p>
<p>Finish the quiz:<br><a href="${cta}">${cta}</a></p>
<p>If the timing is wrong, ignore me. You lose nothing. But the shares on that page are a real count of what's left this round, so if a freezer full of honest beef is still the plan, it's worth a look this week.</p>
<p>— Ben</p></div>`,
  };
}

export function validateRequalifyBatch(body: unknown):
  | { recipients: RequalifyRecipient[]; campaign: string; dryRun: boolean }
  | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const campaign = String(b.campaign || '').trim();
  if (!/^[a-z0-9-]{3,40}$/.test(campaign)) return { error: 'campaign must be a kebab-case slug' };
  if (!Array.isArray(b.recipients) || b.recipients.length === 0) return { error: 'recipients required' };
  if (b.recipients.length > MAX_BATCH) return { error: `max ${MAX_BATCH} recipients per call` };
  const recipients: RequalifyRecipient[] = [];
  for (const r of b.recipients) {
    const rec = r as Record<string, unknown>;
    const email = String(rec?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `invalid email: ${email.slice(0, 40)}` };
    recipients.push({ email, name: String(rec?.name || '').slice(0, 80), state: String(rec?.state || '').slice(0, 2) });
  }
  return { recipients, campaign, dryRun: b.dryRun === true };
}
