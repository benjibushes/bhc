// app/api/admin/desk/route.ts
//
// Sales-floor pivot 2026-06-09: single endpoint that powers /admin/today v2.
// Returns Cal feed + pipeline snapshot + closed-today + waitlisted-states +
// rancher pulse in one round-trip. Frontend polls every 30s.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { computeLeadScore } from '@/lib/leadScore';
import { computeNBA } from '@/lib/nextBestAction';
import { orderTypeToCut } from '@/lib/requalifyCampaign';
import {
  hasOpenCallbackRequest,
  rankDialQueue,
  type DialCandidate,
} from '@/lib/callbackQueue';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ── INBOUND CALLBACK RAIL ──────────────────────────────────────────────────
//
// Consumers field names, verified against the live schema (tblAbjQDnLrOtjpoE)
// 2026-07-30 — see docs/WRITE-MAP.md.
const F_CALLBACK_REQUESTED_AT = 'Callback Requested At';
const F_CALLBACK_NOTE = 'Callback Note';
const F_CALLBACK_HANDLED_AT = 'Callback Handled At';

// Open = asked, and not called SINCE. The OR() is not decoration: both stamps
// are single-value dateTime fields, so a buyer who asks a second time
// overwrites Requested At while Handled At still holds the first call. Without
// the IS_BEFORE arm that re-ask would be invisible to the desk forever.
// lib/callbackQueue.hasOpenCallbackRequest re-checks the same rule in JS below,
// so the desk and the endpoint's duplicate guard can never disagree.
const OPEN_CALLBACK_FORMULA = `AND(NOT({${F_CALLBACK_REQUESTED_AT}}=''),OR({${F_CALLBACK_HANDLED_AT}}='',IS_BEFORE({${F_CALLBACK_HANDLED_AT}},{${F_CALLBACK_REQUESTED_AT}})))`;

