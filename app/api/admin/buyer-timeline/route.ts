import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { mergeTimelineEvents, toIso, type TimelineSource, type TimelineSourceEvent } from '@/lib/buyerTimeline';

export const maxDuration = 30;

// ─────────────────────────────────────────────────────────────────────────
// PER-BUYER ENGAGEMENT TIMELINE  (read-only)  — admin blindness fix (B3)
//
// GET /api/admin/buyer-timeline?consumerId=recXXX   (or ?email=a@b.com)
//
// Merges every per-buyer touchpoint the base actually records into ONE
// chronological timeline: outbound emails + open/click engagement
// (Email Sends + Consumer stamps from the Resend webhook), inbound replies
// (Conversations, written by resend-inbound), SMS stamps (Consumers +
// Referrals — there is no per-message SMS log table), funnel stage
// transitions (Funnel Events), and deal milestones (Referrals stamps).
//
// Read discipline: 1 record fetch (or 1 filtered Consumers read for
// ?email=) + 4 filtered reads — never an unfiltered .all(). Each source is
// wrapped in its own try/catch and reported in a `sources` health map so a
// missing table degrades to a partial timeline, never a 500.
//
// Field names below are the REAL live-base names, verified against the
// writers: lib/emailFrequencyGuard.ts logEmailSend (Email Sends),
// app/api/webhooks/resend/route.ts (engagement stamps),
// app/api/webhooks/resend-inbound/route.ts (Conversations),
// lib/funnelMetrics.ts (Funnel Events), and the deal journey route
// (Referrals milestones, "verified against the live base").
// ─────────────────────────────────────────────────────────────────────────

type SourceHealth = 'ok' | 'empty' | string; // string = 'error: ...'

