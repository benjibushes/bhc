// lib/nextBestAction.ts
//
// F6 — Next-Best-Action engine.
//
// Why: Ben opens desk, sees 30 buyers + 5 calls + 10 pending. Cognitive
// overload. NBA collapses to "do these 3 things right now."
//
// SUPPLY-AWARE (Wave 1B, 2026-08-01): callers may pass the set of states with
// an operational rancher (the 6-gate lib/rancherEligibility canon). A hot
// buyer in a state with NO operational rancher is not a call — there is
// nobody to route them to — so those rows are demoted below every covered-
// state buyer and relabeled "recruit supply in <state>". Without the option
// the engine behaves exactly as before (no supply info ⇒ no gating).
//
// Pure function over current desk snapshot. No side effects, no DB writes.
// Same input → same output. Rules ordered by revenue impact descending.

import { normalizeState } from './states';

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
    // Fix 1 — Status='Awaiting Payment' covers BOTH invoice-out-unpaid and
    // deposit-paid-awaiting-rancher; only this timestamp distinguishes.
    depositPaidAt?: string;
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

export interface NBAOptions {
  /**
   * States (any casing / full names ok — normalized internally) that have an
   * operational rancher per lib/rancherEligibility. Omit ⇒ legacy behavior:
   * no supply gating at all. A buyer with a blank/unparseable state is never
   * demoted — you can ask a state on the phone.
   */
  coveredStates?: Iterable<string>;
}

export function computeNBA(input: NBAInput, opts: NBAOptions = {}): NBAItem[] {
  const items: NBAItem[] = [];
  const now = Date.now();

  const covered: Set<string> | null = opts.coveredStates
    ? new Set(
        Array.from(opts.coveredStates)
          .map((s) => normalizeState(s))
          .filter(Boolean),
      )
    : null;
  const isCoveredState = (state: string | undefined): boolean => {
    if (!covered) return true; // no supply info — never gate
    const st = normalizeState(state);
    if (!st) return true; // unknown state — cannot gate honestly
    return covered.has(st);
  };
  /** One recruit item per state, no matter how many buyers are stranded there. */
  const recruitEmitted = new Set<string>();

  // 1) Cal calls starting within 60 min — prep + show up.
  //    Fix 5: startTime is fed from `Sales Call Start At` (real call time);
  //    it used to be `Sales Call Booked At`, so this rule could never fire
  //    unless the booking was *created* within the hour.
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

  // 2) Hot quiz-complete buyers (score >= 70) — call within 2h.
  //    SUPPLY GATE: a hot buyer in an uncovered state is not a call — it's a
  //    recruiting signal, demoted below every covered-state item. Action text
  //    fixed 2026-08-01: "send invoice on close" was the DEAD money model —
  //    the live rail is the durable deposit link (/r/p), fee added to the
  //    buyer at deposit (docs/BUSINESS-MODEL.md).
  const hotBuyers = input.quizComplete
    .filter((b) => (b.leadScore ?? 0) >= 70)
    .slice(0, 5);
  for (const b of hotBuyers) {
    const ageHrs = b.qualifiedAt
      ? (now - new Date(b.qualifiedAt).getTime()) / 3600000
      : 999;
    if (!isCoveredState(b.state)) {
      const st = normalizeState(b.state);
      if (recruitEmitted.has(st)) continue;
      recruitEmitted.add(st);
      items.push({
        priority: 3,
        type: 'recruit',
        subject: `Recruit supply in ${st}`,
        reason: `Hot buyer (score ${b.leadScore}) waiting in ${st} — no operational rancher there`,
        action: `Sign a rancher in ${st} — do not dial buyers you cannot route`,
        entityType: 'rancher',
      });
      continue;
    }
    items.push({
      priority: 1,
      type: 'call',
      subject: `${b.name} · ${b.state}`,
      reason: `Lead score ${b.leadScore}, qualified ${formatAge(ageHrs)} ago`,
      action: 'Phone outreach — hot lead, send the deposit link on close',
      entityType: 'consumer',
      entityId: b.id,
    });
  }

  // 3) Awaiting Payment rows — Fix 1 split: deposit paid → chase the
  //    rancher; invoice still unpaid → chase the buyer.
  for (const r of input.depositPending) {
    if (r.depositPaidAt) {
      items.push({
        priority: 2,
        type: 'chase',
        subject: `${r.buyerEmail} → ${r.rancherName}`,
        reason: 'Stripe deposit paid — awaiting rancher accept',
        action: 'Telegram rancher — confirm slot or refund',
        entityType: 'referral',
        entityId: r.id,
      });
    } else {
      items.push({
        priority: 2,
        type: 'chase',
        subject: `${r.buyerEmail} → ${r.rancherName}`,
        reason: 'Deposit invoice sent — buyer has not paid',
        action: 'Chase buyer — resend checkout link',
        entityType: 'referral',
        entityId: r.id,
      });
    }
  }

  // 4) Mid-warm buyers (score 40-69) — drip + qualify.
  //    Same supply gate as rule 2: a Cal invite to a buyer in an uncovered
  //    state books a call that can only end in an apology. Skipped rather
  //    than converted — the recruit signal for that state is rule 2's job
  //    (and the cockpit's ONE-MOVE band covers the demand cross).
  const warmBuyers = input.quizComplete
    .filter((b) => {
      const s = b.leadScore ?? 0;
      return s >= 40 && s < 70;
    })
    .filter((b) => isCoveredState(b.state))
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
