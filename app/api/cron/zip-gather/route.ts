// app/api/cron/zip-gather/route.ts
//
// ZIP-GATHERING CAMPAIGN — DARK CRON (2026-07-23).
//
// Asks the ~248 legacy TX WAITING buyers with no ZIP to confirm a delivery ZIP,
// so the exclusive-ZIP gate (PR #462) can finally place the Houston/Austin ones
// with Thomas Cattle. See docs/ZIP-GATHER-CAMPAIGN.md for audience + copy.
//
// SAFETY — this fires NOTHING until Ben flips it. TWO independent gates:
//   ZIP_GATHER_ENABLED=true  → run at all (else return { skipped }).
//   ZIP_GATHER_SEND=true     → actually send (else DRY-RUN: audience + sample
//                              copy, zero messages).
// Neither is set in Vercel, so every scheduled invocation is a no-op today.
// Sends also respect suppression + the 3/week cap (via sendEmail→guardedSend)
// and a per-run warm-up cap (ZIP_GATHER_DAILY_CAP, default 50).
//
// Pure selection + copy live in lib/zipGatherCampaign (unit-tested); this route
// is the thin I/O shell (scan Consumers, mint confirm links, send, report).

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireCron } from '@/lib/cronAuth';
import { JWT_SECRET } from '@/lib/secrets';
import { sendEmail } from '@/lib/email';
import {
  selectZipGatherAudience,
  buildZipConfirmMessage,
  type ZipGatherCandidate,
} from '@/lib/zipGatherCampaign';
import type { TxMetro } from '@/lib/areaCodeMetro';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function parseMetros(raw: string | undefined): TxMetro[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is TxMetro => s === 'houston' || s === 'austin');
  return list.length > 0 ? list : undefined;
}

/** Signed one-tap confirm link — binds the consumer, never trusts a raw id. */
function confirmUrlFor(consumerId: string): string {
  const token = jwt.sign({ type: 'zip-confirm', consumerId }, JWT_SECRET, { expiresIn: '30d' });
  return `${SITE_URL}/api/zip-confirm?t=${encodeURIComponent(token)}`;
}

export async function GET(request: Request) {
  const denied = requireCron(request);
  if (denied) return denied;

  // MASTER GATE — dark until Ben flips it.
  const enabled = process.env.ZIP_GATHER_ENABLED === 'true';
  if (!enabled) {
    return NextResponse.json({
      skipped: true,
      reason: 'ZIP_GATHER_ENABLED is not true — campaign is dark',
    });
  }

  const send = process.env.ZIP_GATHER_SEND === 'true';
  const supplierName = process.env.ZIP_GATHER_SUPPLIER || 'Thomas Cattle & Catering';
  const metros = parseMetros(process.env.ZIP_GATHER_METROS);
  const channel = process.env.ZIP_GATHER_CHANNEL === 'sms' ? 'sms' : 'email';
  const cap = Math.max(0, Number(process.env.ZIP_GATHER_DAILY_CAP || 50) || 0);

  // Scan only WAITING buyers — the pool the campaign targets.
  let consumers: any[] = [];
  try {
    consumers = await getAllRecords(TABLES.CONSUMERS, `{Buyer Stage}='WAITING'`);
  } catch (e: any) {
    return NextResponse.json({ error: `consumer scan failed: ${e?.message || 'unknown'}` }, { status: 502 });
  }

  const audience = selectZipGatherAudience(consumers, { supplierName, metros });
  const byMetro = audience.reduce<Record<string, number>>((m, c) => {
    m[c.metro] = (m[c.metro] || 0) + 1;
    return m;
  }, {});

  const sampleFor = (c: ZipGatherCandidate | undefined) =>
    c
      ? buildZipConfirmMessage({
          firstName: c.firstName,
          supplierName,
          metro: c.metro,
          confirmUrl: `${SITE_URL}/api/zip-confirm?t=<signed-token>`,
          channel,
        })
      : null;

  // DRY-RUN (default even when ENABLED): report the audience + the exact copy,
  // send nothing. This is what Ben reviews before flipping ZIP_GATHER_SEND.
  if (!send) {
    return NextResponse.json({
      dryRun: true,
      enabled,
      channel,
      supplierName,
      metros: metros || ['houston', 'austin'],
      audienceCount: audience.length,
      byMetro,
      sampleMessage: sampleFor(audience[0]),
      note: 'Set ZIP_GATHER_SEND=true to actually send (respects suppression + weekly cap + daily cap).',
    });
  }

  // LIVE SEND — capped, suppression-aware (sendEmail → guardedSend). SMS path is
  // intentionally not wired to a live provider here; it dry-reports until an SMS
  // sender is chosen, so flipping SEND can never fire an unconfigured SMS blast.
  if (channel === 'sms') {
    return NextResponse.json({
      dryRun: true,
      reason: 'SMS channel has no live sender wired yet — use email or wire an A2P provider first',
      audienceCount: audience.length,
      byMetro,
      sampleMessage: sampleFor(audience[0]),
    });
  }

  const batch = audience.slice(0, cap);
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  for (const c of batch) {
    try {
      const msg = buildZipConfirmMessage({
        firstName: c.firstName,
        supplierName,
        metro: c.metro,
        confirmUrl: confirmUrlFor(c.id),
        channel: 'email',
      });
      const res: any = await sendEmail({
        to: c.email,
        subject: msg.subject || `Confirm your delivery ZIP so ${supplierName} can serve you`,
        html: msg.html || `<p>${msg.text}</p>`,
        templateName: 'zip_confirm_gather',
      });
      if (res && res.success === false) suppressed++;
      else sent++;
    } catch (e: any) {
      failed++;
      console.error('[zip-gather] send failed for', c.email, e?.message);
    }
  }

  return NextResponse.json({
    dryRun: false,
    channel,
    supplierName,
    audienceCount: audience.length,
    cap,
    attempted: batch.length,
    sent,
    suppressed,
    failed,
    remaining: Math.max(0, audience.length - batch.length),
  });
}
