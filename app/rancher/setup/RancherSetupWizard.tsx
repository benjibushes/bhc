'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Container from '../../components/Container';
import LivePreview from './LivePreview';

// 4-step self-serve wizard. State + transitions live in the component;
// each step PATCHes /api/rancher/setup with its slice of the payload.
//
// Steps:
//   1. Confirm contact (email, phone, city, state, ships to)
//   2. Brand (logo URL, tagline, about, video)
//   3. Pricing (Quarter/Half/Whole + Tier Specialty)
//   4. Review + send agreement
//
// All steps are optional except step 1 (must have email + city + state).
// Step 4 calls /api/rancher/setup/request-agreement which mints the signing
// JWT and emails the link to the rancher.
//
// Visual: matches the rest of the rebuild — semantic tokens, Pill labels,
// Card surfaces, focus rings, motion. Mobile-first.

type Rancher = {
  id: string;
  ranchName: string;
  operatorName: string;
  slug: string;
  verificationStatus: string;
  agreementSigned: boolean;
  pageLive: boolean;
  onboardingStatus?: string;
  Email?: string;
  Phone?: string;
  City?: string;
  State?: string;
  Zip?: string;
  'States Served'?: string;
  'Beef Types'?: string;
  'Logo URL'?: string;
  Tagline?: string;
  'About Text'?: string;
  'Video URL'?: string;
  'Quarter Price'?: number;
  'Quarter lbs'?: string;
  'Quarter Payment Link'?: string;
  'Half Price'?: number;
  'Half lbs'?: string;
  'Half Payment Link'?: string;
  'Whole Price'?: number;
  'Whole lbs'?: string;
  'Whole Payment Link'?: string;
  'Tier Specialty'?: string[];
  'Custom Notes'?: string;
};

const CALENDLY_LINK = 'https://cal.com/ben-beauchman-1itnsg/30min';

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

