// Capacity Liberator cron — frees dead lead slots and reopens ranchers that
// have real ORDER headroom (committed orders < fulfillment cap), so capable
// ranchers keep getting buyers instead of being throttled by stale leads.
//
// PHASE 1 = DRY-RUN ONLY. This route reads + computes + sends one Telegram
// summary. It writes NOTHING until CAPACITY_LIBERATOR_ENABLED=true (Phase 2),
// at which point the release goes through recordClose() (which sends the buyer
// no email — verified) + stamps Auto Released At/From for idempotency + revert,
// and the reopen flips Active Status + fires triggerLaunchWarmup.
//
// SAFETY (all in place for the dry-run numbers + ready for live):
//   - chase-aware staleness (never release a lead chased recently)
//   - buyer-reply gate (never release a lead whose buyer replied — read from
//     Conversations by From-email, since the activity timestamps are dead)
//   - committed-order accounting by status, not the blank Deposit Paid At field
//   - routing-truth scope (isRancherOperationalForBuyers, not Page Live)
// REMAINING before flipping live: confirm/stagger the downstream re-match burst
// (stuck-buyer-recovery re-routes freed buyers) and wire recordClose + stamps.
//
// See docs/CAPACITY-LIBERATOR-PLAN.md.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  computeHeadroom,
  buildReplyIndex,
  isLiberatorScope,
  LEAD_STATUSES,
  COMMITTED_STATUSES,
  STALE_WINDOW_DAYS,
} from '@/lib/capacityLiberator';

export const maxDuration = 180;

type Rec = Record<string, unknown> & { id: string };

interface LiberatorResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

const LEAD_STATUS_FORMULA = `OR(${LEAD_STATUSES.map((s) => `{Status}="${s}"`).join(',')})`;
const COMMITTED_FORMULA = `OR(${COMMITTED_STATUSES.map((s) => `{Status}="${s}"`).join(',')})`;
// Inbound email replies. Direction casing is split in the table ("inbound" from
// the resend webhook, "Inbound" from ManyChat) — LOWER() catches both.
const INBOUND_FORMULA = 'AND(LOWER({Direction})="inbound",{From}!="")';

/** Escape rancher names before HTML-mode Telegram interpolation. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rancherIdsOf(ref: Rec): string[] {
  const link = (ref['Rancher'] ?? ref['Suggested Rancher']) as unknown;
  if (Array.isArray(link)) return link.filter((x): x is string => typeof x === 'string');
  return typeof link === 'string' ? [link] : [];
}

function groupByRancher(refs: Rec[]): Map<string, Rec[]> {
  const m = new Map<string, Rec[]>();
  for (const ref of refs) {
    for (const rid of rancherIdsOf(ref)) {
      const arr = m.get(rid);
      if (arr) arr.push(ref);
      else m.set(rid, [ref]);
    }
  }
  return m;
}

async function realHandler(request: Request): Promise<LiberatorResult> {
  const url = new URL(request.url);
  const liveEnabled = process.env.CAPACITY_LIBERATOR_ENABLED === 'true';
  // DEFAULT DRY-RUN. Only ever writes when explicitly enabled AND not forced dry.
  const dryRun = !liveEnabled || url.searchParams.get('dryRun') === '1';
  const nowMs = Date.now();

  // Scan Active + At Capacity ranchers, then filter to the routing-eligible set
  // (NOT gated on Page Live — mirrors lib/rancherEligibility, the SSOT).
  const allRanchers = (await getAllRecords(
    TABLES.RANCHERS,
    'OR({Active Status}="Active",{Active Status}="At Capacity")',
  )) as Rec[];
  const ranchers = allRanchers.filter((r) => isLiberatorScope(r));

  const allLeadRefs = (await getAllRecords(TABLES.REFERRALS, LEAD_STATUS_FORMULA)) as Rec[];
  const allCommittedRefs = (await getAllRecords(TABLES.REFERRALS, COMMITTED_FORMULA)) as Rec[];
  const inboundConvos = (await getAllRecords(TABLES.CONVERSATIONS, INBOUND_FORMULA)) as Rec[];

  const leadByRancher = groupByRancher(allLeadRefs);
  const committedByRancher = groupByRancher(allCommittedRefs);
  const replyIdx = buildReplyIndex(inboundConvos);

  let wouldRelease = 0;
  let wouldReopen = 0;
  const releaseLines: string[] = [];
  const reopenLines: string[] = [];

  for (const r of ranchers) {
    const leadRefs = leadByRancher.get(r.id) ?? [];
    const committedRefs = committedByRancher.get(r.id) ?? [];
    const h = computeHeadroom(r, leadRefs, committedRefs, nowMs, replyIdx);
    const name = esc(String(r['Ranch Name'] || r['Operator Name'] || r.id));

    if (h.staleCount > 0) {
      wouldRelease += h.staleCount;
      releaseLines.push(`• ${name}: free ${h.staleCount} stale (${h.liveLeads}→${h.liveLeadsAfterRelease} live)`);
    }
    if (h.shouldReopen) {
      wouldReopen += 1;
      reopenLines.push(`• ${name}: reopen — ${h.committed}/${h.orderCap} orders, headroom ${h.headroom}`);
    }
  }

  // PHASE 2 (live, behind CAPACITY_LIBERATOR_ENABLED) will, per rancher:
  //   - for each stale ref: recordClose(lost,'no_response') + stamp Auto Released At/From
  //   - if shouldReopen: flip Active Status='Active' + triggerLaunchWarmup()
  // Nothing below writes in Phase 1.

  const mode = dryRun ? '🧪 DRY-RUN (no writes)' : '🔴 LIVE';
  const cap = (lines: string[]) =>
    (lines.slice(0, 25).join('\n') || '— none') +
    (lines.length > 25 ? `\n…+${lines.length - 25} more` : '');
  const summary =
    `🐂 <b>Capacity Liberator</b> — ${mode}\n` +
    `Scanned ${ranchers.length} eligible ranchers · ${STALE_WINDOW_DAYS}d window · chase+reply aware.\n\n` +
    `<b>Would free ${wouldRelease} dead slots</b> (${releaseLines.length} ranchers):\n` +
    cap(releaseLines) +
    `\n\n<b>Would reopen ${wouldReopen} ranchers</b> (real order headroom):\n` +
    cap(reopenLines);

  try {
    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, summary);
  } catch {
    // Telegram is best-effort; never fail the run on it.
  }

  return {
    status: 'success',
    recordsTouched: dryRun ? 0 : wouldRelease + wouldReopen,
    notes:
      `${dryRun ? 'dry-run' : 'live'} · would free ${wouldRelease} slots across ` +
      `${releaseLines.length} ranchers · would reopen ${wouldReopen} ` +
      `(live writes gated by CAPACITY_LIBERATOR_ENABLED + Phase 2)`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('capacity-liberator', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
