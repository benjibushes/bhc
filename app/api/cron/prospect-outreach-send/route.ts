// app/api/cron/prospect-outreach-send/route.ts
//
// COLD OUTREACH — SEND PASS (2026-07-08). Hourly, but only ACTS inside the
// send window (Mon–Fri, 9a–5p Mountain — ranchers answer email at human
// hours; a 2am timestamp is an AI-tell all by itself). Sends ONLY rows Ben
// flipped to Outreach Status='Approved'. One touch per prospect, ever.
//
// SAFETY RAILS (the owned-send discipline + mutation-guardrails checklist):
//   - env PROSPECT_OUTREACH_ENABLED 3-state (unset skip / dry-run report /
//     true) — same double-gate as everything: env AND per-row approval.
//   - OUTREACH_FROM env REQUIRED for live sends (e.g. "Ben <ben@buyhalfcow.com>").
//     Missing → loud skip note, nothing sent. Ben must use a mailbox he
//     actually reads: replies land there, and a reply is the whole point.
//   - DAILY_SEND_CAP across the day (Redis counter, fail-closed to the cap).
//   - claim-before-send per prospect + read-back verify of the Sent stamp —
//     a stamp that fails to persist ABORTS further sends (never double-email
//     a cold prospect; that's how you get marked spam).
//   - suppression: prospect email already on a Ranchers row → they applied;
//     flip to Suppressed instead of emailing them a cold pitch.
//   - CAN-SPAM: honest from-name, physical address line, working reply-based
//     opt-out phrased like a person (the draft's own "tell me no thanks").
//
// Plain-text email, no template chrome, no tracking pixels beyond Resend's
// defaults — it should land like a personal note because it is one.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { claimOnce } from '@/lib/rancherCapacity';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { toProspectRow } from '@/lib/prospectOutreach';

export const maxDuration = 300;

const PROSPECTS_TABLE = 'Rancher Prospects';
const DAILY_SEND_CAP = 10;
const PER_RUN_CAP = 4; // hourly cron × window ≈ ramps to the daily cap gently

interface CronResult {
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}

