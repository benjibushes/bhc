'use client';

// BuyerFunnel — the single front door for every beef buyer.
//
// One cohesive, game-like, mobile-first wizard that replaces both the /access
// signup form and the /qualify quiz. Five steps, one question per screen,
// auto-advance on single-select, a goal-gradient progress bar, founder-voice
// copy, the brand saddle accent (#6B4F3F) and Playfair serif headers.
//
// Two entry modes:
//   • fresh  → starts at Size (step 1). Lead is created mid-flow at Contact.
//   • resume → starts at Storage (step 4). consumerId + token come from props
//     (the quiz-drip resume link / an existing WAITING lead). Size/timing/contact
//     are already on the record, so the wizard only collects storage + finalizes.
//
// Data lifecycle (see docs/.../2026-06-18-unified-buyer-funnel-design.md,
// budget + commit steps added 2026-07-15 funnel truth PR):
//   Steps 1–3 (size, timing, budget) → client state only. Budget is OPTIONAL
//                              (one skippable chip row). Tire-kickers leave no
//                              trace.
//   Step 4 (contact submit)  → POST /api/consumers { quizStarted: true, … }
//                              → creates the lead (Approved + WAITING, NO
//                                Qualified At), stamps Intent Score/Budget,
//                                and returns { consumerId, resumeToken }.
//   Step 5 (storage select)  → client state only, advances to commit.
//   Step 6 (commit tap)      → POST /api/qualify { token, consumerId,
//                                answers:{tier,timing,storage,ack},
//                                ackConfirmedAt, eventId }
//                              → finalizes, scores, fires matching, returns the
//                                match (or a waitlist signal). The tap is the
//                                REAL response commitment — ackConfirmedAt is
//                                minted only here, and the server stamps
//                                `Response Ack At` only when it's present.
//   Step 7 (reveal)          → the matched rancher OR Ben's inline call (when
//                              offerOperatorCall) OR an honest waitlist.
//
// Everything textual/structural reads from lib/funnelConfig.ts so future tweaks
// are config edits, not component rewrites. The server (/api/qualify) is the
// authoritative scorer; scoreFunnel here is only for in-flow feel.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FUNNEL_STEPS,
  FUNNEL_COPY,
  FUNNEL_DISPLAY_STEP_COUNT,
  funnelProgressPct,
  SIZE_OPTIONS,
  TIMING_OPTIONS,
  BUDGET_OPTIONS,
  STORAGE_OPTIONS,
  RAISED_OPTIONS,
  FUNNEL_ACCENT,
  type StepKey,
  type FunnelOption,
} from '@/lib/funnelConfig';
import { US_STATES } from '@/lib/states';
import Button from '@/app/components/Button';
import CalInlineBooker from '@/app/qualify/[consumerId]/CalInlineBooker';
import { trackEvent, metaEventId } from '@/lib/analytics';
import {
  QUIZ_START_BEACON_PATH,
  QUIZ_START_SESSION_KEY,
  shouldFireQuizStart,
  buildQuizStartPayload,
} from '@/lib/quizStart';
import { BEN_SALES_CAL_URL } from '@/lib/salesContact';
import { isDepositCapableMatch } from '@/lib/depositOptionality';
import { REFUND_POLICY_SHORT } from '@/lib/refundPolicy';
import { readFunnelAttribution } from '@/lib/adAttribution';
import { smsHref, formatPhonePretty, buyerIntroSmsBody } from '@/lib/phoneHygiene';
import LowTicketRail from './LowTicketRail';
import type { MarketplaceProduct } from '@/lib/marketplaceProducts';

// ── Props ──────────────────────────────────────────────────────────────────
interface BuyerFunnelProps {
  mode: 'fresh' | 'resume';
  consumerId?: string;
  token?: string;
  rancherSlug?: string;
  offerOperatorCall: boolean;
  // Geo-landing passthrough (/access/[state] → /access?state=XX). Seeds the
  // state <select> with the visitor's region. Always overridable by the user.
  initialState?: string;
  // Friendly banner shown at the top (e.g. an expired re-engagement link
  // redirected here with ?error=). Dismissible; never blocks the funnel.
  notice?: string;
  // Low-ticket rail (Phase 8): ≤3 real marketplace products, loaded server-
  // side on /access via pickFunnelProducts. Rendered on the NOT-READY reveal
  // outcomes (waitlist/nurture full, matched/call compact) so every buyer has
  // a priced next step. Deposit-capable reveal never shows it.
  lowTicketPicks?: MarketplaceProduct[];
  // Reconfirm fast lane (2026-08-07 speed-to-lead): a "still looking"
  // email click already re-verified this buyer server-side, so resume mode
  // jumps straight to the commit step — one tap from inbox to routed (and,
  // for deposit-capable matches, the Mode 0 deposit reveal). Stored answers
  // hydrate server-side in /api/qualify; the skip-never-clears semantics in
  // lib/qualifyUpdates make the jumped-over steps safe. Resume mode only.
  startAtCommit?: boolean;
}

// ── Live social-proof stats (GET /api/funnel/stats) ──────────────────────────
interface FunnelStats {
  familiesMatched: number;
  verifiedRanches: number;
  ranchesInState: number;
}

// ── Reveal payload (subset of POST /api/qualify response we actually render) ──
interface QualifyResult {
  qualified: boolean;
  score?: number;
  routingOk?: boolean;
  rancher?: RevealRancher | null;
  // 'tier_v2' | 'legacy'. For tier_v2 matches /api/qualify fires with
  // skipBuyerIntro=true — the rancher does NOT text the buyer; Ben (the
  // operator) runs the sales call and emails a Cal link. Drives the reveal
  // copy so we never promise a rancher text that won't come (see Mode 2).
  pricingModel?: string;
  // Rancher's Stripe Connect Status ('active' | 'onboarding' | …). Deposit CTA
  // renders ONLY when active — a tier_v2 rancher mid Connect onboarding would
  // 409 at checkout/deposit (dead-CTA guard, 2026-07-15).
  connectStatus?: string;
  operatorCalLink?: string;
  buyerName?: string;
  buyerEmail?: string;
  referralId?: string | null;
  message?: string;
}

// Matched-rancher subset — rancherTier drives the reveal's channel promise
// (Operator = BHC closes → "our team will call you today"; everyone else =
// the rancher calls or texts within 24–48 hours).
interface RevealRancher {
  name: string;
  state: string;
  slug?: string;
  rancherTier?: string;
  // TEXT-YOUR-RANCHER-NOW (2026-07-15): /api/qualify sends '' for Operator
  // tier or no phone on record; a non-empty value unlocks the additive
  // "or text them right now" sms: affordance on the matched reveals.
  phone?: string;
}

// ── Nationwide opt-in match payload (POST /api/member/preferences) ──────────
// When the waitlisted buyer clicks "yes — match me with a shipping rancher",
// the preference endpoint re-fires matching in-process; a hit comes back in
// this shape and is merged into the QualifyResult so the reveal re-renders
// as a real match (deposit CTA / rancher card) without leaving the page.
interface NationwideMatch {
  rancher: { id: string; name: string; state: string };
  referralId: string | null;
  pricingModel: string;
  connectStatus?: string;
}

// Step index helpers — derived from the canonical FUNNEL_STEPS order so the
// progress maths and Back logic never drift from the config.
const STEP_INDEX: Record<StepKey, number> = FUNNEL_STEPS.reduce(
  (m, k, i) => ({ ...m, [k]: i }),
  {} as Record<StepKey, number>,
);
// H2 (2026-07-28): display count EXCLUDES `reveal` (it's the destination, not
// a question). Counting it made the final commit tap read "Step 6 of 7 · 83%"
// — telling the buyer another question was coming at the exact commit moment.
// Count + percent math live in lib/funnelConfig next to FUNNEL_STEPS so they
// can never drift from the config (unit-tested in lib/funnelConfig.test.ts).
const TOTAL_DISPLAY_STEPS = FUNNEL_DISPLAY_STEP_COUNT; // 6 — size…commit

