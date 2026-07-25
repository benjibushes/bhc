// lib/onboardingFlow.ts
//
// THE ROAD (2026-07-24 onboarding rebuild). One ordered flow for every
// rancher, nothing → live:
//
//   0 intro → 1 contact → 2 brand → 3 what-you-sell → 8 fulfillment
//     → 9 connect bank → 5 sign (& go live) → 6 done
//
// Step NUMBERS are historical Airtable-of-the-codebase — they are persisted in
// localStorage for resume, so they can never be renumbered (a renumber strands
// every mid-flight rancher; it happened before). Only the ORDER lives here.
//
// What left the road (deliberately, per the certified business model):
//   • step 4 (call) — OPTIONAL side path off the intro; rejoins at contact.
//   • step 7 (pick a plan) — new ranchers get the free plan automatically
//     (see shouldAutoSelectFreeTier); paid tiers are a dashboard upsell and
//     the step stays reachable only via ?tier= upgrade deep links.
//
// This module is the single source of truth for the order — the wizard's
// transitions, progress bar, and resume logic all read it from here. Pure,
// no imports, fully unit-tested.

/** Wizard step ids that are ON the road, in walk order. */
export const STEP_FLOW = [0, 1, 2, 3, 8, 9, 5, 6] as const;

export type FlowStep = (typeof STEP_FLOW)[number];
export type WizardStep = FlowStep | 4 | 7;

/** Where the off-road steps rejoin, going forward. Mirrors today's behavior. */
const OFF_FLOW_NEXT: Record<number, number> = {
  4: 1, // call → contact
  7: 9, // plan (paid-upgrade deep link) → connect bank
};

/** Next step on the road. Terminal step returns itself. */
export function nextStep(step: number): number {
  if (step in OFF_FLOW_NEXT) return OFF_FLOW_NEXT[step];
  const i = STEP_FLOW.indexOf(step as FlowStep);
  if (i === -1) return STEP_FLOW[0];
  return STEP_FLOW[Math.min(i + 1, STEP_FLOW.length - 1)];
}

/**
 * Previous step on the road. First step returns itself.
 *
 * EXCEPTION — back from sign (5) goes to fulfillment (8), NOT connect (9):
 * StripeConnectStep auto-advances any non-tier_v2 rancher forward on mount,
 * so sending a legacy rancher back to 9 ping-pongs them straight to where
 * they came from. Skipping 9 backward is safe for both models (a tier_v2
 * rancher who needs to redo Connect gets there by walking forward).
 */
export function prevStep(step: number): number {
  if (step === 5) return 8;
  if (step in OFF_FLOW_NEXT) return STEP_FLOW[0];
  const i = STEP_FLOW.indexOf(step as FlowStep);
  if (i === -1) return STEP_FLOW[0];
  return STEP_FLOW[Math.max(i - 1, 0)];
}

/**
 * Where a localStorage-saved step resumes.
 *
 *   • On-road steps resume IN PLACE — including 9 (see below).
 *   • 4 (call) still exists — resume there.
 *   • 7 (removed plan step) → 3: they were choosing how to sell; pricing is
 *     the road-position that replaces it, and the free plan auto-selects on
 *     the way out of 3.
 *   • Anything else (corrupt/foreign value) → start of the road.
 *
 * STEP 9 — the fix that matters (2026-07-24).
 * This function's job is migrating PRE-#464 localStorage values, and its 9→8
 * case has now outlived the flow it was written for. The OLD order ran
 * …3 → 7 → 9 → 8 → 5, so back then a saved 9 meant "reached Connect, hasn't
 * done fulfillment" and bouncing them to 8 was right. Under the CURRENT road
 * (…3 → 8 → 9 → 5) a saved 9 means they already FINISHED fulfillment — so the
 * blanket remap sent every returning rancher BACKWARD from Stripe Connect, the
 * single likeliest abandonment point in the whole flow. Coming back to find
 * yourself demoted a step is how a warm rancher quits.
 *
 * So 9 resumes at 9. The legacy protection survives as a NARROW, positive
 * signal: pass `fulfillmentDone: false` and we know this is an old-flow
 * rancher who genuinely never did step 8, and only then do we route them
 * through 8 first (idempotent + pre-filled; its continue walks forward to
 * Connect, or past it when Connect is already active). Step 8 hard-requires at
 * least one fulfillment type to continue, so a rancher who walked the current
 * road can NEVER be at 9 with fulfillment unset — the hint can't misfire on
 * them. Absent the hint, resume in place.
 */
export function remapSavedStep(saved: number, opts?: { fulfillmentDone?: boolean }): number {
  if (saved === 9) return opts?.fulfillmentDone === false ? 8 : 9;
  if (STEP_FLOW.includes(saved as FlowStep)) return saved;
  if (saved === 4) return 4;
  if (saved === 7) return 3;
  return STEP_FLOW[0];
}

/** Display position for the progress bar. Off-road steps borrow a stage. */
export function flowIndexOf(step: number): number {
  const i = STEP_FLOW.indexOf(step as FlowStep);
  if (i !== -1) return i;
  if (step === 4) return 0; // the call is part of the intro stage
  if (step === 7) return 4; // plan deep-link sits at the bank-stage boundary
  return 0;
}

/** Airtable singleSelects read back as a string OR a {name} object. */
function enumStr(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * Should the wizard silently select the FREE plan for this rancher on the way
 * out of the pricing step?
 *
 * The free-plan select (POST /api/rancher/tier/select) flips 'Pricing Model'
 * to 'tier_v2' server-side — which yanks a rancher out of the legacy routing
 * pool until Stripe Connect is active. For a rancher who is still SETTING UP
 * that's exactly right (Connect is the road). For a rancher who is already
 * LIVE on the legacy rail it's silent supply loss — a live legacy rancher who
 * merely OPENS their 60-day setup link must never be converted. That exact
 * bug shipped once; this predicate is the guard, and it fails CLOSED on
 * anything that looks live, signed, or already converted.
 */
export function shouldAutoSelectFreeTier(rancher: Record<string, unknown> | null | undefined): boolean {
  if (!rancher) return false;
  if (String(rancher['Pricing Model'] || '').toLowerCase() === 'tier_v2') return false;
  // BOTH field shapes, because the wizard's GET /api/rancher/setup response
  // carries live/signed state ONLY as camelCase (agreementSigned, pageLive,
  // onboardingStatus) and has no 'Active Status' at all — a raw-only check
  // would wave live ranchers through on the surface where this guard runs.
  if (enumStr(rancher['Active Status']) === 'Active') return false;
  if (rancher['Page Live'] || rancher['pageLive']) return false;
  if (rancher['Agreement Signed'] || rancher['agreementSigned']) return false;
  if (enumStr(rancher['Onboarding Status'] ?? rancher['onboardingStatus']) === 'Live') return false;
  return true;
}
