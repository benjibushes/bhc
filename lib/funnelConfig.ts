// Single source of truth for the unified buyer funnel: step order, copy, and
// option sets. Everything visual/textual in the flow reads from here so future
// tweaks are config edits, not component rewrites. Values (tier/timing/storage)
// MUST match the server scorer in app/api/qualify/route.ts.

export type StepKey = 'size' | 'timing' | 'budget' | 'contact' | 'storage' | 'commit' | 'reveal';

export interface FunnelStepCopy {
  title: string;
  sub: string;
}

// budget (optional, skippable chip row) + commit (the real response-ack tap —
// it IS the finalize submit, replacing the old hard-coded ack:true) added
// 2026-07-15 (funnel truth PR). Both single-tap, mobile-first, no text inputs.
export const FUNNEL_STEPS: StepKey[] = ['size', 'timing', 'budget', 'contact', 'storage', 'commit', 'reveal'];

export const FUNNEL_COPY: Record<StepKey, FunnelStepCopy> = {
  // sub softened 2026-07-06 (journey overhaul Phase 2): the size step is the
  // funnel's first screen for cold /access traffic and used to read as a bare
  // $1k-5k commitment gate. "nothing's locked in" lowers the stakes without
  // touching option values (scorer contract intact).
  size: { title: 'how much beef are you after?', sub: 'pick the closest — nothing’s locked in, your rancher helps you dial it in.' },
  timing: { title: 'when do you want the freezer full?', sub: 'no wrong answer.' },
  budget: { title: 'roughly what budget?', sub: 'optional — helps your rancher quote you right. skip if you’re not sure.' },
  contact: { title: 'claim your match', sub: 'private & approval-only. no spam, never resold.' },
  storage: { title: 'how will you store it?', sub: 'almost there — last one.' },
  // The dynamic question line ("your rancher will call or text within 24–48
  // hours from a {state} number — will you pick up?") renders in the component
  // because it interpolates the buyer's state.
  commit: { title: 'one last thing.', sub: '' },
  reveal: { title: "you're in.", sub: '' },
};

export interface FunnelOption {
  value: string;
  label: string;
  detail: string;
  icon: string;
}

// `value` strings match VALID_TIERS in app/api/qualify/route.ts.
// Price ranges updated 2026-07-15 (funnel truth PR): the old anchors
// ($2,000–2,500 half / $4,000–5,000 whole) understated live supply 40–50%
// (halves $3,299–3,650, wholes $6,500–6,800) — buyers hit sticker shock on
// the rancher call. Ranges below cover what ranchers actually charge.
export const SIZE_OPTIONS: FunnelOption[] = [
  { value: 'Quarter', label: 'quarter', detail: '~85 lbs · feeds 1–2 · $1,500–2,000', icon: 'ti-meat' },
  { value: 'Half', label: 'half', detail: '~170 lbs · feeds 3–4 · $3,000–3,700', icon: 'ti-meat' },
  { value: 'Whole', label: 'whole', detail: '~340 lbs · feeds 5+ · $6,000–7,000', icon: 'ti-meat' },
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

// Optional budget chips (2026-07-15). `value` strings are EXACT choice names
// on the Consumers `Budget` singleSelect (Airtable fldWyHP1ZF4uqk59A) — write
// anything else and the API rejects the record. Labels are the buyer-facing
// pretty form; skipping the step writes nothing ("prefer not to say").
export const BUDGET_OPTIONS: FunnelOption[] = [
  { value: '$1500-$2500', label: 'up to $2,500', detail: 'quarter territory', icon: 'ti-coin' },
  { value: '2500-3500', label: '$2,500–3,500', detail: 'about a half', icon: 'ti-coin' },
  { value: '$4000-$5000', label: '$4,000–5,000', detail: 'half to whole', icon: 'ti-coin' },
  { value: '$5000+', label: '$5,000+', detail: 'whole territory', icon: 'ti-coin' },
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
