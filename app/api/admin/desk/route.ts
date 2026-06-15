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

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

  const [quizComplete, depositPending, slotsLocked, closedToday, waitlisted, ranchersActive, wholesaleInquiries, callDoneNoInvoice, callBuyers] =
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

  // F6 — Next Best Action
  const nba = computeNBA({
    calls: callsFormatted,
    quizComplete: quizFormatted,
    depositPending: depositPendingFormatted,
    slotsLocked: slotsLockedFormatted,
    wholesale: wholesaleFormatted,
  });

  return NextResponse.json({
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
