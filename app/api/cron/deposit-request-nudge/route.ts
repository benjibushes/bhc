// app/api/cron/deposit-request-nudge/route.ts
//
// LEAK 2 of the rancher-driven deposit rail (2026-07-05): BUYER-facing
// follow-up on an unpaid deposit request. Before this cron, a buyer who got a
// rancher-sent deposit link and didn't pay heard NOTHING for 14 days — and
// that 14-day net (awaiting-payment-nudge) pings the RANCHER. Rancher-sent
// requests were 0-for-7 paid.
//
// Hourly. Selection is pure + unit-tested (lib/depositRequestNudge):
// Deposit Requested At set · Deposit Paid At empty · Status='Awaiting
// Payment' · request >= 24h old · < 2 lifetime nudges · outside 48h cooldown.
// Suppression trio enforced on the linked Consumer here; guardedSend's global
// suppression list backs it up.
//
// CLAIM-BEFORE-SEND: the dedupe stamp ('Deposit Nudge Last Sent At' +
// 'Deposit Nudge Count') is written BEFORE the send, then verified — if the
// stamp didn't persist (fields missing → updateRecord silently strips), the
// run ABORTS before any further send: no dedupe = no sends (the
// waiting-activation pattern).
//
// LINK: the magic-link → deposit-page hop, NOT the stored Stripe session URL
// ('Deposit Checkout URL') — Stripe Checkout sessions expire in ~24h, which
// is exactly when this cron first fires. The deposit page mints a fresh
// session on arrival.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES, isInvalidFilterFormulaError } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendDepositRequestNudge } from '@/lib/emailMinimal';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { generateMemberLoginToken } from '@/lib/secrets';
import { selectDepositNudges, selectDepositAbandonNudges } from '@/lib/depositRequestNudge';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

// Candidate formula — long-standing fields only in the required clauses; the
// nudge-stamp fields exist (created 2026-07-05) but the selector re-checks
// everything JS-side, so the formula is purely an I/O optimization.
const CANDIDATE_FORMULA =
  `AND({Status}="Awaiting Payment", NOT({Deposit Requested At}=""), {Deposit Paid At}="")`;