const linkIds = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export async function GET(request: Request) {
  const authResp = await requireAdmin(request);
  if (authResp) return authResp;

  const { searchParams } = new URL(request.url);
  const consumerId = (searchParams.get('consumerId') || '').trim();
  const email = (searchParams.get('email') || '').trim().toLowerCase();

  if (!consumerId && !email) {
    return NextResponse.json({ error: 'Pass ?consumerId= or ?email=' }, { status: 400 });
  }

  // ── Resolve the buyer (read #1) ──
  let buyer: any = null;
  try {
    if (consumerId) {
      buyer = await getRecordById(TABLES.CONSUMERS, consumerId);
    } else {
      const matches = (await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER(TRIM({Email})) = "${escapeAirtableValue(email)}"`,
      )) as any[];
      // Duplicate consumer rows exist for some emails — pick the most recent.
      matches.sort((a, b) =>
        String(b['Created'] || b._createdTime || '').localeCompare(String(a['Created'] || a._createdTime || '')),
      );
      buyer = matches[0] || null;
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Consumer lookup failed: ${e?.message || e}` }, { status: 502 });
  }
  if (!buyer) {
    return NextResponse.json({ error: 'Buyer not found' }, { status: 404 });
  }

  const buyerId: string = buyer.id;
  const buyerEmail = String(buyer['Email'] || email || '').trim().toLowerCase();
  const buyerName = String(buyer['Full Name'] || '');
  const sources: Record<string, SourceHealth> = {};
  const merged: TimelineSource[] = [];
  const add = (name: string, kind: string, events: TimelineSourceEvent[]) => {
    sources[name] = events.length ? 'ok' : 'empty';
    merged.push({ kind, events });
  };

  // ── Source 1: the Consumer record itself (no extra read) ──
  // Signup + warmup + last-engagement stamps written by the Resend webhook,
  // quiz qualification, and the SMS-recovery idempotency stamp.
  try {
    const ev: TimelineSourceEvent[] = [];
    const src = buyer['Source'] || buyer['Campaign'] || 'organic';
    const intent = buyer['Intent Score'] != null ? ` · intent ${buyer['Intent Score']}` : '';
    ev.push({ ts: buyer['Created'] || buyer._createdTime, kind: 'signup', summary: `Signed up via ${src}${intent}` });
    ev.push({ ts: buyer['Qualified At'], kind: 'funnel', summary: 'Passed the qualification quiz' });
    ev.push({ ts: buyer['Warmup Sent At'], kind: 'email', summary: 'Warmup email sent' });
    ev.push({ ts: buyer['Warmup Engaged At'], kind: 'email_click', summary: 'Clicked YES on warmup' });
    ev.push({ ts: buyer['Sequence Sent At'], kind: 'email', summary: `Sequence email sent${buyer['Sequence Stage'] ? ` (${buyer['Sequence Stage']})` : ''}` });
    // Latest-engagement stamps (webhook keeps only the most recent + counters).
    const opens = Number(buyer['Email Opens'] || 0);
    const clicks = Number(buyer['Email Clicks'] || 0);
    ev.push({ ts: buyer['Last Email Opened At'], kind: 'email_open', summary: `Last email open${opens ? ` (${opens} total opens)` : ''}` });
    ev.push({ ts: buyer['Last Email Clicked At'], kind: 'email_click', summary: `Last email click${clicks ? ` (${clicks} total clicks)` : ''}` });
    // SMS: no per-message log table exists — surface the send stamps we have.
    ev.push({ ts: buyer['Campaign SMS Recovery Sent At'], kind: 'sms', summary: 'Campaign recovery SMS sent' });
    add('consumer', 'milestone', ev.filter((e) => toIso(e.ts)));
  } catch (e: any) {
    sources.consumer = `error: ${e?.message || e}`;
  }

  // ── Source 2: Email Sends — outbound log + per-send engagement (read #2) ──
  if (buyerEmail) {
    try {
      const sends = (await getAllRecords(
        TABLES.EMAIL_SENDS,
        `LOWER({Recipient Email}) = "${escapeAirtableValue(buyerEmail)}"`,
      )) as any[];
      const ev: TimelineSourceEvent[] = [];
      for (const s of sends) {
        const label = s['Subject'] || s['Template Name'] || 'email';
        const status = String(s['Status'] || 'sent');
        ev.push({
          ts: s['Sent At'] || s._createdTime,
          summary: `${status === 'sent' ? 'Sent' : status[0].toUpperCase() + status.slice(1)}: ${label}`,
          detail: [s['Template Name'], s['Campaign'] ? `campaign: ${s['Campaign']}` : '', s['Suppression Reason'] ? `suppressed: ${s['Suppression Reason']}` : ''].filter(Boolean).join(' · ') || undefined,
        });
        // Engagement stamps written back onto the send row by the Resend webhook.
        if (s['Delivered At']) ev.push({ ts: s['Delivered At'], kind: 'email_delivered', summary: `Delivered: ${label}` });
        if (s['Opened At']) ev.push({ ts: s['Opened At'], kind: 'email_open', summary: `Opened: ${label}${Number(s['Open Count'] || 0) > 1 ? ` (×${s['Open Count']})` : ''}` });
        if (s['Clicked At']) ev.push({ ts: s['Clicked At'], kind: 'email_click', summary: `Clicked: ${label}${Number(s['Click Count'] || 0) > 1 ? ` (×${s['Click Count']})` : ''}` });
      }
      add('emails', 'email', ev);
    } catch (e: any) {
      sources.emails = `error: ${e?.message || e}`;
    }
  } else {
    sources.emails = 'empty';
  }

  // ── Source 3: Conversations — inbound replies + calls (read #3) ──
  // Table has From (sender email / ig:handle) + optional Linked Consumer.
  // Formula matches From by email; the Linked Consumer clause is
  // belt-and-braces (SEARCH by record id inside ARRAYJOIN only matches when
  // the id appears in the joined primary-field values, so we ALSO
  // post-filter in JS on the real link ids the API returns).
  try {
    const clauses: string[] = [];
    if (buyerEmail) {
      clauses.push(`SEARCH("${escapeAirtableValue(buyerEmail)}", LOWER({From}))`);
      clauses.push(`SEARCH("${escapeAirtableValue(buyerEmail)}", LOWER({To}))`);
    }
    clauses.push(`SEARCH("${buyerId}", ARRAYJOIN({Linked Consumer}))`);
    const convos = (await getAllRecords(
      TABLES.CONVERSATIONS,
      `OR(${clauses.join(', ')})`,
    )) as any[];
    const ev: TimelineSourceEvent[] = [];
    for (const c of convos) {
      const from = String(c['From'] || '').trim().toLowerCase();
      const to = String(c['To'] || '').trim().toLowerCase();
      const linked = linkIds(c['Linked Consumer']);
      const isThisBuyer =
        (buyerEmail && (from.includes(buyerEmail) || to.includes(buyerEmail))) ||
        linked.includes(buyerId);
      if (!isThisBuyer) continue;
      const dir = String(c['Direction'] || '').toLowerCase();
      const inbound = dir === 'inbound';
      const isCall = !!c['Call Sid'] || String(c['Subject'] || '').startsWith('Call recording');
      const body = String(c['Body Plain'] || c['Body'] || '').replace(/\s+/g, ' ').trim();
      const summaryCore = c['AI Summary'] || c['Subject'] || body.slice(0, 120) || 'Message';
      ev.push({
        ts: c['Timestamp'] || c._createdTime,
        kind: isCall ? 'call' : 'reply',
        summary: isCall
          ? `Call recorded${c['Call Duration Seconds'] ? ` (${c['Call Duration Seconds']}s)` : ''}`
          : `${inbound ? 'Buyer replied' : 'Outbound message'}: ${summaryCore}`,
        detail: [
          c['Sentiment'] ? `sentiment: ${c['Sentiment']}` : '',
          c['Objection Category'] && c['Objection Category'] !== 'none' ? `objection: ${c['Objection Category']}` : '',
          isCall ? String(c['Transcript'] || '').slice(0, 300) : body.slice(0, 300),
        ].filter(Boolean).join(' · ') || undefined,
      });
    }
    add('conversations', 'reply', ev);
  } catch (e: any) {
    sources.conversations = `error: ${e?.message || e}`;
  }

  // ── Source 4: Funnel Events — stage transitions (read #4) ──
  // Linked by `Buyer` (link → Consumers). Formula filter narrows the read
  // (id or name inside ARRAYJOIN); JS post-filter on the returned link ids
  // is the source of truth (ARRAYJOIN emits primary-field values, not ids).
  try {
    const feClauses = [`SEARCH("${buyerId}", ARRAYJOIN({Buyer}))`];
    if (buyerName) feClauses.push(`SEARCH("${escapeAirtableValue(buyerName)}", ARRAYJOIN({Buyer}))`);
    const fes = (await getAllRecords('Funnel Events', `OR(${feClauses.join(', ')})`)) as any[];
    const ev: TimelineSourceEvent[] = [];
    for (const fe of fes) {
      if (!linkIds(fe['Buyer']).includes(buyerId)) continue;
      const stage = String(fe['Stage'] || '');
      if (!stage) continue;
      ev.push({
        ts: fe['Created At'] || fe._createdTime,
        summary: `Funnel: ${stage}${fe['Reason'] ? ` — ${fe['Reason']}` : ''}`,
        detail: fe['Amount Cents'] ? `$${(Number(fe['Amount Cents']) / 100).toLocaleString()}` : undefined,
      });
    }
    add('funnel', 'funnel', ev);
  } catch (e: any) {
    sources.funnel = `error: ${e?.message || e}`;
  }

  // ── Source 5: Referrals — deal milestone stamps (read #5) ──
  let stage = String(buyer['Referral Status'] || '');
  try {
    let referrals: any[] = [];
    if (buyerEmail) {
      // Exact bare match or "Name <addr>" wrapper — same guard as
      // lib/airtable findReferralByBuyerEmail (avoids ben@x vs rueben@x).
      const e = buyerEmail.replace(/"/g, '');
      referrals = (await getAllRecords(
        TABLES.REFERRALS,
        `OR(LOWER(TRIM({Buyer Email})) = "${e}", FIND("<${e}>", LOWER({Buyer Email})) > 0)`,
      )) as any[];
    }
    const mine = referrals.filter(
      (r) => linkIds(r['Buyer']).includes(buyerId) || String(r['Buyer Email'] || '').trim().toLowerCase().includes(buyerEmail),
    );
    const ev: TimelineSourceEvent[] = [];
    for (const r of mine) {
      const who = r['Rancher Name'] || '';
      const tag = mine.length > 1 ? ` [deal ${r.id.slice(-4)}]` : '';
      ev.push({ ts: r['Created At'] || r._createdTime, summary: `Deal created${who ? ` with ${who}` : ''}${tag}` });
      ev.push({ ts: r['Approved At'], summary: `Match approved${tag}` });
      ev.push({ ts: r['Intro Sent At'], summary: `Intro sent${tag}` });
      ev.push({ ts: r['Sales Call Booked At'], kind: 'call', summary: `Sales call booked${tag}` });
      ev.push({ ts: r['Sales Call Completed At'], kind: 'call', summary: `Sales call completed${tag}` });
      ev.push({ ts: r['Rancher Accepted At'], summary: `Rancher accepted the deal${tag}` });
      ev.push({ ts: r['Reserve Recovery Sent At'], kind: 'email', summary: `Reserve recovery email sent${tag}` });
      ev.push({ ts: r['Reserve Recovery SMS Sent At'], kind: 'sms', summary: `Reserve recovery SMS sent${tag}` });
      ev.push({ ts: r['Reservation Hold Paid At'], summary: `Reservation hold paid${tag}` });
      ev.push({ ts: r['Deposit Paid At'], summary: `Deposit paid${r['Deposit Amount'] ? ` ($${Number(r['Deposit Amount']).toLocaleString()})` : ''}${tag}` });
      ev.push({ ts: r['Final Paid At'], summary: `Final payment received${tag}` });
      ev.push({ ts: r['Refunded At'], summary: `Deposit refunded${tag}` });
      ev.push({ ts: r['Closed At'], summary: `Deal closed — ${r['Status'] || 'unknown'}${r['Sale Amount'] ? ` ($${Number(r['Sale Amount']).toLocaleString()})` : ''}${tag}` });
    }
    add('referrals', 'milestone', ev.filter((e) => toIso(e.ts)));
    // Best "stage": open referral status beats the consumer's rollup text.
    const open = mine.find((r) => !['Closed Won', 'Closed Lost'].includes(String(r['Status'] || '')));
    stage = String((open || mine[0])?.['Status'] || stage || 'No deal yet');
  } catch (e: any) {
    sources.referrals = `error: ${e?.message || e}`;
  }

  const events = mergeTimelineEvents(merged);

  return NextResponse.json({
    buyer: {
      id: buyerId,
      name: buyerName,
      email: buyerEmail,
      state: String(buyer['State'] || ''),
      stage: stage || 'Unknown',
    },
    events,
    sources,
  });
}
