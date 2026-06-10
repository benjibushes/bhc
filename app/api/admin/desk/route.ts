// app/api/admin/desk/route.ts
//
// Sales-floor pivot 2026-06-09: single endpoint that powers /admin/today v2.
// Returns Cal feed + pipeline snapshot + closed-today + waitlisted-states +
// rancher pulse in one round-trip. Frontend polls every 30s.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const todayIso = today.toISOString().slice(0, 10);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);

  // Conversations table holds Cal bookings (per the cal webhook handler).
  // Fall back to empty list if the table or filter format isn't supported —
  // we don't want a single missing table to break the whole desk.
  let calls: any[] = [];
  try {
    calls = await getAllRecords(
      'Conversations',
      `AND({Type}='cal_booking',IS_AFTER({Start Time},'${todayIso}'),IS_BEFORE({Start Time},'${tomorrowIso}'))`,
    );
  } catch {
    calls = [];
  }

  const [quizComplete, depositPending, slotsLocked, closedToday, waitlisted, ranchersActive] =
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
    ]);

  return NextResponse.json({
    calls: calls.map(formatCall),
    quizComplete: quizComplete.map(formatBuyer),
    depositPending: depositPending.map(formatReferral),
    slotsLocked: slotsLocked.map(formatReferral),
    closedToday: closedToday.map(formatReferral),
    waitlisted: groupByState(waitlisted),
    ranchersActive: ranchersActive.length,
    pipeline: computePipelineValue(quizComplete, depositPending, slotsLocked, closedToday),
  });
}

function formatCall(r: any) {
  return {
    id: r.id,
    startTime: r['Start Time'] || '',
    buyerName: r['Attendee Name'] || r['Buyer Name'] || '?',
    buyerEmail: r['Attendee Email'] || r['Buyer Email'] || '?',
    rancherName: r['Rancher Name'] || '',
    state: r['State'] || '',
    quizScore: r['Quiz Score'] || null,
  };
}

function formatBuyer(r: any) {
  return {
    id: r.id,
    name: r['Full Name'] || '?',
    email: r['Email'] || '',
    state: r['State'] || '',
    quizScore: r['Qualification Score'] || 0,
    intentScore: r['Intent Score'] || 0,
    qualifiedAt: r['Qualified At'] || '',
  };
}

function formatReferral(r: any) {
  return {
    id: r.id,
    buyerEmail: r['Buyer Email'] || '?',
    rancherName: Array.isArray(r['Rancher']) ? '(linked)' : (r['Rancher Name'] || '?'),
    saleAmount: r['Sale Amount'] || 0,
    depositAmount: r['Deposit Amount'] || 0,
    state: r['Buyer State'] || '',
    closedAt: r['Closed At'] || '',
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
  return {
    quizPotential: quiz.length * AVG_SALE,
    pendingValueCents: pending.reduce((s, r) => s + Number(r['Deposit Amount'] || 0), 0),
    lockedValueCents: locked.reduce((s, r) => s + Number(r['Sale Amount'] || 0) * 100, 0),
    closedTodayValueCents: closed.reduce((s, r) => s + Number(r['Sale Amount'] || 0) * 100, 0),
  };
}
