// lib/funnelIntentScore.ts
//
// Pure intent scorer for the unified buyer funnel (2026-07-15).
//
// The 2026-06-18 funnel rewrite returned from /api/consumers BEFORE the legacy
// intent scorer ran, so Intent Score went nonzero 92.3% (Jun 1–17) → 3–6%
// (July) and every downstream consumer of the field (Telegram hot-lead alerts,
// admin sorting, Meta lead values) went blind. This module restores the signal
// from the answers the funnel actually collects — no legacy form fields.
//
// Weights (sum to a natural 100 for the hottest honest path:
// whole 30 + within-30-days 30 + budget>=mid 20 + freezer 10 + phone 10):
//   tier     — Whole 30 / Half 28 / Quarter 22 / Not Sure 5
//   timing   — ASAP·Within 30 days 30 / Within 60 days 18 / else 0
//   budget   — answered at/above the mid bracket ($2,500+ floor) 20 /
//              answered below it 8 / skipped or non-committal 5
//   storage  — have_freezer 10 / rancher_holds 8 / concrete other 6 / none 0
//   phone    — valid (10–15 digits) 10
// Clamped to 0–100.

export interface FunnelIntentInput {
  tier: string; // Consumers `Order Type` value ('Quarter'|'Half'|'Whole'|'Not Sure')
  timing: string; // Consumers `Timing` value
  budget?: string; // Consumers `Budget` choice name; ''/undefined = skipped
  storage?: string; // quiz storage answer; undefined at signup time (collected later)
  phone?: string;
}

// Mid bracket = half/whole money ($2,500+ floor). The Budget singleSelect has
// 20+ legacy choice-name spellings ('$2000-$2500', '2500-3500', '$5000+', …)
// so we parse the bracket floor instead of enumerating names.
const MID_BRACKET_FLOOR = 2500;

// First dollar figure in the choice name = the bracket floor. '<$500' is a
// ceiling, not a floor — treat as floor 0.
function budgetFloor(budget: string): number | null {
  const m = budget.replace(/[,$\s]/g, '').match(/^(<?)(\d+)/);
  if (!m) return null;
  return m[1] === '<' ? 0 : Number(m[2]);
}

function budgetPoints(budget: string | undefined): number {
  const b = (budget || '').trim();
  if (!b) return 5; // skipped — "prefer not to say"
  if (/just exploring|unsure/i.test(b)) return 5; // non-committal ≡ skipped
  const floor = budgetFloor(b);
  if (floor == null) return 5; // unparseable legacy value — no signal
  return floor >= MID_BRACKET_FLOOR ? 20 : 8;
}

function isValidPhone(phone: string | undefined): boolean {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

export function computeFunnelIntentScore(input: FunnelIntentInput): number {
  let s = 0;

  switch (input.tier) {
    case 'Whole': s += 30; break;
    case 'Half': s += 28; break;
    case 'Quarter': s += 22; break;
    case 'Not Sure': s += 5; break;
    default: break;
  }

  // Entry-level "now" is normalized to 'Within 30 days' before this runs;
  // 'ASAP' is the quiz's equivalent bucket.
  if (input.timing === 'Within 30 days' || input.timing === 'ASAP') s += 30;
  else if (input.timing === 'Within 60 days') s += 18;

  s += budgetPoints(input.budget);

  switch (input.storage) {
    case 'have_freezer': s += 10; break;
    case 'rancher_holds': s += 8; break;
    case 'need_freezer':
    case 'cuts_only': s += 6; break; // concrete answer, lowest bucket
    default: break;
  }

  if (isValidPhone(input.phone)) s += 10;

  return Math.max(0, Math.min(100, s));
}

// Maps to the EXACT `Intent Classification` singleSelect choices on Consumers
// (fldHdx82X2zhLXfwW): 'High' | 'Medium' | 'Low'.
export type FunnelIntentClassification = 'High' | 'Medium' | 'Low';

export function classifyFunnelIntent(score: number): FunnelIntentClassification {
  if (score >= 80) return 'High';
  if (score >= 60) return 'Medium';
  return 'Low';
}
