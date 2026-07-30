// lib/smsProviders/twilio.ts — the Twilio adapter.
//
// This is the EXISTING lib/twilio.ts send path, MOVED not rewritten. Same SDK,
// same env vars, same log strings, same false-on-anything-wrong contract. If
// SMS_PROVIDER is unset, lib/smsTransport.ts routes here and BuyHalfCow's SMS
// behavior is exactly what it was before the transport existed.
//
// Env:
//   TWILIO_ACCOUNT_SID   — from Twilio Console
//   TWILIO_AUTH_TOKEN    — from Twilio Console (or an API Key in production)
//   TWILIO_FROM_NUMBER   — sending number in E.164 (+1XXXXXXXXXX)
//
// The only structural change from the original: credentials are read at CALL
// time instead of module-load time (with the client memoized per credential
// pair), because the transport needs an injectable env for unit tests. On
// Vercel the env is identical at load and at call, so outcomes are unchanged.

import twilio from 'twilio';
import type { SmsAdapterOptions, SmsSendInput, SmsSendResult } from './types';

/** Test seam — lets the adapter test assert result mapping without the network. */
export interface TwilioAdapterOptions extends SmsAdapterOptions {
  clientFactory?: (sid: string, token: string) => {
    messages: { create: (args: { body: string; from: string; to: string }) => Promise<{ sid?: string }> };
  };
}

type TwilioClient = ReturnType<NonNullable<TwilioAdapterOptions['clientFactory']>>;

let memoKey = '';
let memoClient: TwilioClient | null = null;

function getClient(
  sid: string,
  token: string,
  factory?: TwilioAdapterOptions['clientFactory'],
): TwilioClient {
  if (factory) return factory(sid, token);
  const key = `${sid}:${token}`;
  if (memoKey !== key || !memoClient) {
    memoKey = key;
    memoClient = twilio(sid, token) as unknown as TwilioClient;
  }
  return memoClient;
}

export async function sendViaTwilio(
  input: SmsSendInput,
  opts: TwilioAdapterOptions = {},
): Promise<SmsSendResult> {
  const env = opts.env || process.env;
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = input.from || env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    // Log string preserved verbatim from the original lib/twilio.ts so existing
    // log greps and runbooks keep matching.
    console.warn('[twilio] account SID/auth token/from number missing — skip send');
    return { ok: false, provider: 'twilio', error: 'missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER' };
  }

  try {
    const client = getClient(sid, token, opts.clientFactory);
    const result = await client.messages.create({
      body: input.body,
      from,
      to: input.to,
    });
    console.log(`[twilio] sent SID ${result?.sid} to ${input.to}`);
    return { ok: true, provider: 'twilio', providerMessageId: result?.sid };
  } catch (e: any) {
    console.error(`[twilio] send failed to ${input.to}:`, e?.message || e);
    return { ok: false, provider: 'twilio', error: String(e?.message || e) };
  }
}
