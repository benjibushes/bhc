// app/api/webhooks/twilio-recording/route.ts
//
// F11 — Twilio recording-complete webhook. Saves Conversation row with
// recording URL + Groq Whisper transcript.
//
// Twilio POSTs form-urlencoded with RecordingUrl, RecordingSid, CallSid,
// RecordingDuration, etc. Telegram alerts on save.
//
// SECURITY: this webhook is unauthenticated by URL, so it MUST verify the
// X-Twilio-Signature before doing any work. Without it, an attacker can POST
// an arbitrary RecordingUrl that transcribeRecording() then fetches WITH our
// Twilio Basic-auth header attached → SSRF + Twilio credential exfiltration +
// transcription-cost abuse. We verify the signature (fail-closed in prod) and
// transcribeRecording() additionally allowlists Twilio hosts (defense in depth).

import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { createRecord, TABLES } from '@/lib/airtable';
import { transcribeRecording } from '@/lib/clickToCall';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

/**
 * Reconstruct the exact public URL Twilio signed. Behind Vercel the request
 * URL host is internal, so prefer the forwarded headers (the public host
 * Twilio was configured to POST to).
 */
function reconstructSignedUrl(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) params[k] = String(v);

    // --- Verify X-Twilio-Signature BEFORE any work (SSRF + cred-exfil guard) ---
    const signature = req.headers.get('x-twilio-signature') || '';
    if (AUTH_TOKEN) {
      const signedUrl = reconstructSignedUrl(req);
      const valid = twilio.validateRequest(AUTH_TOKEN, signature, signedUrl, params);
      if (!valid) {
        console.warn('[twilio-recording] invalid X-Twilio-Signature — rejecting');
        return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 403 });
      }
    } else if (process.env.NODE_ENV === 'production') {
      // Cannot verify without the auth token — fail closed in prod rather than
      // process an unauthenticated webhook.
      console.error('[twilio-recording] TWILIO_AUTH_TOKEN unset in production — refusing unverified webhook');
      return NextResponse.json({ ok: false, error: 'unverified' }, { status: 503 });
    }

    const recordingUrl = String(params['RecordingUrl'] || '');
    const callSid = String(params['CallSid'] || '');
    const duration = Number(params['RecordingDuration'] || 0);

    if (!recordingUrl || !callSid) {
      return NextResponse.json({ ok: true, skipped: 'no recordingUrl/callSid' });
    }

    // Transcribe (Groq Whisper). Best-effort — call row still saved if it fails.
    // transcribeRecording() allowlists Twilio hosts before attaching Basic auth.
    const transcript = await transcribeRecording(recordingUrl);

    try {
      // Final-sweep fix (2026-06-10): Conversations has no `Type` field —
      // identify recordings via Subject + Sender Type instead. Recording
      // URL / Transcript / Call Duration Seconds / Call Sid all exist
      // (added via MCP during F11).
      await createRecord(TABLES.CONVERSATIONS, {
        'Timestamp': new Date().toISOString(),
        'Direction': 'outbound',
        'Subject': `Call recording — ${callSid}`,
        'Sender Type': 'system',
        'Call Sid': callSid,
        'Recording URL': recordingUrl,
        'Call Duration Seconds': duration,
        'Transcript': transcript,
      });
    } catch (e: any) {
      console.warn('[twilio-recording] Conversations createRecord failed:', e?.message);
    }

    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `📞 <b>Call recorded</b>\n\nDuration: ${duration}s\nTranscript: ${
        transcript ? transcript.slice(0, 280) : '(transcription failed)'
      }`
    ).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[twilio-recording] error:', e?.message);
    // Return 200 to avoid Twilio retry storms.
    return NextResponse.json({ ok: true, error: e?.message });
  }
}
