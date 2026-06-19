'use client';

// BuyerFunnel — the single front door for every beef buyer.
//
// One cohesive, game-like, mobile-first wizard that replaces both the /access
// signup form and the /qualify quiz. Five steps, one question per screen,
// auto-advance on single-select, a goal-gradient progress bar, founder-voice
// copy, the saddle accent (#92632F) and Playfair serif headers.
//
// Two entry modes:
//   • fresh  → starts at Size (step 1). Lead is created mid-flow at Contact.
//   • resume → starts at Storage (step 4). consumerId + token come from props
//     (the quiz-drip resume link / an existing WAITING lead). Size/timing/contact
//     are already on the record, so the wizard only collects storage + finalizes.
//
// Data lifecycle (see docs/.../2026-06-18-unified-buyer-funnel-design.md):
//   Steps 1–2 (size, timing) → client state only. Tire-kickers leave no trace.
//   Step 3 (contact submit)  → POST /api/consumers { quizStarted: true, … }
//                              → creates the lead (Approved + WAITING, NO
//                                Qualified At) and returns { consumerId,
//                                resumeToken }.
//   Step 4 (storage select)  → POST /api/qualify { token, consumerId,
//                                answers:{tier,timing,storage}, eventId }
//                              → finalizes, scores, fires matching, returns the
//                                match (or a waitlist signal).
//   Step 5 (reveal)          → the matched rancher OR Ben's inline call (when
//                              offerOperatorCall) OR an honest waitlist.
//
// Everything textual/structural reads from lib/funnelConfig.ts so future tweaks
// are config edits, not component rewrites. The server (/api/qualify) is the
// authoritative scorer; scoreFunnel here is only for in-flow feel.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FUNNEL_STEPS,
  FUNNEL_COPY,
  SIZE_OPTIONS,
  TIMING_OPTIONS,
  STORAGE_OPTIONS,
  FUNNEL_ACCENT,
  type StepKey,
  type FunnelOption,
} from '@/lib/funnelConfig';
import { US_STATES } from '@/lib/states';
import CalInlineBooker from '@/app/qualify/[consumerId]/CalInlineBooker';

// ── Props ──────────────────────────────────────────────────────────────────
interface BuyerFunnelProps {
  mode: 'fresh' | 'resume';
  consumerId?: string;
  token?: string;
  rancherSlug?: string;
  offerOperatorCall: boolean;
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
  rancher?: {
    name: string;
    state: string;
    slug?: string;
  } | null;
  operatorCalLink?: string;
  buyerName?: string;
  buyerEmail?: string;
  referralId?: string | null;
  message?: string;
}

