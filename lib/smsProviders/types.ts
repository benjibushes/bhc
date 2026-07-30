// lib/smsProviders/types.ts — the shared vocabulary of the SMS transport.
//
// Lives in its own module (not in lib/smsTransport.ts) so the adapters can
// import the types + the shared HTTP helper without importing the dispatcher
// that imports THEM. No cycles, no side effects.
//
// IMPORT-CLEAN by design (same contract as lib/smsFlag.ts).

/** Every SMS vendor the transport knows how to speak to. */
export const SMS_PROVIDERS = ['twilio', 'telnyx', 'plivo', 'bandwidth'] as const;

export type SmsProvider = (typeof SMS_PROVIDERS)[number];

export interface SmsSendInput {
  /** Destination. Callers above the transport have already normalized to E.164. */
  to: string;
  body: string;
  /** Optional per-send sender override. Falls back to the provider's *_FROM env. */
  from?: string;
}

/**
 * Normalized outcome of a send, identical in shape for every vendor.
 *
 * `ok:false` is the ONLY failure signal — adapters never throw. A network
 * blowup, a timeout, a 4xx, a missing credential and an unparseable response
 * all land here with a human-readable `error`.
 */
export interface SmsSendResult {
  ok: boolean;
  provider: SmsProvider;
  /** Vendor's own id for the accepted message, when the response carried one. */
  providerMessageId?: string;
  error?: string;
}

/** Per-adapter injection seam: unit tests pass a fake env + fetch, prod passes neither. */
export interface SmsAdapterOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type SmsAdapter = (
  input: SmsSendInput,
  opts?: SmsAdapterOptions,
) => Promise<SmsSendResult>;
