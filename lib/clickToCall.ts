// lib/clickToCall.ts
//
// F11 — Click-to-call + auto-record + Whisper transcribe (feature-flagged).
//
// User constraint: "I dont have twlio setup yet" — feature stays OFF
// until ENABLE_CLICK_TO_CALL=1 + Twilio + GROQ creds set.
//
// Flow:
//   1. Ben clicks "Call" on a Consumer card in /admin/today/v2
//   2. POST /api/admin/click-to-call → initiateCall() here
//   3. Twilio conference: dials Ben's phone first, then the buyer
//   4. Auto-record both legs (Twilio recordingStatusCallback)
//   5. Twilio POSTs to /api/webhooks/twilio-recording when complete
//   6. Webhook fetches audio, sends to Groq Whisper, saves Conversation row
//
// Env vars:
//   ENABLE_CLICK_TO_CALL       — '1' to enable, default off
//   TWILIO_ACCOUNT_SID / AUTH_TOKEN / FROM_NUMBER  — existing
//   BHC_OPERATOR_PHONE         — Ben's phone in E.164
//   GROQ_API_KEY               — for Whisper transcription
//   NEXT_PUBLIC_SITE_URL       — for recordingStatusCallback URL

import twilio from 'twilio';
import { normalizeToE164 } from './twilio';

const CTC_FEATURE_FLAG = 'ENABLE_CLICK_TO_CALL';

export function isClickToCallEnabled(): boolean {
  return process.env[CTC_FEATURE_FLAG] === '1';
}

/**
 * SSRF guard for the recording fetch. transcribeRecording sends the Twilio
 * Basic-auth header (ACCOUNT_SID:AUTH_TOKEN) with the request, so the URL
 * MUST be a Twilio-hosted https endpoint — otherwise an attacker-supplied
 * RecordingUrl (e.g. via a spoofed webhook) would exfiltrate our Twilio
 * credentials or reach internal services (cloud metadata endpoints, etc).
 * Only twilio.com / *.twilio.com over https are allowed.
 */
export function isAllowedTwilioRecordingUrl(recordingUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(recordingUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'twilio.com' || host.endsWith('.twilio.com');
}

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const OPERATOR_PHONE = process.env.BHC_OPERATOR_PHONE;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

/**
 * Initiate a click-to-call. Connects operator (Ben) to buyer via
 * Twilio conference, records both legs, transcribes async on completion.
 *
 * Returns null if feature disabled, missing env, or invalid phone.
 */
export async function initiateCall(input: {
  buyerPhone: string;
  buyerName: string;
  consumerId: string;
}): Promise<{ callSid: string } | null> {
  if (!isClickToCallEnabled()) return null;
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER || !OPERATOR_PHONE) {
    console.warn('[clickToCall] Twilio creds or BHC_OPERATOR_PHONE missing');
    return null;
  }

  const to = normalizeToE164(input.buyerPhone);
  const from = normalizeToE164(OPERATOR_PHONE);
  if (!to || !from) {
    console.warn('[clickToCall] invalid phone normalization');
    return null;
  }

  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

  // TwiML: when Ben picks up, dial buyer + record both legs.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Connecting you to ${escapeXml(input.buyerName)}. Recording will start now.</Say><Dial record="record-from-answer-dual" recordingStatusCallback="${SITE_URL}/api/webhooks/twilio-recording" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"><Number>${to}</Number></Dial></Response>`;

  try {
    const call = await client.calls.create({
      to: from,                   // Ben first
      from: FROM_NUMBER,
      twiml,                       // when Ben answers → dial buyer
      statusCallback: `${SITE_URL}/api/webhooks/twilio-call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });
    return { callSid: call.sid };
  } catch (e: any) {
    console.error('[clickToCall] Twilio call failed:', e?.message);
    return null;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Transcribe a Twilio recording URL via Groq Whisper.
 * Returns transcript text or empty string on failure.
 */
export async function transcribeRecording(recordingUrl: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn('[transcribe] GROQ_API_KEY missing');
    return '';
  }
  if (!recordingUrl) return '';

  // SSRF / credential-exfiltration guard: we attach Twilio Basic auth to this
  // fetch, so only ever fetch Twilio-hosted URLs.
  if (!isAllowedTwilioRecordingUrl(recordingUrl)) {
    console.warn('[transcribe] refusing non-Twilio recording URL');
    return '';
  }

  try {
    // Fetch the audio file from Twilio (basic auth)
    const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    const audioRes = await fetch(`${recordingUrl}.mp3`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!audioRes.ok) {
      console.warn(`[transcribe] audio fetch ${audioRes.status}`);
      return '';
    }
    const audioBlob = await audioRes.blob();

    // POST to Groq's Whisper endpoint (OpenAI-compatible)
    const form = new FormData();
    form.append('file', audioBlob, 'call.mp3');
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'text');

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!groqRes.ok) {
      const txt = await groqRes.text().catch(() => '');
      console.warn(`[transcribe] Groq ${groqRes.status}: ${txt.slice(0, 200)}`);
      return '';
    }
    return (await groqRes.text()).trim();
  } catch (e: any) {
    console.error('[transcribe] error:', e?.message);
    return '';
  }
}