// DEPOSIT-ABANDON RAIL (2026-07-05): quiz-complete deposit invites (Deposit
// Invite Sent At set) that were never paid and aren't past the deposit ask.
// Disjoint from the rancher-request rail via the empty Deposit Requested At
// clause; the JS selector re-checks age/cap/cooldown/terminal-status.
const ABANDON_CANDIDATE_FORMULA =
  `AND(NOT({Deposit Invite Sent At}=""), {Deposit Requested At}="", {Deposit Paid At}="")`;

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const nowMs = Date.now();

  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(TABLES.REFERRALS, CANDIDATE_FORMULA)) as any[];
  } catch (e: any) {
    if (isInvalidFilterFormulaError(e)) {
      // Field renamed → degrade to the unfiltered scan (self-heal pattern).
      console.warn('[deposit-request-nudge] formula rejected; falling back to full scan');
      candidates = (await getAllRecords(TABLES.REFERRALS)) as any[];
    } else {
      return { status: 'error', recordsTouched: 0, notes: `referrals read failed: ${e?.message?.slice(0, 160)}` };
    }
  }

  // Rail B — deposit-abandon (quiz-complete invites unpaid). Best-effort: a
  // read failure here must NOT sink the rancher-request rail above.
  let abandonCandidates: any[] = [];
  try {
    abandonCandidates = (await getAllRecords(TABLES.REFERRALS, ABANDON_CANDIDATE_FORMULA)) as any[];
  } catch (e: any) {
    if (isInvalidFilterFormulaError(e)) {
      console.warn('[deposit-request-nudge] abandon formula rejected; falling back to full scan');
      abandonCandidates = (await getAllRecords(TABLES.REFERRALS)) as any[];
    } else {
      console.warn('[deposit-request-nudge] abandon read failed (non-fatal):', e?.message);
      abandonCandidates = [];
    }
  }

  // Merge both rails, dedupe by id (the two selectors are disjoint by design,
  // but dedupe is cheap insurance), total capped so one run never floods.
  const railA = selectDepositNudges(candidates, { nowMs, batchCap: 25 });
  const railB = selectDepositAbandonNudges(abandonCandidates, { nowMs, batchCap: 25 });
  const seen = new Set<string>();
  const selected = [...railA, ...railB].filter((r) => {
    const id = String(r.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 25);

  let sent = 0;
  let suppressed = 0;
  const errors: string[] = [];

  for (const r of selected) {
    try {
      // Linked Consumer — suppression trio + email + phone live there.
      const buyerId: string = ((r['Buyer'] || []) as string[])[0] || '';
      if (!buyerId) continue;
      const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
      if (!buyer) continue;
      if (buyer['Unsubscribed'] || buyer['Bounced'] || buyer['Complained']) { suppressed++; continue; }
      const buyerEmail = String(buyer['Email'] || '').trim().toLowerCase();
      if (!buyerEmail) continue;

      const priorCount = Number(r['Deposit Nudge Count']) || 0;
      const touch: 1 | 2 = priorCount >= 1 ? 2 : 1;

      // CLAIM BEFORE SEND + verify-persist (fields-missing abort).
      const updated: any = await updateRecord(TABLES.REFERRALS, r.id, {
        'Deposit Nudge Last Sent At': new Date().toISOString(),
        'Deposit Nudge Count': priorCount + 1,
      });
      if (!updated || !updated['Deposit Nudge Last Sent At']) {
        return {
          status: 'error',
          recordsTouched: sent,
          notes:
            `ABORT: nudge stamp did not persist for ${r.id} — verify "Deposit Nudge Last Sent At" ` +
            `(dateTime) + "Deposit Nudge Count" (number) exist on Referrals. sentBeforeAbort=${sent}`,
        };
      }

      // Rancher context for the copy (name + phone). Best-effort.
      let rancherName = String(r['Suggested Rancher Name'] || '').trim();
      let rancherPhone = '';
      try {
        const rancherId: string = ((r['Rancher'] || []) as string[])[0] || '';
        if (rancherId) {
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          rancherName = String(rancher?.['Ranch Name'] || rancherName || 'your rancher').trim();
          rancherPhone = String(rancher?.['Phone'] || '').trim();
        }
      } catch { /* copy falls back to generic */ }

      const cutTier = String(r['Order Type'] || 'share').replace(/\s*cow\s*$/i, '').trim() || 'share';
      const buyerFirst = String(buyer['Full Name'] || r['Buyer Name'] || 'there').split(/\s+/)[0];

      // Magic-link hop → deposit page (fresh Stripe session minted there).
      const token = generateMemberLoginToken(buyerId, buyerEmail);
      const checkoutUrl = `${SITE_URL}/api/auth/member/verify?token=${token}&next=${encodeURIComponent(`/checkout/${r.id}/deposit`)}`;

      const res = await sendDepositRequestNudge({
        buyerEmail,
        buyerName: buyerFirst,
        rancherName: rancherName || 'your rancher',
        cutTier,
        checkoutUrl,
        rancherPhone: rancherPhone || undefined,
        touch,
      });
      if ((res as any)?.success === false) suppressed++;
      else sent++;

      await new Promise((res2) => setTimeout(res2, 400)); // pace Resend + Airtable
    } catch (e: any) {
      errors.push(`${r.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  if (selected.length > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `deposit-request-nudge: ${sent} buyer nudge${sent === 1 ? '' : 's'} sent`,
      detail: `request=${candidates.length} abandon=${abandonCandidates.length} selected=${selected.length} sent=${sent} suppressed=${suppressed} errs=${errors.length}`,
      dedupeKey: 'deposit-request-nudge-summary',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes:
      `candidates=${candidates.length} selected=${selected.length} sent=${sent} ` +
      `suppressed=${suppressed} errs=${errors.length}` +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('deposit-request-nudge', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
