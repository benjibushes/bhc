// lib/leadGrade.ts
//
// LEAD GRADE (2026-07-06, conversion slice 1): the rancher card shows an
// A/B/C grade with receipts, so ranchers work the right leads first.
//
// WHY: routed leads already pass a real quiz gate (score >= 75), but ranchers
// can't tell a Dana (90, freezer, "within 60 days", opened her deposit page
// yesterday) from a lukewarm 75 that qualified in April. The connect
// investigation showed rancher-ENGAGED leads advance 22.1% vs 1.5% untouched
// (~15x) — so getting the hottest leads engaged FIRST is the strongest
// conversion lever in the data. Quality = intent x timing x freshness; the
// gate only enforces intent. This grade adds the other two dimensions plus
// the single hottest signal we have: the buyer OPENED their deposit page
// ('Deposit Link Opened At', stamped server-side by the deposit GET).
//
// Pure + dependency-free. Signals come from fields the rancher-dashboard
// payload already carries:
//   - notes            → the "[QUIZ <iso>] tier=.. timing=.. storage=.. ack=.. score=NN/100" line
//   - created_at       → freshness (days since the referral was minted)
//   - deposit_link_opened_at → deposit intent (instant A while unpaid)
//   - deposit_paid_at  → paid leads aren't graded (they're customers)

export type LeadGrade = 'A' | 'B' | 'C';

export interface QuizSignals {
  score: number | null;      // NN from score=NN/100
  timingSoon: boolean;       // "Within 60 days" / "1-2 months" class
  hasFreezer: boolean;       // storage=have_freezer
  budgetAck: boolean;        // ack=true
}

export interface LeadGradeResult {
  grade: LeadGrade;
  /** Short human "receipts" for the badge tooltip, most important first. */
  reasons: string[];
}

/** Freshness cutoffs (days since the referral was created). */
export const FRESH_DAYS = 21;
export const STALE_DAYS = 45;

const DAY_MS = 86_400_000;

/**
 * Parse the quiz-signal line the /qualify route appends to Referral Notes:
 *   "[QUIZ 2026-07-03T16:52:27.678Z] tier=Half timing=Within 60 days storage=have_freezer ack=true score=90/100"
 * Tolerant: missing line / fields → nulls and falses (grade degrades to the
 * freshness + score dimensions it can prove). Never throws.
 */
export function parseQuizSignals(notes: unknown): QuizSignals {
  const out: QuizSignals = { score: null, timingSoon: false, hasFreezer: false, budgetAck: false };
  const s = String(notes || '');
  const quizIdx = s.lastIndexOf('[QUIZ ');
  if (quizIdx === -1) return out;
  // The quiz line runs to the next newline (or end of string).
  const lineEnd = s.indexOf('\n', quizIdx);
  const line = lineEnd === -1 ? s.slice(quizIdx) : s.slice(quizIdx, lineEnd);

  const scoreMatch = line.match(/score=(\d{1,3})\s*\/\s*100/);
  if (scoreMatch) {
    const n = Number(scoreMatch[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 120) out.score = n;
  }

  // timing=... runs until the next known key (storage=/ack=/score=) — the
  // value itself contains spaces ("Within 60 days").
  const timingMatch = line.match(/timing=(.*?)\s+(?:storage=|ack=|score=)/);
  const timing = (timingMatch?.[1] || '').trim().toLowerCase();
  out.timingSoon =
    timing.includes('60 day') || timing.includes('30 day') ||
    timing.includes('1-2 month') || timing.includes('1–2 month') ||
    timing === 'asap' || timing.includes('right away') || timing.includes('now');

  out.hasFreezer = /storage=have_freezer\b/.test(line);
  out.budgetAck = /ack=true\b/.test(line);
  return out;
}

/** Whole days since an ISO stamp; null when missing/unparseable. */
function daysSince(iso: unknown, nowMs: number): number | null {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

/**
 * The grade.
 *   A — proven or near-proven purchase intent, current:
 *        opened their deposit page (unpaid), OR
 *        score >= 85 + timing-soon + fresh (<= FRESH_DAYS)
 *   B — solid and workable: score >= 75 and not stale (<= STALE_DAYS)
 *   C — everything else (stale, weak signals, or unparseable quiz) — still a
 *        lead, but the rancher should spend call time on A/B first.
 */
export function gradeLead(input: {
  notes?: unknown;
  createdAt?: unknown;             // referral created_at ISO
  depositLinkOpenedAt?: unknown;   // hottest signal (while unpaid)
  depositPaidAt?: unknown;         // paid → not graded (customer, not lead)
  nowMs: number;
}): LeadGradeResult | null {
  // Paid buyers aren't "leads" — no grade (the card shows paid states instead).
  if (String(input.depositPaidAt || '').trim()) return null;

  const q = parseQuizSignals(input.notes);
  const age = daysSince(input.createdAt, input.nowMs);
  const fresh = age !== null && age <= FRESH_DAYS;
  const stale = age === null || age > STALE_DAYS;
  const openedDeposit = !!String(input.depositLinkOpenedAt || '').trim();

  const reasons: string[] = [];
  if (openedDeposit) reasons.push('opened their deposit page');
  if (q.score !== null) reasons.push(`quiz ${q.score}/100`);
  if (q.timingSoon) reasons.push('buying within ~60 days');
  if (q.hasFreezer) reasons.push('has a freezer');
  if (q.budgetAck) reasons.push('acknowledged the budget');
  if (age !== null) reasons.push(age === 0 ? 'new today' : `${age}d old`);

  if (openedDeposit) return { grade: 'A', reasons };
  if ((q.score ?? 0) >= 85 && q.timingSoon && fresh) return { grade: 'A', reasons };
  if ((q.score ?? 0) >= 75 && !stale) return { grade: 'B', reasons };
  return { grade: 'C', reasons };
}

/** Sort weight: A leads first inside actionable pipeline groups. */
export function gradeSortWeight(grade: LeadGrade | null | undefined): number {
  if (grade === 'A') return 0;
  if (grade === 'B') return 1;
  return 2;
}
