// lib/smsProviders/telnyx.ts — Telnyx adapter (REST over fetch, no SDK).
//
// VERIFIED against https://developers.telnyx.com/docs/messaging/messages/send-message
// (fetched 2026-07-30):
//   POST https://api.telnyx.com/v2/messages
//   Content-Type: application/json
//   Authorization: Bearer YOUR_API_KEY
//   { "from": "+15551234567", "to": "+15559876543", "text": "Hello, world!" }
//   → 200 OK, message id at `data.id`.
//
// Env:
//   TELNYX_API_KEY — API key from the Telnyx portal (Auth → API Keys)
//   TELNYX_FROM    — sending number in E.164
//
// A2P 10DLC still applies — see docs/SMS-PROVIDER-SETUP.md. Swapping to Telnyx
// changes the onboarding EXPERIENCE, not the registration REQUIREMENT.

import type { SmsAdapterOptions, SmsSendInput, SmsSendResult } from './types';
import { postJson } from './http';

const ENDPOINT = 'https://api.telnyx.com/v2/messages';

/** Telnyx errors come back as `{ errors: [{ code, title, detail }] }`. */
function telnyxError(json: any, fallback: string): string {
  const first = Array.isArray(json?.errors) ? json.errors[0] : null;
  if (!first) return fallback;
  return [first.title, first.detail].filter(Boolean).join(': ') || fallback;
}

export async function sendViaTelnyx(
  input: SmsSendInput,
  opts: SmsAdapterOptions = {},
): Promise<SmsSendResult> {
  const env = opts.env || process.env;
  const apiKey = env.TELNYX_API_KEY;
  const from = input.from || env.TELNYX_FROM;

  if (!apiKey || !from) {
    console.warn('[telnyx] TELNYX_API_KEY / TELNYX_FROM missing — skip send');
    return { ok: false, provider: 'telnyx', error: 'missing TELNYX_API_KEY / TELNYX_FROM' };
  }

  const res = await postJson(ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { from, to: input.to, text: input.body },
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

  if (res.transportError) {
    console.error(`[telnyx] send failed to ${input.to}:`, res.transportError);
    return { ok: false, provider: 'telnyx', error: res.transportError };
  }
  if (!res.ok) {
    const err = telnyxError(res.json, res.text || `HTTP ${res.status}`);
    console.error(`[telnyx] send rejected (HTTP ${res.status}) to ${input.to}:`, err);
    return { ok: false, provider: 'telnyx', error: `HTTP ${res.status}: ${err}` };
  }

  const id = res.json?.data?.id ? String(res.json.data.id) : undefined;
  console.log(`[telnyx] sent id ${id ?? '(none)'} to ${input.to}`);
  return { ok: true, provider: 'telnyx', providerMessageId: id };
}