export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const todayIso = today.toISOString().slice(0, 10);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);

  // R5 (2026-06-10): Cal bookings are stamped on Referrals by the cal
  // webhook. Prior implementation queried Conversations.Type='cal_booking' —
  // that field doesn't exist on Conversations, so calls was always empty.
  // Fix 5 (2026-06-11): window on `Sales Call Start At` (when the call
  // actually happens), not `Sales Call Booked At` (when the booking was
  // created) — a call booked yesterday for 2pm today never showed up.
  let calls: any[] = [];
  try {
    calls = await getAllRecords(
      TABLES.REFERRALS,
      `AND(IS_AFTER({Sales Call Start At},'${todayIso}'),IS_BEFORE({Sales Call Start At},'${tomorrowIso}'))`,
    );
  } catch {
    calls = [];
  }

  // Fix 5/7 — dossier join: pull the Consumer rows behind today's calls in
  // one batched OR() lookup so call cards carry quiz score + phone.
  const callEmails = [
    ...new Set(
      calls
        .map((r: any) => String(r['Buyer Email'] || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  const [quizComplete, depositPending, slotsLocked, closedToday, waitlisted, ranchersActive, wholesaleInquiries, callDoneNoInvoice, callBuyers, callbackRows] =
    await Promise.all([
      getAllRecords(
        TABLES.CONSUMERS,
        `AND(NOT({Qualified At}=''),{Buyer Stage}='READY')`,
      ).catch(() => []),
      getAllRecords(
        TABLES.REFERRALS,
        `{Status}='Awaiting Payment'`,
      ).catch(() => []),
      getAllRecords(
        TABLES.REFERRALS,
        `{Status}='Slot Locked'`,
      ).catch(() => []),
      getAllRecords(
        TABLES.REFERRALS,
        `AND({Status}='Closed Won',IS_AFTER({Closed At},'${todayIso}'))`,
      ).catch(() => []),
      getAllRecords(
        TABLES.CONSUMERS,
        `{Buyer Stage}='WAITING'`,
      ).catch(() => []),
      getAllRecords(
        TABLES.RANCHERS,
        `AND({Active Status}='Active',{Agreement Signed}=TRUE())`,
      ).catch(() => []),
      getAllRecords(
        TABLES.INQUIRIES,
        `AND({Interest Type}='Wholesale',NOT({Status}='Closed Won'),NOT({Status}='Closed Lost'))`,
      ).catch(() => []),
      // Fix 2 — "Ben closed on the call but forgot the invoice" net: the
      // call is marked completed but the referral never advanced into the
      // money stages.
      getAllRecords(
        TABLES.REFERRALS,
        `AND(NOT({Sales Call Completed At}=''),{Status}!='Awaiting Payment',{Status}!='Slot Locked',{Status}!='Closed Won',{Status}!='Closed Lost')`,
      ).catch(() => []),
      // Fix 5/7 — Consumers behind today's calls (quiz score + phone)
      callEmails.length > 0
        ? getAllRecords(
            TABLES.CONSUMERS,
            `OR(${callEmails.map((e) => `LOWER({Email})="${escapeAirtableValue(e)}"`).join(',')})`,
          ).catch(() => [])
        : Promise.resolve([] as any[]),
      // Inbound callback rail — buyers who ASKED to be called. Not gated on
      // CALLBACK_RAIL_ENABLED: the desk must already work the instant the flag
      // flips, and with the rail dark this simply returns nothing.
      getAllRecords(TABLES.CONSUMERS, OPEN_CALLBACK_FORMULA).catch(() => []),
    ]);

  // F4 — composite lead score + sort quiz-complete by hottest first
  const quizFormatted = quizComplete
    .map(formatBuyer)
    .sort((a, b) => b.leadScore - a.leadScore);

  const buyerByEmail = new Map<string, any>(
    (callBuyers as any[]).map((c) => [String(c['Email'] || '').trim().toLowerCase(), c] as [string, any]),
  );
  // Fix 5 — ordered by actual start time so the desk reads top-to-bottom
  // like Ben's day.
  const callsFormatted = calls
    .map((r: any) => formatCall(r, buyerByEmail.get(String(r['Buyer Email'] || '').trim().toLowerCase())))
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  const depositPendingFormatted = depositPending.map(formatReferral);
  const slotsLockedFormatted = slotsLocked.map(formatReferral);
  const callDoneNoInvoiceFormatted = (callDoneNoInvoice as any[]).map(formatReferral);

  const wholesaleFormatted = (wholesaleInquiries as any[]).map(formatWholesale);

  // ── INBOUND: buyers who asked for a call ────────────────────────────────
  // Re-filtered in JS through the SAME predicate the endpoint's duplicate
  // guard uses, so an Airtable formula quirk can never let the two drift.
  // Sorted OLDEST FIRST: a callback request is a debt, and the person who has
  // waited longest is closest to giving up on us.
  const callbackRequests = (callbackRows as any[])
    .filter((c) =>
      hasOpenCallbackRequest({
        callbackRequestedAt: c[F_CALLBACK_REQUESTED_AT],
        callbackHandledAt: c[F_CALLBACK_HANDLED_AT],
      }),
    )
    .map(formatCallbackRequest)
    .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));

  // "Who do I dial right now?" — ONE ranking across every source, so the desk
  // stops making Ben eyeball five buckets and guess. Ordering + the reasoning
  // behind it live in lib/callbackQueue.
  const dialQueue = rankDialQueue(
    buildDialCandidates(callbackRows as any[], depositPending as any[], quizComplete as any[]),
    { now: Date.now() },
  );

  // F6 — Next Best Action
  const nba = computeNBA({
    calls: callsFormatted,
    quizComplete: quizFormatted,
    depositPending: depositPendingFormatted,
    slotsLocked: slotsLockedFormatted,
    wholesale: wholesaleFormatted,
  });

  return NextResponse.json({
    callbackRequests,
    dialQueue,
    calls: callsFormatted,
    quizComplete: quizFormatted,
    depositPending: depositPendingFormatted,
    slotsLocked: slotsLockedFormatted,
    callDoneNoInvoice: callDoneNoInvoiceFormatted,
    closedToday: closedToday.map(formatReferral),
    waitlisted: groupByState(waitlisted),
    ranchersActive: ranchersActive.length,
    wholesale: wholesaleFormatted,
    pipeline: computePipelineValue(quizComplete, depositPending, slotsLocked, closedToday),
    nba,
  });
}

// ── INBOUND CALLBACK RAIL — shaping ────────────────────────────────────────

/** One buyer who asked to be called, as the desk card needs them. */
function formatCallbackRequest(c: any) {
  const requestedAt = String(c[F_CALLBACK_REQUESTED_AT] || '');
  const t = Date.parse(requestedAt);
  return {
    id: c.id,
    name: String(c['Full Name'] || '').trim() || '(no name)',
    email: String(c['Email'] || '').trim(),
    phone: String(c['Phone'] || '').trim(),
    state: String(c['State'] || '').trim(),
    note: String(c[F_CALLBACK_NOTE] || '').trim(),
    orderType: String(c['Order Type'] || '').trim(),
    requestedAt,
    /** Hours waiting. The number Ben should feel guilty about. */
    hoursWaiting: Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 3_600_000)),
    /** They have been called before and came back. Worth knowing pre-dial. */
    repeatAsk: String(c[F_CALLBACK_HANDLED_AT] || '').trim().length > 0,
  };
}