// Step index helpers — derived from the canonical FUNNEL_STEPS order so the
// progress maths and Back logic never drift from the config.
const STEP_INDEX: Record<StepKey, number> = FUNNEL_STEPS.reduce(
  (m, k, i) => ({ ...m, [k]: i }),
  {} as Record<StepKey, number>,
);
const TOTAL_DISPLAY_STEPS = FUNNEL_STEPS.length; // 5

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
}: BuyerFunnelProps) {
  // resume mode jumps straight to Storage — size/timing/contact already exist
  // on the record (props carry consumerId + token).
  const [stepKey, setStepKey] = useState<StepKey>(mode === 'resume' ? 'storage' : 'size');

  // Answers (client state until the relevant POST persists them).
  const [tier, setTier] = useState('');
  const [timing, setTiming] = useState('');
  const [storage, setStorage] = useState('');

  // Contact fields. Phone is REQUIRED.
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState('');

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

  // Attribution — read once on mount from the same localStorage keys the legacy
  // /access form wrote (UtmCapture populates these site-wide). Best-effort.
  const attribution = useRef<{ source: string; campaign: string; utmParams: string }>({
    source: 'funnel',
    campaign: '',
    utmParams: '',
  });

  // Guard the auto-advance timer so a fast double-tap can't skip a step.
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); }, []);

  // ── Attribution capture (mount) ────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const ls = window.localStorage;
      const campaignFromRancher = rancherSlug ? `rancher-${rancherSlug}` : '';
      attribution.current = {
        source: ls.getItem('bhc_source') || 'funnel',
        // A rancher-pinned entry (?rancher=slug) takes precedence so matching
        // can pin the originally-clicked rancher; else fall back to stored UTM
        // campaign.
        campaign: campaignFromRancher || ls.getItem('bhc_campaign') || '',
        utmParams: ls.getItem('bhc_utm_params') || '',
      };
    } catch {
      /* localStorage blocked (private mode) — defaults are fine. */
    }
  }, [rancherSlug]);

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
  const progressPct = Math.round((STEP_INDEX[stepKey] / (TOTAL_DISPLAY_STEPS - 1)) * 100);

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

  // Back is allowed on timing/contact/storage. In resume mode there's nothing
  // before storage to go back to (size/timing/contact live on the record), so
  // Back is hidden there.
  const canGoBack =
    (stepKey === 'timing' || stepKey === 'contact' || stepKey === 'storage') &&
    !(mode === 'resume' && stepKey === 'storage');

  // Tap-card select → flash the check → auto-advance. The `from` guard prevents a
  // double-tap (or a late timer) from skipping the next question.
  function selectAndAdvance(setter: (v: string) => void, value: string, from: StepKey) {
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
    if (name.length < 2) { setError('Please enter your first name.'); return; }
    if (!emailValid) { setError('Please enter a valid email address.'); return; }
    if (!phone.trim()) { setError('Phone is required so your rancher can reach you.'); return; }
    if (!phoneValid) { setError('Please enter a valid phone number (at least 10 digits).'); return; }
    if (!state) { setError('Please pick your state.'); return; }

    setSubmitting(true);
    try {
      const res = await fetch('/api/consumers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quizStarted: true,
          fullName: name,
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          state,
          tier,
          timing,
          source: attribution.current.source,
          campaign: attribution.current.campaign,
          utmParams: attribution.current.utmParams,
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
      setSubmitting(false);
      advance(); // → storage
    } catch {
      setError('Network hiccup — please try again.');
      setSubmitting(false);
    }
  }

  // ── Step 4: finalize (storage) → reveal ─────────────────────────────────────
  async function submitStorage(storageValue: string) {
    setStorage(storageValue);
    setFlashing(storageValue);
    if (!token || !consumerId) {
      // Shouldn't happen (resume carries them; fresh minted them at contact),
      // but degrade honestly rather than POST a broken finalize.
      setError('Your session expired. Please start again.');
      setFlashing(null);
      return;
    }
    setSubmitting(true);
    setError('');
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
          answers: { tier, timing, storage: storageValue },
          eventId,
          ...(attribution.current.campaign.startsWith('rancher-')
            ? { campaign: attribution.current.campaign }
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
              Private network
            </span>
            {stats && (stats.familiesMatched > 0 || stats.verifiedRanches > 0) && (
              <span className="max-w-[55%] text-right text-[11px] leading-tight text-saddle">
                {commas(stats.familiesMatched)}+ families matched · {commas(stats.verifiedRanches)}+ verified ranches
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
          <CardGrid
            options={SIZE_OPTIONS}
            selected={tier}
            flashing={flashing}
            onSelect={(v) => selectAndAdvance(setTier, v, 'size')}
          />
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

        {/* ── STEP 3 — CONTACT ─────────────────────────────────────────────── */}
        {stepKey === 'contact' && (
          <div className="space-y-4">
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
                You match {commas(stats.ranchesInState)}{' '}
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
            </div>

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

            <button
              type="button"
              onClick={submitContact}
              disabled={submitting}
              className="w-full rounded-md px-6 py-4 text-sm font-semibold uppercase tracking-wider text-bone transition-opacity disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {submitting ? 'Finding your match…' : 'Show me my match'}
            </button>
          </div>
        )}

        {/* ── STEP 4 — STORAGE ─────────────────────────────────────────────── */}
        {stepKey === 'storage' && (
          <div className="space-y-4">
            <CardGrid
              options={STORAGE_OPTIONS}
              selected={storage}
              flashing={flashing}
              disabled={submitting}
              onSelect={(v) => submitStorage(v)}
            />
            {submitting && (
              <p className="text-center text-sm text-saddle">Locking in your match…</p>
            )}
            {error && <ErrorBox>{error}</ErrorBox>}
          </div>
        )}

        {/* ── STEP 5 — REVEAL ──────────────────────────────────────────────── */}
        {stepKey === 'reveal' && (
          <Reveal
            result={result}
            offerOperatorCall={offerOperatorCall}
            state={state}
            stats={stats}
          />
        )}

        {/* ── Back nav (steps 2–4, not in resume-storage, not on reveal) ───── */}
        {canGoBack && (
          <div className="mt-7">
            <button
              type="button"
              onClick={back}
              disabled={submitting}
              className="text-sm text-saddle transition-colors hover:text-charcoal disabled:opacity-40"
            >
              ← Back
            </button>
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

// ── Step 5 reveal ─────────────────────────────────────────────────────────────
// Three honest outcomes:
//   1. offerOperatorCall ON  → "Book your 15-min call with Ben" (CalInlineBooker).
//   2. matched rancher       → named rancher + "they'll text you today".
//   3. no in-state match     → honest waitlist ("you're first in line"), NOT a
//      fake match.
function Reveal({
  result,
  offerOperatorCall,
  state,
  stats,
}: {
  result: QualifyResult | null;
  offerOperatorCall: boolean;
  state: string;
  stats: FunnelStats | null;
}) {
  const matched = !!(result?.routingOk && result?.rancher && result.rancher.name);
  const rancher = result?.rancher;
  // Live "family #N" line — familiesMatched + 1 (rounded, comma-formatted). Hides
  // if stats failed.
  const familyNumber = stats && stats.familiesMatched > 0 ? commas(stats.familiesMatched + 1) : null;

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
        <h1 className="font-serif text-4xl leading-tight text-charcoal">You&apos;re in.</h1>
        {familyNumber && (
          <p className="text-sm text-saddle">
            You&apos;re family <strong className="text-charcoal">#{familyNumber}</strong>.
          </p>
        )}
      </header>

      {/* ── Mode 1: operator sales call ──────────────────────────────────────── */}
      {offerOperatorCall ? (
        <div className="space-y-4 text-left">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-widest text-saddle">Next step · about 15 minutes</p>
            <h2 className="font-serif text-2xl text-charcoal">Book your 15-min call with Ben</h2>
            <p className="text-sm leading-relaxed text-saddle">
              {matched && rancher
                ? <>Ben will confirm your cut, lock your processing date, and walk you through {rancher.name}. No payment now.</>
                : <>Ben will confirm your cut, talk you through your options, and get you matched. No payment now.</>}
            </p>
          </div>
          <CalInlineBooker
            operatorCalLink={result?.operatorCalLink}
            name={result?.buyerName}
            email={result?.buyerEmail}
            referralId={result?.referralId}
          />
        </div>
      ) : matched && rancher ? (
        /* ── Mode 2: matched rancher reveal ─────────────────────────────────── */
        <div className="space-y-4">
          <div className="rounded-lg border border-dust bg-white p-6 text-left">
            <p className="text-xs uppercase tracking-widest text-saddle">Your matched rancher</p>
            <h2 className="mt-1 font-serif text-3xl text-charcoal">{rancher.name}</h2>
            {rancher.state && <p className="mt-0.5 text-sm text-saddle">{rancher.state}</p>}
            <div
              className="mt-4 rounded-md px-4 py-3 text-sm font-medium text-bone"
              style={{ backgroundColor: FUNNEL_ACCENT }}
            >
              They&apos;ll text you today.
            </div>
          </div>
          <p className="text-xs text-saddle">
            Keep an eye on your phone — your rancher reaches out directly, no middleman.
          </p>
        </div>
      ) : (
        /* ── Mode 3: honest waitlist (no in-state rancher / no match) ────────── */
        <div className="space-y-4">
          <div className="rounded-lg border border-dust bg-white p-6 text-left">
            <p className="text-xs uppercase tracking-widest text-saddle">You&apos;re first in line</p>
            <h2 className="mt-1 font-serif text-2xl text-charcoal">
              We&apos;re bringing ranches to {state || 'your state'}.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-saddle">
              You&apos;re a qualified buyer the moment a verified rancher opens up near you — and you&apos;ll
              be the first we reach out to. We&apos;re working on it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
