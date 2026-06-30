// Single source of truth for the unified buyer funnel: step order, copy, and
// option sets. Everything visual/textual in the flow reads from here so future
// tweaks are config edits, not component rewrites. Values (tier/timing/storage)
// MUST match the server scorer in app/api/qualify/route.ts.

export type StepKey = 'size' | 'timing' | 'contact' | 'storage' | 'reveal';

export interface FunnelStepCopy {
  title: string;
  sub: string;
}

export const FUNNEL_STEPS: StepKey[] = ['size', 'timing', 'contact', 'storage', 'reveal'];

export const FUNNEL_COPY: Record<StepKey, FunnelStepCopy> = {
  size: { title: 'how much beef are you after?', sub: 'pick the closest — your rancher helps you dial it in.' },
  timing: { title: 'when do you want the freezer full?', sub: 'no wrong answer.' },
  contact: { title: 'claim your match', sub: 'private & approval-only. no spam, never resold.' },
  storage: { title: 'how will you store it?', sub: 'almost there — last one.' },
  reveal: { title: "you're in.", sub: '' },
};

export interface FunnelOption {
  value: string;
  label: string;
  detail: string;
  icon: string;
}

// `value` strings match VALID_TIERS in app/api/qualify/route.ts.
export const SIZE_OPTIONS: FunnelOption[] = [
  { value: 'Quarter', label: 'quarter', detail: '~85 lbs · feeds 1–2 · $1,000–1,500', icon: 'ti-meat' },
  { value: 'Half', label: 'half', detail: '~170 lbs · feeds 3–5 · $2,000–2,500', icon: 'ti-meat' },
  { value: 'Whole', label: 'whole', detail: '~340 lbs · feeds 6+ · $4,000–5,000', icon: 'ti-meat' },
  { value: 'Not Sure', label: 'not sure yet', detail: 'talk me through it', icon: 'ti-help-circle' },
];

// `value` strings match the timing cases in the server scorer (ASAP / Within 30
// days / Within 60 days / Within 90 days / Just exploring). "1–3 months" maps to
// "Within 60 days" (15 pts) so the score is correct.
export const TIMING_OPTIONS: FunnelOption[] = [
  { value: 'Within 30 days', label: 'within a month', detail: 'ready to go', icon: 'ti-bolt' },
  { value: 'Within 60 days', label: '1–3 months', detail: 'planning ahead', icon: 'ti-calendar' },
  // `value` MUST stay 'Just exploring' (the server scorer keys on it for +0 pts).
  // Copy reframed 2026-06-30: was "just browsing / curious for now" — the softest,
  // last-in-list card ~68% of buyers tapped as an easy out, dropping the whole
  // cohort below the route gate. Reframed to a real timeframe so only genuinely
  // not-ready buyers self-select it; no scoring change.
  { value: 'Just exploring', label: 'still deciding', detail: 'a few months out', icon: 'ti-eye' },
];

// `value` strings match VALID_STORAGE in app/api/qualify/route.ts.
export const STORAGE_OPTIONS: FunnelOption[] = [
  { value: 'have_freezer', label: 'I have a freezer', detail: 'Ready for it', icon: 'ti-snowflake' },
  { value: 'need_freezer', label: 'Need freezer space', detail: 'Help me sort it', icon: 'ti-building-warehouse' },
  { value: 'rancher_holds', label: 'Rancher holds it', detail: 'Pick up in batches', icon: 'ti-clock' },
];

// On-brand accent used across the flow — the brand saddle (--color-saddle).
// Matches the state landing pages so /access/[state] → funnel doesn't shift brown.
export const FUNNEL_ACCENT = '#6B4F3F';
