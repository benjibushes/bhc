'use client';

// /access — CRO Phase 1 overhaul (2026-05-24)
//
// Fields trimmed to 5: firstName, state, householdSize, timing, email.
// Fields moved to post-signup follow-up sequence:
//   - phone, orderType, budgetRange, notes,
//     interestBeef, interestLand, interestMerch, interestAll
//
// /api/consumers POST contract preserved — removed fields sent as empty
// defaults so the API handler never 400s on missing keys.

import { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Script from 'next/script';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';
import { trackEvent } from '@/lib/analytics';
import { track } from '@/lib/track';
import ExitIntentModal from '@/app/components/ExitIntentModal';

const US_STATES = [
  { value: '', label: 'pick your state' },
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' },
  { value: 'DC', label: 'Washington D.C.' },
];

// VideoObject structured data — swap contentUrl + thumbnailUrl once shoot done
const VIDEO_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: 'how buyhalfcow works — 90 seconds',
  description: 'how buyers find verified ranchers in their state via BuyHalfCow',
  thumbnailUrl: 'https://buyhalfcow.com/og-cover.png',
  uploadDate: '2026-05-24',
  contentUrl: 'https://buyhalfcow.com/videos/how-it-works.mp4',
};

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  thisMonthClosedWon: number;
}

// Consumed by hero JSX (`{stats.ranchersActive}` etc.) which renders the raw
// number — no em-dash fallback layer for 0. So if we hardcoded zeros here,
// /api/stats/public failure would lie with "0 verified ranchers" rather than
// degrade to a placeholder. Real, conservative numbers are safer than fake-low
// zeros. Verified against prod 2026-05-27 — re-verify monthly.
const STATS_FALLBACK: PublicStats = {
  ranchersActive: 17,
  familiesMatched: 1533,
  thisMonthClosedWon: 0,
};

// ── Testimonial type ────────────────────────────────────────────────────
// Real testimonials only — fetched client-side from /api/testimonials
// (which pulls Closed Won referrals w/ explicit Testimonial field
// populated). When zero exist, the testimonial row hides entirely.
// We previously shipped invented S.K./J.M./L.W. placeholder fallbacks
// but pulled them: fabricated quotes attributed to fabricated initials
// presented as real customer voices was impersonation-class risk.

interface ApiTestimonial {
  buyerName: string;
  buyerState: string;
  rancherName: string;
  ranchSlug: string;
  saleAmount: number;
  orderType: string;
  quote: string;
  daysAgo: number;
  closedAt: string;
}

function validateEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = [
    'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
    'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com',
    '10minutemail.com', 'trashmail.com',
  ];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

// Common fat-finger domains → the domain the buyer almost certainly meant.
// A typo'd email kills the whole funnel (qualify link + welcome email bounce),
// so we surface a one-tap "did you mean" instead of letting it through.
const DOMAIN_TYPO_MAP: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmal.com': 'gmail.com',
  'gmaill.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com',
  'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'outlook.co': 'outlook.com',
  'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com', 'icloud.co': 'icloud.com',
};

function suggestEmailFix(email: string): string | null {
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  const fixed = DOMAIN_TYPO_MAP[domain.toLowerCase()];
  return fixed ? `${local}@${fixed}` : null;
}

function validateName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/[<>{}()[\]\\/]/.test(trimmed)) return false;
  return true;
}

