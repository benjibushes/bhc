// app/api/webhooks/twilio-recording/route.ts
//
// F11 — Twilio recording-complete webhook. Saves Conversation row with
// recording URL + Groq Whisper transcript.
//
// Twilio POSTs form-urlencoded with RecordingUrl, RecordingSid, CallSid,
// RecordingDuration, etc. Telegram alerts on save.

import { NextResponse } from 'next/server';
import { createRecord, TABLES } from '@/lib/airtable';
import { transcribeRecording } from '@/lib/clickToCall';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const recordingUrl = String(form.get('RecordingUrl') || '');
    const callSid = String(form.get('CallSid') || '');
    const duration = Number(form.get('RecordingDuration') || 0);

    if (!recordingUrl || !callSid) {
      return NextResponse.json({ ok: true, skipped: 'no recordingUrl/callSid' });
    }

    // Transcribe (Groq Whisper). Best-effort — call row still saved if it fails.
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
