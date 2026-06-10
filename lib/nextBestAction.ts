// lib/nextBestAction.ts
//
// F6 — Next-Best-Action engine.
//
// Why: Ben opens desk, sees 30 buyers + 5 calls + 10 pending. Cognitive
// overload. NBA collapses to "do these 3 things right now."
//
// Pure function over current desk snapshot. No side effects, no DB writes.
// Same input → same output. Rules ordered by revenue impact descending.

export interface NBAItem {
  priority: 1 | 2 | 3; // 1 = highest
  type: 'call' | 'chase' | 'send' | 'recruit';
  subject: string;     // who/what
  reason: string;      // why now
  action: string;      // suggested verb
  entityType: 'consumer' | 'referral' | 'rancher' | 'cal';
  entityId?: string;
}

interface NBAInput {
  calls: Array<{
    id: string;
    startTime: string;
    buyerName: string;
    buyerEmail: string;
    state?: string;
  }>;
  quizComplete: Array<{
    id: string;
    name: string;
    email: string;
    state: string;
    qualifiedAt: string;
    leadScore?: number;
  }>;
  depositPending: Array<{
    id: string;
    buyerEmail: string;
    rancherName: string;
    state?: string;
  }>;
  slotsLocked: Array<{
    id: string;
    buyerEmail: string;
    rancherName: string;
  }>;
  wholesale?: Array<{
    id: string;
    businessName: string;
    state: string;
    status: string;
    daysSinceActivity: number | null;
  }>;
}

export function computeNBA(input: NBAInput): NBAItem[] {
  const items: NBAItem[] = [];
  const now = Date.now();

  // 1) Cal calls starting within 60 min — prep + show up
  for (const c of input.calls) {
    if (!c.startTime) continue;
    const startMs = new Date(c.startTime).getTime();
    const minsUntil = (startMs - now) / 60000;
    if (minsUntil > 0 && minsUntil <= 60) {
      items.push({
        priority: 1,
        type: 'call',
        subject: `${c.buyerName} (${c.state || '?'})`,
        reason: `Cal call in ${Math.round(minsUntil)} min`,
        action: 'Pull buyer Airtable + jump on call',
        entityType: 'cal',
        entityId: c.id,
      });
    }
  }

  // 2) Hot quiz-complete buyers (score >= 70) — call within 2h
  const hotBuyers = input.quizComplete
    .filter((b) => (b.leadScore ?? 0) >= 70)
    .slice(0, 5);
  for (const b of hotBuyers) {
    const ageHrs = b.qualifiedAt
      ? (now - new Date(b.qualifiedAt).getTime()) / 3600000
      : 999;
    items.push({
      priority: 1,
      type: 'call',
      subject: `${b.name} · ${b.state}`,
      reason: `Lead score ${b.leadScore}, qualified ${formatAge(ageHrs)} ago`,
      action: 'Phone outreach — hot lead, send invoice on close',
      entityType: 'consumer',
      entityId: b.id,
    });
  }

  // 3) Deposit pending > 24h with no rancher accept — chase rancher
  for (const r of input.depositPending) {
    items.push({
      priority: 2,
      type: 'chase',
      subject: `${r.buyerEmail} → ${r.rancherName}`,
      reason: 'Awaiting rancher accept (Stripe deposit paid)',
      action: 'Telegram rancher — confirm slot or refund',
      entityType: 'referral',
      entityId: r.id,
    });
  }

  // 4) Mid-warm buyers (score 40-69) — drip + qualify
  const warmBuyers = input.quizComplete
    .filter((b) => {
      const s = b.leadScore ?? 0;
      return s >= 40 && s < 70;
    })
    .slice(0, 3);
  for (const b of warmBuyers) {
    items.push({
      priority: 3,
      type: 'send',
      subject: `${b.name} · ${b.state}`,
      reason: `Lead score ${b.leadScore}, warm but not closing`,
      action: 'Send Cal invite via Airtable email',
      entityType: 'consumer',
      entityId: b.id,
    });
  }

  // 5) Slots locked — fulfill watch
  for (const r of input.slotsLocked.slice(0, 3)) {
    items.push({
      priority: 3,
      type: 'chase',
      subject: `${r.buyerEmail} → ${r.rancherName}`,
      reason: 'Slot locked, awaiting fulfillment',
      action: 'Verify processing date w/ rancher',
      entityType: 'referral',
      entityId: r.id,
    });
  }

  // 6) Wholesale inquiries — Status=New is highest priority (no outreach yet);
  //    then any wholesale lead stale >7 days.
  for (const w of (input.wholesale || []).slice(0, 5)) {
    if (w.status === 'New') {
      items.push({
        priority: 2,
        type: 'send',
        subject: `${w.businessName} (${w.state || '?'})`,
        reason: 'Wholesale inquiry, no outreach yet',
        action: 'Send intro + quote within 24h',
        entityType: 'consumer',
        entityId: w.id,
      });
    } else if ((w.daysSinceActivity ?? 0) >= 7) {
      items.push({
        priority: 3,
        type: 'chase',
        subject: `${w.businessName} (${w.state || '?'})`,
        reason: `Wholesale ${w.status}, ${w.daysSinceActivity}d cold`,
        action: 'Re-engage or close-lost',
        entityType: 'consumer',
        entityId: w.id,
      });
    }
  }

  // Sort by priority then return top 8
  items.sort((a, b) => a.priority - b.priority);
  return items.slice(0, 8);
}

function formatAge(hrs: number): string {
  if (hrs < 1) return `${Math.round(hrs * 60)}min`;
  if (hrs < 24) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}
