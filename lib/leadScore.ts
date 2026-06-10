// lib/leadScore.ts
//
// F4 — Composite lead score for desk sorting.
//
// Why: Ben sees 30 quiz-complete buyers on the desk; he needs to know
// WHICH 3 to call first. Composite score collapses 4 signals into a
// 0-100 sortable number.
//
// Components:
//   - Qualification Score (quiz answers, 0-100)         × 0.4
//   - Intent Score (form signal at signup, 0-100)       × 0.3
//   - Recency bonus (0-20 if Qualified At < 24h)        × 1.0
//   - Phone present (5 pts)                             × 1.0
//   - Paid UTM source (5 pts)                           × 1.0
//
// Pure function. No side effects. Same Consumer record → same score.
// Future: train against Closed Won outcome to learn weights.

const PAID_SOURCES = ['meta', 'facebook', 'instagram', 'google', 'tiktok', 'paid'];

export interface ConsumerForScore {
  'Qualification Score'?: number | string;
  'Intent Score'?: number | string;
  'Qualified At'?: string;
  'Phone'?: string;
  'Source'?: string;
  'UTM Source'?: string;
}

export interface LeadScoreResult {
  score: number; // 0-100
  reasons: string[]; // short tags ['quiz:85', 'fresh', 'phone', 'paid:meta']
}

export function computeLeadScore(c: ConsumerForScore): LeadScoreResult {
  const reasons: string[] = [];

  const quiz = num(c['Qualification Score']);
  const intent = num(c['Intent Score']);

  let score = 0;
  score += quiz * 0.4;
  if (quiz > 0) reasons.push(`quiz:${quiz}`);
  score += intent * 0.3;
  if (intent > 0) reasons.push(`intent:${intent}`);

  // Recency bonus (up to 20 pts, decays over 24h)
  if (c['Qualified At']) {
    const ageMs = Date.now() - new Date(c['Qualified At']).getTime();
    const ageHrs = ageMs / (1000 * 60 * 60);
    if (ageHrs >= 0 && ageHrs < 24) {
      const recency = Math.max(0, 20 * (1 - ageHrs / 24));
      score += recency;
      if (ageHrs < 2) reasons.push('fresh');
      else if (ageHrs < 6) reasons.push('today');
    }
  }

  // Phone present
  if (c['Phone'] && String(c['Phone']).replace(/\D/g, '').length >= 10) {
    score += 5;
    reasons.push('phone');
  }

  // Paid acquisition source
  const src = String(c['Source'] || c['UTM Source'] || '').toLowerCase();
  if (PAID_SOURCES.some((p) => src.includes(p))) {
    score += 5;
    reasons.push(`paid:${src}`);
  }

  // Clamp 0-100
  score = Math.min(100, Math.max(0, Math.round(score)));

  return { score, reasons };
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}
