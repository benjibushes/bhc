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
  const [website, setWebsite] = useState(''); // honeypot

  // ── UI state ──────────────────────────────────────────────────────────────
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submittedRancherAvailable, setSubmittedRancherAvailable] = useState(false);
  const [submittedConsumerId, setSubmittedConsumerId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [formLoadedAt] = useState(Date.now());
  const [emailTouched, setEmailTouched] = useState(false);

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

  // ── Campaign tracking ─────────────────────────────────────────────────────
  const [campaignData, setCampaignData] = useState({
    campaign: '',
    source: 'organic',
    utmParams: '',
    ref: '',
  });

  const searchParams = useSearchParams();
  // Stable serialised string prevents useEffect infinite-loop (see legacy bug
  // comment in original file — same fix applies here).
  const searchParamsString = searchParams.toString();

  useEffect(() => {
    const refFromUrl = searchParams.get('ref') || searchParams.get('aff');
    if (refFromUrl) localStorage.setItem('bhc_ref', refFromUrl);
    const campaign = localStorage.getItem('bhc_campaign') || '';
    const source = localStorage.getItem('bhc_source') || 'organic';
    const utmParams = localStorage.getItem('bhc_utm_params') || '';
    const ref = refFromUrl || localStorage.getItem('bhc_ref') || '';
    setCampaignData((prev) => {
      if (
        prev.campaign === campaign &&
        prev.source === source &&
        prev.utmParams === utmParams &&
        prev.ref === ref
      ) {
        return prev;
      }
      return { campaign, source, utmParams, ref };
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
  const isValid =
    validateName(firstName) &&
    emailValid &&
    state !== '' &&
    householdSize !== '' &&
    timing !== '';

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
      return;
    }
    if (!emailValid) {
      setError('please enter a valid email address.');
      return;
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
          // Preserved API contract fields — empty defaults for follow-up sequence
          phone: '',
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
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'submission failed');
      }

      try {
        const data = await response.json();
        setSubmittedRancherAvailable(!!data?.rancherAvailable);
        const consumerId = data?.consumer?.id;
        if (typeof consumerId === 'string' && consumerId.startsWith('rec')) {
          setSubmittedConsumerId(consumerId);
        }
      } catch {}

      setIsSubmitted(true);

      // Analytics — both systems
      trackEvent('access_quiz_submit', { state, timing });
      track('Lead', {
        segment,
        state,
        orderType: '',
        budget: '',
        source: campaignData.campaign || 'access',
      });
      track('CompleteRegistration', { segment, state });
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

  const affiliateShareText = encodeURIComponent(
    'I just signed up for BuyHalfCow — direct-from-rancher beef, no middleman. Refer 3 friends, get a free Half ($800 value).',
  );
  const tweetUrl = affiliateShareUrl
    ? `https://twitter.com/intent/tweet?text=${affiliateShareText}&url=${encodeURIComponent(affiliateShareUrl)}`
    : '';
  const smsUrl = affiliateShareUrl
    ? `sms:?&body=${affiliateShareText}%20${encodeURIComponent(affiliateShareUrl)}`
    : '';

  // ── Success screen (same as original) ────────────────────────────────────
  if (isSubmitted) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-8">
            <h1 className="font-serif text-4xl md:text-5xl lowercase">
              you&apos;re in
            </h1>
            <Divider />

            <div className="space-y-3">
              <p className="text-xl leading-relaxed">
                your login link is on its way to{' '}
                <strong className="text-charcoal break-all">{email}</strong>
              </p>
              <p className="text-sm text-saddle">
                arrives in 1-2 minutes. check spam if you don&apos;t see it from{' '}
                <em>ben@buyhalfcow.com</em>.
              </p>
            </div>

            <div className="space-y-3 text-left max-w-md mx-auto pt-4">
              <div className="flex items-center gap-3 text-base">
                <span className="w-6 h-6 bg-charcoal text-bone rounded-full flex items-center justify-center text-xs font-bold">
                  ✓
                </span>
                <span>application approved</span>
              </div>
              <div className="flex items-start gap-3 text-base text-saddle">
                <span className="w-6 h-6 border border-dust rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                  2
                </span>
                <span>
                  {submittedRancherAvailable ? (
                    <>
                      we&apos;ve got a verified rancher in{' '}
                      <strong>{state}</strong>. check your inbox — one click
                      confirms.
                    </>
                  ) : (
                    <>
                      no verified rancher in <strong>{state}</strong> yet.
                      you&apos;re on the list and will be first to hear when one
                      goes live.
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-start gap-3 text-base text-saddle/60">
                <span className="w-6 h-6 border border-dust rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                  3
                </span>
                <span>
                  {submittedRancherAvailable
                    ? 'personal introduction email within 24-48 hours of your yes click'
                    : 'monthly update on which states are about to launch'}
                </span>
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
                    <p className="text-xs text-[#8C2F2F] mb-3">{affiliateError}</p>
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

            <div className="pt-4 text-sm text-saddle">
              email not showing up?{' '}
              <a
                href="mailto:hello@buyhalfcow.com"
                className="text-charcoal underline underline-offset-2 hover:text-saddle"
              >
                email hello@buyhalfcow.com
              </a>{' '}
              and we&apos;ll resend it.
            </div>

            <div className="pt-4">
              <Link href="/" className="text-saddle hover:text-charcoal transition-colors">
                &larr; back to home
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
            <h1 className="font-serif text-3xl sm:text-5xl text-charcoal lowercase mb-3 leading-tight">
              get matched to a verified rancher in your state in 90 seconds
            </h1>
            <p className="text-saddle text-lg mb-8 leading-relaxed">
              pick your state. answer 4 questions. we route you to the rancher
              closest to you. you talk direct.
            </p>

            {/* ── Section B — Explainer Video Slot ──────────────────────────
                Renders YouTube embed when NEXT_PUBLIC_ACCESS_VIDEO_ID is set.
                Otherwise hidden entirely — no placeholder copy visible to
                paid traffic. Mobile: 9:16 portrait. Desktop: 16:9 landscape. */}
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

            {/* ── Section C — Social Proof Block ──────────────────────────── */}
            <div className="mb-12">
              {/* Stat counters */}
              <div className="grid grid-cols-3 gap-4 mb-8">
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
                    families matched
                  </div>
                </div>
                <div className="text-center">
                  <div className="font-serif text-2xl sm:text-3xl text-charcoal">
                    {stats.thisMonthClosedWon}
                  </div>
                  <div className="text-xs sm:text-sm text-saddle mt-1">
                    closed this month
                  </div>
                </div>
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
                          {r.state} · {cutSummary} · available
                        </div>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>

            <Divider />

            {/* ── Section D — Trimmed Quiz Form (5 fields) ────────────────── */}
            <div className="pt-8">
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

                {/* 1. First name */}
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

                {/* 2. State */}
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
                </div>

                {/* 3. Household size */}
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

                {/* 4. Timing */}
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

                {/* 5. Email */}
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
                        ? 'border-[#8C2F2F]'
                        : 'border-charcoal/30'
                    }`}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailTouched) return; // validation shows on blur
                    }}
                    onBlur={() => {
                      setEmailTouched(true);
                      handleEmailBlur();
                    }}
                  />
                  {emailTouched && !emailValid && email.length > 0 && (
                    <p className="mt-1 text-xs text-[#8C2F2F]">
                      enter a valid email address
                    </p>
                  )}
                </div>

                {error && (
                  <div className="p-4 border border-[#8C2F2F] bg-transparent text-[#8C2F2F] text-sm">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!isValid || isSubmitting}
                  className="w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-4 min-h-[52px] hover:bg-charcoal/80 disabled:opacity-40 transition-opacity"
                >
                  {isSubmitting ? 'matching…' : 'find my rancher'}
                </button>

                <p className="text-xs text-saddle text-center">
                  no spam. no cold calls. we intro you directly to your rancher.
                </p>
              </form>
            </div>

            <div className="mt-12 text-center">
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