export default function RancherSetupWizard() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rancher, setRancher] = useState<Rancher | null>(null);
  // Hybrid B onboarding flow:
  //   Step 0 = intro (business model + video)
  //   Step 1-3 = page setup (contact / brand / pricing)
  //   Step 4 = Book onboarding call with Ben (Cal.com embed). REQUIRED unless
  //            rancher already has Onboarding Status = 'Call Complete' set
  //            (Ben backfilled it for an existing rancher OR finished the
  //            call already and tapped the Telegram callback).
  //   Step 5 = inline agreement signing
  //   Step 6 = done (logged in, dashboard auto-link)
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(0);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false); // mobile accordion state
  const [signing, setSigning] = useState(false);
  const [signatureName, setSignatureName] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [signingToken, setSigningToken] = useState('');
  const [dashboardLink, setDashboardLink] = useState('');
  const [autoAboutLoading, setAutoAboutLoading] = useState(false);
  const [autoAboutHint, setAutoAboutHint] = useState('');
  const [websiteForAbout, setWebsiteForAbout] = useState('');
  const [showTaglineTemplates, setShowTaglineTemplates] = useState(false);
  const [buyerCountInState, setBuyerCountInState] = useState<number | null>(null);
  const [testimonials, setTestimonials] = useState<
    Array<{ name: string; quote: string; location?: string }>
  >([]);

  // Editable form state — initialized from server response, updated locally.
  const [form, setForm] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!token) {
      setError('No setup token provided. Use the link from your welcome email.');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/rancher/setup?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error || 'Could not load your page');
        } else {
          setRancher(data.rancher);
          // Parse existing testimonials from JSON string field. Treat any
          // parse failure as "no testimonials yet" — non-fatal.
          try {
            const raw = data.rancher.Testimonials || (data.rancher as any)['Testimonials'];
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) setTestimonials(parsed);
            }
          } catch {}
          setForm({
            Email: data.rancher.Email || '',
            Phone: data.rancher.Phone || '',
            City: data.rancher.City || '',
            State: data.rancher.State || '',
            Zip: data.rancher.Zip || '',
            'States Served': data.rancher['States Served'] || '',
            'Beef Types': data.rancher['Beef Types'] || '',
            'Logo URL': data.rancher['Logo URL'] || '',
            Tagline: data.rancher.Tagline || '',
            'About Text': data.rancher['About Text'] || '',
            'Video URL': data.rancher['Video URL'] || '',
            'Quarter Price': data.rancher['Quarter Price'] || '',
            'Quarter lbs': data.rancher['Quarter lbs'] || '',
            'Quarter Payment Link': data.rancher['Quarter Payment Link'] || '',
            'Half Price': data.rancher['Half Price'] || '',
            'Half lbs': data.rancher['Half lbs'] || '',
            'Half Payment Link': data.rancher['Half Payment Link'] || '',
            'Whole Price': data.rancher['Whole Price'] || '',
            'Whole lbs': data.rancher['Whole lbs'] || '',
            'Whole Payment Link': data.rancher['Whole Payment Link'] || '',
            'Tier Specialty': Array.isArray(data.rancher['Tier Specialty'])
              ? data.rancher['Tier Specialty']
              : [],
            'Custom Notes': data.rancher['Custom Notes'] || '',
          });
        }
      } catch {
        setError('Network error — try refreshing');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const setField = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }));

  // Phone mask — formats raw input as (555) 555-5555 progressively. Plays
  // nice with backspace and partial input. Strips non-digits, truncates at 10.
  const formatPhone = (raw: string) => {
    const digits = (raw || '').replace(/\D/g, '').slice(0, 10);
    if (digits.length === 0) return '';
    if (digits.length < 4) return `(${digits}`;
    if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  // Tagline starter templates. Click → fills the field, rancher edits.
  // Mix of voices so something fits any operator.
  const TAGLINE_TEMPLATES = [
    'Family-raised Angus from the {state} valley since {year}.',
    '{generation}-generation ranchers, 100% grass-fed, no shortcuts.',
    'Pasture to freezer in 90 days. No middleman, no commodity feedlot.',
    'Real beef from a real ranch — the way your grandparents bought it.',
    'Rotational grazing, USDA-inspected, raised by a family that eats it too.',
  ];

  // Pull buyer count for current state — drives the "X families looking for
  // beef in MT right now" widget on step 0. Only fires when state is known.
  useEffect(() => {
    const state = (form.State || rancher?.State || '').toString().trim().toUpperCase();
    if (!state || state.length !== 2) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/stats/buyers-by-state?state=${state}`);
        const data = await res.json();
        if (!cancelled && res.ok && typeof data?.count === 'number') {
          setBuyerCountInState(data.count);
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.State, rancher?.State]);

  // Auto-fill About from website URL via Tavily.
  async function autoFillAbout() {
    const url = (websiteForAbout || '').trim();
    if (!url) {
      setAutoAboutHint('Paste your website URL first');
      return;
    }
    setAutoAboutLoading(true);
    setAutoAboutHint('');
    try {
      const res = await fetch(
        `/api/rancher/setup/auto-about?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Auto-fill failed');
      if (data?.suggested) {
        // Don't overwrite — append. Rancher edits.
        const existing = form['About Text'] || '';
        const draft = existing
          ? `${existing}\n\n${data.suggested}`
          : data.suggested;
        setField('About Text', draft);
        setAutoAboutHint('Pulled from your site — edit it down to your voice');
      } else {
        setAutoAboutHint('No content found at that URL');
      }
    } catch (e: any) {
      setAutoAboutHint(e?.message || 'Auto-fill failed');
    } finally {
      setAutoAboutLoading(false);
    }
  }

  // Testimonials — array of {name, quote, location}. Stored in form
  // as JSON-stringified Testimonials field (existing schema).
  const addTestimonial = () =>
    setTestimonials((t) => [...t, { name: '', quote: '', location: '' }]);
  const removeTestimonial = (i: number) =>
    setTestimonials((t) => t.filter((_, idx) => idx !== i));
  const setTestimonial = (
    i: number,
    key: 'name' | 'quote' | 'location',
    value: string
  ) =>
    setTestimonials((t) =>
      t.map((row, idx) => (idx === i ? { ...row, [key]: value } : row))
    );

  const toggleTier = (tier: 'Quarter' | 'Half' | 'Whole') => {
    setForm((f) => {
      const cur: string[] = Array.isArray(f['Tier Specialty']) ? f['Tier Specialty'] : [];
      return {
        ...f,
        'Tier Specialty': cur.includes(tier) ? cur.filter((t) => t !== tier) : [...cur, tier],
      };
    });
  };

  // Persist current step's slice of form to Airtable. Each "Save & continue"
  // call sends only the relevant subset (cleaner Airtable history).
  async function saveStep(slice: Record<string, any>) {
    setSaving(true);
    try {
      // Coerce numeric price fields to numbers (form state is strings).
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(slice)) {
        if (k.endsWith(' Price') && v !== '' && v != null) {
          const n = Number(v);
          payload[k] = isFinite(n) ? n : '';
        } else {
          payload[k] = v;
        }
      }
      const res = await fetch(`/api/rancher/setup?token=${encodeURIComponent(token)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Save failed');
      }
      setLastSavedAt(new Date());
      return true;
    } catch (e: any) {
      setError(e?.message || 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Request a signing JWT (mints a fresh one + stamps Onboarding Status=Docs Sent).
  // Doesn't email — we sign inline. Returns nothing visible, just primes the
  // signing state so step 4 can POST to /api/ranchers/sign-agreement.
  async function primeSigningToken() {
    if (signingToken) return; // already minted
    try {
      const res = await fetch(
        `/api/rancher/setup/request-agreement?token=${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'X-Inline-Sign': '1' } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not load agreement');
      if (data?.signingToken) setSigningToken(data.signingToken);
    } catch (e: any) {
      setError(e?.message || 'Could not load agreement');
    }
  }

  // Submit the inline signature → existing /api/ranchers/sign-agreement endpoint
  // → flips Agreement Signed=true, mints rancher-login JWT, returns dashboard link.
  async function signAgreement() {
    if (!signatureName.trim() || signatureName.trim().length < 2) {
      setError('Please enter your full legal name');
      return;
    }
    if (!agreedToTerms) {
      setError('Please confirm you agree to the partner terms');
      return;
    }
    if (!signingToken) {
      setError('Signing not ready — refresh and try again');
      return;
    }
    setError('');
    setSigning(true);
    try {
      const res = await fetch('/api/ranchers/sign-agreement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: signingToken,
          signatureName: signatureName.trim(),
          agreedToTerms: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Signing failed');
      if (data?.dashboardLink) setDashboardLink(data.dashboardLink);
      setStep(6);
    } catch (e: any) {
      setError(e?.message || 'Signing failed');
    } finally {
      setSigning(false);
    }
  }

  // Hybrid B gate: rancher must have completed the onboarding call (Ben
  // marks Onboarding Status = "Call Complete" via Telegram callback or
  // dashboard) before agreement signing unlocks. Existing ranchers that
  // already had calls done are backfilled by scripts/backfill-call-complete.mjs.
  function canSkipBooking(): boolean {
    const status = (rancher?.onboardingStatus || '').toString();
    return status === 'Call Complete' || status === 'Verification Pending' || status === 'Verification Complete' || status === 'Live';
  }

  if (loading) {
    return (
      <Container>
        <div className="py-24 text-center text-saddle">Loading your page…</div>
      </Container>
    );
  }

  if (error && !rancher) {
    return (
      <Container>
        <div className="py-24 max-w-xl mx-auto text-center space-y-4">
          <h1 className="font-serif text-3xl text-charcoal">Couldn’t load your setup</h1>
          <p className="text-saddle">{error}</p>
          <p className="text-sm text-dust">
            If your link is older than 60 days, email{' '}
            <a className="underline" href="mailto:ben@buyhalfcow.com">
              ben@buyhalfcow.com
            </a>{' '}
            for a fresh one.
          </p>
        </div>
      </Container>
    );
  }

  if (!rancher) return null;

  const stepLabel = (n: 1 | 2 | 3 | 4 | 5) => {
    const labels = { 1: 'Contact', 2: 'Brand', 3: 'Pricing', 4: 'Call', 5: 'Sign' };
    return labels[n];
  };

  // Replace YouTube ID below with the real onboarding video ID once filmed.
  // Until then, the placeholder embed is a 60-sec founder intro from the
  // public BHC channel; if missing, the wizard hides the video and falls
  // through to the "skip + start setup" CTA.
  const ONBOARDING_VIDEO_ID =
    process.env.NEXT_PUBLIC_RANCHER_ONBOARDING_VIDEO_ID || '';

  // Already signed? Skip wizard, jump them to dashboard / page preview.
  if (rancher.agreementSigned) {
    return (
      <Container>
        <div className="py-24 max-w-xl mx-auto text-center space-y-5">
          <p className="text-xs uppercase tracking-[0.2em] text-saddle">Already onboarded</p>
          <h1 className="font-serif text-3xl text-charcoal">
            {rancher.ranchName}, you’re all set.
          </h1>
          <p className="text-saddle">
            Your agreement is signed and your page is live. Edit anything from
            your rancher dashboard.
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Link
              href="/rancher"
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
            >
              Open dashboard →
            </Link>
            <Link
              href={`/ranchers/${rancher.slug}`}
              className="inline-flex items-center gap-2 px-7 py-3.5 border border-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-charcoal hover:text-bone"
            >
              View public page →
            </Link>
          </div>
        </div>
      </Container>
    );
  }

  // Build the preview props from current form state — passed to LivePreview
  // on every keystroke so the rendered listing updates in real time.
  const previewProps = {
    ranchName: rancher.ranchName,
    operatorName: rancher.operatorName,
    city: form.City || '',
    state: form.State || '',
    shipsTo: form['States Served'] || '',
    beefTypes: form['Beef Types'] || '',
    logoUrl: form['Logo URL'] || '',
    tagline: form.Tagline || '',
    aboutText: form['About Text'] || '',
    quarterPrice: form['Quarter Price'],
    quarterLbs: form['Quarter lbs'] || '',
    halfPrice: form['Half Price'],
    halfLbs: form['Half lbs'] || '',
    wholePrice: form['Whole Price'],
    wholeLbs: form['Whole lbs'] || '',
    tierSpecialty: Array.isArray(form['Tier Specialty']) ? form['Tier Specialty'] : [],
    isLive: false,
  };

  // Show live preview on data-entry steps (1, 2, 3) — not on the intro,
  // sign, or done screens. Step 4 sign-step shows its own listing review.
  const showLivePreview = step >= 1 && step <= 3;

  return (
    <Container>
      <div className="py-10 md:py-14 max-w-6xl mx-auto space-y-8">
        {/* Heading */}
        <header className="space-y-3 max-w-3xl">
          <p className="text-xs uppercase tracking-[0.2em] text-saddle">
            {rancher.ranchName} · onboarding
          </p>
          <h1 className="font-serif text-3xl md:text-5xl text-charcoal leading-tight">
            Set up your page in 5 minutes
          </h1>
          <p className="text-saddle leading-relaxed">
            Fill in what you&rsquo;ve got — skip the rest, you can come back any
            time. Sign at the end and your page goes live the moment you do.
          </p>
        </header>

        {/* Progress + auto-save indicator */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="flex flex-wrap items-center gap-3" aria-label="Progress">
            {([1, 2, 3, 4, 5] as const).map((n) => {
              const isActive = step === n;
              const isDone = step > n;
              return (
                <div key={n} className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center justify-center w-7 h-7 text-xs font-bold transition-base ${
                      isActive
                        ? 'bg-charcoal text-bone'
                        : isDone
                        ? 'bg-sage text-bone'
                        : 'bg-bone-deep text-saddle border border-dust'
                    }`}
                  >
                    {isDone ? '✓' : n}
                  </span>
                  <span
                    className={`text-xs uppercase tracking-widest hidden sm:inline ${
                      isActive ? 'text-charcoal font-bold' : 'text-saddle'
                    }`}
                  >
                    {stepLabel(n)}
                  </span>
                  {n < 5 && <span aria-hidden className="text-dust hidden sm:inline">·</span>}
                </div>
              );
            })}
          </nav>
          <SaveIndicator saving={saving} lastSavedAt={lastSavedAt} />
        </div>

        {error && rancher && (
          <div role="alert" className="text-sm text-weathered border border-weathered/40 bg-weathered/5 p-3">
            {error}
          </div>
        )}

        {/* Mobile preview accordion — desktop sees split-screen below; mobile
            gets a toggle button that expands the preview between form and
            footer. Tapping it scrolls the preview into view. */}
        {showLivePreview && (
          <div className="lg:hidden">
            <button
              type="button"
              onClick={() => setPreviewOpen((v) => !v)}
              className="w-full text-left flex items-center justify-between px-4 py-3 bg-bone-warm border border-dust text-sm font-medium text-charcoal transition-base hover:border-saddle"
              aria-expanded={previewOpen}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>👁</span>
                {previewOpen ? 'Hide live preview' : 'See live preview of your page'}
              </span>
              <span aria-hidden className={`text-saddle transition-base ${previewOpen ? 'rotate-180' : ''}`}>
                ↓
              </span>
            </button>
            {previewOpen && (
              <div className="mt-3">
                <LivePreview {...previewProps} />
              </div>
            )}
          </div>
        )}

        {/* STEP 0 — Intro + Business Model + Video + Stat grid */}
        {step === 0 && (
          <section className="space-y-7 bg-bone border border-dust p-7 md:p-10">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">
                Welcome
              </p>
              <h2 className="font-serif text-2xl md:text-4xl text-charcoal">
                What you&rsquo;re joining
              </h2>
            </header>

            {/* Stat grid — concrete promises up front, before the prose. The
                "boom-boom-bam" anchor so ranchers see the deal at a glance. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              {[
                { stat: '10%', label: 'Commission on closed deals only' },
                { stat: '$0', label: 'Setup fee · subscription · listing' },
                { stat: '5 min', label: 'From here to your live page' },
                { stat: 'Anytime', label: 'Pause routing · leave clean' },
              ].map((s) => (
                <div
                  key={s.label}
                  className="border-l-2 border-charcoal pl-3 py-1"
                >
                  <p className="font-serif text-2xl md:text-3xl text-charcoal leading-tight">
                    {s.stat}
                  </p>
                  <p className="text-[11px] uppercase tracking-widest text-saddle mt-1 leading-snug">
                    {s.label}
                  </p>
                </div>
              ))}
            </div>

            {/* Live buyer counter — pulled from /api/stats/buyers-by-state.
                Only renders if rancher state is known + count > 0. Real-time
                proof that ready-to-buy families are waiting in their state. */}
            {buyerCountInState !== null && buyerCountInState > 0 && rancher.State && (
              <div className="bg-sage/10 border-l-4 border-sage p-4 flex items-center gap-3">
                <span aria-hidden className="text-2xl shrink-0">🔥</span>
                <p className="text-sm text-charcoal/90 leading-relaxed">
                  <strong>{buyerCountInState}</strong> {buyerCountInState === 1 ? 'family is' : 'families are'}{' '}
                  looking for beef in <strong>{rancher.State}</strong> right
                  now. Sign and you could be the first rancher routed to them.
                </p>
              </div>
            )}

            {/* 60-second business model — the "what is this" pitch. Plain text
                so it loads instant + readable for ranchers on rural broadband. */}
            <div className="space-y-3 text-charcoal/85 leading-relaxed text-[15px]">
              <p>
                BuyHalfCow is the private network that connects American
                families with verified direct-to-consumer ranchers. We&rsquo;re
                building the public hit list of every D2C rancher in America
                so families can find you instead of buying mystery beef from
                a grocery chain.
              </p>
              <p>
                <strong>How it works for you:</strong> we send you pre-screened
                buyers in your state who are ready to commit to a quarter,
                half, or whole. You close the deal. We take 10% commission
                on what closes &mdash; nothing on no-shows, nothing on
                tire-kickers. You set your own prices, your own capacity,
                your own pace.
              </p>
              <p>
                <strong>Non-exclusive.</strong> Sell direct, sell at farmers
                markets, sell off your own site. We&rsquo;re an extra channel,
                not a leash.
              </p>
            </div>

            {ONBOARDING_VIDEO_ID && (
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-widest text-saddle">
                  Or watch the 90-second walkthrough
                </p>
                <div
                  className="relative w-full overflow-hidden border border-dust"
                  style={{ paddingBottom: '56.25%' }}
                >
                  <iframe
                    src={`https://www.youtube.com/embed/${ONBOARDING_VIDEO_ID}`}
                    title="BuyHalfCow rancher onboarding overview"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="absolute inset-0 w-full h-full"
                  />
                </div>
              </div>
            )}

            <div className="border-t border-dust pt-5 flex flex-col sm:flex-row sm:items-center gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-2 justify-center px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
              >
                Got it &mdash; let&rsquo;s set up &rarr;
              </button>
              <a
                href={CALENDLY_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-saddle hover:text-charcoal underline underline-offset-4 sm:ml-2"
              >
                Or schedule a 15-min call
              </a>
            </div>
          </section>
        )}

        {/* Split-screen layout for data-entry steps — form left, sticky live
            preview right on desktop. Mobile uses the accordion above.
            The grid wraps both the step section AND the preview as siblings.
            Step sections are rendered inside a <div> that becomes the left
            column; preview <aside> is the right column. Empty <div> shells
            keep the grid structure consistent across step transitions. */}
        <div
          className={
            showLivePreview
              ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-8 lg:items-start'
              : ''
          }
        >
          <div key={step} className="space-y-6 step-in">

        {/* STEP 1 — Contact */}
        {step === 1 && (
          <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 1</p>
              <h2 className="font-serif text-2xl text-charcoal">Confirm your contact</h2>
            </header>
            <div className="space-y-4">
              <Field label="Email" required value={form.Email} onChange={(v) => setField('Email', v)} type="email" />
              <Field
                label="Phone"
                value={form.Phone}
                onChange={(v) => setField('Phone', formatPhone(v))}
                type="tel"
                placeholder="(555) 555-5555"
              />
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
                <div className="sm:col-span-3">
                  <Field label="City" required value={form.City} onChange={(v) => setField('City', v)} />
                </div>
                <div className="sm:col-span-1">
                  <SelectField label="State" required value={form.State} onChange={(v) => setField('State', v)}>
                    <option value="" disabled>—</option>
                    {STATES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </SelectField>
                </div>
                <div className="sm:col-span-2">
                  <Field
                    label="ZIP"
                    required
                    value={form.Zip}
                    onChange={(v) => setField('Zip', v.replace(/\D/g, '').slice(0, 5))}
                    placeholder="59715"
                  />
                </div>
              </div>
              <p className="text-xs text-saddle -mt-3">
                ZIP places your pin within ~3 miles. Privacy: never your street address — pin lands at ZIP centroid.
              </p>
              <Field
                label="States you ship to (comma-separated)"
                value={form['States Served']}
                onChange={(v) => setField('States Served', v)}
                placeholder="MT, ID, WY (leave blank if local pickup only)"
              />
              <Field
                label="Beef types (e.g. Grass-fed, Angus, Wagyu)"
                value={form['Beef Types']}
                onChange={(v) => setField('Beef Types', v)}
                placeholder="100% grass-fed Angus"
              />
            </div>
            <StepFooter
              saving={saving}
              onContinue={async () => {
                if (!form.Email || !form.City || !form.State || !form.Zip) {
                  setError('Email, City, State, and ZIP are required');
                  return;
                }
                if (!/^\d{5}$/.test(String(form.Zip))) {
                  setError('ZIP must be 5 digits');
                  return;
                }
                setError('');
                const ok = await saveStep({
                  Email: form.Email,
                  Phone: form.Phone,
                  City: form.City,
                  State: form.State,
                  Zip: form.Zip,
                  'States Served': form['States Served'],
                  // Mirror to Preferred States — sets the rancher's "requested
                  // service area" baseline. Routing States (admin-controlled)
                  // is what actually drives matching; falls back to States
                  // Served when unset, so initial routing still works.
                  'Preferred States': form['States Served'],
                  'Beef Types': form['Beef Types'],
                });
                if (ok) setStep(2);
              }}
            />
          </section>
        )}

        {/* STEP 2 — Brand */}
        {step === 2 && (
          <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 2</p>
              <h2 className="font-serif text-2xl text-charcoal">Tell families who you are</h2>
              <p className="text-sm text-saddle mt-1">
                Skip what you don&rsquo;t have — you can fill it in later from your dashboard.
              </p>
            </header>

            <div className="space-y-5">
              {/* Logo URL with instant preview chip — paste URL, see logo
                  rendered inline. Fails gracefully if URL bad. */}
              <div className="space-y-2">
                <Field
                  label="Logo URL"
                  value={form['Logo URL']}
                  onChange={(v) => setField('Logo URL', v)}
                  placeholder="https://yourranch.com/logo.png"
                  type="url"
                />
                {form['Logo URL'] && (
                  <div className="flex items-center gap-3 px-3 py-2 bg-bone-warm border border-dust">
                    <div className="relative w-12 h-12 bg-bone border border-dust shrink-0">
                      <img
                        src={form['Logo URL']}
                        alt="Logo preview"
                        className="absolute inset-0 w-full h-full object-contain p-1"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                          (e.currentTarget.nextSibling as HTMLElement)?.classList?.remove?.('hidden');
                        }}
                      />
                      <span className="hidden absolute inset-0 flex items-center justify-center text-xs text-weathered">
                        ⚠
                      </span>
                    </div>
                    <p className="text-xs text-saddle leading-relaxed">
                      Logo preview. If you see a broken icon, the URL isn&rsquo;t
                      reachable — try right-clicking your logo on your site and
                      choosing &ldquo;Copy image address&rdquo;.
                    </p>
                  </div>
                )}
              </div>

              {/* Tagline + templates */}
              <div className="space-y-2">
                <Field
                  label="Tagline (one sentence)"
                  value={form.Tagline}
                  onChange={(v) => setField('Tagline', v)}
                  placeholder="Family-raised Angus from the Bitterroot Valley since 1962."
                />
                <div className="flex items-start gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setShowTaglineTemplates((v) => !v)}
                    className="text-xs text-saddle hover:text-charcoal underline underline-offset-2"
                  >
                    {showTaglineTemplates ? 'Hide examples' : 'Need help? See examples →'}
                  </button>
                  {(form.Tagline || '').length > 0 && (
                    <span className="text-xs text-dust">
                      {form.Tagline.length}/120 chars
                    </span>
                  )}
                </div>
                {showTaglineTemplates && (
                  <div className="border border-dust bg-bone-warm p-3 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-widest text-saddle mb-2">
                      Click to use as starter (then edit to your voice)
                    </p>
                    {TAGLINE_TEMPLATES.map((t, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          setField('Tagline', t);
                          setShowTaglineTemplates(false);
                        }}
                        className="block w-full text-left text-sm text-charcoal/85 px-2 py-1.5 hover:bg-bone hover:text-charcoal transition-base"
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Auto-fill About from website URL */}
              <div className="space-y-2 border border-dust bg-bone-warm p-4">
                <p className="text-xs uppercase tracking-widest text-saddle">
                  Quick fill — paste your website URL
                </p>
                <p className="text-xs text-charcoal/75 leading-relaxed">
                  We&rsquo;ll pull the text from your site so you don&rsquo;t
                  start with a blank page. Edit it down to your voice after.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={websiteForAbout}
                    onChange={(e) => setWebsiteForAbout(e.target.value)}
                    placeholder="https://yourranch.com/about"
                    className="flex-1 px-3 py-2.5 border border-dust bg-bone text-sm text-charcoal transition-base focus:outline-none focus:border-charcoal"
                  />
                  <button
                    type="button"
                    onClick={autoFillAbout}
                    disabled={autoAboutLoading}
                    className="px-5 py-2.5 bg-charcoal text-bone text-xs font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-50"
                  >
                    {autoAboutLoading ? 'Pulling…' : 'Fill from site'}
                  </button>
                </div>
                {autoAboutHint && (
                  <p className="text-xs text-saddle italic">{autoAboutHint}</p>
                )}
              </div>

              <TextareaField
                label="About your ranch"
                value={form['About Text']}
                onChange={(v) => setField('About Text', v)}
                rows={7}
                placeholder="A few paragraphs. How you got started, what makes your operation different, what families are buying when they buy from you."
              />

              <Field
                label="Video URL (YouTube or Vimeo, optional)"
                value={form['Video URL']}
                onChange={(v) => setField('Video URL', v)}
                placeholder="https://youtube.com/watch?v=..."
                type="url"
              />
            </div>
            <StepFooter
              saving={saving}
              onBack={() => setStep(1)}
              onContinue={async () => {
                setError('');
                const ok = await saveStep({
                  'Logo URL': form['Logo URL'],
                  Tagline: form.Tagline,
                  'About Text': form['About Text'],
                  'Video URL': form['Video URL'],
                });
                if (ok) setStep(3);
              }}
            />
          </section>
        )}

        {/* STEP 3 — Pricing */}
        {step === 3 && (
          <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 3</p>
              <h2 className="font-serif text-2xl text-charcoal">Set your share prices</h2>
              <p className="text-sm text-saddle mt-1">
                Optional — but pages with prices convert ~3× better. Fill in
                only the shares you sell. Buyers see "Contact for pricing" if
                you skip.
              </p>
            </header>

            {/* Tier specialty checkboxes */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-charcoal">I sell:</p>
              <div className="flex flex-wrap gap-2">
                {(['Quarter', 'Half', 'Whole'] as const).map((t) => {
                  const active = (form['Tier Specialty'] || []).includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTier(t)}
                      className={`px-4 py-2 text-sm font-medium uppercase tracking-wide border transition-base ${
                        active
                          ? 'bg-charcoal text-bone border-charcoal'
                          : 'bg-bone text-charcoal border-dust hover:border-saddle'
                      }`}
                    >
                      {t} {active && <span aria-hidden>✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {(['Quarter', 'Half', 'Whole'] as const).map((tier) => (
              <div key={tier} className="border border-dust p-4 md:p-5 space-y-3 bg-bone-warm">
                <p className="font-serif text-lg text-charcoal">{tier} Cow</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field
                    label="Price ($)"
                    type="number"
                    value={form[`${tier} Price`]}
                    onChange={(v) => setField(`${tier} Price`, v)}
                    placeholder="1200"
                  />
                  <Field
                    label="Approx finished weight (lbs)"
                    value={form[`${tier} lbs`]}
                    onChange={(v) => setField(`${tier} lbs`, v)}
                    placeholder="~150 lbs"
                  />
                </div>
                <Field
                  label="Stripe / payment link (optional — auto-built later)"
                  value={form[`${tier} Payment Link`]}
                  onChange={(v) => setField(`${tier} Payment Link`, v)}
                  type="url"
                  placeholder="https://buy.stripe.com/..."
                />
              </div>
            ))}

            {/* Testimonials editor — array of {name, quote, location}.
                Stored as JSON-stringified Testimonials field. Renders on the
                public /ranchers/[slug] page in the "Word of mouth" section.
                Optional — most ranchers add later from dashboard. */}
            <div className="border-t border-dust pt-5 space-y-3">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div>
                  <p className="text-sm font-medium text-charcoal">
                    Customer testimonials (optional)
                  </p>
                  <p className="text-xs text-saddle">
                    Quotes from real customers. Adds trust on your public page.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addTestimonial}
                  className="text-xs uppercase tracking-widest font-semibold text-saddle hover:text-charcoal underline underline-offset-2"
                >
                  + Add testimonial
                </button>
              </div>
              {testimonials.map((t, i) => (
                <div
                  key={i}
                  className="border border-dust bg-bone-warm p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                      Testimonial #{i + 1}
                    </p>
                    <button
                      type="button"
                      onClick={() => removeTestimonial(i)}
                      className="text-xs text-weathered hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <Field
                    label="Name"
                    value={t.name}
                    onChange={(v) => setTestimonial(i, 'name', v)}
                    placeholder="Jane Doe"
                  />
                  <Field
                    label="Location (city, state)"
                    value={t.location || ''}
                    onChange={(v) => setTestimonial(i, 'location', v)}
                    placeholder="Bozeman, MT"
                  />
                  <TextareaField
                    label="Quote"
                    value={t.quote}
                    onChange={(v) => setTestimonial(i, 'quote', v)}
                    rows={2}
                    placeholder="The freezer's full and the kids actually eat dinner now."
                  />
                </div>
              ))}
              {testimonials.length === 0 && (
                <p className="text-xs text-dust italic">
                  No testimonials yet. Click + Add testimonial above to build trust on your page.
                </p>
              )}
            </div>

            <StepFooter
              saving={saving}
              onBack={() => setStep(2)}
              onContinue={async () => {
                setError('');
                // Filter out empty testimonials before saving (rancher may add
                // then leave blank).
                const validTestimonials = testimonials.filter(
                  (t) => t.name.trim() && t.quote.trim()
                );
                const ok = await saveStep({
                  'Tier Specialty': form['Tier Specialty'],
                  'Quarter Price': form['Quarter Price'],
                  'Quarter lbs': form['Quarter lbs'],
                  'Quarter Payment Link': form['Quarter Payment Link'],
                  'Half Price': form['Half Price'],
                  'Half lbs': form['Half lbs'],
                  'Half Payment Link': form['Half Payment Link'],
                  'Whole Price': form['Whole Price'],
                  'Whole lbs': form['Whole lbs'],
                  'Whole Payment Link': form['Whole Payment Link'],
                  Testimonials: validTestimonials.length
                    ? JSON.stringify(validTestimonials)
                    : '',
                });
                if (ok) {
                  // After pricing, route to step 4 (Book Call). If the rancher
                  // already has Call Complete on file (e.g. Ben backfilled or
                  // they came back to a partially-onboarded record), skip the
                  // booking step and prime the signing token for step 5.
                  if (canSkipBooking()) {
                    primeSigningToken();
                    setStep(5);
                  } else {
                    setStep(4);
                  }
                }
              }}
            />
          </section>
        )}

        {/* STEP 4 — Book onboarding call (Hybrid B gate) */}
        {step === 4 && (
          <CallStep
            rancher={rancher}
            onAlreadyComplete={() => {
              primeSigningToken();
              setStep(5);
            }}
            onBack={() => setStep(3)}
            onProceedAnyway={() => {
              primeSigningToken();
              setStep(5);
            }}
          />
        )}

        {/* STEP 5 — Inline sign agreement */}
        {step === 5 && (
          <SignStep
            rancher={rancher}
            form={form}
            signingToken={signingToken}
            primeSigningToken={primeSigningToken}
            signatureName={signatureName}
            setSignatureName={setSignatureName}
            agreedToTerms={agreedToTerms}
            setAgreedToTerms={setAgreedToTerms}
            signing={signing}
            onSign={signAgreement}
            onBack={() => setStep(canSkipBooking() ? 3 : 4)}
          />
        )}

        {/* STEP 6 — Done. Auto-redirect to dashboard via dashboardLink. */}
        {step === 6 && (
          <section className="space-y-5 bg-sage/10 border-2 border-sage p-7 md:p-8 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-sage-dark font-bold">
              You&rsquo;re live
            </p>
            <h2 className="font-serif text-3xl md:text-4xl text-charcoal">
              Welcome to the network.
            </h2>
            <p className="text-charcoal/85 max-w-md mx-auto leading-relaxed">
              <strong>{rancher.ranchName}</strong> is signed and locked in.
              Your public page is live, your dashboard is ready, and BuyHalfCow
              starts routing buyers in your state immediately.
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-3">
              {dashboardLink ? (
                <a
                  href={dashboardLink}
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
                >
                  Open my dashboard →
                </a>
              ) : (
                <Link
                  href="/rancher"
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
                >
                  Open my dashboard →
                </Link>
              )}
              <Link
                href={`/ranchers/${rancher.slug}`}
                className="inline-flex items-center gap-2 px-7 py-3.5 border border-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-charcoal hover:text-bone"
              >
                View my public page →
              </Link>
            </div>
          </section>
        )}

          </div>
          {/* Right column — sticky live preview, desktop only. Mobile uses the
              accordion above. Hidden on intro / sign / done screens. */}
          {showLivePreview && (
            <aside className="hidden lg:block lg:sticky lg:top-6 self-start space-y-2">
              <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                Live preview
              </p>
              <LivePreview {...previewProps} />
              <p className="text-[11px] text-dust italic leading-relaxed">
                What families will see at /ranchers/{rancher.slug}. Updates
                as you type.
              </p>
            </aside>
          )}
        </div>

        {/* Always-available escape hatch + remove option */}
        <div className="border-t border-dust pt-6 space-y-3 text-center text-sm text-saddle">
          <div>
            Want to talk first?{' '}
            <a
              href={CALENDLY_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-charcoal"
            >
              Book a 15-min call with Ben
            </a>
            {' · '}
            or reply to your welcome email.
          </div>
          <RemoveMeLink token={token} ranchName={rancher.ranchName} />
        </div>
      </div>
    </Container>
  );
}

// ── Form helpers ──────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
}: {
  label: string;
  value: any;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-charcoal mb-1.5">
        {label} {required && <span className="text-weathered">*</span>}
      </span>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  required,
  children,
}: {
  label: string;
  value: any;
  onChange: (v: string) => void;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-charcoal mb-1.5">
        {label} {required && <span className="text-weathered">*</span>}
      </span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle"
      >
        {children}
      </select>
    </label>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  label: string;
  value: any;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-charcoal mb-1.5">{label}</span>
      <textarea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle resize-y"
      />
    </label>
  );
}

function StepFooter({
  saving,
  onContinue,
  onBack,
}: {
  saving: boolean;
  onContinue: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2">
      <button
        type="button"
        onClick={onContinue}
        disabled={saving}
        className="inline-flex items-center gap-2 justify-center px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save & continue →'}
      </button>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-saddle hover:text-charcoal underline underline-offset-4"
        >
          ← Back
        </button>
      )}
    </div>
  );
}

function SaveIndicator({
  saving,
  lastSavedAt,
}: {
  saving: boolean;
  lastSavedAt: Date | null;
}) {
  // Live "Saved · 2s ago" hint — builds trust that the wizard isn't going
  // to eat their work. Updates relative time once a second so it stays fresh.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (saving) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-saddle">
        <span className="w-1.5 h-1.5 rounded-full bg-saddle animate-pulse" aria-hidden />
        Saving…
      </span>
    );
  }
  if (!lastSavedAt) return <span className="text-xs text-dust">Not saved yet</span>;

  const sec = Math.max(0, Math.floor((Date.now() - lastSavedAt.getTime()) / 1000));
  const label =
    sec < 5 ? 'just now' : sec < 60 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-sage-dark">
      <span aria-hidden>✓</span>
      Saved {label}
    </span>
  );
}

function ReviewRow({ label, value }: { label: string; value: any }) {
  if (!value) return null;
  return (
    <div className="flex flex-col sm:flex-row sm:gap-3">
      <span className="text-saddle text-xs uppercase tracking-widest w-32 shrink-0">
        {label}
      </span>
      <span className="text-charcoal">{String(value)}</span>
    </div>
  );
}

// Step 4 — inline agreement. Primes the signing JWT on mount, shows a
// scrollable plain-text agreement summary, captures typed signature name +
// "I agree" checkbox, POSTs to /api/ranchers/sign-agreement. On success
// the parent flips to step 5 with a dashboardLink for instant login.
function SignStep({
  rancher,
  form,
  signingToken,
  primeSigningToken,
  signatureName,
  setSignatureName,
  agreedToTerms,
  setAgreedToTerms,
  signing,
  onSign,
  onBack,
}: {
  rancher: Rancher;
  form: Record<string, any>;
  signingToken: string;
  primeSigningToken: () => Promise<void>;
  signatureName: string;
  setSignatureName: (v: string) => void;
  agreedToTerms: boolean;
  setAgreedToTerms: (v: boolean) => void;
  signing: boolean;
  onSign: () => void;
  onBack: () => void;
}) {
  // Backstop: if step 3 didn't prime the token (race / refresh), prime here.
  useEffect(() => {
    if (!signingToken) primeSigningToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 4</p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          Lock it in &mdash; sign the partner agreement
        </h2>
        <p className="text-sm text-saddle mt-1">
          One signature. No PDF, no notary, no email round-trip. As soon as
          you sign, your page goes live and we start routing buyers.
        </p>
      </header>

      {/* Public listing review — what families see */}
      <div className="bg-bone-warm border border-dust p-5 space-y-3 text-sm text-charcoal/85">
        <p className="text-xs uppercase tracking-widest text-saddle">Your public listing</p>
        <ReviewRow label="Ranch" value={rancher.ranchName} />
        <ReviewRow label="Operator" value={rancher.operatorName} />
        <ReviewRow label="Email" value={form.Email} />
        <ReviewRow
          label="Location"
          value={`${form.City || ''}${form.State ? ', ' + form.State : ''}`}
        />
        {form['States Served'] && <ReviewRow label="Ships to" value={form['States Served']} />}
        {form.Tagline && <ReviewRow label="Tagline" value={form.Tagline} />}
        {form['Beef Types'] && <ReviewRow label="Beef Types" value={form['Beef Types']} />}
        {(form['Tier Specialty'] || []).length > 0 && (
          <ReviewRow label="Sells" value={(form['Tier Specialty'] || []).join(', ')} />
        )}
        {form['Quarter Price'] && (
          <ReviewRow
            label="Quarter price"
            value={`$${form['Quarter Price']}${form['Quarter lbs'] ? ' · ' + form['Quarter lbs'] : ''}`}
          />
        )}
        {form['Half Price'] && (
          <ReviewRow
            label="Half price"
            value={`$${form['Half Price']}${form['Half lbs'] ? ' · ' + form['Half lbs'] : ''}`}
          />
        )}
        {form['Whole Price'] && (
          <ReviewRow
            label="Whole price"
            value={`$${form['Whole Price']}${form['Whole lbs'] ? ' · ' + form['Whole lbs'] : ''}`}
          />
        )}
      </div>

      {/* First-buyer simulation — shows what the rancher's first inbound
          intro will look like. Builds anticipation + makes the "leads will
          actually come" promise concrete. Fully hard-coded mock; no fetch. */}
      <div className="border border-charcoal bg-charcoal text-bone p-5 space-y-3">
        <p className="text-[11px] uppercase tracking-widest text-bone/70 font-semibold">
          Sneak peek — your first buyer intro
        </p>
        <p className="text-sm text-bone/85 leading-relaxed">
          When a buyer in {rancher['State'] as any || form.State || 'your state'} qualifies for {rancher.ranchName}, this lands in your inbox:
        </p>
        <div className="bg-bone text-charcoal p-4 space-y-2">
          <p className="text-[11px] text-saddle font-mono">
            From: BuyHalfCow &lt;ben@buyhalfcow.com&gt;
          </p>
          <p className="text-[11px] text-saddle font-mono">
            To: {form.Email || 'you@yourranch.com'}
          </p>
          <p className="text-sm font-bold text-charcoal">
            🟢 New buyer for {rancher.ranchName} — Sarah K., {form.State || 'MT'}
          </p>
          <p className="text-sm text-charcoal/85 leading-relaxed">
            Sarah just signed up looking for a Half cow, budget $1,200-$1,500,
            ready to buy in the next 1-2 months. She picked you. Reach out
            within 24h — buyers go cold fast.
          </p>
          <p className="text-sm text-charcoal/85">
            <strong>Phone:</strong> (406) 555-0142<br />
            <strong>Email:</strong> sarah.k@example.com<br />
            <strong>Notes:</strong> &ldquo;Family of 5, freezer space, prefers
            grass-fed.&rdquo;
          </p>
        </div>
        <p className="text-xs text-bone/70 italic leading-relaxed">
          That&rsquo;s the whole product. Pre-screened, in-state, ready-to-buy.
          You sign below and we start routing real ones to {rancher.ranchName}.
        </p>
      </div>

      {/* Plain-language agreement summary. Full legal text linked. */}
      <div className="border border-dust p-5 space-y-3 text-sm text-charcoal/85 leading-relaxed">
        <p className="text-xs uppercase tracking-widest text-saddle">Partner Agreement &mdash; the gist</p>
        <ul className="space-y-2 list-none">
          <li className="flex gap-2.5">
            <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
            <span>
              <strong>10% commission</strong> on closed deals only. Nothing on
              tire-kickers, nothing on no-shows.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
            <span>
              <strong>You set your prices.</strong> Your capacity, your
              processing dates, your cut sheets. We don&rsquo;t lock you in.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
            <span>
              <strong>Non-exclusive.</strong> Sell at farmers markets, sell off
              your own site, sell anywhere. We&rsquo;re an extra channel, not
              a leash.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
            <span>
              <strong>Pause or leave any time.</strong> One click pauses
              routing. 30 days&rsquo; notice ends the partnership cleanly.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
            <span>
              <strong>Honest delivery.</strong> You ship the beef on the
              processing date you committed to, or refund the buyer. We take
              that seriously.
            </span>
          </li>
        </ul>
        <p className="text-xs text-dust pt-2">
          Full legal terms are at{' '}
          <a
            href="/terms"
            target="_blank"
            className="underline underline-offset-2 hover:text-charcoal"
          >
            buyhalfcow.com/terms
          </a>
          . Anything in there contradicts the bullets above? The bullets win.
        </p>
      </div>

      {/* Signature block */}
      <div className="space-y-4 border-t border-dust pt-5">
        <label className="block">
          <span className="block text-sm font-medium text-charcoal mb-1.5">
            Type your full legal name as your signature{' '}
            <span className="text-weathered">*</span>
          </span>
          <input
            type="text"
            value={signatureName}
            onChange={(e) => setSignatureName(e.target.value)}
            placeholder="Jane Smith"
            className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal font-serif italic transition-base focus:outline-none focus:border-charcoal hover:border-saddle"
          />
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={agreedToTerms}
            onChange={(e) => setAgreedToTerms(e.target.checked)}
            className="mt-1 w-4 h-4 accent-charcoal cursor-pointer"
          />
          <span className="text-sm text-charcoal/85 leading-relaxed">
            I&rsquo;m {rancher.operatorName || 'the operator'} of{' '}
            <strong>{rancher.ranchName}</strong>, I have authority to enter
            this agreement, and I agree to the terms above and at{' '}
            <a
              href="/terms"
              target="_blank"
              className="underline underline-offset-2 hover:text-charcoal"
            >
              buyhalfcow.com/terms
            </a>
            .
          </span>
        </label>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center pt-2">
        <button
          type="button"
          onClick={onSign}
          disabled={signing || !signingToken || !signatureName.trim() || !agreedToTerms}
          className="inline-flex items-center gap-2 justify-center px-7 py-3.5 bg-charcoal text-bone text-sm font-bold tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {signing ? 'Signing…' : 'Sign & go live →'}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-saddle hover:text-charcoal underline underline-offset-4"
        >
          ← Back
        </button>
      </div>
    </section>
  );
}

// ── Step 4 — Hybrid B onboarding call gate ────────────────────────────────
// Embeds the Cal.com booking iframe. Once the rancher books, Cal.com fires
// BOOKING_CREATED → /api/webhooks/cal flips Onboarding Status to "Call
// Scheduled". After Ben hops on the call and marks Call Complete (via
// Telegram callback or Airtable directly), the rancher's next return to
// the wizard auto-skips this step (canSkipBooking() returns true).
//
// Status display logic per current rancher.onboardingStatus:
//   "" / "New"             → show booking embed, primary CTA
//   "Call Scheduled"       → show "you booked, here's what to expect"
//   "Call Complete"+       → auto-skip via parent, but defensive UI here too
function CallStep({
  rancher,
  onAlreadyComplete,
  onBack,
  onProceedAnyway,
}: {
  rancher: Rancher;
  onAlreadyComplete: () => void;
  onBack: () => void;
  onProceedAnyway: () => void;
}) {
  const status = (rancher.onboardingStatus || '').toString();
  const calBookingUrl =
    process.env.NEXT_PUBLIC_CALENDLY_LINK ||
    'https://cal.com/ben-beauchman-1itnsg/30min';
  // Cal.com inline embed URL — append `?embed=true&theme=light` for clean iframe
  const embedUrl = `${calBookingUrl}?embed=true&theme=light&hideEventTypeDetails=false`;

  const alreadyBooked = status === 'Call Scheduled';
  const callDone =
    status === 'Call Complete' ||
    status === 'Verification Pending' ||
    status === 'Verification Complete' ||
    status === 'Live';

  if (callDone) {
    // Edge case: parent should have auto-skipped, but render fallback so
    // the rancher isn't dead-ended if the parent gate logic ever drifts.
    return (
      <section className="space-y-5 bg-bone border border-dust p-7 md:p-8">
        <header>
          <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 4</p>
          <h2 className="font-serif text-2xl text-charcoal">Call already done.</h2>
          <p className="text-sm text-saddle mt-1">
            Looks like you&rsquo;ve already had your onboarding call. Let&rsquo;s
            jump to the agreement.
          </p>
        </header>
        <button
          type="button"
          onClick={onAlreadyComplete}
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
        >
          Sign agreement →
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 4</p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          {alreadyBooked ? 'Your call is booked.' : 'Book your 15-min onboarding call.'}
        </h2>
        <p className="text-sm text-saddle mt-1">
          {alreadyBooked
            ? `Great — looking forward to chatting. After our call, I'll mark you complete and unlock the agreement signing step.`
            : `One short call before you go live. We walk through your operation, answer your questions, confirm fit, and queue up your agreement. After the call you sign + go live.`}
        </p>
      </header>

      {!alreadyBooked && (
        <>
          <div className="bg-bone-warm border border-dust p-5 space-y-2 text-sm text-charcoal/85">
            <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
              What we&rsquo;ll cover (15 min)
            </p>
            <ul className="space-y-1.5">
              <li className="flex gap-2.5">
                <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
                <span>Your operation, herd size, processing rhythm</span>
              </li>
              <li className="flex gap-2.5">
                <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
                <span>How matching + intro emails work day-to-day</span>
              </li>
              <li className="flex gap-2.5">
                <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
                <span>Pricing strategy + commission mechanics</span>
              </li>
              <li className="flex gap-2.5">
                <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
                <span>Anything you want to ask before signing</span>
              </li>
            </ul>
          </div>

          <div
            className="relative w-full overflow-hidden border border-dust"
            style={{ minHeight: '600px' }}
          >
            <iframe
              src={embedUrl}
              title="Book onboarding call with Ben"
              className="absolute inset-0 w-full h-full"
              allow="camera; microphone; autoplay; encrypted-media; fullscreen"
              loading="lazy"
            />
          </div>

          <p className="text-xs text-dust leading-relaxed text-center">
            Once you book, we&rsquo;ll auto-stamp this step. After the call,
            sign agreement + go live.
          </p>
        </>
      )}

      {alreadyBooked && (
        <div className="bg-sage/10 border border-sage p-5 space-y-3">
          <p className="text-sm text-charcoal/85 leading-relaxed">
            Need to reschedule? Use the link in your booking confirmation email
            from Cal.com. After our call, this step auto-completes and you can
            sign your agreement.
          </p>
          <a
            href={calBookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline underline-offset-2 text-sage-dark hover:text-charcoal"
          >
            Reschedule on Cal.com →
          </a>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center pt-2 border-t border-dust">
        <button
          type="button"
          onClick={onProceedAnyway}
          disabled={!alreadyBooked}
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-40 disabled:cursor-not-allowed"
          title={alreadyBooked ? '' : 'Book a call first'}
        >
          {alreadyBooked ? 'Continue to agreement →' : 'Book a call to continue'}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-saddle hover:text-charcoal underline underline-offset-4"
        >
          ← Back
        </button>
      </div>
    </section>
  );
}

// ── Self-serve removal link ──────────────────────────────────────────────
// Always visible in the footer of the wizard. Click → confirm modal →
// POST /api/rancher/remove with optional reason. Soft-deletes the record.
function RemoveMeLink({ token, ranchName }: { token: string; ranchName: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');

  if (done) {
    return (
      <p className="text-sm text-charcoal">
        ✓ {ranchName} has been removed from BuyHalfCow. You can close this tab.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-dust hover:text-weathered underline underline-offset-2"
      >
        Remove {ranchName} from BuyHalfCow
      </button>
    );
  }

  return (
    <div className="border border-weathered/40 bg-weathered/5 p-4 text-left max-w-md mx-auto space-y-3">
      <p className="text-sm text-charcoal">
        Remove <strong>{ranchName}</strong> from BuyHalfCow?
      </p>
      <p className="text-xs text-saddle leading-relaxed">
        Soft-delete: hidden from the public map, paused from buyer routing,
        drip emails stopped. Record stays in the database for audit but
        nothing surfaces publicly. Reversible if you change your mind — email{' '}
        <a className="underline" href="mailto:ben@buyhalfcow.com">
          ben@buyhalfcow.com
        </a>
        .
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional — helps us improve)"
        rows={2}
        className="w-full px-3 py-2 border border-dust bg-bone text-sm text-charcoal focus:outline-none focus:border-charcoal"
      />
      {err && <p className="text-xs text-weathered">{err}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={async () => {
            setSubmitting(true);
            setErr('');
            try {
              const res = await fetch(
                `/api/rancher/remove?token=${encodeURIComponent(token)}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reason: reason.trim() }),
                }
              );
              const data = await res.json();
              if (!res.ok) throw new Error(data?.error || 'Removal failed');
              setDone(true);
            } catch (e: any) {
              setErr(e?.message || 'Removal failed');
            } finally {
              setSubmitting(false);
            }
          }}
          disabled={submitting}
          className="text-xs px-4 py-2 bg-weathered text-bone uppercase tracking-widest font-bold hover:bg-charcoal transition-base disabled:opacity-50"
        >
          {submitting ? 'Removing…' : 'Confirm remove'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs px-4 py-2 border border-dust text-saddle uppercase tracking-widest hover:border-charcoal hover:text-charcoal transition-base"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