/**
 * Fold every source the desk already holds into ONE list of callable buyers.
 *
 * Merged by consumer id, not concatenated — a buyer who asked for a call AND
 * has an unpaid checkout open is one person and must appear once, in the
 * higher tier. Costs no extra Airtable read: all three inputs were already
 * fetched for other panels.
 */
function buildDialCandidates(
  callbackRows: any[],
  depositPending: any[],
  quizComplete: any[],
): DialCandidate[] {
  const byId = new Map<string, DialCandidate>();
  const merge = (id: string, patch: Partial<DialCandidate>) => {
    if (!id) return;
    // First writer wins per field, and sources are merged highest-signal
    // first, so a callback row's identity is never clobbered by a colder one.
    const prev = byId.get(id) || { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '' || v === null) continue;
      if ((prev as any)[k] === undefined || (prev as any)[k] === '') (prev as any)[k] = v;
    }
    byId.set(id, prev);
  };

  // 1. asked for a call — the top tier.
  for (const c of callbackRows) {
    merge(c.id, {
      id: c.id,
      name: String(c['Full Name'] || '').trim(),
      state: String(c['State'] || '').trim(),
      phone: String(c['Phone'] || '').trim(),
      email: String(c['Email'] || '').trim(),
      callbackRequestedAt: String(c[F_CALLBACK_REQUESTED_AT] || ''),
      callbackHandledAt: String(c[F_CALLBACK_HANDLED_AT] || ''),
      callbackNote: String(c[F_CALLBACK_NOTE] || '').trim(),
      qualifiedAt: String(c['Qualified At'] || ''),
      hasCutOnFile: !!orderTypeToCut(c['Order Type']),
    });
  }

  // 2. opened a deposit page and never paid. Keyed on the referral's Buyer
  //    link so it merges with the same person's callback row; falls back to
  //    the referral id so a link-less row is still listed rather than dropped.
  for (const r of depositPending) {
    const buyerLink = Array.isArray(r['Buyer']) ? String(r['Buyer'][0] || '') : '';
    merge(buyerLink || r.id, {
      id: buyerLink || r.id,
      name: String(r['Buyer Name'] || '').trim(),
      state: String(r['Buyer State'] || '').trim(),
      phone: String(r['Buyer Phone'] || '').trim(),
      email: String(r['Buyer Email'] || '').trim(),
      depositLinkOpenedAt: String(r['Deposit Link Opened At'] || ''),
      depositPaidAt: String(r['Deposit Paid At'] || ''),
      referralId: r.id,
      rancherName: String(r['Rancher Name'] || r['Suggested Rancher Name'] || '').trim(),
      cutLabel: String(r['Order Type'] || '').trim(),
      dealAmount: Number(r['Total Sale Amount'] || r['Sale Amount'] || 0) || undefined,
      hasLiveDeal: true,
    });
  }

  // 3. qualified, a real cut on file, nothing live. Buyer Stage='READY' is
  //    already the "not in a deal" state (MATCHED is the in-deal one), so
  //    these rows carry no live-deal flag unless a referral above set it.
  for (const c of quizComplete) {
    merge(c.id, {
      id: c.id,
      name: String(c['Full Name'] || '').trim(),
      state: String(c['State'] || '').trim(),
      phone: String(c['Phone'] || '').trim(),
      email: String(c['Email'] || '').trim(),
      qualifiedAt: String(c['Qualified At'] || ''),
      hasCutOnFile: !!orderTypeToCut(c['Order Type']),
    });
  }

  return [...byId.values()];
}

