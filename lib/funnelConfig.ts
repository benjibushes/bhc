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
  size: { title: 'How much beef are you after?', sub: 'Pick the closest — your rancher helps you dial it in.' },
  timing: { title: 'When do you want the freezer full?', sub: 'No wrong answer.' },
  contact: { title: 'Claim your match', sub: 'Private & approval-only. No spam, never resold.' },
  storage: { title: 'How will you store it?', sub: 'Almost there — last one.' },
  reveal: { title: "You're in.", sub: '' },
};

export interface FunnelOption {
  value: string;
  label: string;
  detail: string;
  icon: string;
}

// `value` strings match VALID_TIERS in app/api/qualify/route.ts.
export const SIZE_OPTIONS: FunnelOption[] = [
  { value: 'Quarter', label: 'Quarter', detail: '~85 lbs · feeds 1–2 · $1,000–1,500', icon: 'ti-meat' },
  { value: 'Half', label: 'Half', detail: '~170 lbs · feeds 3–5 · $2,000–2,500', icon: 'ti-meat' },
  { value: 'Whole', label: 'Whole', detail: '~340 lbs · feeds 6+ · $4,000–5,000', icon: 'ti-meat' },
  { value: 'Not Sure', label: 'Not sure yet', detail: 'Talk me through it', icon: 'ti-help-circle' },
];

// `value` strings match the timing cases in the server scorer (ASAP / Within 30
// days / Within 60 days / Within 90 days / Just exploring). "1–3 months" maps to
// "Within 60 days" (15 pts) so the score is correct.
export const TIMING_OPTIONS: FunnelOption[] = [
  { value: 'Within 30 days', label: 'Within a month', detail: 'Ready to go', icon: 'ti-bolt' },
  { value: 'Within 60 days', label: '1–3 months', detail: 'Planning ahead', icon: 'ti-calendar' },
  { value: 'Just exploring', label: 'Just browsing', detail: 'Curious for now', icon: 'ti-eye' },
];

// `value` strings match VALID_STORAGE in app/api/qualify/route.ts.
export const STORAGE_OPTIONS: FunnelOption[] = [
  { value: 'have_freezer', label: 'I have a freezer', detail: 'Ready for it', icon: 'ti-snowflake' },
  { value: 'need_freezer', label: 'Need freezer space', detail: 'Help me sort it', icon: 'ti-building-warehouse' },
  { value: 'rancher_holds', label: 'Rancher holds it', detail: 'Pick up in batches', icon: 'ti-clock' },
];

// On-brand accent used across the flow (saddle). Keep in sync with the wizard CSS.
export const FUNNEL_ACCENT = '#92632F';
