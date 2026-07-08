// app/api/cron/prospect-outreach-draft/route.ts
//
// COLD OUTREACH — DRAFT PASS (2026-07-08). Daily: pick the highest-leverage
// un-contacted prospects (demand-state first — the pitch IS the buyer count),
// draft a natural, prospect-specific email through the voice engine
// (lib/prospectOutreach — banned-phrase validated, per-prospect structure),
// write it onto the row as Draft Ready, and drop a review digest in Telegram.
//
// DRAFTS ONLY. Nothing here sends. Ben reviews on the prospects dashboard or
// in Airtable, edits freely, and flips rows to 'Approved' — the send cron
// (prospect-outreach-send) only ever touches Approved rows.
//
// DARK BY DEFAULT — env PROSPECT_OUTREACH_ENABLED, platform 3-state:
//   unset/other → skipped BEFORE withCronRun (no Cron Runs row while dark)
//   'dry-run'   → selection + ONE sample draft to Telegram, writes NOTHING
//   'true'      → drafts up to DAILY_DRAFT_CAP rows + digest

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import {
  toProspectRow,
  pickProspectsForDraft,
  draftOutreach,
} from '@/lib/prospectOutreach';

export const maxDuration = 300;

const PROSPECTS_TABLE = 'Rancher Prospects';
const DAILY_DRAFT_CAP = 12;

interface CronResult {
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}

async function waitingByState(): Promise<Record<string, number>> {
  const rows = (await getAllRecords(TABLES.CONSUMERS, 'UPPER({Buyer Stage}) = "WAITING"', {
    fields: ['State'],
  }).catch(() => [])) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    const st = String(r['State'] || '').trim().toUpperCase();
    if (st) out[st] = (out[st] || 0) + 1;
  }
  return out;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const dryRun = process.env.PROSPECT_OUTREACH_ENABLED === 'dry-run';

  let rows: any[] = [];
  try {
    rows = (await getAllRecords(PROSPECTS_TABLE)) as any[];
  } catch (e: any) {
    return { status: 'partial', recordsTouched: 0, notes: `prospects read failed: ${e?.message?.slice(0, 120)}` };
  }

  const demand = await waitingByState();
  const picks = pickProspectsForDraft(rows.map(toProspectRow), demand, DAILY_DRAFT_CAP);

  if (picks.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: 'no eligible prospects (all drafted, low-fit, or email-less)' };
  }

  if (dryRun) {
    // One sample draft so Ben can judge the VOICE before anything persists.
    const sample = await draftOutreach({
      prospect: picks[0],
      waitingInState: demand[picks[0].state] || 0,
      seed: picks[0].id,
      phone: process.env.OUTREACH_PHONE || undefined,
    });
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🧪 <b>outreach DRY RUN</b> — nothing written\n\n` +
        `would draft ${picks.length} today:\n` +
        picks.map((p) => `· ${p.ranchName} (${p.state}, fit ${p.fitScore}, ${demand[p.state] || 0} waiting)`).join('\n') +
        (sample
          ? `\n\n<b>sample — ${picks[0].ranchName}</b>\nsubject: ${sample.subject}\n\n${sample.body}`
          : '\n\n(sample draft failed — check ANTHROPIC_API_KEY/GROQ_API_KEY)'),
    ).catch(() => {});
    return { status: 'success', recordsTouched: 0, notes: `DRY-RUN would-draft=${picks.length} sample=${sample ? 'ok' : 'FAILED'}` };
  }

  let drafted = 0;
  let skipped = 0;
  const digest: string[] = [];
  for (const p of picks) {
    const draft = await draftOutreach({
      prospect: p,
      waitingInState: demand[p.state] || 0,
      seed: p.id,
      phone: process.env.OUTREACH_PHONE || undefined,
    });
    if (!draft) {
      skipped++;
      continue;
    }
    try {
      await updateRecord(PROSPECTS_TABLE, p.id, {
        'First-Touch Draft': draft.body,
        'Outreach Subject': draft.subject,
        'Outreach Status': 'Draft Ready',
      });
      drafted++;
      digest.push(`· <b>${p.ranchName}</b> (${p.state}, ${demand[p.state] || 0} waiting) — "${draft.subject}"`);
    } catch (e: any) {
      skipped++;
    }
    await new Promise((r) => setTimeout(r, 250)); // pace Airtable writes
  }

  if (drafted > 0) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `✍️ <b>${drafted} outreach drafts ready for review</b>\n\n` +
        digest.join('\n') +
        `\n\nreview + edit, then flip rows to <b>Approved</b> — the send cron only touches Approved.\nhttps://bhc-prospects.vercel.app`,
    ).catch(() => {});
  }

  return {
    status: skipped > 0 ? 'partial' : 'success',
    recordsTouched: drafted,
    notes: `drafted=${drafted} skipped=${skipped} pool=${picks.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  const mode = process.env.PROSPECT_OUTREACH_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }
  return withCronRun('prospect-outreach-draft', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