// F15 — wholesale inquiries surface on v2 desk.
// Parses "State: XX" out of structured Notes (best signal until schema
// adds a clean column). Returns the same shape as the retail rows so
// the NBA engine + UI can stay consistent.
// R2 (2026-06-10): Inquiries schema fields are `Created` (date) +
// `Last Activity At` (dateTime, added today). Airtable metadata
// `createdTime` is the only universal fallback when both are empty.
function formatWholesale(i: any) {
  const notes = String(i['Notes'] || i['Message'] || '');
  const stateMatch = notes.match(/^State:\s*(.+)$/m);
  const businessMatch = notes.match(/^Business:\s*(.+)$/m);
  const businessTypeMatch = notes.match(/^Business Type:\s*(.+)$/m);
  const volumeMatch = notes.match(/^Monthly Volume:\s*(.+)$/m);
  const lastActivity = i['Last Activity At'] || i['Created'] || i._createdTime || '';
  const ageDays = lastActivity
    ? Math.floor((Date.now() - new Date(String(lastActivity)).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return {
    id: i.id,
    businessName: businessMatch?.[1]?.trim() || i['Ranch Name'] || i['Consumer Name'] || '?',
    businessType: businessTypeMatch?.[1]?.trim() || '',
    contactName: i['Consumer Name'] || '',
    email: i['Consumer Email'] || '',
    phone: i['Consumer Phone'] || '',
    state: stateMatch?.[1]?.trim() || '',
    monthlyVolume: volumeMatch?.[1]?.trim() || '',
    status: String(i['Status'] || 'New'),
    daysSinceActivity: ageDays,
  };
}

// R5 (2026-06-10): now reads Referral rows — not Conversations rows.
// Fix 5 (2026-06-11): startTime is `Sales Call Start At` (real call time),
// not `Sales Call Booked At` (booking-creation time) — the NBA "call in
// ≤60min" rule needs the actual start to fire. `c` is the joined Consumer
// row (fix 7 dossier) for quiz score + phone fallback.
function formatCall(r: any, c?: any) {
  return {
    id: r.id,
    startTime: r['Sales Call Start At'] || '',
    buyerName: r['Buyer Name'] || '?',
    buyerEmail: r['Buyer Email'] || '?',
    buyerPhone: r['Buyer Phone'] || c?.['Phone'] || '',
    rancherName: r['Suggested Rancher Name'] || '',
    state: r['Buyer State'] || c?.['State'] || '',
    quizScore: c && c['Qualification Score'] != null ? Number(c['Qualification Score']) : null,
  };
}

function formatBuyer(r: any) {
  const { score, reasons } = computeLeadScore(r);
  // F13 — email engagement (F5 webhook stamps these)
  const emailOpens = Number(r['Email Opens'] || 0);
  const emailClicks = Number(r['Email Clicks'] || 0);
  const lastOpenedAt = r['Last Email Opened At'] || '';
  const lastClickedAt = r['Last Email Clicked At'] || '';
  return {
    id: r.id,
    name: r['Full Name'] || '?',
    email: r['Email'] || '',
    state: r['State'] || '',
    quizScore: r['Qualification Score'] || 0,
    intentScore: r['Intent Score'] || 0,
    qualifiedAt: r['Qualified At'] || '',
    leadScore: score,
    leadReasons: reasons,
    emailOpens,
    emailClicks,
    lastOpenedAt,
    lastClickedAt,
  };
}

function formatReferral(r: any) {
  // F12 — Deal-rot indicator. Compute days since the most recent activity.
  // "Last activity" = max of (Last Rancher Activity At, Last Buyer Activity At,
  // Rancher Accepted At, Intro Sent At, createdTime). The bigger this is, the
  // colder the deal.
  // R3 (2026-06-10): Referrals has NO `Created At` field. The only universal
  // creation timestamp is Airtable metadata `createdTime`, exposed by
  // getAllRecords as `_createdTime` (the flatten drops _rawJson, so reading
  // _rawJson.createdTime here was always undefined).
  const now = Date.now();
  const candidates = [
    r['Last Rancher Activity At'],
    r['Last Buyer Activity At'],
    r['Rancher Accepted At'],
    r['Intro Sent At'],
    r._createdTime,
  ]
    .filter(Boolean)
    .map((s: any) => {
      const t = new Date(String(s)).getTime();
      return isNaN(t) ? 0 : t;
    });
  const lastActivityMs = candidates.length ? Math.max(...candidates) : 0;
  const daysSinceActivity = lastActivityMs > 0
    ? Math.floor((now - lastActivityMs) / (1000 * 60 * 60 * 24))
    : null;

  return {
    id: r.id,
    buyerEmail: r['Buyer Email'] || '?',
    buyerName: r['Buyer Name'] || '',
    buyerPhone: r['Buyer Phone'] || '',
    rancherName: Array.isArray(r['Rancher']) ? '(linked)' : (r['Rancher Name'] || '?'),
    saleAmount: r['Sale Amount'] || 0,
    // Fix 4 — Airtable money fields are stored in DOLLARS. Convert ×100
    // here so every client fmtUsd (÷100) stays consistent.
    depositAmountCents: Math.round(Number(r['Deposit Amount'] || 0) * 100),
    totalSaleAmountCents: Math.round(Number(r['Total Sale Amount'] || 0) * 100),
    finalInvoiceAmountCents: Math.round(Number(r['Final Invoice Amount'] || 0) * 100),
    state: r['Buyer State'] || '',
    closedAt: r['Closed At'] || '',
    status: r['Status'] || '',
    // Fix 1/2/3 — stage timestamps. Stripe keeps Status='Awaiting Payment'
    // after the deposit is PAID; only these distinguish the true stage.
    depositPaidAt: r['Deposit Paid At'] || '',
    rancherAcceptedAt: r['Rancher Accepted At'] || '',
    finalInvoiceSentAt: r['Final Invoice Sent At'] || '',
    salesCallCompletedAt: r['Sales Call Completed At'] || '',
    daysSinceActivity,
  };
}

function groupByState(buyers: any[]) {
  const m: Record<string, number> = {};
  for (const b of buyers) {
    const s = String(b['State'] || 'UNK').toUpperCase();
    m[s] = (m[s] || 0) + 1;
  }
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => ({ state, count }));
}

function computePipelineValue(quiz: any[], pending: any[], locked: any[], closed: any[]) {
  const AVG_SALE = 2000; // half cow avg in dollars
  // Fix 4 — `Deposit Amount` / `Total Sale Amount` are DOLLARS in Airtable;
  // multiply ×100 so the *Cents names are honest (pendingValueCents was
  // understating 100x). `Sale Amount` stays empty until Closed Won for
  // tier_v2, so locked value falls back to `Total Sale Amount`.
  return {
    quizPotential: quiz.length * AVG_SALE,
    pendingValueCents: pending.reduce((s, r) => s + Number(r['Deposit Amount'] || 0) * 100, 0),
    lockedValueCents: locked.reduce(
      (s, r) => s + Number(r['Sale Amount'] || r['Total Sale Amount'] || 0) * 100,
      0,
    ),
    closedTodayValueCents: closed.reduce((s, r) => s + Number(r['Sale Amount'] || 0) * 100, 0),
  };
}