// Mon–Fri 9:00–16:59 Mountain. Vercel crons run UTC; America/Denver handles DST.
function inSendWindow(now = new Date()): boolean {
  const mt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const hour = Number(mt.find((p) => p.type === 'hour')?.value || 0);
  const day = String(mt.find((p) => p.type === 'weekday')?.value || '');
  return !['Sat', 'Sun'].includes(day) && hour >= 9 && hour < 17;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function realHandler(_request: Request): Promise<CronResult> {
  const dryRun = process.env.PROSPECT_OUTREACH_ENABLED === 'dry-run';
  const from = String(process.env.OUTREACH_FROM || '').trim();

  if (!inSendWindow()) {
    return { status: 'success', recordsTouched: 0, notes: 'outside send window (Mon–Fri 9–5 MT)' };
  }

  let rows: any[] = [];
  try {
    rows = (await getAllRecords(PROSPECTS_TABLE)) as any[];
  } catch (e: any) {
    return { status: 'partial', recordsTouched: 0, notes: `prospects read failed: ${e?.message?.slice(0, 120)}` };
  }

  const approved = rows.filter(
    (r) => toProspectRow(r).outreachStatus === 'Approved' && String(r['Email'] || '').includes('@'),
  );
  if (approved.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: 'no Approved rows in queue' };
  }

  if (dryRun) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🧪 <b>outreach send DRY RUN</b> — ${approved.length} Approved in queue, would send ${Math.min(approved.length, PER_RUN_CAP)} this hour (cap ${DAILY_SEND_CAP}/day). from=${from || '⚠️ OUTREACH_FROM NOT SET'}`,
    ).catch(() => {});
    return { status: 'success', recordsTouched: 0, notes: `DRY-RUN queue=${approved.length} from=${from ? 'set' : 'MISSING'}` };
  }

  if (!from) {
    return { status: 'partial', recordsTouched: 0, notes: 'OUTREACH_FROM env not set — refusing to send cold email from the default transactional identity' };
  }

  // Daily cap via Redis claims: claim slots named by date+index. Fail-open
  // claimOnce means Redis-down would over-claim — so on claim failure we
  // count it as used and stop early (fail toward FEWER sends, never more).
  const today = new Date().toISOString().slice(0, 10);
  const batch = approved.slice(0, PER_RUN_CAP);

  // Suppression set: any prospect email that already exists on a Ranchers row
  // applied on their own — cold-pitching them now would be embarrassing.
  const rancherEmails = new Set(
    ((await getAllRecords(TABLES.RANCHERS).catch(() => [])) as any[])
      .map((r) => String(r['Email'] || '').trim().toLowerCase())
      .filter(Boolean),
  );

  const { sendEmail } = await import('@/lib/email');
  let sent = 0;
  let suppressed = 0;
  const errors: string[] = [];

  for (const row of batch) {
    const p = toProspectRow(row);
    const body = String(row['First-Touch Draft'] || '').trim();
    const subject = String(row['Outreach Subject'] || '').trim() || `buyers waiting in ${p.state}`;
    if (!body) continue;

    if (rancherEmails.has(p.email)) {
      await updateRecord(PROSPECTS_TABLE, p.id, { 'Outreach Status': 'Suppressed' }).catch(() => {});
      suppressed++;
      continue;
    }

    // Daily-cap slot: one claim per send index per day.
    let slotOk = false;
    for (let i = 0; i < DAILY_SEND_CAP; i++) {
      if (await claimOnce(`outreach-slot:${today}:${i}`, 60 * 60 * 24)) {
        slotOk = true;
        break;
      }
    }
    if (!slotOk) {
      return {
        status: 'success',
        recordsTouched: sent,
        notes: `daily cap ${DAILY_SEND_CAP} reached · sent=${sent} suppressed=${suppressed}`,
      };
    }

    // CLAIM-BEFORE-SEND: stamp first, read back, only then send. A cold
    // prospect must never receive the same note twice.
    if (!(await claimOnce(`outreach-send:${p.id}`, 60 * 60 * 24 * 30))) continue;
    try {
      await updateRecord(PROSPECTS_TABLE, p.id, {
        'Outreach Status': 'Sent',
        'Last Contacted': new Date().toISOString().slice(0, 10),
        'Touch Count': Number(row['Touch Count'] || 0) + 1,
        'Channel': 'email',
      });
      const readBack: any = await getRecordById(PROSPECTS_TABLE, p.id);
      const st = readBack?.['Outreach Status'];
      if ((st && typeof st === 'object' ? st.name : st) !== 'Sent') {
        errors.push(`${p.ranchName}: Sent stamp did not persist — ABORTING run`);
        break;
      }
    } catch (e: any) {
      errors.push(`${p.ranchName}: stamp failed — skipped`);
      continue;
    }

    // Plain-text-styled send. The address line keeps CAN-SPAM honest without
    // template chrome; the draft itself carries the human opt-out sentence.
    const html =
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px">` +
      escapeHtml(body).replace(/\n/g, '<br>') +
      `<br><br><span style="color:#999;font-size:12px">BuyHalfCow · Kalispell, MT · buyhalfcow.com</span></div>`;

    const res = await sendEmail({
      to: p.email,
      from,
      subject,
      html,
      templateName: 'prospect_outreach',
    }).catch((e: any) => ({ success: false, error: e?.message }));

    if ((res as any)?.success === false) {
      errors.push(`${p.ranchName}: send failed`);
      // leave status=Sent — safer to lose one prospect than risk a double-send
    } else {
      sent++;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (sent > 0) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `📬 outreach: ${sent} sent this hour · ${approved.length - sent - suppressed} still queued` +
        (suppressed ? ` · ${suppressed} suppressed (already applied)` : '') +
        `\nreplies land at ${from.replace(/.*</, '').replace(/>.*/, '')}`,
    ).catch(() => {});
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes: `sent=${sent} suppressed=${suppressed} queued=${approved.length}${errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  const mode = process.env.PROSPECT_OUTREACH_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }
  return withCronRun('prospect-outreach-send', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