function AccessPageContent() {
  // ── Form state (5 visible fields + honeypot) ─────────────────────────────
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState('');
  const [householdSize, setHouseholdSize] = useState('');
  const [timing, setTiming] = useState('');
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot

  // ── UI state ──────────────────────────────────────────────────────────────
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submittedRancherAvailable, setSubmittedRancherAvailable] = useState(false);
  const [submittedConsumerId, setSubmittedConsumerId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [formLoadedAt] = useState(Date.now());
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailSuggestion, setEmailSuggestion] = useState<string | null>(null);
  // Resend-quiz-link state on the success card (the #1 post-signup dead end
  // is "email never arrived" — give them a button, not just a mailto).
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  // Phone requirement follows the A/B env flag EVERYWHERE — label, native
  // `required` attr, and JS validation. Previously the attr + label were
  // hardcoded required, so flipping NEXT_PUBLIC_REQUIRE_PHONE=0 silently
  // did nothing (browser still blocked the submit).
  const phoneRequired = process.env.NEXT_PUBLIC_REQUIRE_PHONE !== '0';

  // ── Affiliate signup state (thank-you card) ──────────────────────────────
  const [affiliateBusy, setAffiliateBusy] = useState(false);
  const [affiliateCode, setAffiliateCode] = useState<string>('');
  const [affiliateShareUrl, setAffiliateShareUrl] = useState<string>('');
  const [affiliateError, setAffiliateError] = useState<string>('');
  const [affiliateCopied, setAffiliateCopied] = useState(false);

  // ── Stats (client-fetched so page can stay 'use client') ─────────────────
  const [stats, setStats] = useState<PublicStats>(STATS_FALLBACK);

  // ── Real testimonials (client-fetched from /api/testimonials) ────────────
  // Integrity rule: render real quotes only. If zero are available (no
  // operator-collected Testimonial fields yet), the entire testimonials
  // row hides — we never show invented quotes attributed to invented
  // initials (S.K./J.M./L.W. fallbacks were impersonation-class risk).
  const [realTestimonials, setRealTestimonials] = useState<ApiTestimonial[]>([]);

  // ── Real ranch cards (client-fetched from /api/public/ranchers) ──────────
  // Replaces the 3 hardcoded generic mini-cards ("grass-finished angus —
  // Colorado") with 3 random live ranchers from the Page-Live set. Each
  // card links to /ranchers/[slug] so the social-proof block doubles as
  // a discovery surface. If 0 ranchers (cold start, API outage), the
  // entire row hides.
  interface PublicRancher {
    id: string;
    slug: string;
    ranch_name: string;
    operator_name: string;
    state: string;
    beef_types: string;
    quarter_price: number | null;
    half_price: number | null;
    whole_price: number | null;
  }
  const [realRanchers, setRealRanchers] = useState<PublicRancher[]>([]);
  // States with at least one Page-Live rancher (home state + states served).
  // Drives the instant "✓ a rancher serves your state" feedback under the
  // state select. Empty set = data unavailable → show nothing, claim nothing.
  const [coveredStates, setCoveredStates] = useState<Set<string>>(new Set());

  // ── Campaign tracking ─────────────────────────────────────────────────────
  const [campaignData, setCampaignData] = useState({
    campaign: '',
    source: 'organic',
    utmParams: '',
    ref: '',
    rancherSlug: '',
  });

  // ── G15 Rancher hero overlay ─────────────────────────────────────────────
  // When ?rancher=<slug>, optionally fetch rancher name to show "you're
  // matching with {Ranch Name}" hero copy. Non-blocking: if fetch fails,
  // the form still works (Preferred Rancher link set server-side).
  interface RancherHero {
    id: string;
    name: string;
  }
  const [rancherHero, setRancherHero] = useState<RancherHero | null>(null);

  const searchParams = useSearchParams();
  // Stable serialised string prevents useEffect infinite-loop (see legacy bug
  // comment in original file — same fix applies here).
  const searchParamsString = searchParams.toString();

  useEffect(() => {
    const refFromUrl = searchParams.get('ref') || searchParams.get('aff');
    if (refFromUrl) localStorage.setItem('bhc_ref', refFromUrl);
    // G15 — rancher deep-link attribution on /access?rancher=<slug>
    const rancherSlugFromUrl = searchParams.get('rancher');
    if (rancherSlugFromUrl) localStorage.setItem('bhc_rancher_slug', rancherSlugFromUrl);
    // State-landing prefill — /access?state=XX from the per-state landing
    // pages + state-targeted ads/SEO. Uppercase + validate it's a REAL
    // 2-letter US_STATES code before applying (a bad ?state=ZZ would otherwise
    // leave the select on an option the dropdown can't show). Only prefill an
    // empty field so we never clobber a selection the buyer already made.
    const stateFromUrl = (searchParams.get('state') || '').trim().toUpperCase();
    if (
      /^[A-Z]{2}$/.test(stateFromUrl) &&
      US_STATES.some((s) => s.value === stateFromUrl)
    ) {
      setState((prev) => (prev ? prev : stateFromUrl));
    }
    const campaign = localStorage.getItem('bhc_campaign') || '';
    const source = localStorage.getItem('bhc_source') || 'organic';
    const utmParams = localStorage.getItem('bhc_utm_params') || '';
    const ref = refFromUrl || localStorage.getItem('bhc_ref') || '';
    const rancherSlug = rancherSlugFromUrl || localStorage.getItem('bhc_rancher_slug') || '';
    setCampaignData((prev) => {
      if (
        prev.campaign === campaign &&
        prev.source === source &&
        prev.utmParams === utmParams &&
        prev.ref === ref &&
        prev.rancherSlug === rancherSlug
      ) {
        return prev;
      }
      return { campaign, source, utmParams, ref, rancherSlug };
    });

    // Affiliate click ping — de-duped per session
    if (refFromUrl) {
      const pingKey = `bhc_ref_pinged:${refFromUrl}`;
      if (typeof window !== 'undefined' && !window.sessionStorage.getItem(pingKey)) {
        window.sessionStorage.setItem(pingKey, '1');
        fetch(`/api/affiliates/track-click?ref=${encodeURIComponent(refFromUrl)}`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsString]);

  // G15 — fetch rancher hero data when ?rancher=<slug> present
  useEffect(() => {
    if (campaignData.rancherSlug) {
      fetch(`/api/public/ranchers?slug=${encodeURIComponent(campaignData.rancherSlug)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.rancher) {
            const name = data.rancher['Ranch Name'] || data.rancher['Operator Name'] || 'Ranch';
            setRancherHero({ id: data.rancher.id, name });
          }
        })
        .catch(() => {
          // Non-blocking: rancher hero is nice-to-have. If fetch fails, form still works.
        });
    } else {
      setRancherHero(null);
    }
  }, [campaignData.rancherSlug]);

  // ── access_view analytics on mount ────────────────────────────────────────
  useEffect(() => {
    trackEvent('access_view');
    // G5 — quiz_started fires once on /access mount so we have a baseline
    // for per-step drop-off measurement. Pairs with quiz_step_completed
    // (fired on email/state/timing/householdSize blur+change below) to
    // unlock Meta+GA optimization toward LEAD-progression bidding.
    trackEvent('quiz_started');
  }, []);

  // G5 — per-field idempotency guards prevent double-fire on repeated
  // blur/change of the same field. Each step fires exactly once per visit.
  const quizStepFired = useRef<Record<string, boolean>>({});
  const fireQuizStep = (step: 'email' | 'state' | 'householdSize' | 'timing') => {
    if (quizStepFired.current[step]) return;
    quizStepFired.current[step] = true;
    trackEvent('quiz_step_completed', { step });
  };

  // ── Fetch live stats ───────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/stats/public')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          setStats({
            ranchersActive: data.ranchersActive ?? STATS_FALLBACK.ranchersActive,
            familiesMatched: data.familiesMatched ?? STATS_FALLBACK.familiesMatched,
            thisMonthClosedWon: data.thisMonthClosedWon ?? STATS_FALLBACK.thisMonthClosedWon,
          });
        }
      })
      .catch(() => {});
  }, []);

  // ── Fetch real testimonials ───────────────────────────────────────────────
  // Hits the same in-process cache the /start page uses, so this is cheap
  // even at scale. On failure we silently render empty (testimonial row hides).
  useEffect(() => {
    fetch('/api/testimonials?limit=3')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.testimonials) && data.testimonials.length > 0) {
          setRealTestimonials(data.testimonials);
        }
      })
      .catch(() => {});
  }, []);

  // ── Fetch real ranchers for mini-cards ──────────────────────────────────
  // Pick 3 at random from the Page-Live set so repeat visitors don't see
  // the same 3 every time. Server endpoint is unauthenticated + ISR-friendly.
  useEffect(() => {
    fetch('/api/public/ranchers')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.ranchers) && data.ranchers.length > 0) {
          // Coverage set — home state + every 2-letter code in states_served.
          // Proxy for "will this buyer match": the authoritative gate runs
          // server-side at matching time; this only powers the inline hint.
          const covered = new Set<string>();
          for (const r of data.ranchers as PublicRancher[] & { states_served?: string }[]) {
            const home = String((r as any).state || '').trim().toUpperCase();
            if (/^[A-Z]{2}$/.test(home)) covered.add(home);
            const served = String((r as any).states_served || '').toUpperCase();
            for (const m of served.match(/\b[A-Z]{2}\b/g) || []) covered.add(m);
          }
          setCoveredStates(covered);

          // Fisher-Yates shuffle truncated to 3
          const arr = [...data.ranchers] as PublicRancher[];
          for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          setRealRanchers(arr.slice(0, 3));
        }
      })
      .catch(() => {});
  }, []);

  // ── Mobile sticky CTA (CRO Phase 2) ──────────────────────────────────────
  const formRef = useRef<HTMLFormElement>(null);
  const [stickyVisible, setStickyVisible] = useState(false);

  useEffect(() => {
    if (!formRef.current) return;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobile) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show sticky CTA when form is NOT visible (user scrolled past)
        setStickyVisible(!entry.isIntersecting);
      },
      { threshold: 0.1 }
    );
    observer.observe(formRef.current);
    return () => observer.disconnect();
  }, []);

  // ── Abandoned-app capture ─────────────────────────────────────────────────
  const [abandonedCaptured, setAbandonedCaptured] = useState(false);
  const handleEmailBlur = () => {
    if (!email) return;
    setEmailSuggestion(suggestEmailFix(email.trim()));
    if (!validateEmail(email)) return;
    // G5 — fire quiz_step_completed once when email is first validated on blur.
    // This is the highest-signal step (real email = real lead).
    fireQuizStep('email');
    if (abandonedCaptured) return;
    fetch('/api/abandoned-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName: firstName, state }),
    })
      .then(() => setAbandonedCaptured(true))
      .catch(() => {});
  };

  // ── Form validity ─────────────────────────────────────────────────────────
  const emailValid = validateEmail(email);

  // Focus + scroll the field that blocked the submit, so the error isn't a
  // mystery box. Native `required` handles empties; this covers format errors.
  const focusField = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Honeypot
    if (website) return;

    // Time-based bot check
    if (Date.now() - formLoadedAt < 3000) {
      setError('please take a moment to fill out the form completely.');
      return;
    }

    if (!validateName(firstName)) {
      setError('please enter a valid first name.');
      focusField('firstName');
      return;
    }
    if (!emailValid) {
      setError('please enter a valid email address.');
      focusField('email');
      return;
    }
    // Phone REQUIRED (2026-06-03). Matched ranchers need a callback channel —
    // email-only buyers ghost ~50% of the time. Block the submit here so the
    // 400 from /api/consumers is never reached for missing-phone signups.
    //
    // F10: env override `NEXT_PUBLIC_REQUIRE_PHONE=0` flips phone to optional,
    // for A/B testing top-of-funnel conversion lift (component-scope const —
    // also drives the label + native required attr).
    if (phoneRequired) {
      if (!phone.trim()) {
        setError('phone number is required so your rancher can reach you.');
        focusField('phone');
        return;
      }
      const phoneDigits = phone.replace(/\D/g, '');
      if (phoneDigits.length < 10) {
        setError('please enter a valid phone number (at least 10 digits).');
        focusField('phone');
        return;
      }
    } else if (phone.trim()) {
      // Optional but if provided, still validate format.
      const phoneDigits = phone.replace(/\D/g, '');
      if (phoneDigits.length < 10) {
        setError('please enter a valid phone number (at least 10 digits).');
        focusField('phone');
        return;
      }
    }

    // Intent score — simplified for 5-field form.
    // Timing carries the most signal available; householdSize feeds
    // rancher-side portion sizing. Budget/orderType collected post-signup.
    let intentScore = 0;
    if (timing === 'now') intentScore += 25;
    else if (timing === '1-3 months') intentScore += 15;
    else intentScore += 0; // just exploring
    if (householdSize === '6+') intentScore += 10;
    else if (householdSize === '3-5') intentScore += 7;
    else intentScore += 4;
    // Default to beef buyer — we only route beef buyers through /access.
    const intentClassification = intentScore >= 20 ? 'High' : intentScore >= 10 ? 'Medium' : 'Low';
    const segment = 'Beef Buyer';

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/consumers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Core 5-field payload
          fullName: firstName.trim(),
          email: email.trim().toLowerCase(),
          state,
          timing,
          householdSize,
          // Preserved API contract fields — empty defaults for follow-up sequence.
          // Phone optional; SMS opt-in only meaningful when phone supplied
          // (TCPA — Twilio sends gated on both).
          phone: phone.trim(),
          smsOptIn: smsOptIn && phone.trim().length > 0,
          // Honeypot travels with the payload so the server-side gate in
          // /api/consumers sees it (humans always send empty string).
          website,
          orderType: '',
          budgetRange: '',
          notes: '',
          interestBeef: true,  // implied — /access is a beef-buyer funnel
          interestLand: false,
          interestMerch: false,
          interestAll: false,
          // Scoring
          intentScore,
          intentClassification,
          segment,
          // Attribution
          source: campaignData.source,
          campaign: campaignData.campaign,
          utmParams: campaignData.utmParams,
          ref: campaignData.ref || undefined,
          rancherSlug: campaignData.rancherSlug || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'submission failed');
      }

      let consumerIdForCapi: string | undefined;
      let qualifyRedirect: string | null = null;
      try {
        const data = await response.json();
        setSubmittedRancherAvailable(!!data?.rancherAvailable);
        const consumerId = data?.consumer?.id;
        if (typeof consumerId === 'string' && consumerId.startsWith('rec')) {
          setSubmittedConsumerId(consumerId);
          consumerIdForCapi = consumerId;
        }
        // /api/consumers returns qualifyUrl for hot signups (intent>=60 +
        // in-state rancher + concrete tier/budget/timing). Redirect directly
        // to the gamified quiz so the buyer never has to wait for the
        // welcome email. Single-page flow: signup → qualify → match.
        if (typeof data?.qualifyUrl === 'string' && data.qualifyUrl.startsWith('http')) {
          qualifyRedirect = data.qualifyUrl;
        }
      } catch {}

      setIsSubmitted(true);

      if (qualifyRedirect) {
        // Use window.location so any extension/router state is cleared and the
        // qualify page mounts fresh. router.push would keep the /access state
        // in memory which could leak if buyer navigates back.
        window.location.href = qualifyRedirect;
        return;
      }

      // Analytics — both systems.
      // E-4 audit fix: server CAPI Lead at app/api/consumers/route.ts:394
      // uses event_id=record.id. Pass same id here so Meta dedup pairs
      // client Pixel + server CAPI fires for accurate Lead attribution.
      trackEvent('access_quiz_submit', {
        state,
        timing,
        ...(consumerIdForCapi ? { event_id: consumerIdForCapi } : {}),
      });
      track('Lead', {
        segment,
        state,
        orderType: '',
        budget: '',
        source: campaignData.campaign || 'access',
        ...(consumerIdForCapi ? { event_id: consumerIdForCapi } : {}),
      });
      track('CompleteRegistration', {
        segment,
        state,
        ...(consumerIdForCapi ? { event_id: consumerIdForCapi } : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'something went wrong. please try again.';
      setError(message);
      setIsSubmitting(false);
    }
  };

  // ── Affiliate signup handler (thank-you card) ────────────────────────────
  const handleAffiliateSignup = async () => {
    if (affiliateBusy || affiliateCode) return;
    setAffiliateError('');
    setAffiliateBusy(true);
    trackEvent('affiliate_signup_click');
    try {
      const res = await fetch('/api/affiliates/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          fullName: firstName.trim(),
          consumerRecordId: submittedConsumerId || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'could not create your share link');
      }
      setAffiliateCode(String(data.code || ''));
      setAffiliateShareUrl(String(data.shareUrl || ''));
      trackEvent('affiliate_signup_success', { code: String(data.code || '') });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'something went wrong';
      setAffiliateError(message);
    } finally {
      setAffiliateBusy(false);
    }
  };

  const handleAffiliateCopy = async () => {
    if (!affiliateShareUrl) return;
    try {
      await navigator.clipboard.writeText(affiliateShareUrl);
      setAffiliateCopied(true);
      trackEvent('affiliate_link_copied', { code: affiliateCode });
      window.setTimeout(() => setAffiliateCopied(false), 2000);
    } catch {
      // Fallback: select-into-prompt would be jarring on mobile; just ignore.
    }
  };

  // Resend the Step-2 quiz link from the success card. Endpoint always
  // returns ok (email-enumeration safe), so "sent" here means "if that email
  // is on file, the link is on its way" — copy matches.
  const handleResendQuizLink = async () => {
    if (resendState === 'sending' || resendState === 'sent') return;
    setResendState('sending');
    try {
      const res = await fetch('/api/qualify/resend-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json().catch(() => ({}));
      setResendState(res.ok && data?.ok !== false ? 'sent' : 'error');
    } catch {
      setResendState('error');
    }
  };

  const affiliateShareText = encodeURIComponent(
    'I just signed up for BuyHalfCow — direct-from-rancher beef, no middleman. Refer 3 friends, get a free Half ($800 value).',
  );
  const tweetUrl = affiliateShareUrl
    ? `https://twitter.com/intent/tweet?text=${affiliateShareText}&url=${encodeURIComponent(affiliateShareUrl)}`
    : '';
  const smsUrl = affiliateShareUrl
    ? `sms:?&body=${affiliateShareText}%20${encodeURIComponent(affiliateShareUrl)}`
    : '';

  // ── Success screen — gamified 5-step ladder ────────────────────────────
  // Hot-intent signups w/ qualifyUrl never see this (redirected client-side
  // before isSubmitted flips). This state shows for: no-rancher-state
  // signups (waitlist) + low-intent signups awaiting welcome+RTB email
  // qualify link.
  if (isSubmitted) {
    return (
      <main className="min-h-screen py-16 md:py-24 bg-bone text-charcoal">
        <Container>
          <div className="max-w-2xl mx-auto space-y-8">
            {/* Progress: Step 1 done (Apply). */}
            <div>
              <div className="flex items-center justify-between text-xs uppercase tracking-widest text-saddle mb-2">
                <span>Step 1 of 5 · Complete ✓</span>
                <span>20% to stocked</span>
              </div>
              <div className="h-1.5 bg-dust overflow-hidden">
                <div className="h-full bg-charcoal transition-all duration-700" style={{ width: '20%' }} />
              </div>
              <div className="grid grid-cols-5 gap-2 mt-2 text-[10px] uppercase tracking-wider text-saddle">
                <span className="text-charcoal font-medium">✓ Apply</span>
                <span className="text-charcoal/70">Qualify</span>
                <span>Match</span>
                <span>Connect</span>
                <span>Stock</span>
              </div>
            </div>

            <div className="text-center space-y-3">
              <div className="text-5xl">✓</div>
              <h1 className="font-serif text-4xl md:text-5xl lowercase">
                you&apos;re in
              </h1>
              <p className="text-lg text-saddle">
                Step 2 of 5 is in your inbox — check{' '}
                <strong className="text-charcoal break-all">{email}</strong>
              </p>
              <p className="text-sm text-saddle">
                arrives in 1-2 minutes. check spam if you don&apos;t see it from{' '}
                <em>ben@buyhalfcow.com</em>.
              </p>
            </div>

            <Divider />

            <div className="space-y-4 max-w-md mx-auto pt-2">
              <p className="text-xs uppercase tracking-widest text-saddle text-center">What happens next</p>
              <div className="flex items-center gap-3 text-base">
                <span className="w-7 h-7 bg-charcoal text-bone rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                  ✓
                </span>
                <span><strong>Application approved.</strong> You cleared Step 1.</span>
              </div>
              <div className="flex items-start gap-3 text-base text-charcoal">
                <span className="w-7 h-7 bg-saddle text-bone rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
                  2
                </span>
                <span>
                  <strong>4-question quiz</strong> in your inbox — one click opens the gamified gate. Takes 60 seconds. Unlocks your match.
                </span>
              </div>
              <div className="flex items-start gap-3 text-base text-saddle">
                <span className="w-7 h-7 border border-dust rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
                  3
                </span>
                <span>
                  {submittedRancherAvailable ? (
                    <>
                      <strong>Match locked.</strong> Verified rancher in{' '}
                      <strong>{state}</strong> ready to receive you.
                    </>
                  ) : (
                    <>
                      <strong>Match pending.</strong> No verified rancher in{' '}
                      <strong>{state}</strong> yet — you&apos;ll be first to hear when one goes live.
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-start gap-3 text-base text-saddle/70">
                <span className="w-7 h-7 border border-dust rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
                  4
                </span>
                <span><strong>Connect.</strong> Schedule a 15-min call or pay deposit on the platform.</span>
              </div>
              <div className="flex items-start gap-3 text-base text-saddle/70">
                <span className="w-7 h-7 border border-dust rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
                  5
                </span>
                <span><strong>Stock.</strong> Pick up at processing date. Freezer full.</span>
              </div>
            </div>

            {/* ── Affiliate signup card ─────────────────────────────── */}
            {/*
              Surfaces post-quiz: every completer becomes a potential
              affiliate with one click. Headline is the hook ("free Half"),
              body sets the bar ("3 friends + complete a purchase"), button
              mints the code via /api/affiliates/signup (idempotent by email).
            */}
            <div className="mt-8 border border-dust bg-divider/30 p-6 text-left">
              {!affiliateCode ? (
                <>
                  <h2 className="font-serif text-2xl lowercase text-charcoal mb-2">
                    want a free Half? share your link.
                  </h2>
                  <p className="text-saddle text-sm leading-relaxed mb-4">
                    refer 3 friends who sign up + complete a purchase &rarr;
                    you get a free Half (worth $800). no caps, no expiry,
                    stacks with future referrals.
                  </p>
                  {affiliateError && (
                    <p className="text-xs text-weathered mb-3">{affiliateError}</p>
                  )}
                  <button
                    type="button"
                    onClick={handleAffiliateSignup}
                    disabled={affiliateBusy}
                    className="w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-3 min-h-[48px] hover:bg-charcoal/80 disabled:opacity-40 transition-opacity"
                  >
                    {affiliateBusy ? 'minting your link…' : 'get my share link'}
                  </button>
                </>
              ) : (
                <>
                  <h2 className="font-serif text-2xl lowercase text-charcoal mb-2">
                    your share link is live.
                  </h2>
                  <p className="text-saddle text-sm leading-relaxed mb-4">
                    3 friends who sign up + buy &rarr; free Half on us. track
                    progress at{' '}
                    <a
                      href="/affiliate"
                      className="text-charcoal underline underline-offset-2 hover:text-saddle"
                    >
                      /affiliate
                    </a>
                    .
                  </p>
                  <div className="flex items-stretch gap-2 mb-3">
                    <input
                      type="text"
                      readOnly
                      value={affiliateShareUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 min-w-0 border border-dust px-3 py-2 bg-bone text-charcoal text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleAffiliateCopy}
                      className="bg-charcoal text-bone uppercase tracking-wider text-xs font-semibold px-4 min-h-[44px] hover:bg-charcoal/80 transition-opacity whitespace-nowrap"
                    >
                      {affiliateCopied ? 'copied' : 'copy link'}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <a
                      href={tweetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() =>
                        trackEvent('affiliate_link_shared', {
                          code: affiliateCode,
                          channel: 'twitter',
                        })
                      }
                      className="flex-1 border border-dust text-charcoal uppercase tracking-wider text-xs font-semibold px-4 py-2 min-h-[40px] flex items-center justify-center hover:bg-bone transition-colors"
                    >
                      tweet
                    </a>
                    <a
                      href={smsUrl}
                      onClick={() =>
                        trackEvent('affiliate_link_shared', {
                          code: affiliateCode,
                          channel: 'sms',
                        })
                      }
                      className="flex-1 border border-dust text-charcoal uppercase tracking-wider text-xs font-semibold px-4 py-2 min-h-[40px] flex items-center justify-center hover:bg-bone transition-colors"
                    >
                      text
                    </a>
                  </div>
                </>
              )}
            </div>

            <div className="pt-4 text-sm text-saddle space-y-2">
              <p>
                email not showing up after a few minutes?{' '}
                {resendState === 'sent' ? (
                  <span className="text-sage-dark">
                    ✓ fresh link sent to <strong className="text-charcoal">{email}</strong> — give it a minute
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={handleResendQuizLink}
                    disabled={resendState === 'sending'}
                    className="text-charcoal underline underline-offset-2 hover:text-saddle disabled:opacity-50"
                  >
                    {resendState === 'sending' ? 'resending…' : 'resend my quiz link'}
                  </button>
                )}
              </p>
              {resendState === 'error' && (
                <p className="text-xs text-weathered">
                  resend hit a snag — email{' '}
                  <a href="mailto:hello@buyhalfcow.com" className="underline underline-offset-2">
                    hello@buyhalfcow.com
                  </a>{' '}
                  and we&apos;ll sort it.
                </p>
              )}
            </div>

            <div className="pt-4">
              <Link href="/" className="text-saddle hover:text-charcoal transition-colors">
                &larr; back to home
              </Link>
            </div>

            <div className="pt-6 text-xs text-dust text-center">
              Are you a rancher?{' '}
              <Link href="/apply" className="underline underline-offset-2 hover:text-charcoal transition-colors">
                Apply here &rarr;
              </Link>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  // ── Main page ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Mobile sticky CTA — shows when form is scrolled out of view */}
      {stickyVisible && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-bone border-t border-dust p-3 sm:hidden">
          <button
            onClick={() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            className="block w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-4 min-h-[52px]"
          >
            find my rancher ↑
          </button>
        </div>
      )}

      {/* VideoObject structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(VIDEO_SCHEMA) }}
      />

      <main className="min-h-screen bg-bone text-charcoal">
        <Container>
          <div className="max-w-2xl mx-auto py-12 sm:py-20 px-0">

            {/* ── Section A — H1 + Value Prop ─────────────────────────────── */}
            {/* Hero copy is honest about the two-state outcome:
                  - covered state → matched to a rancher in hours
                  - uncovered state → priority waitlist + we recruit a rancher
                Previous "90 seconds" overpromised — only ~15 states have a Live
                rancher. Buyers in NY/MA/FL hit a waitlist letter and felt baited. */}
            <h1 className="font-serif text-3xl sm:text-5xl text-charcoal lowercase mb-3 leading-tight">
              find your rancher — direct, no marketplace middleman
            </h1>

            {/* G15 — Rancher hero overlay when ?rancher=<slug> */}
            {rancherHero && (
              <div className="bg-amber/10 border border-amber/30 rounded-sm p-4 mb-8 text-center">
                <p className="text-saddle text-lg font-semibold">
                  you're matching with <span className="text-charcoal font-serif">{rancherHero.name}</span>
                </p>
              </div>
            )}

            <p className="text-saddle text-lg mb-8 leading-relaxed">
              pick your state. answer 4 questions. if a rancher serves your
              state, we make the intro within hours. if not, you go on the
              priority waitlist and we work on it. you talk direct — no
              marketplace middleman, transparent fee shown at checkout.
            </p>

            {/* ── Section B — Quiz Form (FIRST — this page's only job) ──────
                CRO Phase 3 (2026-06-12): form moved directly under the hero.
                It used to sit below the video + stats + testimonials + ranch
                cards — two screens of proof before the ask. High-intent
                visitors (ads, /start, /r links) now hit the form immediately;
                skeptics scroll to the proof below and the mobile sticky CTA
                brings them back up. */}
            <div className="pt-2">
              {/* 5-step funnel progress — Step 1 of 5 active.
                  Mirrors the same visual indicator in homepage funnel preview,
                  /qualify quiz progress bar, /matched celebration, intro
                  email. Buyer sees they're 20% to stocked freezer before
                  even clicking submit. Reduces drop-off at form gate. */}
              <div className="mb-7">
                <div className="flex items-center justify-between text-xs uppercase tracking-widest text-saddle mb-2">
                  <span>Step 1 of 5 · Apply</span>
                  <span>20% to stocked</span>
                </div>
                <div className="h-1.5 bg-dust overflow-hidden">
                  <div className="h-full bg-charcoal" style={{ width: '20%' }} />
                </div>
                <div className="grid grid-cols-5 gap-2 mt-2 text-[10px] uppercase tracking-wider text-saddle">
                  <span className="text-charcoal font-medium">Apply</span>
                  <span>Qualify</span>
                  <span>Match</span>
                  <span>Connect</span>
                  <span>Stock</span>
                </div>
              </div>

              <p className="text-sm text-saddle uppercase tracking-wider mb-6">
                find your rancher
              </p>

              <form ref={formRef} onSubmit={handleSubmit} className="space-y-5">
                {/* Honeypot — hidden from real users */}
                <div
                  className="absolute opacity-0 h-0 overflow-hidden"
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  <input
                    type="text"
                    name="website"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    tabIndex={-1}
                    autoComplete="off"
                  />
                </div>

                {/* 1. State — first field. Lowest-friction answer, and the
                    instant coverage feedback below it is the strongest
                    motivation moment on the page ("a rancher serves TX"). */}
                <div>
                  <label
                    htmlFor="state"
                    className="block text-sm text-charcoal mb-1"
                  >
                    state
                  </label>
                  <select
                    id="state"
                    required
                    className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal appearance-none"
                    value={state}
                    onChange={(e) => {
                      setState(e.target.value);
                      if (e.target.value) fireQuizStep('state');
                    }}
                  >
                    {US_STATES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  {/* Coverage hint — honest two-state outcome, only when the
                      Page-Live set actually loaded (never claim from a guess). */}
                  {state && coveredStates.size > 0 && (
                    coveredStates.has(state) ? (
                      <p className="mt-1.5 text-sm text-sage-dark">
                        ✓ a verified rancher serves {state} — finish below and we make the intro within hours
                      </p>
                    ) : (
                      <p className="mt-1.5 text-sm text-saddle">
                        no {state} rancher live yet — you&apos;ll join the priority waitlist and hear first when one is
                      </p>
                    )
                  )}
                </div>

                {/* 2. Email — second so the abandoned-app capture on blur
                    catches everyone who gets even two fields in. Was field 5;
                    partial fills were lost. */}
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm text-charcoal mb-1"
                  >
                    email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    className={`w-full border px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal ${
                      emailTouched && !emailValid
                        ? 'border-weathered'
                        : 'border-charcoal/30'
                    }`}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailSuggestion) setEmailSuggestion(null);
                    }}
                    onBlur={() => {
                      setEmailTouched(true);
                      handleEmailBlur();
                    }}
                  />
                  {emailSuggestion && (
                    <button
                      type="button"
                      onClick={() => {
                        setEmail(emailSuggestion);
                        setEmailSuggestion(null);
                        setEmailTouched(true);
                      }}
                      className="mt-1 text-xs text-charcoal underline underline-offset-2 hover:text-saddle"
                    >
                      did you mean <strong>{emailSuggestion}</strong>?
                    </button>
                  )}
                  {emailTouched && !emailValid && email.length > 0 && (
                    <p className="mt-1 text-xs text-weathered">
                      enter a valid email address
                    </p>
                  )}
                </div>

                {/* 3. First name */}
                <div>
                  <label
                    htmlFor="firstName"
                    className="block text-sm text-charcoal mb-1"
                  >
                    first name
                  </label>
                  <input
                    id="firstName"
                    type="text"
                    required
                    autoComplete="given-name"
                    className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>

                {/* 4. Household size */}
                <div>
                  <label
                    htmlFor="householdSize"
                    className="block text-sm text-charcoal mb-1"
                  >
                    household size
                  </label>
                  <select
                    id="householdSize"
                    required
                    className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal appearance-none"
                    value={householdSize}
                    onChange={(e) => {
                      setHouseholdSize(e.target.value);
                      if (e.target.value) fireQuizStep('householdSize');
                    }}
                  >
                    <option value="">how many you feeding?</option>
                    <option value="1-2">1–2 people</option>
                    <option value="3-5">3–5 people</option>
                    <option value="6+">6+ people</option>
                  </select>
                </div>

                {/* 5. Timing */}
                <div>
                  <label
                    htmlFor="timing"
                    className="block text-sm text-charcoal mb-1"
                  >
                    when do you want beef?
                  </label>
                  <select
                    id="timing"
                    required
                    className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal appearance-none"
                    value={timing}
                    onChange={(e) => {
                      setTiming(e.target.value);
                      if (e.target.value) fireQuizStep('timing');
                    }}
                  >
                    <option value="">pick a timeline</option>
                    <option value="now">now (within 30 days)</option>
                    <option value="1-3 months">1–3 months</option>
                    <option value="Just exploring">just exploring</option>
                  </select>
                </div>

                {/* 6. Phone + SMS opt-in. F-3 audit: TCPA explicit opt-in
                    required before any Twilio send. Without checkbox checked,
                    no SMS will ever fire regardless of phone presence.
                    Required-ness follows NEXT_PUBLIC_REQUIRE_PHONE — label,
                    native attr, and JS validation all read the same flag. */}
                <div>
                  <label
                    htmlFor="phone"
                    className="block text-sm text-charcoal mb-1"
                  >
                    phone{' '}
                    <span className="text-saddle">
                      {phoneRequired ? '(required so your rancher can reach you)' : '(optional — helps your rancher reach you faster)'}
                    </span>
                  </label>
                  <input
                    id="phone"
                    type="tel"
                    autoComplete="tel"
                    placeholder="555-555-5555"
                    required={phoneRequired}
                    className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>

                {phone.trim().length > 0 && (
                  <label className="flex items-start gap-2 text-sm text-saddle cursor-pointer">
                    <input
                      type="checkbox"
                      checked={smsOptIn}
                      onChange={(e) => setSmsOptIn(e.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      SMS updates ok &mdash; we&apos;ll text you when your rancher reaches out. Reply STOP to opt out anytime. Standard rates apply.
                    </span>
                  </label>
                )}

                {error && (
                  <div className="p-4 border border-weathered bg-transparent text-weathered text-sm">
                    {error}
                  </div>
                )}

                {/* Always-enabled submit (except mid-flight). A disabled
                    button gives zero feedback on WHAT is missing — native
                    required bubbles + the focusField() format errors point at
                    the exact field instead. */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-4 min-h-[52px] hover:bg-charcoal/80 disabled:opacity-40 transition-opacity"
                >
                  {isSubmitting ? 'matching…' : 'find my rancher'}
                </button>

                <p className="text-xs text-saddle text-center">
                  no spam. no cold calls. we intro you directly to your rancher.
                </p>
              </form>
            </div>

            <div className="my-12">
              <Divider />
            </div>

            {/* ── Section C — Social Proof (below the form — for skeptics who
                scroll; the mobile sticky CTA brings them back to the form) ── */}
            <div className="mb-12">
              {/* Stat counters. "0 deals closed this month" is anti-proof —
                  the third cell hides until the count is real. */}
              <div className={`grid ${stats.thisMonthClosedWon > 0 ? 'grid-cols-3' : 'grid-cols-2'} gap-4 mb-8`}>
                <div className="text-center">
                  <div className="font-serif text-2xl sm:text-3xl text-charcoal">
                    {stats.ranchersActive}
                  </div>
                  <div className="text-xs sm:text-sm text-saddle mt-1">
                    verified ranchers
                  </div>
                </div>
                <div className="text-center">
                  <div className="font-serif text-2xl sm:text-3xl text-charcoal">
                    {stats.familiesMatched.toLocaleString()}
                  </div>
                  <div className="text-xs sm:text-sm text-saddle mt-1">
                    families in pipeline
                  </div>
                </div>
                {stats.thisMonthClosedWon > 0 && (
                  <div className="text-center">
                    <div className="font-serif text-2xl sm:text-3xl text-charcoal">
                      {stats.thisMonthClosedWon}
                    </div>
                    <div className="text-xs sm:text-sm text-saddle mt-1">
                      deals closed this month
                    </div>
                  </div>
                )}
              </div>

              {/* Testimonials — REAL Closed Won quotes only. Row hides when
                  zero real quotes exist (no fabricated S.K./J.M./L.W. fakes). */}
              {realTestimonials.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                  {realTestimonials.slice(0, 3).map((t, i) => (
                    <blockquote
                      key={i}
                      className="border-l-2 border-dust pl-4 text-charcoal italic text-sm"
                    >
                      &ldquo;{t.quote}&rdquo;
                      <footer className="mt-2 text-xs text-saddle not-italic">
                        {t.ranchSlug ? (
                          <a
                            href={`/ranchers/${t.ranchSlug}`}
                            className="hover:text-charcoal underline underline-offset-2"
                          >
                            {t.rancherName}
                          </a>
                        ) : (
                          t.rancherName
                        )}
                        {t.buyerState ? ` · ${t.buyerState}` : ''}
                      </footer>
                    </blockquote>
                  ))}
                </div>
              )}

              {/* Ranch mini-cards — REAL Page-Live ranchers. Pulls 3 random
                  from /api/public/ranchers; links to /ranchers/[slug] so the
                  social-proof block doubles as discovery. Hides when none. */}
              {realRanchers.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {realRanchers.map((r) => {
                    const cuts: string[] = [];
                    if (r.quarter_price) cuts.push('quarter');
                    if (r.half_price) cuts.push('half');
                    if (r.whole_price) cuts.push('whole');
                    const cutSummary = cuts.length > 0 ? cuts.join('–') : 'beef';
                    const headline =
                      r.beef_types || r.ranch_name || 'verified rancher';
                    return (
                      <a
                        key={r.id}
                        href={`/ranchers/${r.slug}`}
                        className="border border-dust px-4 py-3 text-sm block hover:bg-bone-warm transition-base"
                      >
                        <div className="font-medium text-charcoal mb-0.5 lowercase">
                          {headline}
                        </div>
                        <div className="text-saddle text-xs">
                          {r.state} · {cutSummary} · verified
                        </div>
                      </a>
                    );
                  })}
                </div>
              )}

              {/* BHC Promise — inline trust block. NRD policy: refundable until
                  rancher accepts, non-refundable after. Cold-chain + mediation
                  always apply. We do not manage cold-chain ourselves. */}
              <div className="mt-8 border-l-2 border-charcoal pl-4 text-sm text-charcoal/85 leading-relaxed">
                <p className="text-xs uppercase tracking-wider text-saddle font-semibold mb-1">
                  the bhc promise
                </p>
                <p>
                  your deposit reserves your slot. refundable until your rancher
                  accepts (usually 24-48h), non-refundable after. cold-chain
                  guarantee + ben mediates any dispute — direct, no script.
                </p>
              </div>
            </div>

            {/* ── Explainer Video Slot — below proof. Renders YouTube embed
                when NEXT_PUBLIC_ACCESS_VIDEO_ID is set; hidden otherwise. */}
            {process.env.NEXT_PUBLIC_ACCESS_VIDEO_ID && (
              <div className="aspect-[9/16] sm:aspect-video bg-charcoal mb-10 relative overflow-hidden rounded-sm">
                <iframe
                  src={`https://www.youtube.com/embed/${process.env.NEXT_PUBLIC_ACCESS_VIDEO_ID}?rel=0&modestbranding=1`}
                  title="BuyHalfCow — 90-second explainer"
                  className="absolute inset-0 w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              </div>
            )}

            <div className="mt-12 text-center space-y-3">
              <p className="text-xs italic text-saddle/80">
                Connecting every household to a ranch they trust.
              </p>
              <Link href="/" className="text-saddle hover:text-charcoal transition-colors">
                &larr; back to home
              </Link>
            </div>
          </div>
        </Container>
        <ExitIntentModal />
      </main>
    </>
  );
}

export default function AccessPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen py-24 bg-bone flex items-center justify-center">
          <p className="text-saddle">loading…</p>
        </main>
      }
    >
      <AccessPageContent />
    </Suspense>
  );
}
