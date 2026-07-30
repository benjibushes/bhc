// lib/smsProviders/plivo.ts — Plivo adapter (REST over fetch, no SDK).
//
// VERIFIED against https://www.plivo.com/docs/messaging/api/message/send-a-message/
// (fetched 2026-07-30):
//   POST https://api.plivo.com/v1/Account/{auth_id}/Message/
//   Basic auth: AUTH_ID as username, AUTH_TOKEN as password
//   Content-Type: application/json
//   { "src": "+14151234567", "dst": "+14157654321", "text": "Hello from Plivo!" }
//   → { "message": "message(s) queued", "message_uuid": ["…"], "api_id": "…" }
//   Docs print the success as 200; the live API answers 202 Accepted for a
//   queued message, so we accept ANY 2xx rather than pinning one code.
//
// Env:
//   PLIVO_AUTH_ID    — Plivo console → Account → Auth ID
//   PLIVO_AUTH_TOKEN — Plivo console → Account → Auth Token
//   PLIVO_FROM       — sending number in E.164 (goes out as `src`)

import type { SmsAdapterOptions, SmsSendInput, SmsSendResult } from './types';
import { postJson, basicAuth } from './http';

/** Plivo errors come back as `{ error: "…" }` (sometimes `{ message: "…" }`). */
function plivoError(json: any, fallback: string): string {
  return String(json?.error || json?.message || fallback);
}

export async function sendViaPlivo(
  input: SmsSendInput,
  opts: SmsAdapterOptions = {},
): Promise<SmsSendResult> {
  const env = opts.env || process.env;
  const authId = env.PLIVO_AUTH_ID;
  const authToken = env.PLIVO_AUTH_TOKEN;
  const src = input.from || env.PLIVO_FROM;

  if (!authId || !authToken || !src) {
    console.warn('[plivo] PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_FROM missing — skip send');
    return { ok: false, provider: 'plivo', error: 'missing PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_FROM' };
  }

  const url = `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Message/`;
  const res = await postJson(url, {
    headers: { Authorization: basicAuth(authId, authToken) },
    body: { src, dst: input.to, text: input.body },
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

  if (res.transportError) {
    console.error(`[plivo] send failed to ${input.to}:`, res.transportError);
    return { ok: false, provider: 'plivo', error: res.transportError };
  }
  if (!res.ok) {
    const err = plivoError(res.json, res.text || `HTTP ${res.status}`);
    console.error(`[plivo] send rejected (HTTP ${res.status}) to ${input.to}:`, err);
    return { ok: false, provider: 'plivo', error: `HTTP ${res.status}: ${err}` };
  }

  const uuid = Array.isArray(res.json?.message_uuid) ? res.json.message_uuid[0] : undefined;
  const id = uuid ? String(uuid) : undefined;
  console.log(`[plivo] sent uuid ${id ?? '(none)'} to ${input.to}`);
  return { ok: true, provider: 'plivo', providerMessageId: id };
}
