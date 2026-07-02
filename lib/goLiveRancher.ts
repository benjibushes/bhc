// THE one-click go-live rail. Every path that flips a rancher Live calls
// goLiveRancher() so gates, writes, and side effects can never diverge again.
//
// Callers (all thin wrappers around this):
//   - POST /api/admin/ranchers/[id]/go-live      (admin Go Live buttons, /admin/today, desk)
//   - PATCH /api/admin/ranchers/[id]             (onboarding_status='Live' branch:
//                                                 "Mark Live" + handleRelease)
//   - /api/rancher/landing-page _action=request-go-live (rancher self-publish)
//
// Contract:
//   GATES  — lib/goLiveGates.ts (pure, tested). force=true overrides all.
//   WRITE  — one updateRecord with GO_LIVE_FIELDS (the 4-field union).
//   SIDE EFFECTS — exactly once, each individually try/catch'd:
//     1. triggerLaunchWarmup       (warm this state's Waitlisted buyers now)
//     2. waitlist blast            (auto-match up to 50 waiting buyers via
//                                   /api/matching/suggest)
//     3. sendRancherGoLiveEmail    ("You're Live — Buyer Leads Are Coming")
//     4. operator Telegram note    (who went live, via which rail, matched N)
//   IDEMPOTENT — already-Live returns { ok:true, alreadyLive:true } with NO
//     duplicate side effects.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';
import { sendRancherGoLiveEmail } from '@/lib/email';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';
import {
  goLiveGates,
  isAlreadyLive,
  GO_LIVE_FIELDS,
  type GoLiveGateCode,
} from '@/lib/goLiveGates';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export type GoLiveSuccess = { ok: true; alreadyLive: boolean; matched: number };
export type GoLiveFailure = { ok: false; code: GoLiveGateCode; message: string };
export type GoLiveOutcome = GoLiveSuccess | GoLiveFailure;

