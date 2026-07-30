// lib/smsTransport.ts — provider-agnostic SMS send.
//
// WHY THIS EXISTS (2026-07-30): lib/twilio.ts was the ONLY transport, so one
// vendor's signup decision could hold BuyHalfCow's entire SMS channel hostage.
// SMS is not a nice-to-have here — 7 of 7 unpaid deposit requests were never
// opened across 3 email touches; the single buyer who did open paid same-day.
// Email demonstrably failed that cohort. The channel must not depend on any one
// vendor's onboarding queue.
//
// WHERE THIS SITS — BELOW every guard, and that is the whole point:
//
//   fireSMSEvent / fireRancherSMSEvent  (lib/smsEvents.ts)
//     └─ smsEnabled()                   ENABLE_SMS master gate (lib/smsFlag.ts)
//        └─ sendSMSToConsumer()         TCPA: SMS Opt-In === true
//           └─                          suppression: Unsubscribed !== true
//              └─ sendSMS()             phone present + normalized to E.164
//                 └─ sendViaProvider()  ◀── THIS MODULE. Transport only.
//                    └─ adapter         twilio | telnyx | plivo | bandwidth
//
// Nothing above this line changed. Swapping SMS_PROVIDER cannot loosen consent,
// quiet hours, or the one-SMS-ever stamps — it only changes which wire the
// already-authorized message leaves on.
//
// DEFAULT = TWILIO. With SMS_PROVIDER unset, behavior is exactly what it was
// before this module existed (and ENABLE_SMS is still unset in prod, so the
// whole channel remains dark either way — this module lights nothing).

import { normalizeToE164 } from './phoneE164';
// DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
// lib/demo/demoMode.ts. Pure import, no side effect when the flag is off.
import { isDemoMode } from './demo/demoMode';
import { SMS_PROVIDERS } from './smsProviders/types';
import type {
  SmsAdapter,
  SmsAdapterOptions,
  SmsProvider,
  SmsSendInput,
  SmsSendResult,
} from './smsProviders/types';
import { sendViaTwilio } from './smsProviders/twilio';
import { sendViaTelnyx } from './smsProviders/telnyx';
import { sendViaPlivo } from './smsProviders/plivo';
import { sendViaBandwidth } from './smsProviders/bandwidth';

export { SMS_PROVIDERS };
export type { SmsProvider, SmsSendInput, SmsSendResult, SmsAdapterOptions };

const ADAPTERS: Record<SmsProvider, SmsAdapter> = {
  twilio: sendViaTwilio,
  telnyx: sendViaTelnyx,
  plivo: sendViaPlivo,
  bandwidth: sendViaBandwidth,
};

/**
 * Which vendor this deploy sends through.
 *
 * Pure: reads only the env object it is given. Unset/blank → 'twilio' so a
 * deploy that never heard of SMS_PROVIDER behaves identically to today. An
 * UNKNOWN value falls back to twilio and warns loudly rather than silently
 * dropping every send — a typo'd provider name must not kill the channel.
 */
export function resolveSmsProvider(
  env: Record<string, string | undefined> = process.env,
): SmsProvider {
  const raw = String(env.SMS_PROVIDER ?? '').trim().toLowerCase();
  if (!raw) return 'twilio';
  if ((SMS_PROVIDERS as readonly string[]).includes(raw)) return raw as SmsProvider;
  console.warn(`[sms] unknown SMS_PROVIDER="${raw}" — falling back to twilio`);
  return 'twilio';
}

/**
 * Send one SMS through the configured provider.
 *
 * CONTRACT: never throws. Every failure — bad creds, timeout, 4xx, unknown
 * provider, invalid number — returns `{ ok:false, error, provider }`. Callers
 * sit inside cron routes and webhooks that must not 500 on a vendor blip.
 *
 * This is TRANSPORT ONLY. It performs no consent, suppression, quiet-hours or
 * frequency checks — those live above it and are NOT optional. Do not call this
 * from a consumer-facing path; call sendSMSToConsumer (lib/twilio.ts) so the
 * TCPA gate can't be bypassed.
 */
export async function sendViaProvider(
  input: SmsSendInput,
  opts: SmsAdapterOptions = {},
): Promise<SmsSendResult> {
  const env = opts.env || process.env;
  const provider = resolveSmsProvider(env);

  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod. Report
  // success without touching any vendor. Mirrors the guard in sendSMS() so a
  // direct sendViaProvider() caller can't punch through it.
  if (isDemoMode()) {
    console.log(`[sms] DEMO MODE — skipping ${provider} send to ${input.to}`);
    return { ok: true, provider, providerMessageId: 'demo' };
  }

  // Defense in depth: sendSMS() already normalized, but sendViaProvider is a
  // public entry point and every vendor above requires strict E.164.
  const to = normalizeToE164(input.to);
  if (!to) {
    console.warn(`[sms] invalid phone number, skipping: ${input.to}`);
    return { ok: false, provider, error: `invalid phone number: ${input.to}` };
  }

  const adapter = ADAPTERS[provider];
  try {
    return await adapter({ to, body: input.body, from: input.from }, opts);
  } catch (e: any) {
    // Adapters are written not to throw; this is the backstop that guarantees
    // it for callers regardless.
    console.error(`[sms] ${provider} adapter threw:`, e?.message || e);
    return { ok: false, provider, error: String(e?.message || e) };
  }
}
