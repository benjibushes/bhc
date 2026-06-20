import { NextResponse } from 'next/server';
import { getRecordById, getAllRecords, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { requireRole } from '@/lib/adminAuth';

export const maxDuration = 30;

// ─────────────────────────────────────────────────────────────────────────
// DEAL JOURNEY AGGREGATOR  (read-only)
//
// Assembles ONE chronological customer-journey timeline for a referral by
// merging every source that records a meaningful event for the buyer + deal.
// Anchor = referral; everything else hydrates off it. EACH source is wrapped
// in its own try/catch so a missing table/field degrades to "no events from
// that source" — the endpoint never 500s on a sparse base.
// ─────────────────────────────────────────────────────────────────────────

type Actor = 'buyer' | 'rancher' | 'admin' | 'cron' | 'system' | 'stripe' | 'ai';
interface JourneyEvent {
  at: string;          // ISO timestamp
  type: string;
  actor: Actor;
  summary: string;
  source: string;
  sentiment?: 'positive' | 'neutral' | 'blocking';
}

const iso = (v: any): string | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const money = (cents: any): string => {
  const n = Number(cents || 0);
  if (!n) return '';
  return ` $${(n / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
};
const linkFilter = (field: string, id: string) => `SEARCH("${id}", ARRAYJOIN({${field}}))`;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ referralId: string }> },
) {
  const authResp = await requireRole(request, ['admin', 'onboarding']);
  if (authResp) return authResp;

  const { referralId } = await params;

  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    referral = null;
  }
  if (!referral) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }

  const buyerId = (Array.isArray(referral['Buyer']) ? referral['Buyer'][0] : null) as string | null;
  const rancherLinks = referral['Rancher'] || referral['Suggested Rancher'] || [];
  const rancherId = (Array.isArray(rancherLinks) ? rancherLinks[0] : null) as string | null;

  const [buyer, rancher] = (await Promise.all([
    buyerId ? getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null) : Promise.resolve(null),
    rancherId ? getRecordById(TABLES.RANCHERS, rancherId).catch(() => null) : Promise.resolve(null),
  ])) as [any, any];

  // Real-schema linking (verified against the live base):
  //   Conversations  → no link fields; matched by sender Email (From)
  //   Email Sends    → matched by `Recipient Email`
  //   Funnel Events  → linked by `Buyer` (record), NOT `Referral`
  //   Payments/Threads → empty tables today (deposit event comes off the
  //     referral's `Deposit Paid At` stamp instead).
  const buyerEmail = String(referral['Buyer Email'] || buyer?.['Email'] || '').trim().toLowerCase();
  const rancherEmail = String(rancher?.['Email'] || '').trim().toLowerCase();

  const events: JourneyEvent[] = [];
  const push = (e: JourneyEvent | null) => { if (e && e.at) events.push(e); };

  // ── Referral milestones ──
  try {
    push({ at: iso(referral['Created At'] || referral._createdTime)!, type: 'created', actor: 'system', source: 'referral', summary: 'Deal created (match approved)' });
    push({ at: iso(referral['Intro Sent At'])!, type: 'intro_sent', actor: 'system', source: 'referral', summary: `Intro sent${rancher ? ` to ${rancher['Operator Name'] || rancher['Ranch Name']}` : ''}` });
    push({ at: iso(referral['Sales Call Booked At'])!, type: 'call_booked', actor: 'buyer', source: 'referral', summary: 'Sales call booked' });
    push({ at: iso(referral['Sales Call Completed At'])!, type: 'call_done', actor: 'buyer', source: 'referral', summary: 'Sales call completed' });
    push({ at: iso(referral['Rancher Accepted At'])!, type: 'accepted', actor: 'rancher', source: 'referral', summary: 'Rancher accepted the deal' });
    push({ at: iso(referral['Deposit Paid At'])!, type: 'deposit', actor: 'buyer', source: 'referral', summary: `Deposit paid${money((referral['Deposit Amount'] || 0) * 100)}` });
    push({ at: iso(referral['Final Paid At'])!, type: 'final_paid', actor: 'buyer', source: 'referral', summary: 'Final payment received' });
    if (referral['Closed At']) {
      push({ at: iso(referral['Closed At'])!, type: 'close', actor: 'admin', source: 'referral', summary: `Closed — ${referral['Status'] || ''}${referral['Sale Amount'] ? ` ($${Number(referral['Sale Amount']).toLocaleString()})` : ''}` });
    }
  } catch { /* milestones best-effort */ }

  // ── Buyer lifecycle ──
  if (buyer) {
    try {
      const src = buyer['Source'] || buyer['Campaign'] || 'organic';
      const intent = buyer['Intent Score'] != null ? ` · intent ${buyer['Intent Score']}` : '';
      push({ at: iso(buyer['Created'] || buyer._createdTime)!, type: 'signup', actor: 'buyer', source: 'consumer', summary: `Signed up via ${src}${intent}` });
      push({ at: iso(buyer['Warmup Sent At'])!, type: 'warmup', actor: 'cron', source: 'consumer', summary: 'Warmup email sent' });
      push({ at: iso(buyer['Warmup Engaged At'])!, type: 'engagement', actor: 'buyer', source: 'consumer', summary: 'Clicked YES on warmup', sentiment: 'positive' });
    } catch { /* best-effort */ }
  }

  // ── Conversations (inbound replies — the "did they respond" signal) ──
  // No link fields on the table → scope to this deal by sender email.
  let lastInbound: { at: string; from: Actor; summary: string } | null = null;
  let responded = false;
  try {
    if (buyerEmail) {
      const clauses = [`LOWER({From})="${escapeAirtableValue(buyerEmail)}"`];
      if (rancherEmail) clauses.push(`LOWER({From})="${escapeAirtableValue(rancherEmail)}"`);
      const convos = await getAllRecords(TABLES.CONVERSATIONS, `AND({Direction}="inbound", OR(${clauses.join(', ')}))`) as any[];
      for (const c of convos) {
        const at = iso(c['Timestamp'] || c._createdTime);
        if (!at) continue;
        const fromEmail = String(c['From'] || '').trim().toLowerCase();
        const isRancher = !!rancherEmail && fromEmail === rancherEmail;
        const actor: Actor = isRancher ? 'rancher' : 'buyer';
        const body = String(c['Body Plain'] || c['Body'] || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const summary = c['Subject'] || body || 'Reply received';
        push({ at, type: 'reply', actor, source: 'conversation', summary: `${isRancher ? 'Rancher' : 'Buyer'} replied: ${summary}` });
        if (!isRancher) {
          responded = true;
          if (!lastInbound || at > lastInbound.at) lastInbound = { at, from: actor, summary };
        }
      }
    }
  } catch { /* conversations table optional */ }

  // ── Outbound email log (matched by Recipient Email) ──
  if (buyerEmail) {
    try {
      const sends = await getAllRecords(TABLES.EMAIL_SENDS, `LOWER({Recipient Email})="${escapeAirtableValue(buyerEmail)}"`) as any[];
      for (const e of sends) {
        const at = iso(e['Sent At'] || e._createdTime);
        if (!at) continue;
        const status = String(e['Status'] || 'sent');
        push({ at, type: 'email_sent', actor: 'system', source: 'email', summary: `Sent: ${e['Subject'] || e['Template Name'] || 'email'}${status !== 'sent' ? ` (${status})` : ''}` });
      }
    } catch { /* email sends optional */ }
  }

  // ── Funnel events (linked by Buyer record, buyer-scoped) ──
  if (buyerId) {
    try {
      const fes = await getAllRecords('Funnel Events', linkFilter('Buyer', buyerId)) as any[];
      for (const fe of fes) {
        const at = iso(fe['Created At'] || fe._createdTime);
        if (!at) continue;
        const stage = String(fe['Stage'] || '');
        if (/^(signup|transition:NEW|transition:WAITING)/.test(stage)) continue; // dedupe vs buyer signup
        push({ at, type: 'funnel', actor: stage.startsWith('admin:') ? 'admin' : 'system', source: 'funnel', summary: `${stage}${fe['Reason'] ? ` (${fe['Reason']})` : ''}` });
      }
    } catch { /* funnel events optional */ }
  }

  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // ── Derived "next action" hint ──
  const status = String(referral['Status'] || '');
  const lastActivityAt = referral['Last Buyer Activity At'] || referral['Last Rancher Activity At'] || referral['Intro Sent At'];
  const daysSince = lastActivityAt ? Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86400000) : null;
  let nextAction = '';
  if (status === 'Pending Approval') nextAction = 'Approve + send intro, or reroute to a better rancher';
  else if (!rancherId) nextAction = 'Unmatched — route this buyer to a rancher';
  else if (status === 'Closed Won') nextAction = referral['Final Paid At'] ? 'Done — paid in full' : 'Collect the final balance';
  else if (status === 'Closed Lost') nextAction = 'Reopen if the buyer re-engages';
  else if (responded && daysSince != null && daysSince >= 3) nextAction = `Buyer replied but ${daysSince}d quiet — follow up or reroute`;
  else if (daysSince != null && daysSince >= 5) nextAction = `No activity ${daysSince}d — nudge the rancher or reroute`;
  else if (!responded && status === 'Intro Sent') nextAction = 'Intro sent — waiting on first reply';
  else nextAction = 'Deal in progress';

  return NextResponse.json({
    referral: {
      id: referral.id,
      status,
      buyerName: referral['Buyer Name'] || buyer?.['Full Name'] || '',
      buyerEmail: referral['Buyer Email'] || buyer?.['Email'] || '',
      buyerState: referral['Buyer State'] || buyer?.['State'] || '',
      orderType: referral['Order Type'] || '',
      saleAmount: referral['Sale Amount'] || 0,
      commissionDue: referral['Commission Due'] || 0,
      depositPaidAt: referral['Deposit Paid At'] || '',
      finalPaidAt: referral['Final Paid At'] || '',
      intentScore: buyer?.['Intent Score'] ?? null,
    },
    rancher: rancher ? {
      id: rancher.id,
      name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
      state: rancher['State'] || '',
      email: rancher['Email'] || '',
      phone: rancher['Phone'] || '',
    } : null,
    responded,
    lastInbound,
    nextAction,
    events,
  });
}