export async function goLiveRancher(
  rancherId: string,
  opts: { force?: boolean; actor: string },
): Promise<GoLiveOutcome> {
  const { force = false, actor } = opts;

  // The record is required — gates can't be verified (and emails can't be
  // addressed) without it, so a failed read aborts even under force.
  let rancher: any = null;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch (e: any) {
    console.error(`[goLiveRancher] failed to load rancher ${rancherId}:`, e?.message);
  }
  if (!rancher) {
    return {
      ok: false,
      code: 'rancher_not_found',
      message: `Rancher ${rancherId} could not be loaded — go-live aborted (gates can't be verified).`,
    };
  }

  // Idempotence: already fully Live → success, NO duplicate side effects.
  if (isAlreadyLive(rancher)) {
    return { ok: true, alreadyLive: true, matched: 0 };
  }

  const gate = goLiveGates(rancher, force);
  if (!gate.ok) return gate;

  // ── THE write: one updateRecord, the canonical 4-field union ────────────
  // Throws on failure — callers surface a 500; no side effects fire.
  await updateRecord(TABLES.RANCHERS, rancherId, { ...GO_LIVE_FIELDS });

  // Audit log (non-fatal) — reversible via the pre-state snapshot.
  try {
    await logAuditEntry({
      actor: 'manual',
      tool: 'rancher-go-live',
      targetType: 'Rancher',
      targetId: rancherId,
      args: { rancherId, actor, force },
      result: { ...GO_LIVE_FIELDS },
      reverseAction: buildAirtableUpdateReverse(TABLES.RANCHERS, rancherId, {
        'Page Live': rancher['Page Live'] || false,
        'Active Status': rancher['Active Status'] || null,
        'Onboarding Status': rancher['Onboarding Status'] || null,
        'Status': rancher['Status'] || null,
      }),
    });
  } catch (e: any) {
    console.error('[goLiveRancher] audit log failed (non-fatal):', e?.message);
  }

  const operatorName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
  const ranchName = rancher['Ranch Name'] || operatorName;

  // ── Side effect 1: launch warmup (fire-and-forget, cron is idempotent) ──
  try {
    triggerLaunchWarmup(`go-live:${actor}:${rancherId}`);
  } catch (e: any) {
    console.error('[goLiveRancher] warmup trigger failed (non-fatal):', e?.message);
  }

  // ── Side effect 2: waitlist blast (auto-match waiting buyers) ───────────
  let matched = 0;
  try {
    matched = await runWaitlistBlast(rancher);
  } catch (e: any) {
    console.error('[goLiveRancher] waitlist blast failed (non-fatal):', e?.message);
  }

  // ── Side effect 3: go-live email to the rancher ──────────────────────────
  try {
    const email = rancher['Email'];
    if (email) {
      await sendRancherGoLiveEmail({
        operatorName: String(operatorName),
        ranchName: String(ranchName),
        email: String(email),
        dashboardUrl: `${SITE_URL}/rancher`,
      });
    }
  } catch (e: any) {
    console.error('[goLiveRancher] go-live email failed (non-fatal):', e?.message);
  }

  // ── Side effect 4: operator Telegram note (always, not just matched>0) ──
  try {
    const state = rancher['State'] || '?';
    const slug = rancher['Slug'] || '';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🚀 <b>${operatorName}</b> is LIVE in <b>${state}</b> (via ${actor}${force ? ', FORCED' : ''})` +
        ` — auto-matched <b>${matched}</b> waiting buyer${matched === 1 ? '' : 's'}` +
        (slug ? `\n${SITE_URL}/ranchers/${slug}` : ''),
    );
  } catch (e: any) {
    console.error('[goLiveRancher] Telegram note failed (non-fatal):', e?.message);
  }

  return { ok: true, alreadyLive: false, matched };
}

// Auto-match waiting buyers in this rancher's state(s) — up to 50, via the
// matching engine (which re-checks eligibility/capacity per buyer). Moved
// verbatim from POST /go-live so every rail gets the blast, not just one.
async function runWaitlistBlast(rancher: any): Promise<number> {
  const rancherState = rancher['State'] || '';
  const statesServedRaw = rancher['States Served'] || '';
  const statesServed: string[] = Array.isArray(statesServedRaw)
    ? statesServedRaw
    : typeof statesServedRaw === 'string'
      ? statesServedRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

  const allStates = new Set<string>();
  if (rancherState) allStates.add(rancherState);
  statesServed.forEach((s: string) => allStates.add(s));
  if (allStates.size === 0) return 0;

  const allConsumers: any[] = await getAllRecords(TABLES.CONSUMERS);
  const waitingBuyers = allConsumers
    .filter((c: any) => {
      const status = c['Status'] || '';
      const refStatus = c['Referral Status'] || '';
      const consumerState = c['State'] || '';
      if (status !== 'Approved') return false;
      if (refStatus !== 'Unmatched' && refStatus !== 'Waitlisted') return false;
      return allStates.has(consumerState);
    })
    .slice(0, 50);

  let matched = 0;
  for (const buyer of waitingBuyers) {
    try {
      const res = await fetch(`${SITE_URL}/api/matching/suggest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(INTERNAL_API_SECRET ? { 'x-internal-secret': INTERNAL_API_SECRET } : {}),
        },
        body: JSON.stringify({
          buyerId: buyer.id,
          buyerState: buyer['State'] || '',
          buyerName: buyer['Full Name'] || '',
          buyerEmail: buyer['Email'] || '',
          buyerPhone: buyer['Phone'] || '',
          orderType: buyer['Order Type'] || '',
          budgetRange: buyer['Budget'] || buyer['Budget Range'] || '',
          intentScore: buyer['Intent Score'] || 0,
          intentClassification: buyer['Intent Classification'] || '',
          notes: buyer['Notes'] || '',
        }),
      });
      if (res.ok) {
        const result = await res.json();
        if (result.matchFound) matched++;
      }
    } catch (e) {
      console.error(
        `[goLiveRancher] waitlist blast: error matching ${buyer['Full Name'] || buyer.id}:`,
        e,
      );
    }
  }
  return matched;
}
