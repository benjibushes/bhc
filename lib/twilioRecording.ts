// lib/twilioRecording.ts
//
// Twilio recording fetch + Groq Whisper transcription for the
// /api/webhooks/twilio-recording listener.
//
// History (Manifest #13, admin sweep 2026-07-01): these helpers used to live
// in lib/clickToCall.ts alongside the F11 click-to-call initiator. The
// click-to-call feature (POST /api/admin/click-to-call + initiateCall) was
// deleted — no UI/bot caller anywhere, and Ben calls from his phone. The
// recording webhook stays (signature-verified listener), so its transcription
// helpers moved here unchanged.
//
// Env vars:
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — Basic auth for the recording fetch
//   GROQ_API_KEY                           — for Whisper transcription

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

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
