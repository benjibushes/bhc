// lib/smsProviders/bandwidth.ts — Bandwidth adapter (REST over fetch, no SDK).
//
// VERIFIED against https://dev.bandwidth.com/docs/messaging/createMessage/
// (fetched 2026-07-30):
//   POST https://messaging.bandwidth.com/api/v2/users/{accountId}/messages
//   Content-Type: application/json; charset=utf-8
//   Authorization: Basic <base64 user:pass>
//   Required body: to, from, text, applicationId   (optional: media, tag, priority)
//   `to` is a JSON ARRAY of strings: "to": ["+12345678902"]
//   → HTTP 202 Accepted, message id at top-level `id`.
//
// AUTH CAVEAT (verified via Bandwidth credential docs, 2026-07-30): the classic
// Basic-auth pair is API Token (username) + API Secret (password). Bandwidth is
// migrating to OAuth 2.0 client credentials — new legacy Basic-auth API users
// could not be created after 2026-03-31. A brand-new Bandwidth account may
// therefore need the OAuth flow, which this adapter does NOT implement. Treat
// Bandwidth as the least-ready of the four for a from-scratch signup and read
// docs/SMS-PROVIDER-SETUP.md before choosing it.
//
// Env:
//   BANDWIDTH_ACCOUNT_ID     — path segment {accountId}
//   BANDWIDTH_API_TOKEN      — Basic auth username
//   BANDWIDTH_API_SECRET     — Basic auth password
//   BANDWIDTH_APPLICATION_ID — messaging application bound to the from number
//   BANDWIDTH_FROM           — sending number in E.164

import type { SmsAdapterOptions, SmsSendInput, SmsSendResult } from './types';
import { postJson, basicAuth } from './http';

/** Bandwidth errors come back as `{ type, description, fieldErrors: [...] }`. */
function bandwidthError(json: any, fallback: string): string {
  const desc = json?.description || json?.message;
  const field = Array.isArray(json?.fieldErrors) ? json.fieldErrors[0] : null;
  const fieldMsg = field ? `${field.fieldName || 'field'}: ${field.description || ''}`.trim() : '';
  return [desc, fieldMsg].filter(Boolean).join(' — ') || fallback;
}

export async function sendViaBandwidth(
  input: SmsSendInput,
  opts: SmsAdapterOptions = {},
): Promise<SmsSendResult> {
  const env = opts.env || process.env;
  const accountId = env.BANDWIDTH_ACCOUNT_ID;
  const token = env.BANDWIDTH_API_TOKEN;
  const secret = env.BANDWIDTH_API_SECRET;
  const applicationId = env.BANDWIDTH_APPLICATION_ID;
  const from = input.from || env.BANDWIDTH_FROM;

  if (!accountId || !token || !secret || !applicationId || !from) {
    console.warn(
      '[bandwidth] BANDWIDTH_ACCOUNT_ID / API_TOKEN / API_SECRET / APPLICATION_ID / FROM missing — skip send',
    );
    return {
      ok: false,
      provider: 'bandwidth',
      error: 'missing BANDWIDTH_ACCOUNT_ID / BANDWIDTH_API_TOKEN / BANDWIDTH_API_SECRET / BANDWIDTH_APPLICATION_ID / BANDWIDTH_FROM',
    };
  }

  const url = `https://messaging.bandwidth.com/api/v2/users/${encodeURIComponent(accountId)}/messages`;
  const res = await postJson(url, {
    headers: { Authorization: basicAuth(token, secret) },
    // `to` is an array per the v2 spec — a bare string is rejected.
    body: { applicationId, to: [input.to], from, text: input.body },
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

  if (res.transportError) {
    console.error(`[bandwidth] send failed to ${input.to}:`, res.transportError);
    return { ok: false, provider: 'bandwidth', error: res.transportError };
  }
  if (!res.ok) {
    const err = bandwidthError(res.json, res.text || `HTTP ${res.status}`);
    console.error(`[bandwidth] send rejected (HTTP ${res.status}) to ${input.to}:`, err);
    return { ok: false, provider: 'bandwidth', error: `HTTP ${res.status}: ${err}` };
  }

  const id = res.json?.id ? String(res.json.id) : undefined;
  console.log(`[bandwidth] sent id ${id ?? '(none)'} to ${input.to}`);
  return { ok: true, provider: 'bandwidth', providerMessageId: id };
}