// Format an integer with thousands separators ("1,901"). Guards NaN.
function commas(n: number | undefined | null): string {
  const v = typeof n === 'number' && isFinite(n) ? Math.round(n) : 0;
  return v.toLocaleString('en-US');
}

// Client-side email validation — mirrors the /access form's rule (format +
// throwaway-domain block) so the UX is consistent and the API 400 is rarely hit.
function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = [
    'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
    'yopmail.com', 'sharklasers.com', 'grr.la', '10minutemail.com', 'trashmail.com',
  ];
  return !throwaway.includes((email.split('@')[1] || '').toLowerCase());
}

export default function BuyerFunnel({
  mode,
  consumerId: initialConsumerId,
  token: initialToken,
  rancherSlug,
  offerOperatorCall,
  initialState,
  notice,
  lowTicketPicks,
  startAtCommit,
}: BuyerFunnelProps) {
  const [noticeOpen, setNoticeOpen] = useState(!!notice);
  // resume mode jumps straight to Storage — size/timing/contact already exist
  // on the record (props carry consumerId + token).
  const [stepKey, setStepKey] = useState<StepKey>(
    mode === 'resume' ? (startAtCommit ? 'commit' : 'storage') : 'size',
  );

  // Answers (client state until the relevant POST persists them).
  const [tier, setTier] = useState('');
  const [timing, setTiming] = useState('');
  // Optional — '' means the buyer skipped the chip row ("prefer not to say").
  const [budget, setBudget] = useState('');
  const [storage, setStorage] = useState('');
  // Raised preference (2026-08-06, REP lead-quality) — optional one-tap;
  // '' means skipped. Server maps it onto Consumers `Interest Beef` so the
  // nationwide fit gate can match true grass-fed seekers.
  const [raised, setRaised] = useState('');

  // Contact fields. Phone is REQUIRED.
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // Geo-landing seed (/access?state=XX). Normalized server-side to a valid
  // 2-letter code before it reaches here, so it's safe to seed directly. The
  // user can still change it via the <select>; the geo-prefill effect below
  // won't clobber a non-empty value.
  const [state, setState] = useState(initialState || '');
  // OPTIONAL ZIP (2026-07-22). State decides WHO can serve the buyer; ZIP only
  // sharpens WHICH of them is nearest (lib/zipCentroids → real-miles routing).
  // It must never gate the funnel: blank ZIP routes on state exactly as before.
  const [zip, setZip] = useState('');

  // TCPA-compliant SMS consent. UNCHECKED by default and NOT a condition of
  // purchase — completing the funnel never depends on this box. When false,
  // /api/consumers stores `SMS Opt-In` = false and no marketing/transactional
  // SMS is ever sent (sendSMSToConsumer gates on the field).
  const [smsOptIn, setSmsOptIn] = useState(false);

  // Lead identity — seeded from props in resume mode; minted at Contact in fresh.
  const [consumerId, setConsumerId] = useState(initialConsumerId || '');
  const [token, setToken] = useState(initialToken || '');

  // Network + UI state.
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<QualifyResult | null>(null);
  const [stats, setStats] = useState<FunnelStats | null>(null);

  // Selected-card "flash" before auto-advancing (the satisfying ~300ms beat).
  const [flashing, setFlashing] = useState<string | null>(null);

  // Attribution — the legacy string keys plus the rich `bhc_source_v2` snapshot
  // UtmCapture writes site-wide, parsed by the ONE shared reader in
  // lib/adAttribution (the same module the two direct reserve forms use, so a
  // key can never drift between capture surfaces).
  //
  // READ AT SEND TIME, NOT AT MOUNT. UtmCapture is mounted from app/layout.tsx
  // ABOVE {children}; React flushes CHILD effects BEFORE parent effects, so a
  // mount-time read here would depend on the relative order of two JSX lines in
  // the layout — invisible to anyone editing it. By the time the buyer taps an
  // answer or submits, the capture has certainly run. Cheap (three getItem calls
  // and one JSON.parse) and total by contract: blocked or corrupt storage yields
  // the defaults, so this can never gate or delay the funnel.
  function readAttribution() {
    return readFunnelAttribution({ rancherSlug });
  }

  // Guard the auto-advance timer so a fast double-tap can't skip a step.
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); }, []);

  // ── FUNNEL PERSISTENCE (Wave 2 buyer UI, 2026-08-01) ──────────────────────
  // Steps 1–3 used to live only in React state: a refresh lost every answer,
  // and hardware Back EXITED the funnel from step 6 of 6. Two fixes:
  //   1. sessionStorage snapshot per step (same-tab only, cleared on reveal)
  //      — a refresh, or /access?resume=1 re-opened in the same tab, restores
  //      the buyer to the exact step + answers they left.
  //   2. history.pushState per step (below) — hardware/browser Back walks the
  //      steps instead of leaving the page.
  // Snapshot restore is fresh-mode only: resume mode is server-driven (the
  // record already carries size/timing/contact; props carry consumerId+token).
  const FUNNEL_SNAPSHOT_KEY = 'bhc-funnel-state-v1';
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || mode === 'resume') return;
    restoredRef.current = true;
    try {
      const raw = window.sessionStorage.getItem(FUNNEL_SNAPSHOT_KEY);
      if (!raw) return;
      const snap = JSON.parse(raw) as Record<string, unknown>;
      if (!snap || typeof snap !== 'object') return;
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      if (str(snap.tier)) setTier(str(snap.tier));
      if (str(snap.timing)) setTiming(str(snap.timing));
      if (str(snap.budget)) setBudget(str(snap.budget));
      if (str(snap.storage)) setStorage(str(snap.storage));
      if (str(snap.raised)) setRaised(str(snap.raised));
      if (str(snap.firstName)) setFirstName(str(snap.firstName));
      if (str(snap.email)) setEmail(str(snap.email));
      if (str(snap.phone)) setPhone(str(snap.phone));
      if (str(snap.state)) setState(str(snap.state));
      if (str(snap.zip)) setZip(str(snap.zip));
      if (snap.smsOptIn === true) setSmsOptIn(true);
      if (str(snap.consumerId)) setConsumerId(str(snap.consumerId));
      if (str(snap.token)) setToken(str(snap.token));
      const saved = str(snap.stepKey);
      if (saved && saved !== 'reveal' && (FUNNEL_STEPS as string[]).includes(saved)) {
        // Never land past contact without the lead identity the later POSTs
        // need — a snapshot from a half-created session resumes AT contact.
        const idx = STEP_INDEX[saved as StepKey];
        const past = idx > STEP_INDEX.contact && !(str(snap.consumerId) && str(snap.token));
        setStepKey(past ? 'contact' : (saved as StepKey));
      }
    } catch {
      /* corrupt/blocked storage — start fresh, never crash the funnel */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Save the snapshot on every answer/step change; clear it once the buyer
  // reaches the reveal (a finished funnel must not resurrect on next visit).
  useEffect(() => {
    if (!restoredRef.current && mode !== 'resume') return; // don't save before restore ran
    try {
      if (result) {
        window.sessionStorage.removeItem(FUNNEL_SNAPSHOT_KEY);
        return;
      }
      if (mode === 'resume') return; // server-driven — nothing to snapshot
      window.sessionStorage.setItem(
        FUNNEL_SNAPSHOT_KEY,
        JSON.stringify({
          stepKey, tier, timing, budget, storage, raised,
          firstName, email, phone, state, zip, smsOptIn,
          consumerId, token,
        }),
      );
    } catch {
      /* storage blocked (private mode) — the funnel still works, just
         without refresh-proofing */
    }
  }, [mode, stepKey, tier, timing, budget, storage, raised, firstName, email, phone, state, zip, smsOptIn, consumerId, token, result]);

  // ── History integration — Back walks steps, never exits mid-quiz ──────────
  // Mount stamps the current entry; every step CHANGE pushes a new entry
  // carrying its step. popstate (hardware/browser Back or Forward) restores
  // the entry's step. Back from the first step leaves the page — correct.
  const navFromPopstate = useRef(false);
  const prevStepRef = useRef(stepKey);
  // Popstate closes over mount-time state — mirror `result` in a ref so Back
  // from the reveal can't re-open the commit screen (a second tap there would
  // double-POST /api/qualify).
  const resultRef = useRef<QualifyResult | null>(null);
  useEffect(() => { resultRef.current = result; }, [result]);
  useEffect(() => {
    try {
      window.history.replaceState(
        { ...(window.history.state || {}), bhcFunnelStep: stepKey },
        '',
      );
    } catch { /* history API blocked — Back just exits, as before */ }
    const onPop = (e: PopStateEvent) => {
      if (resultRef.current) return; // finished — the reveal stays put
      const s = (e.state as Record<string, unknown> | null)?.bhcFunnelStep;
      if (typeof s === 'string' && s !== 'reveal' && (FUNNEL_STEPS as string[]).includes(s)) {
        navFromPopstate.current = true;
        setError('');
        setStepKey(s as StepKey);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = stepKey;
    if (stepKey === prev) return;
    if (navFromPopstate.current) {
      navFromPopstate.current = false;
      return;
    }
    try {
      window.history.pushState({ bhcFunnelStep: stepKey }, '');
    } catch { /* history API blocked */ }
  }, [stepKey]);

  // ── Meta Pixel: ViewContent on /access lander mount ───────────────────────
  // No server CAPI pair needed (top-of-funnel view, low signal). event_id
  // omitted — no dedup surface to pair against.
  const viewContentFired = useRef(false);
  useEffect(() => {
    if (viewContentFired.current) return;
    viewContentFired.current = true;
    trackEvent('access_view');
  }, []);

  // ── Best-effort geo state prefill (never blocks) ────────────────────────────
  // The state <select> is the floor. If a cheap geo hint is available we
  // pre-select it, but we never wait on it and never block submit on it.
  useEffect(() => {
    if (state) return; // don't clobber a manual pick
    let aborted = false;
    (async () => {
      try {
        const res = await fetch('/api/geo', { cache: 'no-store' });
        if (!res.ok) return;
        const j = await res.json().catch(() => null);
        const code = String(j?.state || j?.region || '').toUpperCase();
        if (!aborted && /^[A-Z]{2}$/.test(code) && US_STATES.some((s) => s.code === code)) {
          setState((prev) => (prev ? prev : code));
        }
      } catch {
        /* no geo endpoint / blocked — the dropdown remains the floor. */
      }
    })();
    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Live stats fetch (re-fetch when state changes, for ranchesInState) ──────
  // Guarded: any failure leaves stats null → the social-proof line simply hides,
  // never crashes.
  useEffect(() => {
    let aborted = false;
    const qs = state ? `?state=${encodeURIComponent(state)}` : '';
    fetch(`/api/funnel/stats${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (aborted || !j) return;
        setStats({
          familiesMatched: Number(j.familiesMatched) || 0,
          verifiedRanches: Number(j.verifiedRanches) || 0,
          ranchesInState: Number(j.ranchesInState) || 0,
        });
      })
      .catch(() => { /* hide the social-proof line, never crash */ });
    return () => { aborted = true; };
  }, [state]);

  // ── Derived progress ───────────────────────────────────────────────────────
  const stepNumber = STEP_INDEX[stepKey] + 1; // 1-based
  const progressPct = funnelProgressPct(STEP_INDEX[stepKey]); // commit = 100%

  const emailValid = useMemo(() => isValidEmail(email.trim()), [email]);
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneValid = phoneDigits.length >= 10;

  // ── Navigation ─────────────────────────────────────────────────────────────
  function goToIndex(i: number) {
    const next = FUNNEL_STEPS[Math.max(0, Math.min(FUNNEL_STEPS.length - 1, i))];
    setStepKey(next);
  }
  function advance() { goToIndex(STEP_INDEX[stepKey] + 1); }
  function back() {
    setError('');
    goToIndex(STEP_INDEX[stepKey] - 1);
  }

  // Back is allowed on every mid-flow step. In resume mode there's nothing
  // before storage to go back to (size/timing/contact live on the record), so
  // Back is hidden there.
  const canGoBack =
    (stepKey === 'timing' || stepKey === 'budget' || stepKey === 'contact' ||
      stepKey === 'storage' || stepKey === 'raised' || stepKey === 'commit') &&
    !(mode === 'resume' && stepKey === 'storage') &&
    // Reconfirm fast lane: commit is the FIRST step — nothing behind it.
    !(mode === 'resume' && startAtCommit && stepKey === 'commit');

  // ── quiz_start funnel event (2026-07-28 conversion audit) ─────────────────
  // Fired ONCE per session at the FIRST quiz ANSWER (not page view — bots and
  // bounces would pollute; the first tap is the intent signal). Writes through
  // the same Funnel Events pipeline as 'signup' so the dashboard can finally
  // see pre-contact abandonment. Fresh mode only — resume buyers already have
  // a 'signup' event and would corrupt the quiz_start→signup rate. Beacon is
  // fire-and-forget: any failure is swallowed, the quiz never waits on it.
  const quizStartFired = useRef(false);
  function fireQuizStartOnce() {
    try {
      if (!shouldFireQuizStart({ mode, alreadyFired: quizStartFired.current })) return;
      quizStartFired.current = true;
      // Session flag survives remounts/navigation within the tab. If storage
      // is blocked (private mode) the ref above still guards this mount —
      // bias to a rare re-count over losing the event entirely.
      try {
        if (window.sessionStorage.getItem(QUIZ_START_SESSION_KEY)) return;
        window.sessionStorage.setItem(QUIZ_START_SESSION_KEY, '1');
      } catch { /* storage blocked — ref guard only */ }
      const attribution = readAttribution();
      const payload = JSON.stringify(
        buildQuizStartPayload({
          state,
          source: attribution.source,
          campaign: attribution.campaign,
          utm_source: attribution.utm_source,
          utm_medium: attribution.utm_medium,
          utm_campaign: attribution.utm_campaign,
          utm_content: attribution.utm_content,
          utm_term: attribution.utm_term,
        }),
      );
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(QUIZ_START_BEACON_PATH, payload);
      } else {
        fetch(QUIZ_START_BEACON_PATH, {
          method: 'POST',
          body: payload,
          keepalive: true,
        }).catch(() => { /* fire-and-forget */ });
      }
    } catch { /* never block or slow the quiz */ }
  }

  // Tap-card select → flash the check → auto-advance. The `from` guard prevents a
  // double-tap (or a late timer) from skipping the next question.
  function selectAndAdvance(setter: (v: string) => void, value: string, from: StepKey) {
    // First answer of a fresh session = quiz_start (size is always the first
    // question in fresh mode; the guard makes later calls no-ops).
    fireQuizStartOnce();
    setter(value);
    setFlashing(value);
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(() => {
      setFlashing(null);
      setStepKey((cur) => (cur === from ? FUNNEL_STEPS[STEP_INDEX[from] + 1] : cur));
    }, 300);
  }

  // ── Step 3: create the lead, then advance to storage ────────────────────────
  async function submitContact() {
    setError('');
    const name = firstName.trim();
    if (name.length < 2) { setError('please enter your first name.'); return; }
    if (!emailValid) { setError('please enter a valid email address.'); return; }
    if (!phone.trim()) { setError('phone is required so your rancher can reach you.'); return; }
    if (!phoneValid) { setError('please enter a valid phone number (at least 10 digits).'); return; }
    if (!state) { setError('please pick your state.'); return; }
    // ZIP is optional — but a HALF-typed one is a typo, not a choice. Catch it
    // here rather than storing "787" and silently never resolving a centroid.
    const zipTrimmed = zip.trim();
    if (zipTrimmed && !/^\d{5}$/.test(zipTrimmed)) {
      setError('please enter a 5-digit ZIP code, or leave it blank.');
      return;
    }

    setSubmitting(true);
    const attribution = readAttribution();
    try {
      const res = await fetch('/api/consumers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quizStarted: true,
          fullName: name,
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          // TCPA explicit opt-in (unchecked by default). The server still
          // requires a non-empty phone to store it true, so a stray true with
          // no number can't enable sends.
          smsOptIn,
          state,
          // Optional 5-digit ZIP — '' when skipped. Server writes it only when
          // it's a real ZIP; routing cross-checks it against `state` before
          // trusting it for distance.
          zip: zipTrimmed,
          tier,
          timing,
          // Optional budget chip — '' when skipped; server whitelists against
          // the Budget singleSelect choice names and skips empty.
          budget,
          // Rancher deep-link pin (preference-fidelity audit 2026-08-12): the
          // slug rode ONLY the client-built campaign string before, so the
          // server's `Preferred Rancher` link could never be written. '' when
          // this is a generic /access entry — the server skips empty.
          rancherSlug: rancherSlug || '',
          source: attribution.source,
          campaign: attribution.campaign,
          utmParams: attribution.utmParams,
          // Rich per-field attribution for ad-level ROAS + offline conversions.
          // Server writes non-empty values into dedicated Airtable columns.
          // All fields are always present (empty string when not captured) so
          // the server can safely destructure without optional-chaining.
          attribution: {
            utm_source: attribution.utm_source,
            utm_medium: attribution.utm_medium,
            utm_campaign: attribution.utm_campaign,
            utm_content: attribution.utm_content,
            utm_term: attribution.utm_term,
            fbclid: attribution.fbclid,
            fbclid_ts: attribution.fbclid_ts,
            gclid: attribution.gclid,
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.consumerId || !j?.resumeToken) {
        setError(j?.error || 'Could not save your details. Please try again.');
        setSubmitting(false);
        return;
      }
      setConsumerId(j.consumerId);
      setToken(j.resumeToken);
      // ── Meta Pixel: Lead (contact captured) ────────────────────────────────
      // event_id = consumerId (raw Airtable record id, no prefix). Server CAPI
      // Lead fires at /api/consumers with the SAME id → Meta deduplicates the
      // two fires. Both use metaEventId(consumerId) which is a passthrough.
      trackEvent('funnel_lead', {
        event_id: metaEventId(j.consumerId),
      });
      setSubmitting(false);
      advance(); // → storage
    } catch {
      setError('Network hiccup — please try again.');
      setSubmitting(false);
    }
  }

  // ── Step 5: storage select → raised (client state only) ─────────────────────
  function selectStorage(storageValue: string) {
    setError('');
    selectAndAdvance(setStorage, storageValue, 'storage');
  }

  // ── Step 6: raised preference → commit (client state only, optional) ────────
  function selectRaised(raisedValue: string) {
    setError('');
    selectAndAdvance(setRaised, raisedValue, 'raised');
  }

  // ── Step 6: the real commitment tap → finalize → reveal ─────────────────────
  // The affirm button IS the submit. ackConfirmedAt is minted here and ONLY
  // here — the server stamps `Response Ack At` only when it's present, so a
  // finalize without the tap can never fabricate a commitment (the old flow
  // hard-coded ack:true for every completer and the rancher email claimed an
  // acknowledgment that never happened).
  async function submitCommit() {
    if (!token || !consumerId) {
      // Shouldn't happen (resume carries them; fresh minted them at contact),
      // but degrade honestly rather than POST a broken finalize.
      setError('Your session expired. Please start again.');
      return;
    }
    setSubmitting(true);
    setError('');
    const attribution = readAttribution();
    try {
      // eventId: client-minted dedup id shared by client Pixel + server CAPI.
      const eventId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `funnel-${consumerId}-${Date.now()}`;
      const res = await fetch('/api/qualify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          consumerId,
          // ack mirrors the tap (this function only runs on the tap); the
          // server-side stamp keys on ackConfirmedAt, not this boolean.
          answers: { tier, timing, storage, raised, ack: true },
          ackConfirmedAt: new Date().toISOString(),
          eventId,
          ...(attribution.campaign.startsWith('rancher-')
            ? { campaign: attribution.campaign }
            : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j?.error || 'Could not finalize. Please try again.');
        setSubmitting(false);
        setFlashing(null);
        return;
      }
      // ── Meta Pixel: CompleteRegistration (quiz complete / qualified) ─────────
      // event_id = same client-minted eventId sent to /api/qualify so server
      // CAPI CompleteRegistration (fired there with clientEventId) and this
      // client Pixel fire share the id and Meta deduplicates them correctly.
      trackEvent('funnel_complete_registration', {
        event_id: eventId,
      });
      setResult(j as QualifyResult);
      setFlashing(null);
      setSubmitting(false);
      setStepKey('reveal');
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* noop */ }
    } catch {
      setError('Network hiccup — please try again.');
      setSubmitting(false);
      setFlashing(null);
    }
  }

  const copy = FUNNEL_COPY[stepKey];

  // ── Render ───────────────────────────────────────────────────────────────--
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      {/* Saddle accent surfaced as a CSS var so every accent in the flow reads
          from one source (FUNNEL_ACCENT) — change it in one place. */}
      <div
        className="mx-auto w-full max-w-md px-5 pb-16 pt-5 sm:max-w-lg sm:pt-8"
        style={{ ['--accent' as string]: FUNNEL_ACCENT }}
      >
        {/* B6 — friendly banner for expired/invalid re-engagement links (?error=).
            Dismissible; never blocks the funnel. */}
        {notice && noticeOpen && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-dust bg-bone-warm px-4 py-3 text-sm text-saddle">
            <span>{notice}</span>
            <button type="button" onClick={() => setNoticeOpen(false)} aria-label="dismiss" className="shrink-0 text-saddle/70 hover:text-charcoal">×</button>
          </div>
        )}
        {/* ── Header: private-network pill + live social proof ──────────────── */}
        <header className="mb-5">
          <div className="flex items-center justify-between gap-3">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: 'var(--accent)' }}
                aria-hidden="true"
              />
              private network
            </span>
            {stats && (stats.familiesMatched > 0 || stats.verifiedRanches > 0) && (
              <span className="max-w-[55%] text-right text-[11px] leading-tight text-saddle">
                {/* Honesty (walkthrough 2026-07-15): familiesMatched is
                    Math.max(1900-floor, closed) — the 1,900 is the WAITLIST,
                    not matched families. "on the list" is the true claim. */}
                {commas(stats.familiesMatched)}+ families on the list · {commas(stats.verifiedRanches)}+ ranches live
              </span>
            )}
          </div>
        </header>

        {/* ── Progress bar + step counter (hidden on the reveal) ───────────── */}
        {stepKey !== 'reveal' && (
          <div className="mb-7">
            <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-widest text-saddle">
              <span>Step {stepNumber} of {TOTAL_DISPLAY_STEPS}</span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-dust/40">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${progressPct}%`, backgroundColor: 'var(--accent)' }}
              />
            </div>
          </div>
        )}

        {/* ── Step heading (hidden on reveal — it has its own hero) ─────────── */}
        {stepKey !== 'reveal' && (
          <div className="mb-6">
            <h1 className="font-serif text-3xl leading-tight text-charcoal sm:text-4xl">
              {copy.title}
            </h1>
            {copy.sub && <p className="mt-2 text-[15px] leading-relaxed text-saddle">{copy.sub}</p>}
          </div>
        )}

        {/* ── STEP 1 — SIZE ────────────────────────────────────────────────── */}
        {stepKey === 'size' && (
          <>
            <CardGrid
              options={SIZE_OPTIONS}
              selected={tier}
              flashing={flashing}
              onSelect={(v) => selectAndAdvance(setTier, v, 'size')}
            />
            {/* Low-ticket escape — the $1k+ size ask is the funnel's biggest
                balk point; a balk becomes a /shop sale instead of a bounce.
                Deliberately a de-emphasized text link (not a fifth card) so it
                never competes with the share choice — the share is the anchor. */}
            <p className="mt-4 text-center text-sm text-saddle">
              not ready for a whole share?{' '}
              <a href="/shop" className="underline hover:text-charcoal transition-colors">
                try a box or jerky first &rarr;
              </a>
            </p>
          </>
        )}

        {/* ── STEP 2 — TIMING ──────────────────────────────────────────────── */}
        {stepKey === 'timing' && (
          <CardGrid
            options={TIMING_OPTIONS}
            selected={timing}
            flashing={flashing}
            onSelect={(v) => selectAndAdvance(setTiming, v, 'timing')}
          />
        )}

        {/* ── STEP 3 — BUDGET (optional, skippable) ────────────────────────── */}
        {stepKey === 'budget' && (
          <div className="space-y-4">
            <CardGrid
              options={BUDGET_OPTIONS}
              selected={budget}
              flashing={flashing}
              onSelect={(v) => selectAndAdvance(setBudget, v, 'budget')}
            />
            {/* Skipping is the implicit "prefer not to say" — no chip for it,
                no penalty, one tap either way. */}
            <p className="text-center text-sm text-saddle">
              <button
                type="button"
                onClick={() => { setBudget(''); advance(); }}
                className="underline hover:text-charcoal transition-colors"
              >
                skip — i&apos;d rather not say
              </button>
            </p>
          </div>
        )}

        {/* ── STEP 4 — CONTACT ─────────────────────────────────────────────── */}
        {stepKey === 'contact' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitContact();
            }}
          >
            {/* Reward line — only when there's a real in-state count (>0). */}
            {stats && stats.ranchesInState > 0 && (
              <div
                className="rounded-md border px-4 py-3 text-sm font-medium"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)',
                  backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                you match {commas(stats.ranchesInState)}{' '}
                {stats.ranchesInState === 1 ? 'ranch' : 'ranches'} near you.
              </div>
            )}

            <div className="space-y-3">
              <Field label="First name">
                <input
                  type="text"
                  autoComplete="given-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="funnel-input"
                  placeholder="Jane"
                />
              </Field>

              <Field label="Email">
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="funnel-input"
                  placeholder="jane@email.com"
                />
              </Field>

              <Field label="Phone" hint="required — so your rancher can reach you">
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="funnel-input"
                  placeholder="555-555-5555"
                />
              </Field>

              <Field label="State">
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className="funnel-input appearance-none"
                >
                  <option value="">Pick your state</option>
                  {US_STATES.map((s) => (
                    <option key={s.code} value={s.code}>{s.name}</option>
                  ))}
                </select>
              </Field>

              {/* OPTIONAL — never gates the submit. Buyers who skip it route on
                  state exactly as they always have; a ZIP just lets matching
                  pick the ranch that's actually closest to them. */}
              <Field label="ZIP code" hint="optional — matches you to the closest ranch">
                {/* NO maxLength — it fights the digit-strip below. The browser
                    caps RAW characters before onChange runs, so a stray letter
                    (or a pasted "78701-1234") would eat real digits and leave a
                    silently truncated ZIP. The handler alone bounds it: strip
                    non-digits, then take 5. */}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  value={zip}
                  onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
                  className="funnel-input"
                  placeholder="78701"
                />
              </Field>
            </div>

            {/* TCPA / 10DLC SMS consent — UNCHECKED by default, never gates the
                submit. Disclosure mirrors /privacy §11 so the consent we claim
                there actually exists at the point of collection. */}
            <label className="flex items-start gap-2.5 text-left">
              <input
                type="checkbox"
                checked={smsOptIn}
                onChange={(e) => setSmsOptIn(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-shrink-0"
                style={{ accentColor: FUNNEL_ACCENT }}
              />
              <span className="text-xs leading-relaxed text-saddle">
                Text me updates about my match. By checking this box I agree to receive
                recurring automated marketing &amp; transactional text messages from
                BuyHalfCow at the number provided. Msg &amp; data rates may apply. Reply
                STOP to cancel, HELP for help. Consent is not a condition of purchase. See
                our{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline">
                  Privacy Policy
                </a>.
              </span>
            </label>

            {/* Trust line at the exact point of peak hesitation. */}
            <p className="text-center text-xs text-saddle">
              Private &amp; approval-only · no spam · never resold
            </p>

            {/* Real testimonial, placed at the ask. */}
            <blockquote className="border-l-2 pl-4 text-sm italic text-charcoal" style={{ borderColor: 'var(--accent)' }}>
              &ldquo;Took two minutes, had my rancher on the phone that afternoon.&rdquo;
              <footer className="mt-1 text-xs not-italic text-saddle">— Sarah M., Colorado</footer>
            </blockquote>

            {error && <ErrorBox>{error}</ErrorBox>}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              loading={submitting}
              disabled={submitting}
            >
              {submitting ? 'finding your match…' : 'show me my match'}
            </Button>
          </form>
        )}

        {/* ── STEP 5 — STORAGE ─────────────────────────────────────────────── */}
        {stepKey === 'storage' && (
          <div className="space-y-4">
            <CardGrid
              options={STORAGE_OPTIONS}
              selected={storage}
              flashing={flashing}
              onSelect={(v) => selectStorage(v)}
            />
            {/* Freezer objection → help, not a dead end. Always-visible helper
                (selecting an option auto-advances, so there's no moment to show
                per-option copy): "need freezer space" is the biggest high-ticket
                objection — answer it with the rancher-holds option that's
                already on this screen + the chest freezer on /gear. */}
            <p className="text-center text-sm text-saddle">
              no freezer? your rancher can hold it in batches — or grab the chest freezer ben uses on{' '}
              <a href="/gear" className="underline hover:text-charcoal transition-colors">
                the gear page &rarr;
              </a>
            </p>
            {error && <ErrorBox>{error}</ErrorBox>}
          </div>
        )}

        {/* ── STEP 6 — RAISED (optional preference; REP lead-quality 2026-08-06).
            One tap, auto-advances like every other question. "no strong
            preference" IS the skip — no separate skip link to maintain. The
            answer maps to Consumers `Interest Beef` server-side so grass-fed
            ranchers get matched to buyers who actually asked for grass-fed. */}
        {stepKey === 'raised' && (
          <div className="space-y-4">
            <CardGrid
              options={RAISED_OPTIONS}
              selected={raised}
              flashing={flashing}
              onSelect={(v) => selectRaised(v)}
            />
            {error && <ErrorBox>{error}</ErrorBox>}
          </div>
        )}

        {/* ── STEP 7 — COMMIT (the real response ack — it IS the submit) ────── */}
        {stepKey === 'commit' && (
          <div className="space-y-5">
            <div className="rounded-lg border border-dust bg-white p-5 text-left">
              {/* Honest tense: with zero operational ranchers in-state the next
                  screen is the waitlist — asking the buyer to commit to a call
                  that provably isn't coming this week is the exact fabrication
                  this step replaced. "when we match you" is true in both
                  worlds; the confident 24–48h promise is reserved for states
                  where a rancher actually exists. */}
              <p className="text-base leading-relaxed text-charcoal">
                {stats && stats.ranchesInState === 0 ? (
                  <>
                    when we match you, your rancher will call or text from a{' '}
                    <strong>
                      {US_STATES.find((s) => s.code === state)?.name || 'local'}
                    </strong>{' '}
                    number — will you pick up?
                  </>
                ) : (
                  <>
                    your rancher will call or text within 24&ndash;48 hours from a{' '}
                    <strong>
                      {US_STATES.find((s) => s.code === state)?.name || 'local'}
                    </strong>{' '}
                    number — will you pick up?
                  </>
                )}
              </p>
              <p className="mt-2 text-sm text-saddle">
                that one call is where your cuts, price, and processing date get set.
              </p>
            </div>
            <Button
              type="button"
              variant="primary"
              size="lg"
              fullWidth
              onClick={submitCommit}
              loading={submitting}
              disabled={submitting}
            >
              {submitting ? 'locking in your match…' : "i'll answer or text back"}
            </Button>
            {error && <ErrorBox>{error}</ErrorBox>}
          </div>
        )}

        {/* ── STEP 7 — REVEAL ──────────────────────────────────────────────── */}
        {stepKey === 'reveal' && (
          <Reveal
            result={result}
            offerOperatorCall={offerOperatorCall}
            state={state}
            stats={stats}
            cut={tier}
            lowTicketPicks={lowTicketPicks}
            // Nationwide opt-in hit — merge the fresh match into the reveal
            // payload so the same Reveal flips from waitlist (Mode 3) to a
            // real match (deposit CTA when tier_v2 + referral, Mode 0/2).
            onNationwideMatch={(m) =>
              setResult((prev) =>
                prev
                  ? {
                      ...prev,
                      routingOk: true,
                      rancher: { name: m.rancher.name, state: m.rancher.state },
                      referralId: m.referralId,
                      pricingModel: m.pricingModel,
                      connectStatus: m.connectStatus,
                    }
                  : prev,
              )
            }
          />
        )}

        {/* ── Back nav (steps 2–6, not in resume-storage, not on reveal) ───── */}
        {canGoBack && (
          <div className="mt-7">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={back}
              disabled={submitting}
            >
              ← back
            </Button>
          </div>
        )}
      </div>

      {/* Scoped input styling — keeps the JSX readable and the tokens on-brand.
          Big tap targets (min-height 52px) for mobile. */}
      <style>{`
        .funnel-input {
          width: 100%;
          border: 1px solid color-mix(in srgb, var(--color-charcoal) 22%, transparent);
          background: #ffffff;
          color: var(--color-charcoal);
          padding: 0.85rem 1rem;
          min-height: 52px;
          border-radius: 0.5rem;
          font-size: 16px; /* ≥16px stops iOS zoom-on-focus */
          line-height: 1.4;
          outline: none;
          transition: border-color 150ms ease;
        }
        .funnel-input:focus {
          border-color: ${FUNNEL_ACCENT};
          box-shadow: 0 0 0 3px color-mix(in srgb, ${FUNNEL_ACCENT} 18%, transparent);
        }
      `}</style>
    </main>
  );
}

// ── Tap-card grid (Size / Timing / Storage) ──────────────────────────────────
function CardGrid({
  options,
  selected,
  flashing,
  disabled,
  onSelect,
}: {
  options: FunnelOption[];
  selected: string;
  flashing: string | null;
  disabled?: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="grid gap-3">
      {options.map((opt) => {
        const isSelected = selected === opt.value;
        const isFlashing = flashing === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(opt.value)}
            aria-pressed={isSelected}
            className={[
              'group relative w-full rounded-lg border p-4 text-left transition-all duration-200',
              'min-h-[64px] active:scale-[0.99] disabled:cursor-not-allowed',
              isSelected
                ? 'text-bone shadow-sm'
                : 'border-dust bg-white text-charcoal hover:border-[color:var(--accent)] hover:shadow-sm',
            ].join(' ')}
            style={
              isSelected
                ? { backgroundColor: 'var(--accent)', borderColor: 'var(--accent)' }
                : undefined
            }
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-base font-semibold leading-snug">{opt.label}</div>
                <div className={`mt-0.5 text-[13px] leading-snug ${isSelected ? 'text-bone/85' : 'text-saddle'}`}>
                  {opt.detail}
                </div>
              </div>
              {/* Selected check — the satisfying confirmation beat. */}
              <span
                className={[
                  'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-sm font-bold transition-all',
                  isSelected ? 'border-bone bg-bone/20 text-bone' : 'border-dust text-transparent',
                  isFlashing ? 'scale-110' : '',
                ].join(' ')}
                aria-hidden="true"
              >
                {isSelected ? '✓' : ''}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Labeled field wrapper ────────────────────────────────────────────────────
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-charcoal">
        {label}
        {hint && <span className="ml-1 text-saddle">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

// ── Inline error box ─────────────────────────────────────────────────────────
function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-weathered bg-transparent px-4 py-3 text-sm text-weathered">
      {children}
    </div>
  );
}

// ── Reveal step ───────────────────────────────────────────────────────────────
// Honest outcomes. ONE channel truth (2026-07-15 funnel truth PR): the RANCHER
// calls or texts within 24–48 hours — matching the commit-step promise the
// buyer just acked — EXCEPT when the matched rancher's Tier is 'Operator'
// (BHC closes those) → "our team will call you today".
//   1. offerOperatorCall ON  → "Book your 15-min call with Ben" (CalInlineBooker).
//   2. matched rancher       → named rancher + the channel truth above.
//   3. no in-state match     → honest waitlist ("you're first in line"), NOT a
//      fake match.
function Reveal({
  result,
  offerOperatorCall,
  state,
  stats,
  cut,
  onNationwideMatch,
  lowTicketPicks,
}: {
  result: QualifyResult | null;
  offerOperatorCall: boolean;
  state: string;
  stats: FunnelStats | null;
  cut: string;
  lowTicketPicks?: MarketplaceProduct[];
  // Fires when the waitlisted buyer opted into nationwide and matching found
  // a shipping rancher on the spot — parent merges it into `result` so this
  // reveal re-renders in matched mode.
  onNationwideMatch?: (m: NationwideMatch) => void;
}) {
  const matched = !!(result?.routingOk && result?.rancher && result.rancher.name);
  const rancher = result?.rancher;
  // Operator-tier match → BHC runs the close, so "our team will call you
  // today" is the truth. Every other tier: the RANCHER calls or texts within
  // 24–48 hours — the same promise the buyer just acknowledged on the commit
  // step. (The old copy said "ben reaches out today" for every tier_v2 match,
  // which contradicted both the funnel's own contact step and the rancher
  // intro email's "reach out within 24 hours".)
  const operatorMatch =
    matched && (rancher?.rancherTier || '').trim().toLowerCase() === 'operator';
  // DEPOSIT OPTIONALITY (2026-06-30): a tier_v2 (Stripe-Connect-active) rancher
  // with a minted referralId is deposit-capable — the buyer can one-tap deposit
  // straight to Stripe at /checkout/<refId>/deposit. For these, deposit is the
  // dominant primary CTA and the call is demoted to a quiet secondary, EVEN when
  // offerOperatorCall is on. Call-only is reserved strictly for ranchers that
  // genuinely can't take a deposit (legacy / Operator-without-Connect, i.e. not
  // depositCapable). This is the fix for the cash leak where a ready buyer
  // matched to a Connect rancher was routed to "book a call" with no deposit.
  const depositCapable =
    matched &&
    isDepositCapableMatch(result?.pricingModel, result?.referralId, result?.connectStatus);
  // Live "family #N" line — familiesMatched + 1 (rounded, comma-formatted). Hides
  // if stats failed.
  const familyNumber = stats && stats.familiesMatched > 0 ? commas(stats.familiesMatched + 1) : null;
  // TEXT-YOUR-RANCHER-NOW (close-the-loop 2026-07-15): additive "or text them
  // right now" affordance on the matched reveals — lets the ready buyer open
  // the channel instead of waiting out the 24–48h promise (the 24–48h copy
  // stays; this is an extra door, not a new promise). Renders ONLY when the
  // matched rancher has a normalizable phone AND isn't Operator tier
  // (/api/qualify blanks Operator phones server-side; smsHref returning null
  // on a junk phone is the belt — never a broken sms: link).
  const rancherFirstName = (rancher?.name || '').trim().split(/\s+/)[0] || '';
  const buyerFirstName = (result?.buyerName || '').trim().split(/\s+/)[0] || '';
  const textNowHref =
    matched && !operatorMatch && rancher?.phone
      ? smsHref(rancher.phone, buyerIntroSmsBody(rancherFirstName, buyerFirstName, cut))
      : null;
  const textNowPretty = textNowHref && rancher?.phone ? formatPhonePretty(rancher.phone) : '';

  return (
    <section className="space-y-6 text-center">
      {/* Success crest — a serif checkmark badge, on-brand (no emoji). */}
      <div className="flex justify-center">
        <span
          className="flex h-16 w-16 items-center justify-center rounded-full text-3xl text-bone"
          style={{ backgroundColor: FUNNEL_ACCENT }}
          aria-hidden="true"
        >
          ✓
        </span>
      </div>

      <header className="space-y-2">
        <h1 className="font-serif text-4xl leading-tight text-charcoal">you&apos;re in.</h1>
        {familyNumber && (
          <p className="text-sm text-saddle">
            you&apos;re family <strong className="text-charcoal">#{familyNumber}</strong>.
          </p>
        )}
      </header>

      {/* ── Mode 0: DEPOSIT-CAPABLE match (tier_v2 + Connect) ─────────────────
          deposit is the ONLY thing that looks like a button — full-width,
          thumb-zone, ≥48px — straight to Stripe via /checkout/<refId>/deposit.
          honest scarcity above, refund + stripe trust line below, and the call
          demoted to a quiet recessive text link. wins over offerOperatorCall so
          a ready buyer can always deposit now (never call-only). */}
      {depositCapable && rancher ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-dust bg-white p-6 text-left">
            <p className="text-xs uppercase tracking-widest text-saddle">your matched rancher</p>
            <h2 className="mt-1 font-serif text-3xl text-charcoal">{rancher.name}</h2>
            {rancher.state && <p className="mt-0.5 text-sm text-saddle">{rancher.state}</p>}
            <div
              className="mt-4 rounded-md px-4 py-3 text-sm font-medium text-bone"
              style={{ backgroundColor: FUNNEL_ACCENT }}
            >
              your share is ready to reserve.
            </div>
          </div>
          <div className="space-y-2">
            <Button
              // Carry the cut the buyer already picked in step 1 so the deposit
              // page pre-selects it (no re-pick that contradicts the quiz). The
              // deposit page maps ?cut=<slug> against its priced cuts.
              href={`/checkout/${result!.referralId}/deposit${['Quarter', 'Half', 'Whole'].includes(cut) ? `?cut=${cut.toLowerCase()}` : ''}`}
              variant="primary"
              size="lg"
              fullWidth
            >
              reserve your share — secure deposit →
            </Button>
            {/* trust line at the point of peak deposit anxiety */}
            <p className="text-[11px] text-saddle text-center">
              {REFUND_POLICY_SHORT} · payment secured by stripe
            </p>
          </div>
          {/* recessive, separated secondary — the lower-commitment fallback,
              never a peer button. extra top spacing prevents fat-finger mis-taps. */}
          <p className="pt-2 text-center text-sm text-saddle">
            not ready?{' '}
            <a href={BEN_SALES_CAL_URL} className="underline">
              or book a 15-min call with ben first
            </a>
          </p>
          {/* third path: no action required — the rancher already has the lead and
              will reach out. fills the funnel leak where a buyer who wants neither
              self-serve deposit nor a call thought it dead-ended. */}
          {/* Single channel truth here too: Operator tier = BHC's team calls
              today (same special-case as Mode 2 below) — a deposit-capable
              Operator match must not promise a rancher call that BHC makes. */}
          <p className="text-center text-xs text-saddle">
            {operatorMatch
              ? <>no rush either way — our team has your details and will call you today to lock in your share with {rancher.name}.</>
              : <>no rush either way — {rancher.name} has your details and will call or text within 24&ndash;48 hours.</>}
          </p>
          {/* additive text-now door (never a peer button — the deposit stays
              the single primary). pre-filled sms so the buyer sends in one tap. */}
          {textNowHref && (
            <p className="text-center text-xs text-saddle">
              or open the line yourself —{' '}
              <a href={textNowHref} className="underline">
                text {rancherFirstName || rancher.name} now
              </a>{' '}
              at {textNowPretty}.
            </p>
          )}
        </div>
      ) : offerOperatorCall && result?.qualified ? (
        /* ── Mode 1: operator sales call (non-deposit-capable only) ──────────────
           Gated on result.qualified (2026-07-02 funnel audit F1): a buyer who
           COMPLETES the quiz but scores below the routing gate gets
           qualified:false with NO operatorCalLink from /api/qualify. Without
           the qualified check, this branch rendered a confident "book your
           call with ben … and get you matched" screen whose booker then
           collapsed to "booking temporarily unavailable" (a copy-lie
           dead-end that also offered the sales path to an explicitly-
           unqualified buyer, against qualify-before-route). Unqualified now
           falls through to the honest waitlist/nurture reveal below. */
        <div className="space-y-4 text-left">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-widest text-saddle">next step · about 15 minutes</p>
            <h2 className="font-serif text-2xl text-charcoal">book your 15-min call with ben</h2>
            <p className="text-sm leading-relaxed text-saddle">
              {matched && rancher
                ? <>ben will confirm your cut, lock your processing date, and walk you through {rancher.name}. no payment now.</>
                : <>ben will confirm your cut, talk you through your options, and get you matched. no payment now.</>}
            </p>
          </div>
          <CalInlineBooker
            operatorCalLink={result?.operatorCalLink}
            name={result?.buyerName}
            email={result?.buyerEmail}
            referralId={result?.referralId}
          />
          {/* Compact low-ticket line (Phase 8) — the call is the primary path;
              this quietly catches the buyer who books nothing today. */}
          <LowTicketRail picks={lowTicketPicks || []} variant="compact" />
        </div>
      ) : matched && rancher ? (
        /* ── Mode 2: matched rancher reveal (non-deposit-capable) ────────────── */
        <div className="space-y-4">
          <div className="rounded-lg border border-dust bg-white p-6 text-left">
            <p className="text-xs uppercase tracking-widest text-saddle">your matched rancher</p>
            <h2 className="mt-1 font-serif text-3xl text-charcoal">{rancher.name}</h2>
            {rancher.state && <p className="mt-0.5 text-sm text-saddle">{rancher.state}</p>}
            <div
              className="mt-4 rounded-md px-4 py-3 text-sm font-medium text-bone"
              style={{ backgroundColor: FUNNEL_ACCENT }}
            >
              {/* deposit-capable is handled above; here the single channel
                  truth applies — Operator tier = BHC closes (team calls
                  today); every other rancher calls or texts within 24-48h. */}
              {operatorMatch
                ? <>our team will call you today.</>
                : <>they&apos;ll call or text within 24&ndash;48 hours.</>}
            </div>
          </div>
          <p className="text-xs text-saddle">
            {operatorMatch
              ? <>keep your phone handy — our team calls to lock in your share with {rancher.name}. no payment now.</>
              : <>keep an eye on your phone — {rancher.name} calls or texts you direct, no middleman.</>}
          </p>
          {/* additive text-now door — the 24–48h promise above stays; this
              just lets the ready buyer make first contact in one tap. */}
          {textNowHref && (
            <p className="text-xs text-saddle">
              don&apos;t feel like waiting?{' '}
              <a href={textNowHref} className="underline">
                text {rancherFirstName || rancher.name} right now
              </a>{' '}
              at {textNowPretty} — we pre-filled the message.
            </p>
          )}
          {/* Compact low-ticket line (Phase 8) — share intro is in motion;
              never compete with it, just leave a taste-today door open. */}
          <LowTicketRail picks={lowTicketPicks || []} variant="compact" />
        </div>
      ) : (
        /* ── Mode 3: honest waitlist (no in-state rancher / no match) ────────── */
        <div className="space-y-4">
          <div className="rounded-lg border border-dust bg-white p-6 text-left">
            <p className="text-xs uppercase tracking-widest text-saddle">you&apos;re first in line</p>
            <h2 className="mt-1 font-serif text-2xl text-charcoal">
              we&apos;re bringing ranches to {state || 'your state'}.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-saddle">
              you&apos;re a qualified buyer the moment a rancher opens up near you — and you&apos;ll
              be the first we reach out to. we&apos;re working on it.
            </p>
            {/* Nationwide opt-in choice (2026-07-01 founder directive) — the
                no-local-match moment is the highest-signal place to ask.
                Qualified buyers only: the quiz pass minted their member
                session cookie (the preference endpoint is member-authed),
                and unqualified buyers aren't in the matching pool anyway. */}
            {result?.qualified && (
              <NationwideChoice state={state} onMatched={onNationwideMatch} />
            )}
            {/* U19: the waitlist used to dead-end here. Give the qualified buyer
                a forward path — many ranchers ship nationwide, so let them
                browse + reach one now instead of only waiting. */}
            <div className="mt-5 flex flex-col sm:flex-row gap-3">
              <a
                href="/map"
                className="flex-1 text-center bg-charcoal text-bone px-5 py-3 min-h-[48px] flex items-center justify-center uppercase tracking-wider text-sm transition hover:bg-saddle"
              >
                Browse ranchers on the map &rarr;
              </a>
              {/* Audit fix D-2: this promised "who ships nationwide" but linked
                  to the unfiltered /ranchers directory (zero shipping info) —
                  a broken promise to the highest-intent stranded buyer. /shop
                  IS the ships-to-you surface; the button now tells the truth. */}
              <a
                href="/shop"
                className="flex-1 text-center border border-charcoal text-charcoal px-5 py-3 min-h-[48px] flex items-center justify-center uppercase tracking-wider text-sm transition hover:bg-charcoal hover:text-bone"
              >
                Get beef shipped now &rarr;
              </a>
            </div>
          </div>

          {/* MERCHANDISED low-ticket section (Phase 8) — the waitlist/nurture
              buyer has NOTHING else to buy today, so this is a real, sectioned
              offer with photos + one-tap checkout, not a text-link whisper.
              This reveal is also where "still deciding" + below-gate buyers
              land — their entire monetizable next step lives here. */}
          {/* Title makes no per-state claim (audit D-3): "we ship to {state}"
              rested on blank-counts-as-shippable checkboxes + AK/HI edge. */}
          <LowTicketRail
            picks={lowTicketPicks || []}
            variant="full"
            eyebrow="while you wait — shipped this week"
            title="taste it before the share — shipped to your door"
          />
        </div>
      )}
    </section>
  );
}

// ── Nationwide opt-in choice (waitlist reveal, 2026-07-01) ───────────────────
// "Want your beef sooner?" — writes the buyer's matching preference via the
// member-authed POST /api/member/preferences (the quiz pass minted the
// bhc-member-auth cookie, so no token plumbing needed):
//   yes → 'nationwide-ok' + refireMatching: an immediate in-process matching
//         re-run. A hit bubbles up via onMatched (reveal flips to matched
//         mode); a miss shows "you're in the nationwide pool" and the
//         existing waitlist-retry cron takes it from there.
//   no  → 'local-only' — the buyer keeps their first-in-line waitlist spot
//         and the nationwide fallback will never route them.
function NationwideChoice({
  state,
  onMatched,
}: {
  state: string;
  onMatched?: (m: NationwideMatch) => void;
}) {
  const [phase, setPhase] = useState<'ask' | 'saving' | 'pool' | 'local' | 'error'>('ask');
  // Which button the buyer pressed — keeps the untouched button enabled-looking
  // logic simple and lets error retry re-offer both.
  const [picked, setPicked] = useState<'yes' | 'no' | null>(null);

  async function choose(nationwide: boolean) {
    setPicked(nationwide ? 'yes' : 'no');
    setPhase('saving');
    try {
      const res = await fetch('/api/member/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nationwide, ...(nationwide ? { refireMatching: true } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase('error');
        return;
      }
      if (nationwide && j?.match?.rancher?.name && onMatched) {
        // Matched on the spot — parent re-renders the reveal in matched mode.
        onMatched(j.match as NationwideMatch);
        return;
      }
      setPhase(nationwide ? 'pool' : 'local');
    } catch {
      setPhase('error');
    }
  }

  if (phase === 'pool') {
    return (
      <div
        className="mt-5 rounded-md px-4 py-3 text-left text-sm font-medium text-bone"
        style={{ backgroundColor: FUNNEL_ACCENT }}
      >
        you&apos;re in the nationwide pool — we&apos;ll match you with a shipping rancher shortly.
      </div>
    );
  }
  if (phase === 'local') {
    return (
      <div className="mt-5 rounded-md border border-dust bg-bone px-4 py-3 text-left text-sm text-saddle">
        got it — we&apos;ll hold your spot for a rancher in {state || 'your state'}.
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-dust pt-5 text-left">
      <p className="text-sm font-medium text-charcoal">
        want your beef sooner? some of our ranchers ship nationwide.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <Button
          type="button"
          variant="primary"
          size="md"
          fullWidth
          onClick={() => choose(true)}
          disabled={phase === 'saving'}
          loading={phase === 'saving' && picked === 'yes'}
        >
          yes — match me with a shipping rancher
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => choose(false)}
          disabled={phase === 'saving'}
          loading={phase === 'saving' && picked === 'no'}
        >
          no thanks — i&apos;ll wait for local
        </Button>
      </div>
      {phase === 'error' && (
        <p className="mt-2 text-xs text-weathered">
          couldn&apos;t save that — please try again.
        </p>
      )}
    </div>
  );
}
