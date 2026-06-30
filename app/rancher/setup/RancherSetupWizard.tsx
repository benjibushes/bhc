'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Container from '../../components/Container';
import ImageUploader from '../../components/ImageUploader';
import LivePreview from './LivePreview';
import StripeConnectStep from './steps/StripeConnectStep';
import {
  deriveLadder,
  deriveDeposit,
  checkWholePrice,
  impliedPerLb,
  MIN_TIER_PRICE,
} from '@/lib/pricing';

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
  callCompletedAt?: string;
  Email?: string;
  Phone?: string;
  City?: string;
  State?: string;
  Zip?: string;
  'States Served'?: string;
  'Beef Types'?: string;
  'Cal.com Slug'?: string;
  'Logo URL'?: string;
  Tagline?: string;
  'About Text'?: string;
  'Video URL'?: string;
  'Quarter Price'?: number;
  'Quarter Deposit'?: number;
  'Quarter Processing Fee'?: number;
  'Quarter lbs'?: string;
  'Quarter Payment Link'?: string;
  'Half Price'?: number;
  'Half Deposit'?: number;
  'Half Processing Fee'?: number;
  'Half lbs'?: string;
  'Half Payment Link'?: string;
  'Whole Price'?: number;
  'Whole Deposit'?: number;
  'Whole Processing Fee'?: number;
  'Whole lbs'?: string;
  'Whole Payment Link'?: string;
  'Tier Specialty'?: string[];
  'Custom Notes'?: string;
  // Stage-3 tier subscription state (Task 11)
  Tier?: string | { name: string };
  'Subscription Status'?: string;
  'Pricing Model'?: string;
  // Stage-3 fulfillment fields (Task 11B)
  'Fulfillment Types'?: string[];
  'Pickup City'?: string;
  'Delivery Radius Miles'?: number;
  'Shipping Lead Time Days'?: number;
  'Refund Policy'?: string;
  'Fulfillment Cost Notes'?: string;
};

// Tier card data. Source of truth lives in lib/tiers.ts; mirrored here as
// static copy so the wizard renders without an extra fetch. If lib/tiers.ts
// changes, update these. The slugs MUST match TierSlug exactly.
//
// `mode` distinguishes how the card's CTA behaves:
//   - 'checkout': opens /partner/checkout/[slug] for Stripe Subscription
//     (Pasture/Ranch/Operator — all monthly recurring billing).
//   - 'inline':   directly POSTs /api/rancher/tier/select with no
//     subscription created. Used for Legacy Connect — Stripe Connect
//     deposits + 10% commission per sale + NO monthly fee. The rancher
//     never sees a Stripe Checkout for tier; they go straight from picking
//     the card → bank connect.
const TIER_CARDS: Array<{
  slug: 'pasture' | 'ranch' | 'operator' | 'legacy_connect';
  label: string;
  price: string;
  promise: string;
  perks: string[];
  mode: 'checkout' | 'inline';
}> = [
  // Free tier FIRST + prominent. This is the default self-serve path: $0 to
  // join, BHC earns 10% only when the rancher actually sells. Honest match to
  // the entry page's "$0 setup · 10% on what closes" promise. The paid tiers
  // below are an OPTIONAL upgrade (more leads / lower commission), never a wall.
  {
    slug: 'legacy_connect',
    label: 'Legacy Connect',
    price: 'Free to start · 10% per sale',
    promise: 'Pay nothing up front. BHC earns 10% only when you actually sell — same buyer routing as the paid tiers.',
    perks: [
      'No monthly fee — $0 to join',
      '10% commission only on closed sales (deducted at deposit)',
      'Stripe Connect direct-to-bank payouts',
      'Same buyer routing as paid tiers',
    ],
    mode: 'inline',
  },
  {
    slug: 'pasture',
    label: 'Pasture',
    price: 'Upgrade · $150/mo + 7%',
    promise: 'Optional upgrade: drop your commission to 7% on a flat monthly.',
    perks: ['Lower 7% commission', 'Buyer matching for your states', 'Lead inbox'],
    mode: 'checkout',
  },
  {
    slug: 'ranch',
    label: 'Ranch',
    price: 'Upgrade · $350/mo + 3%',
    promise: 'Optional upgrade: more leads — we make sure buyers see you first.',
    perks: ['Just 3% commission', 'Priority placement', 'Featured ranch badge', 'Homepage rotation slot'],
    mode: 'checkout',
  },
  {
    slug: 'operator',
    label: 'Operator',
    price: 'Upgrade · $500/mo + 0%',
    promise: 'Optional upgrade: 0% commission and we run your marketing for you.',
    perks: ['0% commission', 'Dedicated brand strategist', 'Monthly content + social cadence'],
    mode: 'checkout',
  },
];

// Pull tier slug from a Rancher record. Mirrors lib/tiers.ts tierFor() but
// operates on the wizard's lighter `Rancher` shape (Airtable returns either
// a string or {name} for singleSelect fields).
function tierSlugFromRancher(r: Rancher | null): 'pasture' | 'ranch' | 'operator' | 'legacy_connect' | null {
  if (!r) return null;
  const raw = r.Tier;
  const str = raw && typeof raw === 'object' && 'name' in raw ? String(raw.name) : String(raw || '');
  const slug = str.toLowerCase();
  if (slug === 'pasture' || slug === 'ranch' || slug === 'operator') return slug;
  // 'Legacy Connect' (Airtable display) → 'legacy_connect' (code slug)
  if (slug === 'legacy connect' || slug === 'legacy_connect') return 'legacy_connect';
  return null;
}

const FULFILLMENT_OPTIONS = [
  { value: 'Local Pickup', label: 'Local pickup at my ranch' },
  { value: 'Local Delivery', label: 'Local delivery (within driving distance)' },
  { value: 'Cold-Chain Shipping', label: 'Cold-chain shipping (FedEx/UPS)' },
] as const;

// Max gallery photos — mirrors the rancher dashboard's "up to 8" cap so the
// two editors agree.
const MAX_GALLERY_PHOTOS = 8;

// ── Gallery Photos (de)serialization ───────────────────────────────────────
// Stored in the `Gallery Photos` Airtable field. IMPORTANT: every existing
// CONSUMER of this field — the public buyer page (app/ranchers/[slug]/page.tsx,
// which uses gallery[0] as the cover hero), the rancher dashboard
// (app/rancher/page.tsx), and the admin editor — reads it as a JSON ARRAY of
// URL strings via JSON.parse. So the wizard ALSO serializes as a JSON array;
// writing newline-separated text here would make every wizard-added photo
// invisible on the public listing (JSON.parse throws → empty gallery → no
// cover photo), which is the exact opposite of this feature's goal (photos are
// the #1 conversion lever). parseGallery is tolerant of BOTH a JSON array and
// a legacy newline-separated string so older data still renders; serializeGallery
// always writes the consumer-correct JSON array.
function parseGallery(raw: any): string[] {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter(Boolean);
  }
  const str = String(raw ?? '').trim();
  if (!str) return [];
  // Try JSON array first (the format every consumer writes/reads).
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s).trim()).filter(Boolean);
      }
    } catch {
      /* fall through to newline parsing */
    }
  }
  // Fallback: newline-separated URLs (trim, drop blanks).
  return str
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function serializeGallery(urls: string[]): string {
  const clean = urls.map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? JSON.stringify(clean) : '';
}

const CALENDLY_LINK = 'https://cal.com/ben-beauchman-1itnsg/30min';
// Operator inbox surfaced to ranchers as the Cal "Additional Guest" so Ben sees
// every booking. Extracted from inline JSX — value unchanged.
const OPERATOR_NOTIFY_EMAIL = 'benibeauchman@gmail.com';

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
  // CLOSE-FIRST onboarding flow (reordered 2026-06-22):
  //   Step 0 = intro (business model + video)
  //   Step 4 = Book onboarding call with Ben (Cal.com embed). REQUIRED GATE,
  //            now at the FRONT — setup stays locked until the call is done.
  //            The only way past for a not-yet-called rancher is to book; the
  //            gate opens (canSkipBooking → true) once Onboarding Status hits
  //            'Call Complete' (Ben backfilled it for an existing rancher OR
  //            finished the call and tapped the Telegram callback).
  //   Step 1-3 = page setup (contact / brand / pricing)
  //   Step 7 = Pick Your Plan (tier subscription) [Stage-3 Task 11A]
  //   Step 9 = Stripe Connect onboarding (tier_v2 only) [Stage-3 Task D2]
  //   Step 8 = Fulfillment + Refund Policy [Stage-3 Task 11B]
  //   Step 5 = inline agreement signing
  //   Step 6 = done (logged in, dashboard auto-link)
  //
  // Order is 0→4→1→2→3→7→9→8→5→6 (CALL is the front gate; 7/9/8 sit before Sign).
  //   tier_v2: 0 → 4 → 1 → 2 → 3 → 7 → 9 → 8 → 5
  //   legacy:  0 → 4 → 1 → 2 → 3 → 8 → 5   (skip 7+9)
  // Step 9 auto-advances for legacy ranchers (no Connect needed).
  // Numbering is awkward (step NUMBERS aren't in flow order) to preserve
  // existing setStep call sites; do NOT re-sequence without auditing every
  // setStep(...) in this file AND the close-first progress bar (PROGRESS_ORDER).
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9>(0);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  // P1-1 auto-save: track per-field status so we can show "saving…" → "saved"
  // micro-indicators next to long-form fields. Map key: field name (e.g.
  // 'About Text'), value: 'idle' | 'saving' | 'saved'. 'saved' fades after 3s.
  const [autoSaveStatus, setAutoSaveStatus] = useState<Record<string, 'idle' | 'saving' | 'saved'>>({});
  const autoSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const autoSavedFadeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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

  // ── Step-3 pricing model (2026-06-20 rebuild) ────────────────────────────
  // Rancher enters ONE number — the whole-cow price — and lib/pricing derives
  // the Half/Quarter ladder + every tier's reserve deposit. `priceUnit` lets
  // them type a per-pound rate instead (× hanging weight → whole total).
  // `touchedDerived` tracks which derived fields the rancher hand-edited so we
  // never clobber a deliberate override when the whole price changes.
  const [priceUnit, setPriceUnit] = useState<'total' | 'perlb'>('total');
  const [perLbInput, setPerLbInput] = useState('');
  const [hangingLbsInput, setHangingLbsInput] = useState('');
  const [touchedDerived, setTouchedDerived] = useState<Set<string>>(new Set());

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
            'Cal.com Slug': data.rancher['Cal.com Slug'] || '',
            'Logo URL': data.rancher['Logo URL'] || '',
            Tagline: data.rancher.Tagline || '',
            'About Text': data.rancher['About Text'] || '',
            'Video URL': data.rancher['Video URL'] || '',
            // Stored as a JSON array of URLs (see parseGallery/serializeGallery).
            // Normalize on load so the gallery editor + Save always round-trip
            // through the consumer-correct JSON shape regardless of legacy format.
            'Gallery Photos': serializeGallery(parseGallery(data.rancher['Gallery Photos'])),
            // Date (YYYY-MM-DD) — buyers see "next available processing date".
            'Next Processing Date': data.rancher['Next Processing Date'] || '',
            'Quarter Price': data.rancher['Quarter Price'] || '',
            'Quarter Deposit': data.rancher['Quarter Deposit'] || '',
            'Quarter Processing Fee': data.rancher['Quarter Processing Fee'] || '',
            'Quarter lbs': data.rancher['Quarter lbs'] || '',
            'Quarter Payment Link': data.rancher['Quarter Payment Link'] || '',
            'Half Price': data.rancher['Half Price'] || '',
            'Half Deposit': data.rancher['Half Deposit'] || '',
            'Half Processing Fee': data.rancher['Half Processing Fee'] || '',
            'Half lbs': data.rancher['Half lbs'] || '',
            'Half Payment Link': data.rancher['Half Payment Link'] || '',
            'Whole Price': data.rancher['Whole Price'] || '',
            'Whole Deposit': data.rancher['Whole Deposit'] || '',
            'Whole Processing Fee': data.rancher['Whole Processing Fee'] || '',
            'Whole lbs': data.rancher['Whole lbs'] || '',
            'Whole Payment Link': data.rancher['Whole Payment Link'] || '',
            'Tier Specialty': Array.isArray(data.rancher['Tier Specialty'])
              ? data.rancher['Tier Specialty']
              : [],
            'Custom Notes': data.rancher['Custom Notes'] || '',
            // Stage-3 Task 11B — fulfillment + refund fields
            'Fulfillment Types': Array.isArray(data.rancher['Fulfillment Types'])
              ? data.rancher['Fulfillment Types']
              : [],
            'Pickup City': data.rancher['Pickup City'] || '',
            'Delivery Radius Miles': data.rancher['Delivery Radius Miles'] || '',
            'Shipping Lead Time Days': data.rancher['Shipping Lead Time Days'] || '',
            'Refund Policy': data.rancher['Refund Policy'] || '',
            'Fulfillment Cost Notes': data.rancher['Fulfillment Cost Notes'] || '',
          });

          // Touched-init (Step-3 pricing): if this rancher already has a
          // CUSTOM ladder/deposit on file (a value that doesn't match what we'd
          // derive from the loaded Whole Price), mark those keys touched so the
          // first edit to the whole price doesn't silently overwrite their
          // hand-set numbers. With no whole price on file, nothing is derived
          // yet, so leave touched empty.
          const loadedWhole = Number(data.rancher['Whole Price']);
          if (loadedWhole > 0) {
            const ladder = deriveLadder(loadedWhole);
            const touched = new Set<string>();
            const halfP = Number(data.rancher['Half Price']);
            if (halfP > 0 && halfP !== ladder.half) touched.add('Half Price');
            const quarterP = Number(data.rancher['Quarter Price']);
            if (quarterP > 0 && quarterP !== ladder.quarter) touched.add('Quarter Price');
            for (const tier of ['Quarter', 'Half', 'Whole'] as const) {
              const loadedDep = Number(data.rancher[`${tier} Deposit`]);
              // Compare against the deposit derived from the loaded tier price
              // (overridden ladder prices use their loaded value).
              const loadedTierPrice = Number(data.rancher[`${tier} Price`]);
              const derivedDep = deriveDeposit(loadedTierPrice);
              if (loadedDep > 0 && loadedDep !== derivedDep) touched.add(`${tier} Deposit`);
            }
            setTouchedDerived(touched);
          }
        }
      } catch {
        setError('Network error — try refreshing');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // Resume-from-Stripe handler. After /api/rancher/connect/start sends a tier_v2
  // rancher to Stripe Express, Stripe redirects back here with ?connectComplete=1
  // and the wizard should jump straight to Step 8 (Fulfillment) instead of
  // making them restart from Step 0. Only run once rancher data is loaded so
  // we don't fight the initial setStep(0).
  const connectComplete = searchParams.get('connectComplete') === '1';
  useEffect(() => {
    if (!connectComplete) return;
    if (!rancher) return;
    setStep(8);
  }, [connectComplete, rancher]);

  // Resume-from-paid-tier-checkout handler. After a Pasture/Ranch/Operator
  // subscription clears in Stripe, tier/select's successUrl returns the rancher
  // here with ?tierComplete=1. They must land at Step 9 (Connect bank) so they
  // finish Stripe Connect → Fulfillment → Sign instead of being stranded on
  // /rancher/billing (the old new-tab /partner/checkout success target). Mirror
  // of the connectComplete handler above. Only runs once rancher data is loaded.
  const tierComplete = searchParams.get('tierComplete') === '1';
  useEffect(() => {
    if (!tierComplete) return;
    if (!rancher) return;
    setStep(9);
  }, [tierComplete, rancher]);

  // P1-2 — localStorage step persistence. Rancher returning next day with
  // their token would always land at Step 0 even if they'd previously made it
  // to Step 7. Now we save the current step keyed by a short token hash so
  // the next visit picks up where they left off.
  //
  // Hash, don't store: the wizard token is a JWT (sensitive). We never put
  // the full token in localStorage — just a non-reversible hash that's stable
  // for the same token. Step number itself is non-PII so storing it is safe.
  //
  // Precedence: ?connectComplete=1 (Stripe return) overrides saved step (per
  // P0-2 fix). The Stripe useEffect runs second-ish but its setStep(8) call
  // wins because both useEffects depend on `rancher` and React batches state
  // updates — the saved-step restore happens once, then Stripe overrides if
  // ?connectComplete=1 is present.
  function tokenHashFor(t: string): string {
    if (!t) return '';
    // Cheap deterministic 32-bit hash (djb2). Sufficient to scope a
    // localStorage key per-rancher without leaking the token contents.
    let h = 5381;
    for (let i = 0; i < t.length; i++) {
      h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    }
    return `t${(h >>> 0).toString(36)}`;
  }
  const stepStorageKey = token ? `bhc_setup_step_${tokenHashFor(token)}` : '';

  // Restore saved step on first load after rancher data is available. Skip
  // when ?connectComplete=1 is present — the Stripe useEffect handles that.
  // Run once per rancher load (guarded by didRestoreStep ref).
  const didRestoreStep = useRef(false);
  useEffect(() => {
    if (!rancher) return;
    if (connectComplete) return; // Stripe Connect-return handler wins
    if (tierComplete) return; // paid-tier-return handler wins (jumps to Step 9)
    if (didRestoreStep.current) return;
    if (!stepStorageKey) return;
    didRestoreStep.current = true;
    try {
      const saved = localStorage.getItem(stepStorageKey);
      if (!saved) return;
      const n = parseInt(saved, 10);
      // Only restore valid in-range steps; 0 means "start at intro" so we
      // skip — no point setting the same state we already have.
      if (n > 0 && n <= 9) {
        // CLOSE-FIRST gate enforcement: a rancher who has NOT done the call
        // (canSkipBooking() false) must never be restored PAST the required
        // call into a setup step. Clamp any forward-restore to the call gate
        // (step 4). Steps 5/6 (sign/done) imply the agreement is already in
        // motion, so leave those alone. A rancher who HAS done the call
        // (canSkipBooking() true) is restored exactly where they left off —
        // this preserves mid-onboarding ranchers (Renick/Anna) so they're not
        // stranded or re-gated.
        const restoreTarget =
          !canSkipBooking() && (n === 1 || n === 2 || n === 3 || n === 7 || n === 8 || n === 9)
            ? 4
            : n;
        setStep(restoreTarget as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9);
      }
    } catch {
      /* localStorage disabled — non-fatal, fall back to Step 0. */
    }
  }, [rancher, connectComplete, tierComplete, stepStorageKey]);

  // Persist step on every transition. Skip Step 10/6 — at "Done" we clear so
  // a subsequent rancher visiting the same machine isn't stuck on the
  // confetti screen.
  useEffect(() => {
    if (!stepStorageKey) return;
    try {
      // Step 6 = Done. Clear so a re-visit lands at Step 0 (or wherever
      // server-state guides them).
      if (step === 6) {
        localStorage.removeItem(stepStorageKey);
      } else {
        localStorage.setItem(stepStorageKey, String(step));
      }
    } catch {
      /* localStorage disabled — non-fatal. */
    }
  }, [step, stepStorageKey]);

  const setField = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }));

  // ── Pricing derivation (Step 3) ──────────────────────────────────────────
  // Given a form object + the set of hand-edited derived fields, recompute the
  // Half/Quarter ladder and every tier's deposit from the Whole Price. Any key
  // in `touched` is left exactly as the rancher set it (their override wins).
  // The deposit %/multipliers live ONLY in lib/pricing — never inline here.
  const PRICE_TIERS = ['Quarter', 'Half', 'Whole'] as const;
  function fillDerived(
    f: Record<string, any>,
    touched: Set<string>
  ): Record<string, any> {
    // Only derive into tiers the rancher actually SELLS — otherwise a rancher
    // who sells just Quarter but enters the whole-cow anchor would silently
    // publish derived Half/Whole tiers to buyers. (Unsold tiers are also nulled
    // in the save slice as a belt — see onContinue.)
    const sells: string[] = Array.isArray(f['Tier Specialty']) ? f['Tier Specialty'] : [];
    const whole = Number(f['Whole Price']) || 0;
    const next = { ...f };
    const ladder = deriveLadder(whole); // {0,0,0} when whole <= 0
    // Half/Quarter prices derive from the whole anchor (Whole is the input).
    // When the whole is cleared, blank the untouched derived prices too so a
    // stale ladder can't linger in form state or get saved.
    for (const tier of ['Half', 'Quarter'] as const) {
      if (!sells.includes(tier)) continue;
      const key = `${tier} Price`;
      if (touched.has(key)) continue;
      next[key] = whole > 0 ? (tier === 'Half' ? ladder.half : ladder.quarter) : '';
    }
    // Deposits derive from each SOLD tier's (possibly overridden) price, not the
    // ladder — so an overridden Half price still gets a matching deposit.
    for (const tier of PRICE_TIERS) {
      if (!sells.includes(tier)) continue;
      const depKey = `${tier} Deposit`;
      if (touched.has(depKey)) continue;
      const dep = deriveDeposit(Number(next[`${tier} Price`]) || 0);
      // Only write a positive derived deposit; leave blank if price not set
      // (deriveDeposit returns 0) so the field shows its placeholder.
      next[depKey] = dep > 0 ? dep : '';
    }
    return next;
  }

  // Whole-price input → recompute the whole ladder + deposits live.
  const onWholeChange = (v: string) =>
    setForm((f) => fillDerived({ ...f, 'Whole Price': v }, touchedDerived));

  // Half/Quarter price hand-edit → mark touched, then recompute (so the matching
  // deposit re-derives off the new price unless that deposit is also touched).
  const onLadderPriceChange = (tier: 'Half' | 'Quarter', v: string) => {
    const key = `${tier} Price`;
    const nextTouched = new Set(touchedDerived).add(key);
    setTouchedDerived(nextTouched);
    setForm((f) => fillDerived({ ...f, [key]: v }, nextTouched));
  };

  // Any tier's deposit hand-edit → mark touched, set value directly (a touched
  // deposit is never re-derived, so no recompute needed).
  const onDepositChange = (tier: 'Quarter' | 'Half' | 'Whole', v: string) => {
    const key = `${tier} Deposit`;
    setTouchedDerived((prev) => new Set(prev).add(key));
    setField(key, v);
  };

  // "reset" link → drop the override and recompute that field from the whole.
  const resetDerived = (key: string) => {
    const nextTouched = new Set(touchedDerived);
    nextTouched.delete(key);
    setTouchedDerived(nextTouched);
    setForm((f) => fillDerived({ ...f }, nextTouched));
  };

  // Per-lb mode: $/lb × hanging weight → whole total, fed through onWholeChange
  // so the same ladder/deposit derivation runs. Empty/invalid inputs clear the
  // whole price (so the form falls back to placeholders).
  const recomputeFromPerLb = (perLb: string, lbs: string) => {
    const p = Number(perLb);
    const w = Number(lbs);
    if (Number.isFinite(p) && p > 0 && Number.isFinite(w) && w > 0) {
      onWholeChange(String(Math.round(p * w)));
    } else {
      onWholeChange('');
    }
  };
  const onPerLbChange = (v: string) => {
    setPerLbInput(v);
    recomputeFromPerLb(v, hangingLbsInput);
  };
  const onHangingLbsChange = (v: string) => {
    setHangingLbsInput(v);
    recomputeFromPerLb(perLbInput, v);
  };

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
      // Coerce numeric price/deposit fields to numbers (form state is strings).
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(slice)) {
        if ((k.endsWith(' Price') || k.endsWith(' Deposit')) && v !== '' && v != null) {
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

  // P1-1 — debounced auto-save for long-form text fields. 800ms after the last
  // keystroke, PATCH the single field. Prevents the "I typed 4 paragraphs and
  // then closed the tab" disaster. Validation-failing values (e.g. Refund
  // Policy below 20 chars) are skipped — autoSave waits until valid.
  //
  // Per-field timers live in autoSaveTimers ref so a rapid second keystroke
  // cancels the pending PATCH and starts a fresh 800ms window. Indicator state
  // flips to 'saving' on fire, 'saved' on success, then fades to 'idle' after
  // 3s. No flicker because the fade timer is also debounced.
  //
  // Does NOT call setSaving / setLastSavedAt — those are reserved for the
  // explicit "Save & continue" button so the user still sees a clear primary
  // save action at step boundaries.
  const queueAutoSave = useCallback(
    (key: string, value: any, opts: { isValid?: (v: any) => boolean } = {}) => {
      const { isValid } = opts;
      // Cancel pending PATCH for this field.
      if (autoSaveTimers.current[key]) {
        clearTimeout(autoSaveTimers.current[key]);
      }
      // Don't fire when validation says wait (e.g. Refund Policy < 20 chars).
      if (isValid && !isValid(value)) {
        return;
      }
      autoSaveTimers.current[key] = setTimeout(async () => {
        setAutoSaveStatus((s) => ({ ...s, [key]: 'saving' }));
        try {
          const payload: Record<string, any> = {};
          if (key.endsWith(' Price') && value !== '' && value != null) {
            const n = Number(value);
            payload[key] = isFinite(n) ? n : '';
          } else {
            payload[key] = value;
          }
          const res = await fetch(
            `/api/rancher/setup?token=${encodeURIComponent(token)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }
          );
          if (!res.ok) {
            setAutoSaveStatus((s) => ({ ...s, [key]: 'idle' }));
            return;
          }
          setAutoSaveStatus((s) => ({ ...s, [key]: 'saved' }));
          // Fade 'saved' → 'idle' after 3s.
          if (autoSavedFadeTimers.current[key]) {
            clearTimeout(autoSavedFadeTimers.current[key]);
          }
          autoSavedFadeTimers.current[key] = setTimeout(() => {
            setAutoSaveStatus((s) => ({ ...s, [key]: 'idle' }));
          }, 3000);
        } catch {
          setAutoSaveStatus((s) => ({ ...s, [key]: 'idle' }));
        }
      }, 800);
    },
    [token]
  );

  // Cleanup all pending timers on unmount so we don't leak / fire stale PATCH.
  useEffect(() => {
    return () => {
      Object.values(autoSaveTimers.current).forEach((t) => clearTimeout(t));
      Object.values(autoSavedFadeTimers.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  // Convenience setter that updates form state AND queues auto-save. Used for
  // the 5 highest-risk long-form fields (About Text, Refund Policy, Tagline,
  // Video URL, Custom Notes). Other fields stick with plain setField + the
  // explicit Save & continue button.
  const setFieldAndAutoSave = useCallback(
    (key: string, value: any, opts: { isValid?: (v: any) => boolean } = {}) => {
      setField(key, value);
      queueAutoSave(key, value, opts);
    },
    [queueAutoSave]
  );

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

  // Hybrid B gate: rancher must have completed the onboarding call before
  // signing unlocks. Two signals count as "call done":
  //   1. Onboarding Status advanced to Call Complete / Verification Pending /
  //      Verification Complete / Live / Agreement Signed (any post-call enum).
  //   2. Call Completed At date is set on the record (proof the call happened
  //      even if Onboarding Status was advanced to a non-canonical value like
  //      "Docs Sent" by legacy operator action).
  // Without signal #2 a rancher whose call WAS held but whose status got
  // bumped to "Docs Sent" instead of "Call Complete" was being asked to
  // book a SECOND call when they revisited the wizard. Real bug — Anna
  // Gajewski (Renick Valley) hit it on 2026-05-13.
  // HYBRID call-gate (Ben, 2026-06-24): the onboarding call stays the DEFAULT +
  // recommended path — most new ranchers sign up confused and need the
  // conversation. But a pre-sold rancher who knows the ropes can choose "set up
  // myself" to bypass the booking gate. Persisted to localStorage (keyed on the
  // setup token) so a refresh doesn't re-clamp them back to the call step.
  const [selfServeChosen, setSelfServeChosen] = useState(false);
  const selfServeKey = `bhc-selfserve-${token.slice(0, 32)}`;
  useEffect(() => {
    try {
      if (localStorage.getItem(selfServeKey) === '1') setSelfServeChosen(true);
    } catch { /* localStorage unavailable */ }
  }, [selfServeKey]);
  const chooseSelfServe = () => {
    setSelfServeChosen(true);
    try { localStorage.setItem(selfServeKey, '1'); } catch { /* ignore */ }
    setStep(1);
  };

  function canSkipBooking(): boolean {
    if (selfServeChosen) return true;
    const status = (rancher?.onboardingStatus || '').toString();
    if (
      status === 'Call Complete' ||
      status === 'Docs Sent' ||
      status === 'Agreement Signed' ||
      status === 'Verification Pending' ||
      status === 'Verification Complete' ||
      status === 'Live'
    ) return true;
    if (rancher?.callCompletedAt) return true;
    return false;
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

  // CLOSE-FIRST progress bar. The displayed step numbers are out of numeric
  // order (Call=4 now comes FIRST), so "done" can no longer be a numeric
  // step > n test — that would mark Call as un-done while on Contact (1 > 4 is
  // false) even though the call happened first. Instead we order the *visible*
  // bars by flow position and compare flow indices.
  //
  // Visible order: Call(4) · Contact(1) · Brand(2) · Pricing(3) · Sign(5).
  const PROGRESS_ORDER = [4, 1, 2, 3, 5] as const;
  // Map ANY actual step value to its position on this flow track so the
  // "current" indicator never sits behind the real progress. Steps 7/9/8
  // (Plan/Connect/Fulfillment) live between Pricing and Sign, so they read as
  // "past Pricing, not yet at Sign" — index 3.5 keeps Pricing marked done and
  // Sign still pending while the rancher is in those mid-steps. Intro (0) is
  // before everything (-1). Done (6) is after everything.
  const flowIndexForStep = (s: number): number => {
    if (s === 0) return -1; // intro — nothing done yet
    if (s === 6) return PROGRESS_ORDER.length; // done — everything past
    if (s === 7 || s === 8 || s === 9) return 3.5; // between Pricing and Sign
    const i = (PROGRESS_ORDER as readonly number[]).indexOf(s);
    return i === -1 ? -1 : i;
  };
  const currentFlowIndex = flowIndexForStep(step);

  // Replace YouTube ID below with the real onboarding video ID once filmed.
  // Until then, the placeholder embed is a 60-sec founder intro from the
  // public BHC channel; if missing, the wizard hides the video and falls
  // through to the "skip + start setup" CTA.
  const ONBOARDING_VIDEO_ID =
    process.env.NEXT_PUBLIC_RANCHER_ONBOARDING_VIDEO_ID || '';

  // Already signed?
  //
  // TWO PATHS based on Pricing Model:
  //
  // (a) Pricing Model = 'tier_v2' → fully onboarded, render the "all set"
  //     landing page. They can edit anything from the dashboard.
  //
  // (b) Pricing Model = 'legacy' (or empty) → they signed the original
  //     agreement but haven't migrated to the platform-collected deposit
  //     model. The standardize-funnel rollout (2026-06-03) requires every
  //     rancher to (1) pick a subscription tier, (2) complete Stripe
  //     Connect onboarding, (3) set per-tier deposits. Drop them into
  //     Step 7 (TierPickStep) with a banner explaining the upgrade.
  //
  // Without this branch, every legacy rancher who clicks the v2 upgrade
  // invite email lands in the "all set" dead-end and never reaches tier
  // pick. Pre-2026-06-04 audit found 0/16 ranchers could complete upgrade.
  if (rancher.agreementSigned) {
    const pm = String(rancher['Pricing Model'] || '').toLowerCase();
    const isLegacy = pm !== 'tier_v2';
    // 2026-06-09 P0 fix: tier_v2 ranchers MID-FLOW (just picked Legacy
    // Connect / Pasture / Ranch / Operator, haven't completed Stripe
    // Connect onboarding yet) would hit this branch — agreementSigned
    // true + pm = 'tier_v2' — and get dumped into the "all set" landing
    // page BEFORE they could connect their bank account. Migration
    // Status would freeze at 'upgrading' and the rancher would never
    // see Step 9 (Connect bank).
    //
    // Now we ALSO require Stripe Connect to be Active before showing
    // the "all set" page. If Connect is onboarding/pending/empty, fall
    // through to the wizard render so Step 9 (StripeConnectStep) can
    // collect the bank.
    const connectStatus = String((rancher as any)['Stripe Connect Status'] || '').toLowerCase();
    const connectAccountId = String((rancher as any)['Stripe Connect Account Id'] || '').trim();
    const connectFullyActive = connectStatus === 'active';
    const stillNeedsConnect = pm === 'tier_v2' && (!connectAccountId || !connectFullyActive);
    if (isLegacy || stillNeedsConnect) {
      // 2026-06-09 fix: previously `if (step === 0) setTimeout(setStep(7))`
      // — which had two races:
      //   1. P1-2 localStorage step-restore (line 305-323) could fire
      //      AFTER this setTimeout and overwrite our jump back to a saved
      //      step (e.g. 3, the original new-rancher path).
      //   2. If wizard mounted with step != 0 (e.g. Step 9 connect resume),
      //      this branch never fired — silently dropping into the wrong
      //      flow for ranchers who'd been previously partway through.
      // Now jumps to Step 7 unconditionally on first detection of the
      // legacy-needs-upgrade signal, regardless of current step. Once
      // restoring guard fires, we're already on Step 7 so localStorage
      // restore correctly no-ops.
      if (isLegacy && typeof window !== 'undefined' && !didRestoreStep.current) {
        // Mark restore-done so the localStorage effect doesn't fight us.
        didRestoreStep.current = true;
        setTimeout(() => setStep(7 as any), 0);
      }
      // 2026-06-19 fix: COLD-revisit for a tier_v2 rancher who SKIPPED Stripe
      // Connect. On a fresh open (setup?token=…, no ?tierComplete=1) nothing
      // calls setStep(9) — the tierComplete effect (line 314) is gated on the
      // query param and Step-7's onContinue (line 1755) is unreachable without
      // first reaching Step 7. So they were stranded at the Step-0 intro whose
      // only forward button goes to setStep(1), never to Connect. Mirror the
      // isLegacy one-shot above using the SAME didRestoreStep guard so it fires
      // once and doesn't fight the ?tierComplete=1 / localStorage paths.
      if (stillNeedsConnect && typeof window !== 'undefined' && !didRestoreStep.current) {
        didRestoreStep.current = true;
        setTimeout(() => setStep(9 as any), 0);
      }
      // Fall through to the wizard render below (no early return). When the
      // rancher arrived via ?tierComplete=1 that effect already setStep(9), so
      // the guard above no-ops and we naturally land in StripeConnectStep.
    } else {
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
  // Tier-pick (7) + fulfillment (8) hide it because the page-preview chrome
  // isn't relevant to plan selection or fulfillment policy capture.
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
            {PROGRESS_ORDER.map((n, idx) => {
              // Done/active by FLOW POSITION (not numeric step) so the bars
              // stay correct under the close-first reorder — see flowIndexForStep.
              const isActive = idx === currentFlowIndex;
              const isDone = idx < currentFlowIndex;
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
                    {isDone ? '✓' : idx + 1}
                  </span>
                  <span
                    className={`text-xs uppercase tracking-widest hidden sm:inline ${
                      isActive ? 'text-charcoal font-bold' : 'text-saddle'
                    }`}
                  >
                    {stepLabel(n)}
                  </span>
                  {idx < PROGRESS_ORDER.length - 1 && (
                    <span aria-hidden className="text-dust hidden sm:inline">·</span>
                  )}
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
                "boom-boom-bam" anchor so ranchers see the deal at a glance.
                Subscription messaging is honest about tier_v2 (Step 6 picks
                the actual monthly + commission rate) — earlier "$0 subscription"
                wording contradicted the wizard's own pricing step. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              {[
                { stat: '0–7%', label: 'Commission on closed deals · tier-based' },
                { stat: '$0', label: 'Setup fee · pick subscription at Step 6' },
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

            {/* ── What we actually run for you ─────────────────────────────
                Surfaces the marketing + ops infrastructure ranchers are
                signing up to. Previously this lived only in tier_v2 plan
                copy (which legacy ranchers never saw), so the "what BHC
                does for me" question went unanswered for 100% of current
                ranchers. 5 buckets, scannable. */}
            <div className="space-y-4 border-t border-dust pt-7">
              <div>
                <p className="text-xs uppercase tracking-widest text-saddle mb-2">
                  What we run for you in the background
                </p>
                <h3 className="font-serif text-xl md:text-2xl text-charcoal leading-tight">
                  You raise cattle. We run the marketing engine.
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Traffic & reach */}
                <div className="border border-dust bg-bone-warm p-5 space-y-2.5">
                  <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                    Traffic &amp; reach
                  </p>
                  <ul className="text-sm text-charcoal/90 space-y-1.5 leading-snug">
                    <li>· Paid Meta + Google ads targeting buyers in your state</li>
                    <li>· Programmatic SEO landing pages per state</li>
                    <li>· Public map listing — every D2C rancher in America</li>
                    <li>· Founders campaign exposure (every backer email)</li>
                    <li>· Brand-partner cross-promo on every partner page</li>
                  </ul>
                </div>

                {/* Conversion engine */}
                <div className="border border-dust bg-bone-warm p-5 space-y-2.5">
                  <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                    Conversion engine
                  </p>
                  <ul className="text-sm text-charcoal/90 space-y-1.5 leading-snug">
                    <li>· Auto-routing of state-matched buyers when you go live</li>
                    <li>· Launch warmup — every waitlisted buyer pinged on go-live</li>
                    <li>· Ready-to-buy email sequence + YES-button engagement</li>
                    <li>· Hot-lead bypass when buyers click ready-to-buy</li>
                    <li>· Multi-state routing if you ship beyond your home state</li>
                  </ul>
                </div>

                {/* Lead management */}
                <div className="border border-dust bg-bone-warm p-5 space-y-2.5">
                  <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                    Lead management
                  </p>
                  <ul className="text-sm text-charcoal/90 space-y-1.5 leading-snug">
                    <li>· Real-time Telegram alerts for every new lead</li>
                    <li>· One-click email buttons — Won / Lost / Pass</li>
                    <li>· AI reply triage — classifies inbound buyer responses</li>
                    <li>· Auto-responses for ghosting + scheduling questions</li>
                    <li>· Capacity guard — never over-route beyond your max</li>
                  </ul>
                </div>

                {/* Revenue infrastructure */}
                <div className="border border-dust bg-bone-warm p-5 space-y-2.5">
                  <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                    Revenue infrastructure
                  </p>
                  <ul className="text-sm text-charcoal/90 space-y-1.5 leading-snug">
                    <li>· Stripe-hosted commission invoicing — auto on Closed Won</li>
                    <li>· Optional Stripe Connect — buyers pay you direct</li>
                    <li>· Sale tracking + monthly earnings dashboard</li>
                    <li>· Affiliate auto-enrollment for past customers</li>
                    <li>· Wholesale lead routing (B2B funnel built separate)</li>
                  </ul>
                </div>
              </div>

              {/* Compliance + ops — full width strip */}
              <div className="border border-dust bg-bone-warm p-5 space-y-2.5">
                <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                  Compliance &amp; operations (handled for you)
                </p>
                <ul className="text-sm text-charcoal/90 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 leading-snug">
                  <li>· TCPA-compliant SMS opt-in gating</li>
                  <li>· Suppression list — bounces &amp; complaints auto-honored</li>
                  <li>· Cron observability + operator escalation on failures</li>
                  <li>· Webhook signing, JWT rotation, Redis fail-open</li>
                  <li>· Audit logs on every approve / reject / close action</li>
                  <li>· Capacity drift recovery + atomic counter sync</li>
                </ul>
              </div>

              <p className="text-xs text-saddle italic leading-relaxed">
                You set prices, capacity, and pace. We send the buyers, run the funnel, and stay out of your way.
              </p>
            </div>

            <div className="border-t border-dust pt-5 space-y-3">
              <p className="text-sm text-charcoal/85 leading-relaxed">
                <strong>First, let&rsquo;s hop on a quick call to get you set
                up.</strong> We&rsquo;ll walk through your dashboard, pricing, and
                anything you want to ask &mdash; then build your page together.
                It&rsquo;s the fastest way to go live.
              </p>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="inline-flex items-center gap-2 justify-center px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
                >
                  Book your onboarding call &rarr;
                </button>
              </div>
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
              <div className="border-t border-dust pt-4 mt-4">
                <Field
                  label="Cal.com booking link (so buyers can self-schedule calls with you)"
                  value={form['Cal.com Slug']}
                  onChange={(v) => setField('Cal.com Slug', v.trim().replace(/^https?:\/\/(www\.)?cal\.com\//, ''))}
                  placeholder="yourname or yourname/buyhalfcow-intro"
                />
                <div className="bg-bone border border-dust p-4 mt-3 text-sm leading-relaxed text-charcoal">
                  <p className="font-medium mb-2">3-step setup (5 minutes total):</p>
                  <ol className="list-decimal pl-5 space-y-1.5 text-saddle">
                    <li>
                      <a
                        href="https://cal.com/signup"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline text-charcoal"
                      >
                        Sign up free at cal.com
                      </a>{' '}
                      (if you don&rsquo;t already have an account).
                    </li>
                    <li>
                      Create a <strong>15-minute event type</strong> named &ldquo;BuyHalfCow Intro&rdquo; with your real availability windows.
                    </li>
                    <li>
                      In that event&rsquo;s settings, add{' '}
                      <code className="bg-white border border-dust px-1.5 py-0.5">{OPERATOR_NOTIFY_EMAIL}</code>{' '}
                      as an <strong>Additional Guest</strong> (Cal.com → Event Type → Limits/Workflows → Add invitee).
                      That&rsquo;s how Ben sees every booking and can join if needed.
                    </li>
                  </ol>
                  <p className="mt-3 text-xs text-saddle">
                    Then paste your link above — just the part after <code className="bg-white px-1">cal.com/</code> works
                    (e.g. <code className="bg-white px-1">yourname/buyhalfcow-intro</code>).
                    We embed this in every buyer&rsquo;s intro email as the primary call-to-action.
                  </p>
                </div>
              </div>
            </div>
            <StepFooter
              saving={saving}
              onContinue={async () => {
                if (!form.Email || !form.City || !form.State || !form.Zip) {
                  setError('Email, City, State, and ZIP are required');
                  return;
                }
                // Email FORMAT gate. Email is the rancher's lifeblood: the
                // agreement confirmation, the dashboard magic-link, and every
                // lead notification go here. A typo ("jane@", "jane.com") used
                // to pass the presence-only check, save silently, and then
                // dead-end the rancher — they'd never get a single email and
                // have no idea why. Validate the shape before we save it.
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.Email).trim())) {
                  setError('That email doesn’t look right — double-check it (we send your dashboard link and every lead here).');
                  return;
                }
                if (!/^\d{5}$/.test(String(form.Zip))) {
                  setError('ZIP must be 5 digits');
                  return;
                }
                setError('');
                const ok = await saveStep({
                  Email: String(form.Email).trim(),
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
                  'Cal.com Slug': form['Cal.com Slug'] || '',
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
                  onChange={(v) => setFieldAndAutoSave('Tagline', v)}
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
                  <AutoSaveIndicator status={autoSaveStatus['Tagline']} />
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

              <div className="space-y-1">
                <TextareaField
                  label="About your ranch"
                  value={form['About Text']}
                  onChange={(v) => setFieldAndAutoSave('About Text', v)}
                  rows={7}
                  placeholder="A few paragraphs. How you got started, what makes your operation different, what families are buying when they buy from you."
                />
                <AutoSaveIndicator status={autoSaveStatus['About Text']} />
              </div>

              <div className="space-y-1">
                <Field
                  label="Video URL (YouTube or Vimeo, optional)"
                  value={form['Video URL']}
                  onChange={(v) => setFieldAndAutoSave('Video URL', v)}
                  placeholder="https://youtube.com/watch?v=..."
                  type="url"
                />
                <AutoSaveIndicator status={autoSaveStatus['Video URL']} />
              </div>

              {/* ── Gallery photos ──────────────────────────────────────────
                  The #1 conversion lever: the first photo becomes the cover
                  hero on the public listing. Stored as a JSON array of URLs
                  (parseGallery/serializeGallery) so the public page, dashboard,
                  and admin editor all read it correctly. Each existing photo
                  shows as a thumbnail with a remove button; one empty uploader
                  appends the next, up to MAX_GALLERY_PHOTOS. */}
              {(() => {
                const photos = parseGallery(form['Gallery Photos']);
                const setPhotos = (next: string[]) =>
                  setField('Gallery Photos', serializeGallery(next));
                return (
                  <div className="space-y-3 border-t border-dust pt-5">
                    <div>
                      <p className="text-sm font-medium text-charcoal">
                        Photos of your ranch{' '}
                        <span className="text-dust font-normal">
                          (cattle, the land, your family — what makes it yours)
                        </span>
                      </p>
                      <p className="text-xs text-saddle mt-0.5 leading-relaxed">
                        Add at least one — your first photo becomes the cover
                        image families see at the top of your page. Listings
                        with photos convert far better than those without.
                      </p>
                    </div>

                    {photos.length > 0 && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {photos.map((url, i) => (
                          <div key={`${url}-${i}`} className="relative group">
                            <img
                              src={url}
                              alt={`Gallery ${i + 1}`}
                              className="w-full aspect-square object-cover border border-dust bg-bone"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.opacity = '0.3';
                              }}
                            />
                            {i === 0 && (
                              <span className="absolute bottom-1 left-1 bg-charcoal text-bone text-[10px] uppercase tracking-widest px-1.5 py-0.5">
                                Cover
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => setPhotos(photos.filter((_, idx) => idx !== i))}
                              className="absolute top-1 right-1 px-2 py-0.5 bg-charcoal text-bone text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-base"
                              title="Remove photo"
                              aria-label={`Remove photo ${i + 1}`}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {photos.length < MAX_GALLERY_PHOTOS ? (
                      <ImageUploader
                        label=""
                        hint={`Add photo ${photos.length + 1} of ${MAX_GALLERY_PHOTOS}`}
                        value=""
                        onChange={(url) => {
                          const u = (url || '').trim();
                          if (u) setPhotos([...photos, u]);
                        }}
                      />
                    ) : (
                      <p className="text-xs text-dust italic">
                        Max {MAX_GALLERY_PHOTOS} photos. Remove one to add another.
                      </p>
                    )}
                  </div>
                );
              })()}
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
                  // Persisted as a JSON array of URLs (serializeGallery already
                  // ran on every setField, so form['Gallery Photos'] is the
                  // JSON string — send it through as-is).
                  'Gallery Photos': form['Gallery Photos'] || '',
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

            {/* ── Whole-cow price → auto-ladder + auto-deposits ──────────────
                The rancher types ONE number (the whole-cow price, or a $/lb rate
                × hanging weight) and lib/pricing derives Half (~0.55×), Quarter
                (~0.28×) and every tier's 25% reserve deposit. Hand-edits to any
                derived field stick (touchedDerived); a "reset" link re-derives. */}
            {(() => {
              const whole = Number(form['Whole Price']);
              const ladder = deriveLadder(whole > 0 ? whole : 0);
              const lbsKnown = Number(hangingLbsInput) > 0;
              const perLb = lbsKnown ? impliedPerLb(whole, Number(hangingLbsInput)) : 0;
              const sells: string[] = Array.isArray(form['Tier Specialty'])
                ? form['Tier Specialty']
                : [];
              const wholeOk = !(whole > 0) || checkWholePrice(whole).ok;
              // Live ladder summary under the whole-price input.
              const ladderHelper =
                whole > 0 ? (
                  <span>
                    {lbsKnown && perLb > 0 && <>≈ ${perLb.toFixed(2)}/lb · </>}
                    Half ${ladder.half.toLocaleString()} · Quarter ${ladder.quarter.toLocaleString()} ·
                    deposits W ${deriveDeposit(Number(form['Whole Price'])).toLocaleString()} / H $
                    {deriveDeposit(Number(form['Half Price'])).toLocaleString()} / Q $
                    {deriveDeposit(Number(form['Quarter Price'])).toLocaleString()}
                  </span>
                ) : (
                  <span>Half and Quarter prices + every deposit fill in automatically.</span>
                );
              return (
                <div className="space-y-4">
                  {/* Unit toggle: whole-cow total vs price per pound */}
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ['total', 'Price per whole cow'],
                        ['perlb', 'Price per pound'],
                      ] as const
                    ).map(([unit, label]) => {
                      const active = priceUnit === unit;
                      return (
                        <button
                          key={unit}
                          type="button"
                          onClick={() => {
                            setPriceUnit(unit);
                            // Leaving per-lb mode: clear its inputs so a stale
                            // $/lb × weight can't silently recompute the whole.
                            if (unit === 'total') {
                              setPerLbInput('');
                              setHangingLbsInput('');
                            }
                          }}
                          className={`px-4 py-2 text-sm font-medium uppercase tracking-wide border transition-base ${
                            active
                              ? 'bg-charcoal text-bone border-charcoal'
                              : 'bg-bone text-charcoal border-dust hover:border-saddle'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  {priceUnit === 'total' ? (
                    <Field
                      label="Whole-cow price"
                      prefix="$"
                      suffix="/ whole"
                      inputMode="decimal"
                      value={form['Whole Price']}
                      onChange={onWholeChange}
                      placeholder="2800"
                      helper={ladderHelper}
                    />
                  ) : (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field
                          label="Price per pound"
                          prefix="$"
                          suffix="/ lb"
                          inputMode="decimal"
                          value={perLbInput}
                          onChange={onPerLbChange}
                          placeholder="7.50"
                        />
                        <Field
                          label="Hanging weight"
                          suffix="lbs"
                          inputMode="decimal"
                          value={hangingLbsInput}
                          onChange={onHangingLbsChange}
                          placeholder="375"
                        />
                      </div>
                      <p className="text-sm text-charcoal">
                        {whole > 0 ? (
                          <>
                            Whole-cow total:{' '}
                            <strong>${whole.toLocaleString()}</strong>{' '}
                            <span className="text-saddle">{ladderHelper}</span>
                          </>
                        ) : (
                          <span className="text-saddle">
                            Enter a per-pound price and hanging weight to set the whole-cow total.
                          </span>
                        )}
                      </p>
                    </div>
                  )}

                  {/* Soft sanity warning — never blocks (server hard-blocks < $MIN_TIER_PRICE) */}
                  {whole > 0 && !wholeOk && (
                    <p className="text-xs text-weathered">{checkWholePrice(whole).message}</p>
                  )}

                  {/* ── Your prices & deposits ── per tier the rancher SELLS ── */}
                  {sells.length > 0 && (
                    <div className="border border-dust bg-bone-warm p-4 md:p-5 space-y-4">
                      <p className="text-sm font-medium text-charcoal">Your prices &amp; deposits</p>
                      {(['Quarter', 'Half', 'Whole'] as const)
                        .filter((tier) => sells.includes(tier))
                        .map((tier) => {
                          const isWhole = tier === 'Whole';
                          const priceTouched = touchedDerived.has(`${tier} Price`);
                          const depTouched = touchedDerived.has(`${tier} Deposit`);
                          return (
                            <div key={tier} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {/* Whole's price is the primary input above — don't
                                  duplicate it; show a read-only echo instead. */}
                              {isWhole ? (
                                <div>
                                  <span className="block text-sm font-medium text-charcoal mb-1.5">
                                    Whole price
                                  </span>
                                  <div className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal/70">
                                    {whole > 0 ? `$${whole.toLocaleString()}` : 'Set above'}
                                  </div>
                                </div>
                              ) : (
                                <Field
                                  label={`${tier} price`}
                                  prefix="$"
                                  inputMode="decimal"
                                  value={form[`${tier} Price`]}
                                  onChange={(v) => onLadderPriceChange(tier, v)}
                                  placeholder="0"
                                  autoChip={!priceTouched}
                                  onReset={priceTouched ? () => resetDerived(`${tier} Price`) : undefined}
                                />
                              )}
                              <Field
                                label={`${tier} deposit`}
                                prefix="$"
                                inputMode="decimal"
                                value={form[`${tier} Deposit`]}
                                onChange={(v) => onDepositChange(tier, v)}
                                placeholder="0"
                                autoChip={!depTouched}
                                onReset={depTouched ? () => resetDerived(`${tier} Deposit`) : undefined}
                              />
                            </div>
                          );
                        })}
                      <p className="text-xs text-saddle leading-relaxed">
                        <strong>Deposit</strong> — what the buyer pays now to reserve. Auto-set to ~25% of each
                        price; edit any and we&rsquo;ll keep your number.
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── Per-tier processing, weight, payment link + math card ──────
                Only for tiers the rancher SELLS. Price/deposit live above; here
                we collect the processor cost, finished weight, and any external
                payment link, then show the math on the (overridden) price. */}
            {(['Quarter', 'Half', 'Whole'] as const)
              .filter((tier) =>
                (Array.isArray(form['Tier Specialty']) ? form['Tier Specialty'] : []).includes(tier)
              )
              .map((tier) => {
                const price = Number(form[`${tier} Price`]);
                const fee = Number(form[`${tier} Processing Fee`]);
                const dep = Number(form[`${tier} Deposit`]);
                return (
                  <div key={tier} className="border border-dust p-4 md:p-5 space-y-3 bg-bone-warm">
                    <p className="font-serif text-lg text-charcoal">{tier} Cow — processing &amp; extras</p>
                    <Field
                      label="Processing fee ($) — your processor cost"
                      type="number"
                      value={form[`${tier} Processing Fee`]}
                      onChange={(v) => setField(`${tier} Processing Fee`, v)}
                      placeholder="1000"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Field
                        label="Approx finished weight (lbs)"
                        value={form[`${tier} lbs`]}
                        onChange={(v) => setField(`${tier} lbs`, v)}
                        placeholder="~150 lbs"
                      />
                      <Field
                        label="Stripe / payment link (optional)"
                        value={form[`${tier} Payment Link`]}
                        onChange={(v) => setField(`${tier} Payment Link`, v)}
                        type="url"
                        placeholder="https://buy.stripe.com/..."
                      />
                    </div>
                    {price > 0 && Number.isFinite(fee) && fee >= 0 && (
                      <div className="bg-bone border border-dust p-3 text-xs text-charcoal/85 leading-relaxed">
                        {/* Tier-agnostic on purpose: BHC's commission depends on the
                            plan you pick later (Step 7), and the rates differ per
                            plan — so we DON'T assert a flat % here. The only numbers
                            we can state for certain are the deposit, the processing
                            recoup, and your net on the listed price. */}
                        <p className="font-medium mb-1">How the math works on a {tier.toLowerCase()}:</p>
                        <p>
                          Buyer pays a <strong>${dep > 0 ? dep.toLocaleString() : '—'}</strong> deposit now to
                          reserve — that covers your <strong>${fee.toLocaleString()}</strong> processing recoup
                          plus BHC&rsquo;s commission per the plan you select at the end.
                        </p>
                        <p>
                          Final invoice (rancher net):{' '}
                          <strong>${(price - fee).toLocaleString()}</strong> (listed minus processing, 100% to you)
                        </p>
                        <p className="text-saddle italic mt-1">
                          You keep your full listed ${price.toLocaleString()}. The buyer pays that plus BHC&rsquo;s
                          commission on top — the exact rate is set by the plan you choose at Step 7.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}

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
                // Validate each tier's price + deposit. Prices are auto-derived
                // from the whole-cow input, so these normally pass — but a hand
                // override (or a per-lb value typed as a total) could violate
                // them. A positive price must be >= MIN_TIER_PRICE (mirrors
                // checkWholePrice's per-lb-mismatch intent); a set deposit must
                // be 0 < deposit <= price. A bad deposit silently breaks the
                // buyer deposit checkout math (app/api/checkout/deposit), so we
                // block here AND mirror server-side in /api/rancher/setup.
                const sells: string[] = Array.isArray(form['Tier Specialty']) ? form['Tier Specialty'] : [];
                // Validate ONLY the tiers the rancher sells.
                for (const tier of ['Quarter', 'Half', 'Whole'] as const) {
                  if (!sells.includes(tier)) continue;
                  const priceRaw = form[`${tier} Price`];
                  const price = Number(priceRaw);
                  const hasPrice = priceRaw !== '' && priceRaw != null && Number.isFinite(price) && price > 0;
                  if (hasPrice && price < MIN_TIER_PRICE) {
                    setError(
                      `$${price} looks like a per-pound price for the ${tier.toLowerCase()}, not a total. Tier totals are usually hundreds of dollars — switch to "Price per pound" if you meant per pound.`
                    );
                    return;
                  }
                  const depRaw = form[`${tier} Deposit`];
                  if (depRaw === '' || depRaw == null) continue;
                  const dep = Number(depRaw);
                  if (!Number.isFinite(dep) || dep <= 0) {
                    setError(`${tier} deposit must be greater than $0, or leave it blank to charge the full price upfront.`);
                    return;
                  }
                  if (!hasPrice) {
                    setError(`Set a ${tier.toLowerCase()} price before its deposit.`);
                    return;
                  }
                  if (dep > price) {
                    setError(`${tier} deposit can't exceed the ${tier.toLowerCase()} listed sale price.`);
                    return;
                  }
                }
                // Filter out empty testimonials before saving (rancher may add
                // then leave blank).
                const validTestimonials = testimonials.filter(
                  (t) => t.name.trim() && t.quote.trim()
                );
                // Persist ONLY the tiers the rancher sells. A deselected tier is
                // nulled so it can never ship derived/stale price+deposit to a
                // buyer page (which renders any tier that has a price).
                const tierSlice = (tier: 'Quarter' | 'Half' | 'Whole') => {
                  const sold = sells.includes(tier);
                  return {
                    [`${tier} Price`]: sold ? form[`${tier} Price`] : '',
                    [`${tier} Deposit`]: sold ? form[`${tier} Deposit`] : '',
                    [`${tier} Processing Fee`]: sold ? form[`${tier} Processing Fee`] : '',
                    [`${tier} lbs`]: sold ? form[`${tier} lbs`] : '',
                    [`${tier} Payment Link`]: sold ? form[`${tier} Payment Link`] : '',
                  };
                };
                const ok = await saveStep({
                  'Tier Specialty': form['Tier Specialty'],
                  ...tierSlice('Quarter'),
                  ...tierSlice('Half'),
                  ...tierSlice('Whole'),
                  Testimonials: validTestimonials.length
                    ? JSON.stringify(validTestimonials)
                    : '',
                });
                if (ok) {
                  // CLOSE-FIRST flow: the onboarding call already happened at
                  // the FRONT (Step 0 → Step 4 → Contact), so after pricing we
                  // go STRAIGHT to the next setup gate — no call routing here.
                  //
                  // Step ordering depends on Pricing Model:
                  //   tier_v2: …3 → 7 (Pick Plan) → 9 (Stripe) → 8 (Fulfill) → 5 (Sign)
                  //   legacy:  …3 → 8 (Fulfill) → 5 (Sign)  — skip 7+9
                  // Legacy ranchers pay BHC monthly commission on closed deals
                  // (no tier subscription), so forcing them through Pick Plan
                  // (step 7) or Stripe Connect (step 9) is wrong and blocks
                  // onboarding. (P2-B fix.)
                  const isLegacy =
                    String((rancher as any)['Pricing Model'] || 'legacy') === 'legacy';
                  const nextAfterPricing = isLegacy ? 8 : 7;
                  setStep(nextAfterPricing);
                }
              }}
            />
          </section>
        )}

        {/* STEP 4 — Book onboarding call. CLOSE-FIRST: this is now the REQUIRED
            gate at the FRONT of the funnel (intro → CALL → setup). A rancher who
            has NOT done the call must book and cannot skip into setup. A rancher
            who HAS done the call (canSkipBooking — returning rancher OR an
            operator-backfilled record) advances straight into setup at Contact.
            This preserves the real past-bug fix (Renick/Anna Gajewski must not
            be asked to re-book). */}
        {step === 4 && (
          <CallStep
            rancher={rancher}
            callDone={canSkipBooking()}
            onContinue={() => setStep(1)}
            onBack={() => setStep(0)}
            onSelfServe={chooseSelfServe}
          />
        )}

        {/* STEP 7 — Pick Your Plan (Stage-3 Task 11A) */}
        {step === 7 && (
          <TierPickStep
            token={token}
            targetTier={searchParams.get('tier') || ''}
            currentTier={tierSlugFromRancher(rancher)}
            subscriptionStatus={String((rancher as any)['Subscription Status'] || '')}
            onBack={() => setStep(3)}
            onContinue={(updated) => {
              // updated holds the latest Rancher snapshot from polling — merge
              // it into our local rancher state so the fulfillment + sign
              // screens see the new Tier / Subscription Status without a
              // page refresh.
              if (updated) setRancher(updated);
              // Step 9 (Stripe Connect) sits between Pick-Plan and Fulfillment.
              // Legacy ranchers auto-advance through 9 to 8 in StripeConnectStep.
              setStep(9);
            }}
          />
        )}

        {/* STEP 9 — Stripe Connect onboarding (Stage-3 Task D2). tier_v2 only;
            legacy ranchers auto-advance via the StripeConnectStep effect. */}
        {step === 9 && rancher && (
          <StripeConnectStep
            rancherId={rancher.id}
            pricingModel={String((rancher as any)['Pricing Model'] || 'legacy')}
            wizardToken={token}
            onComplete={() => setStep(8)}
            onBack={() => setStep(7)}
          />
        )}

        {/* STEP 8 — Fulfillment + Refund Policy (Stage-3 Task 11B).
            Back-button target depends on Pricing Model: tier_v2 ranchers came
            from step 9 (Stripe), legacy ranchers came from step 3 (Pricing) —
            the call now happens at the FRONT (close-first), so it's no longer
            between Pricing and Fulfillment. Sending legacy ranchers back to
            step 9 would trap them — StripeConnectStep auto-advances legacy
            back to step 8. (P2-B fix.) */}
        {step === 8 && (() => {
          const isLegacy =
            String((rancher as any)['Pricing Model'] || 'legacy') === 'legacy';
          const backTarget = isLegacy ? 3 : 9;
          return (
            <FulfillmentStep
              token={token}
              form={form}
              setField={setField}
              setFieldAndAutoSave={setFieldAndAutoSave}
              autoSaveStatus={autoSaveStatus}
              saving={saving}
              saveStep={saveStep}
              onBack={() => setStep(backTarget)}
              onContinue={() => {
                // After fulfillment is saved, branch on whether agreement is
                // already signed. Critical for v2-migration test ranchers
                // like Jesse Zimmerman where Agreement Signed=true was set
                // BEFORE the wizard ran (legacy ranchers migrating to v2).
                //
                // Previously this unconditionally fired primeSigningToken
                // + setStep(5), which trapped already-signed ranchers at the
                // SignStep — sign-agreement returns 400 "already signed"
                // and there's no escape hatch in the UI. The wizard would
                // dead-end immediately after Stripe Connect + fulfillment.
                //
                // 2026-06-09 fix: detect signed state, mint /rancher as
                // dashboardLink (rancher-session cookie set on wizard load
                // authenticates them), jump straight to Step 6 (Done).
                if (rancher.agreementSigned) {
                  setDashboardLink('/rancher');
                  setStep(6);
                } else {
                  primeSigningToken();
                  setStep(5);
                }
              }}
            />
          );
        })()}

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
            onBack={() => setStep(8)}
          />
        )}

        {/* STEP 6 — Done. Auto-redirect to dashboard via dashboardLink.
            Augmented with a READINESS NUDGE: the page is live, but if the
            highest-leverage conversion pieces are still missing we WARN (Ben's
            explicit call: warn, never block) and deep-link back to fix them. */}
        {step === 6 && (() => {
          // ── Readiness computation ──────────────────────────────────────
          // Pricing: missing when NONE of the tiers the rancher SELLS has a
          // positive price. (If no tiers are selected at all, sold[] is empty
          // and this is true — still "no buyable price on the page".) Reading
          // from Tier Specialty means deselecting a sold tier in Step 3 removes
          // it from the check, matching Step 3's nulling of unsold tiers.
          const sold: string[] = Array.isArray(form['Tier Specialty'])
            ? form['Tier Specialty']
            : [];
          const hasAnyPrice = (['Quarter', 'Half', 'Whole'] as const).some(
            (tier) => sold.includes(tier) && Number(form[`${tier} Price`]) > 0
          );
          const missingPricing = !hasAnyPrice;

          // Bank: only tier_v2 ranchers settle via Stripe Connect; legacy
          // ranchers use payment links / commission invoicing, so a bank
          // connection isn't part of their readiness. For tier_v2 we flag
          // missing ONLY when Connect status is present AND not 'active' — the
          // setup endpoint doesn't always surface Stripe Connect Status, and
          // the Step-9 flow already gates completion server-side, so an absent
          // status is treated as "don't nag" rather than a false negative.
          const pricingModel = String((rancher as any)['Pricing Model'] || 'legacy').toLowerCase();
          const isTierV2 = pricingModel === 'tier_v2';
          const connectStatus = String((rancher as any)['Stripe Connect Status'] || '').toLowerCase();
          const missingBank = isTierV2 && connectStatus !== '' && connectStatus !== 'active';

          // Photos: zero gallery photos on file.
          const missingPhotos = parseGallery(form['Gallery Photos']).length === 0;

          const missing = [
            missingPricing && {
              key: 'pricing',
              label: 'Add a share price',
              hint: 'Buyers see "Contact for pricing" until you set one. Pages with prices convert far better.',
              cta: 'Set pricing →',
              go: () => setStep(3),
            },
            missingBank && {
              key: 'bank',
              label: 'Connect your bank',
              hint: 'Buyers can’t pay a deposit until your Stripe payout account is connected.',
              cta: 'Connect bank →',
              go: () => setStep(9),
            },
            missingPhotos && {
              key: 'photos',
              label: 'Add at least one photo',
              hint: 'Your first photo becomes the cover image at the top of your page — the single biggest conversion lever.',
              cta: 'Add a photo →',
              go: () => setStep(2),
            },
          ].filter(Boolean) as Array<{
            key: string;
            label: string;
            hint: string;
            cta: string;
            go: () => void;
          }>;

          const dashboardCtas = (
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
          );

          // Nothing missing → keep the celebratory done state unchanged.
          if (missing.length === 0) {
            return (
              <section className="space-y-5 bg-sage/10 border-2 border-sage p-7 md:p-8 text-center">
                <p className="text-xs uppercase tracking-[0.2em] text-sage-dark font-bold">
                  Agreement signed
                </p>
                <h2 className="font-serif text-3xl md:text-4xl text-charcoal">
                  Welcome to the network.
                </h2>
                <p className="text-charcoal/85 max-w-md mx-auto leading-relaxed">
                  <strong>{rancher.ranchName}</strong> is signed and locked in.
                  <strong> One last step:</strong> hit &ldquo;Start Verification&rdquo;
                  on your dashboard. Most ranchers complete it in 2 minutes.
                  Once verified, your page goes live and buyers route to you within 2 hours.
                </p>
                {dashboardCtas}
              </section>
            );
          }

          // Something missing → calm "page is live, but finish these" nudge.
          // Still fully proceedable; the dashboard CTAs stay primary.
          return (
            <section className="space-y-6 bg-bone border-2 border-charcoal p-7 md:p-8">
              <header className="space-y-2 text-center">
                <p className="text-xs uppercase tracking-[0.2em] text-sage-dark font-bold">
                  Agreement signed · page live
                </p>
                <h2 className="font-serif text-3xl md:text-4xl text-charcoal">
                  {rancher.ranchName}, you&rsquo;re in.
                </h2>
                <p className="text-charcoal/85 max-w-md mx-auto leading-relaxed">
                  Your page is live. To start closing deals, finish{' '}
                  {missing.length === 1 ? 'this' : `these ${missing.length}`}:
                </p>
              </header>

              <ul className="space-y-2 max-w-lg mx-auto">
                {missing.map((item) => (
                  <li
                    key={item.key}
                    className="flex items-start gap-3 border border-dust bg-bone-warm p-4"
                  >
                    <span
                      aria-hidden
                      className="inline-flex items-center justify-center w-5 h-5 border border-saddle text-saddle text-[11px] shrink-0 mt-0.5"
                    >
                      ☐
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-charcoal">{item.label}</p>
                      <p className="text-xs text-saddle mt-0.5 leading-relaxed">{item.hint}</p>
                    </div>
                    <button
                      type="button"
                      onClick={item.go}
                      className="shrink-0 self-center text-[11px] uppercase tracking-widest font-semibold border border-charcoal text-charcoal px-3 py-2 transition-base hover:bg-charcoal hover:text-bone"
                    >
                      {item.cta}
                    </button>
                  </li>
                ))}
              </ul>

              <p className="text-xs text-saddle italic text-center max-w-md mx-auto leading-relaxed">
                You can do all of this now or later from your dashboard — your
                page stays live either way.
              </p>

              {dashboardCtas}
            </section>
          );
        })()}

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
              Book a 30-min onboarding call with Ben
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

// P1-1 — auto-save status pill. Three states: saving (dust), saved (sage),
// idle (renders nothing). Small + lowercase so it doesn't fight the existing
// micro-copy under fields. Inline so it can sit next to char counters.
function AutoSaveIndicator({ status }: { status?: 'idle' | 'saving' | 'saved' }) {
  if (!status || status === 'idle') return null;
  if (status === 'saving') {
    return (
      <span className="text-xs text-dust italic ml-2" aria-live="polite">
        saving…
      </span>
    );
  }
  return (
    <span className="text-xs text-sage italic ml-2" aria-live="polite">
      saved
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  prefix,
  suffix,
  helper,
  inputMode,
  autoChip,
  onReset,
}: {
  label: string;
  value: any;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  // ── Optional extensions (all default off → existing call sites unchanged) ──
  prefix?: string; // e.g. "$" rendered as a left side-cell
  suffix?: string; // e.g. "/ whole" rendered as a right side-cell
  helper?: React.ReactNode; // small text under the input
  inputMode?: string; // e.g. "decimal" for mobile numeric keypads
  autoChip?: boolean; // tiny uppercase "auto" chip on the right of the label row
  onReset?: () => void; // tiny "reset" link on the right of the label row (when !autoChip)
}) {
  const input = (
    <input
      type={type}
      inputMode={inputMode as any}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={
        prefix || suffix
          ? 'flex-1 min-w-0 px-3 py-3 border border-transparent bg-bone text-base text-charcoal transition-base focus:outline-none'
          : 'w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle'
      }
    />
  );
  return (
    <label className="block">
      <span className="flex items-center justify-between gap-2 mb-1.5">
        <span className="block text-sm font-medium text-charcoal">
          {label} {required && <span className="text-weathered">*</span>}
        </span>
        {autoChip ? (
          <span className="text-[10px] uppercase tracking-widest text-saddle border border-dust px-1.5 py-0.5 leading-none">
            auto
          </span>
        ) : onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] uppercase tracking-widest text-saddle hover:text-charcoal underline underline-offset-2"
          >
            reset
          </button>
        ) : null}
      </span>
      {prefix || suffix ? (
        <span className="flex items-stretch border border-dust bg-bone transition-base focus-within:border-charcoal hover:border-saddle">
          {prefix && (
            <span className="flex items-center px-3 bg-bone-warm border-r border-dust text-base text-saddle select-none">
              {prefix}
            </span>
          )}
          {input}
          {suffix && (
            <span className="flex items-center px-3 bg-bone-warm border-l border-dust text-sm text-saddle whitespace-nowrap select-none">
              {suffix}
            </span>
          )}
        </span>
      ) : (
        input
      )}
      {helper && <span className="block text-xs text-saddle mt-1 leading-relaxed">{helper}</span>}
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

  // Tier-aware commission copy. Source of truth lives in lib/tiers.ts;
  // mirrored here so the gist bullet matches the tier the rancher just
  // picked at Step 6. Hard-coding "10%" contradicted tier_v2 rates.
  const pricingModel = String((rancher as any)['Pricing Model'] || 'legacy');
  const tierSlug = tierSlugFromRancher(rancher);
  let commissionCopy: ReactNode;
  if (pricingModel === 'tier_v2' && tierSlug === 'pasture') {
    commissionCopy = (
      <>
        <strong>7% commission</strong> on closed deals only (Pasture tier).
        Nothing on tire-kickers, nothing on no-shows.
      </>
    );
  } else if (pricingModel === 'tier_v2' && tierSlug === 'ranch') {
    commissionCopy = (
      <>
        <strong>3% commission</strong> on closed deals only (Ranch tier).
        Nothing on tire-kickers, nothing on no-shows.
      </>
    );
  } else if (pricingModel === 'tier_v2' && tierSlug === 'operator') {
    commissionCopy = (
      <>
        <strong>0% commission</strong> on closed deals (Operator tier · flat
        subscription only).
      </>
    );
  } else if (pricingModel === 'tier_v2') {
    // tier_v2 rancher who hasn't locked a tier yet — show the range.
    commissionCopy = (
      <>
        <strong>Commission per your chosen tier</strong> (Pasture 7% · Ranch 3%
        · Operator 0%). Locked when you finish Step 6.
      </>
    );
  } else {
    // Legacy ranchers — original 10% commission contract.
    commissionCopy = (
      <>
        <strong>10% commission</strong> on closed deals only. Nothing on
        tire-kickers, nothing on no-shows.
      </>
    );
  }

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 4</p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          Lock it in &mdash; sign the partner agreement
        </h2>
        <p className="text-sm text-saddle mt-1">
          One signature. No PDF, no notary, no email round-trip. Signing locks
          you in &mdash; next step is verification (instant tap if your profile
          is filled out, 24-48h otherwise).
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

      {/* P1-3: removed the fabricated "Sarah K." sneak-peek intro mock that
          previously lived here. It set unrealistic expectations about intro
          detail level and violated BHC.md integrity rules against invented
          buyer initials / quotes / phone numbers. If we want a real preview
          later, it should be a real anonymized closed-won example, not
          fabricated copy. The agreement step now focuses on the agreement. */}

      {/* Plain-language agreement summary. Full legal text linked. */}
      <div className="border border-dust p-5 space-y-3 text-sm text-charcoal/85 leading-relaxed">
        <p className="text-xs uppercase tracking-widest text-saddle">Partner Agreement &mdash; the gist</p>
        <ul className="space-y-2 list-none">
          <li className="flex gap-2.5">
            <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
            <span>{commissionCopy}</span>
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

// ── Step 4 — Onboarding call (CLOSE-FIRST required gate) ───────────────────
// This is the FRONT of the funnel: intro → CALL → setup. The onboarding call
// is REQUIRED and setup stays locked behind it. A rancher who has NOT done the
// call must book (Cal.com embed) and CANNOT skip into setup; once they book,
// Cal.com fires BOOKING_CREATED → /api/webhooks/cal flips Onboarding Status to
// "Call Scheduled" and we show the "you're booked, come back after" state with
// no forward button.
//
// `callDone` is the parent's authoritative canSkipBooking() result. When true
// (a returning rancher who already did the call, OR an operator-backfilled
// record), we show "✓ Call done — let's set up your page" and let them continue
// into setup. This PRESERVES the real past-bug fix: an already-called rancher
// (Renick / Anna Gajewski, 2026-05-13) must NEVER be asked to re-book.
//
// Status display (only matters when callDone is false):
//   "" / "New"        → show booking embed, no skip
//   "Call Scheduled"  → "you're booked, come back after your call"
function CallStep({
  rancher,
  callDone,
  onContinue,
  onBack,
  onSelfServe,
}: {
  rancher: Rancher;
  callDone: boolean;
  onContinue: () => void;
  onBack: () => void;
  onSelfServe?: () => void;
}) {
  const status = (rancher.onboardingStatus || '').toString();
  const calBookingUrl =
    process.env.NEXT_PUBLIC_CALENDLY_LINK ||
    CALENDLY_LINK;
  // Cal.com inline embed URL — append `?embed=true&theme=light` for clean iframe
  const embedUrl = `${calBookingUrl}?embed=true&theme=light&hideEventTypeDetails=false`;

  const alreadyBooked = status === 'Call Scheduled';

  if (callDone) {
    // Returning rancher who already did the call (or operator-backfilled).
    // Continue straight into setup — do NOT make them re-book.
    return (
      <section className="space-y-5 bg-bone border border-dust p-7 md:p-8">
        <header>
          <p className="text-xs uppercase tracking-widest text-saddle mb-2">Onboarding call</p>
          <h2 className="font-serif text-2xl text-charcoal">✓ Call done — let&rsquo;s set up your page.</h2>
          <p className="text-sm text-saddle mt-1">
            You&rsquo;ve already had your onboarding call. Let&rsquo;s build your
            page.
          </p>
        </header>
        <button
          type="button"
          onClick={onContinue}
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
        >
          Set up my page →
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">First step · Onboarding call</p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          {alreadyBooked ? 'You’re booked for your call.' : 'Book your 30-min onboarding call.'}
        </h2>
        <p className="text-sm text-saddle mt-1">
          {alreadyBooked
            ? `We'll get your page set up together on the call — pricing, dashboard, and any questions. Come back here after to finish your setup.`
            : `First, let's hop on a quick 30-min call. We'll walk through your dashboard, pricing, and questions, then build your page together. Pick a slot below — your setup unlocks once we've talked.`}
        </p>
      </header>

      {!alreadyBooked && (
        <>
          <div className="bg-bone-warm border border-dust p-5 space-y-2 text-sm text-charcoal/85">
            <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
              What we&rsquo;ll cover (30 min)
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
                <span>We build your page together — live</span>
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
            Once you book, we&rsquo;ll auto-stamp this step and unlock your setup.
            Come back here right after your call to finish.
          </p>
        </>
      )}

      {alreadyBooked && (
        <div className="bg-sage/10 border border-sage p-5 space-y-3">
          <p className="text-sm text-charcoal/85 leading-relaxed">
            <strong>You&rsquo;re booked.</strong> We&rsquo;ll get your page set up
            together on the call. Come back to this link right after &mdash; your
            setup unlocks once we&rsquo;ve talked. Need to reschedule? Use the link
            in your Cal.com confirmation email.
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

      {/* HYBRID gate: the call is the DEFAULT (above). But a pre-sold rancher
          who knows the ropes can self-serve via onSelfServe — the parent persists
          that choice so a refresh doesn't re-clamp them here. Kept visually
          secondary so the call stays the recommended path. */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center pt-2 border-t border-dust">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-saddle hover:text-charcoal underline underline-offset-4"
        >
          ← Back
        </button>
        {onSelfServe && (
          <button
            type="button"
            onClick={onSelfServe}
            className="text-sm text-saddle hover:text-charcoal underline underline-offset-4 sm:ml-auto"
          >
            Already know the ropes? Set up myself →
          </button>
        )}
      </div>
    </section>
  );
}

// ── Step 7 — Pick Your Plan (Stage-3 Task 11A) ────────────────────────────
// FREE-DEFAULT MODEL (paywall removed 2026-06): self-serve ranchers land on
// the free Legacy Connect tier ($0 to join, BHC earns 10% only on closed
// sales). On entry, if the rancher has no tier yet, we auto-select Legacy
// Connect (server-backed, via /api/rancher/tier/select) so Continue is enabled
// immediately — no card, no Stripe, no wall. It stays fully changeable: the
// three paid cards (Pasture/Ranch/Operator) are an OPTIONAL upgrade for more
// leads / a lower commission. Picking a paid card redirects the same tab into
// Stripe Checkout; on success Stripe returns to the wizard (tierComplete=1) and
// the poll detects Subscription Status='active' to confirm that paid tier.
//
// Continue gate: enabled the moment the FREE tier is selected (freeTierSelected
// or a persisted Tier='Legacy Connect') — it never requires a paid Stripe
// subscription. Paid tiers still gate Continue on an active subscription.
//
// We poll /api/rancher/setup every 4s to reconcile persisted Tier +
// Subscription Status, but the free path does not depend on that round-trip to
// advance. We still don't auto-ADVANCE past this step — the rancher clicks
// Continue to stay in control.
function TierPickStep({
  token,
  targetTier,
  currentTier,
  subscriptionStatus,
  onBack,
  onContinue,
}: {
  token: string;
  // Optional paid tier from the upgrade link (?tier=pasture) — when set, the
  // auto-select sends the rancher straight to that plan's checkout instead of
  // defaulting to the free tier.
  targetTier?: string;
  currentTier: 'pasture' | 'ranch' | 'operator' | 'legacy_connect' | null;
  subscriptionStatus: string;
  onBack: () => void;
  onContinue: (updated: Rancher | null) => void;
}) {
  const [polledTier, setPolledTier] = useState<'pasture' | 'ranch' | 'operator' | 'legacy_connect' | null>(currentTier);
  const [polledStatus, setPolledStatus] = useState<string>(subscriptionStatus);
  const [lastRancher, setLastRancher] = useState<Rancher | null>(null);
  const [checking, setChecking] = useState(false);
  // Step-level branded error notice — replaces native alert() in the card
  // onClick handlers below. Shown above the tier grid no matter which card erred.
  const [tierErr, setTierErr] = useState('');
  // Optimistic free-tier flag. The free (Legacy Connect) path has NO Stripe
  // subscription, so we must not gate Continue on Subscription Status for it.
  // We flip this true the instant the rancher picks Legacy Connect (or auto-
  // select picks it on entry) so Continue proceeds immediately — without
  // waiting on the synthetic 'active' write to round-trip through Airtable.
  const [freeTierSelected, setFreeTierSelected] = useState(currentTier === 'legacy_connect');

  const isActive = polledStatus === 'active' || polledStatus === 'trialing';
  // A paid tier is confirmed only once its subscription is active. The FREE
  // tier needs no subscription — selecting it (freeTierSelected, or a persisted
  // Tier='Legacy Connect') is enough to advance. This is the paywall removal:
  // Continue is enabled by the free pick alone, never forcing a paid sub.
  const onFreeTier = freeTierSelected || polledTier === 'legacy_connect';
  const planLocked = onFreeTier || (!!polledTier && isActive);

  // Auto-select the FREE tier on entry for self-serve ranchers who arrive
  // with no tier yet, so a rancher who just wants in can hit Continue
  // immediately (the entry page promised "$0 to start"). This persists
  // Tier='Legacy Connect' + synthetic 'active' via the same route the card
  // uses, so the downstream Connect / deposit gates see them correctly.
  // It stays fully changeable — the rancher can still click any paid card to
  // upgrade. Guarded by a ref so it fires at most once and never overrides a
  // rancher who already picked a (paid or free) tier.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    // Only auto-pick when no tier is set anywhere. If they already have a tier
    // (returning rancher, or mid-checkout paid pick) leave their choice alone.
    if (currentTier || polledTier) return;
    autoSelectedRef.current = true;
    // If the upgrade link targeted a PAID tier (?tier=pasture), select THAT and
    // redirect straight to its subscription checkout — so the rancher lands on
    // the exact plan they were invited to, with no chance of proceeding on the
    // free tier by accident. Otherwise auto-select the free tier ($0 default).
    const paidTarget =
      targetTier === 'pasture' || targetTier === 'ranch' || targetTier === 'operator'
        ? targetTier
        : null;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/rancher/tier/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            paidTarget
              ? { tier: paidTarget, from: 'wizard', wizardToken: token }
              : { tier: 'legacy_connect' },
          ),
        });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json().catch(() => ({} as any));
          // Paid target → tier/select returns a Stripe subscription Checkout URL
          // → redirect the rancher straight to payment for that exact plan.
          if (paidTarget && data?.url) {
            window.location.href = data.url;
            return;
          }
          // Free path — lock in + reconcile (status copy + card ✓).
          setFreeTierSelected(true);
          setPolledTier('legacy_connect');
          const fresh = await fetch(`/api/rancher/setup?token=${encodeURIComponent(token)}`);
          if (!cancelled && fresh.ok) {
            const fd = await fresh.json();
            if (fd?.rancher) {
              const r = fd.rancher as Rancher;
              setLastRancher(r);
              setPolledTier(tierSlugFromRancher(r));
              setPolledStatus(String(r['Subscription Status'] || ''));
            }
          }
        } else {
          // Surface the failure (this used to stay silent). Connect-ACCOUNT
          // creation happens inside this call, so a silent failure left the
          // rancher with NO Stripe account — the single biggest cause of stuck
          // migrations (they proceeded believing they were set). Show a
          // retryable notice so they pick a plan card to try again.
          const eb = await res.json().catch(() => ({}));
          if (!cancelled) {
            setTierErr(
              eb?.error ||
                "We couldn't set up your plan automatically — pick a plan below to continue.",
            );
          }
        }
      } catch {
        if (!cancelled) {
          setTierErr(
            "We couldn't reach the server to set up your plan — pick a plan below, or refresh and try again.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount (currentTier is the server snapshot).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for Tier + Subscription Status. Runs every 4s while the step is
  // mounted. Stops once both are set + active (saves Airtable read budget).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || planLocked) return;
      try {
        const res = await fetch(`/api/rancher/setup?token=${encodeURIComponent(token)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.rancher) return;
        const r = data.rancher as Rancher;
        setLastRancher(r);
        const slug = tierSlugFromRancher(r);
        setPolledTier(slug);
        setPolledStatus(String(r['Subscription Status'] || ''));
      } catch {
        /* non-fatal; will retry */
      }
    };
    // Fire immediately so a returning rancher sees state without 4s wait.
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, planLocked]);

  // Manual refresh button — gives the rancher an "I just paid, check now"
  // affordance without waiting for the next 4s tick.
  async function refreshNow() {
    setChecking(true);
    try {
      const res = await fetch(`/api/rancher/setup?token=${encodeURIComponent(token)}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.rancher) {
          const r = data.rancher as Rancher;
          setLastRancher(r);
          setPolledTier(tierSlugFromRancher(r));
          setPolledStatus(String(r['Subscription Status'] || ''));
        }
      }
    } catch {
      /* non-fatal */
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 6 · Pick Your Plan</p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          Start free. Pay 10% only when you sell.
        </h2>
        <p className="text-sm text-saddle mt-1">
          You&rsquo;re set up on the free plan by default — no monthly fee, no
          card. Want more leads or a lower commission? The paid upgrades are
          optional. Cancel or change anytime.
        </p>
      </header>

      {tierErr && (
        <div className="p-3 border-l-4 border-red-500 bg-red-50 text-sm text-red-900 flex items-center justify-between gap-3">
          <span>{tierErr}</span>
          <button type="button" onClick={() => setTierErr('')} className="text-lg leading-none hover:opacity-70">×</button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {TIER_CARDS.map((card) => {
          const isFreeCard = card.slug === 'legacy_connect';
          // The free card is "selected" the moment freeTierSelected flips,
          // even before the synthetic 'active' write round-trips — so its
          // selected/✓ styling stays in sync with the now-enabled Continue.
          const selected = polledTier === card.slug || (isFreeCard && freeTierSelected);
          // Free card confirms on selection (no subscription to wait on);
          // paid cards still require an active subscription to show ✓.
          const showCheckmark = isFreeCard ? selected : selected && isActive;
          return (
            <div
              key={card.slug}
              className={`relative bg-white border p-4 md:p-5 flex flex-col ${
                showCheckmark
                  ? 'border-2 border-sage'
                  : selected
                  ? 'border-2 border-charcoal'
                  : 'border-divider'
              }`}
            >
              {showCheckmark && (
                <span className="absolute -top-2.5 right-3 bg-sage text-bone text-[10px] tracking-widest uppercase px-2 py-1 font-bold">
                  ✓ Active
                </span>
              )}
              {selected && !isActive && (
                <span className="absolute -top-2.5 right-3 bg-charcoal text-bone text-[10px] tracking-widest uppercase px-2 py-1 font-bold">
                  Selected
                </span>
              )}
              <h3 className="font-serif text-xl text-charcoal mb-1">{card.label}</h3>
              <p className="text-sm font-semibold text-charcoal mb-1">{card.price}</p>
              <p className="text-sm text-saddle min-h-[3rem] mb-3">{card.promise}</p>
              <ul className="border-t border-divider pt-2.5 mb-3 space-y-1 text-sm text-charcoal/85">
                {card.perks.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {card.mode === 'inline' ? (
                // Legacy Connect (FREE): POST tier/select inline — no Stripe
                // Checkout, no subscription. The rancher keeps the $0 /
                // 10%-on-close deal. We flip freeTierSelected immediately so
                // Continue enables on the spot (no paid sub required); the
                // refresh below + the polling effect then reconcile the
                // persisted Tier='Legacy Connect' + synthetic 'active' status.
                <button
                  type="button"
                  onClick={async () => {
                    setTierErr('');
                    try {
                      setChecking(true);
                      const res = await fetch('/api/rancher/tier/select', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ tier: card.slug }),
                      });
                      const data = await res.json();
                      if (!res.ok) {
                        setTierErr(data?.error || `Could not select ${card.label}`);
                        return;
                      }
                      // Free path is locked in the moment select succeeds —
                      // Continue no longer waits on any subscription state.
                      setFreeTierSelected(true);
                      setPolledTier('legacy_connect');
                      // Refresh polled state so the rest of the UI (status copy)
                      // reflects the persisted record without the 4s tick.
                      const fresh = await fetch(`/api/rancher/setup?token=${encodeURIComponent(token)}`);
                      if (fresh.ok) {
                        const fd = await fresh.json();
                        if (fd?.rancher) {
                          const r = fd.rancher as Rancher;
                          setLastRancher(r);
                          setPolledTier(tierSlugFromRancher(r));
                          setPolledStatus(String(r['Subscription Status'] || ''));
                        }
                      }
                    } catch (e: any) {
                      setTierErr(e?.message || 'Network error — please retry');
                    } finally {
                      setChecking(false);
                    }
                  }}
                  disabled={checking || showCheckmark}
                  className={`mt-auto text-center text-[11px] tracking-widest uppercase border px-3 py-2 transition-base ${
                    showCheckmark
                      ? 'border-sage text-sage-dark bg-bone-warm hover:bg-bone'
                      : selected
                      ? 'border-charcoal bg-charcoal text-bone hover:bg-divider'
                      : 'border-charcoal text-charcoal hover:bg-charcoal hover:text-bone'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {showCheckmark ? `On Legacy Connect ✓` : checking ? 'Setting up…' : `Pick ${card.label}`}
                </button>
              ) : (
                // Paid tiers (Pasture / Ranch / Operator): POST tier/select
                // INLINE and redirect the SAME tab to the returned Stripe
                // Checkout url. Previously this opened /partner/checkout/[slug]
                // in a new tab, whose success routed to /rancher/billing — so
                // paying ranchers fell out of the wizard and skipped
                // Fulfillment + Refund Policy + Sign. from='wizard' + the
                // wizard token make tier/select return the rancher to
                // /rancher/setup?...&tierComplete=1 after paying.
                <button
                  type="button"
                  onClick={async () => {
                    setTierErr('');
                    try {
                      setChecking(true);
                      const res = await fetch('/api/rancher/tier/select', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          tier: card.slug,
                          from: 'wizard',
                          wizardToken: token,
                        }),
                      });
                      const data = await res.json();
                      if (!res.ok) {
                        setTierErr(data?.error || `Could not start ${card.label} checkout`);
                        setChecking(false);
                        return;
                      }
                      if (data?.url) {
                        // Same-tab redirect into Stripe Checkout. On success
                        // Stripe returns to the wizard (tierComplete=1).
                        window.location.href = data.url;
                        return;
                      }
                      // No url returned — surface so the rancher isn't stuck on
                      // a silent no-op.
                      setTierErr('Could not start checkout — please retry.');
                      setChecking(false);
                    } catch (e: any) {
                      setTierErr(e?.message || 'Network error — please retry');
                      setChecking(false);
                    }
                  }}
                  disabled={checking || showCheckmark}
                  className={`mt-auto text-center text-[11px] tracking-widest uppercase border px-3 py-2 transition-base ${
                    showCheckmark
                      ? 'border-sage text-sage-dark bg-bone-warm hover:bg-bone'
                      : selected
                      ? 'border-charcoal bg-charcoal text-bone hover:bg-divider'
                      : 'border-charcoal text-charcoal hover:bg-charcoal hover:text-bone'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {showCheckmark
                    ? `Manage ${card.label} →`
                    : checking
                    ? 'Starting checkout…'
                    : selected
                    ? `Resume checkout →`
                    : `Pick ${card.label}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="border border-dust bg-bone-warm p-4 text-sm text-charcoal/85 leading-relaxed">
        {onFreeTier ? (
          <p>
            <span aria-hidden className="text-sage mr-1.5">✓</span>
            You&rsquo;re on <strong>Legacy Connect</strong> — free to start, 10%
            only when you sell. Hit continue to set up your payouts and
            fulfillment. Want more leads or a lower rate? Pick a paid upgrade
            above anytime.
          </p>
        ) : planLocked ? (
          <p>
            <span aria-hidden className="text-sage mr-1.5">✓</span>
            Plan confirmed — <strong>{TIER_CARDS.find((c) => c.slug === polledTier)?.label || polledTier}</strong>.
            Hit continue to set up fulfillment.
          </p>
        ) : polledTier && !isActive ? (
          <p>
            You picked the <strong>{TIER_CARDS.find((c) => c.slug === polledTier)?.label || polledTier}</strong> upgrade
            but we haven&rsquo;t seen the subscription clear yet (status: {polledStatus || 'pending'}).
            Finish checkout in the Stripe tab. We&rsquo;ll auto-detect when it&rsquo;s active —
            or pick <strong>Legacy Connect</strong> to start free instead.
          </p>
        ) : (
          <p>
            Setting you up on the free <strong>Legacy Connect</strong> plan — one
            sec. You can start with no monthly fee, or pick a paid upgrade above
            for more leads / a lower commission.
          </p>
        )}
        <button
          type="button"
          onClick={refreshNow}
          disabled={checking}
          className="mt-2 text-xs uppercase tracking-widest text-saddle underline underline-offset-2 hover:text-charcoal disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Refresh status now'}
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center pt-2 border-t border-dust">
        <button
          type="button"
          onClick={() => onContinue(lastRancher)}
          disabled={!planLocked}
          className="inline-flex items-center gap-2 justify-center px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-40 disabled:cursor-not-allowed"
          title={planLocked ? '' : 'Setting up your free plan…'}
        >
          {onFreeTier
            ? 'Continue free →'
            : planLocked
            ? 'I picked my plan, continue →'
            : 'Setting up your free plan…'}
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

// ── Step 8 — Fulfillment + Refund Policy (Stage-3 Task 11B) ───────────────
// Captures how the rancher delivers beef to buyers + their refund policy.
// Refund Policy is shown verbatim on the buyer's pre-payment page so this
// is the rancher's single-source-of-truth answer to "what happens if…".
function FulfillmentStep({
  token,
  form,
  setField,
  setFieldAndAutoSave,
  autoSaveStatus,
  saving,
  saveStep,
  onBack,
  onContinue,
}: {
  token: string;
  form: Record<string, any>;
  setField: (key: string, value: any) => void;
  setFieldAndAutoSave: (
    key: string,
    value: any,
    opts?: { isValid?: (v: any) => boolean }
  ) => void;
  autoSaveStatus: Record<string, 'idle' | 'saving' | 'saved'>;
  saving: boolean;
  saveStep: (slice: Record<string, any>) => Promise<boolean>;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [localError, setLocalError] = useState('');

  const types: string[] = Array.isArray(form['Fulfillment Types']) ? form['Fulfillment Types'] : [];
  const hasPickup = types.includes('Local Pickup');
  const hasDelivery = types.includes('Local Delivery');
  const hasShipping = types.includes('Cold-Chain Shipping');

  const refundPolicy: string = String(form['Refund Policy'] || '');
  const refundLen = refundPolicy.trim().length;

  // Next Processing Date (YYYY-MM-DD). Buyers see this as the "next available
  // processing date" so they know when they'll get their beef. Compare against
  // today's LOCAL date (string compare on YYYY-MM-DD is safe + tz-stable) to
  // gently warn if a saved date has already passed — we never block on it.
  const nextProcessingDate: string = String(form['Next Processing Date'] || '');
  const todayStr = (() => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  })();
  const processingDateIsPast = !!nextProcessingDate && nextProcessingDate < todayStr;

  const toggle = (val: string) => {
    const cur = new Set(types);
    if (cur.has(val)) cur.delete(val);
    else cur.add(val);
    setField('Fulfillment Types', Array.from(cur));
  };

  async function handleContinue() {
    setLocalError('');
    // Validation: at least one fulfillment type, conditional sub-fields,
    // and refund policy 20–500 chars.
    if (types.length === 0) {
      setLocalError('Pick at least one fulfillment option.');
      return;
    }
    if (hasPickup && !String(form['Pickup City'] || '').trim()) {
      setLocalError('Pickup city is required when Local Pickup is selected.');
      return;
    }
    if (hasDelivery) {
      const n = Number(form['Delivery Radius Miles']);
      if (!isFinite(n) || n <= 0) {
        setLocalError('Delivery radius miles is required when Local Delivery is selected.');
        return;
      }
    }
    if (hasShipping) {
      const n = Number(form['Shipping Lead Time Days']);
      if (!isFinite(n) || n <= 0) {
        setLocalError('Shipping lead time (days) is required when Cold-Chain Shipping is selected.');
        return;
      }
    }
    if (refundLen < 20) {
      setLocalError('Refund policy must be at least 20 characters — buyers see this verbatim.');
      return;
    }
    if (refundLen > 500) {
      setLocalError('Refund policy must be 500 characters or fewer.');
      return;
    }

    // PATCH the new fields. Coerce numerics so Airtable stores them as
    // numbers (the route casts price fields but not these); we send Number
    // values so they round-trip cleanly.
    const payload: Record<string, any> = {
      'Fulfillment Types': types,
      'Pickup City': hasPickup ? String(form['Pickup City'] || '').trim() : '',
      'Delivery Radius Miles': hasDelivery ? Number(form['Delivery Radius Miles']) : null,
      'Shipping Lead Time Days': hasShipping ? Number(form['Shipping Lead Time Days']) : null,
      'Refund Policy': refundPolicy.trim(),
      'Fulfillment Cost Notes': String(form['Fulfillment Cost Notes'] || '').trim(),
      // ISO date string or '' to clear. Optional — no validation gate.
      'Next Processing Date': nextProcessingDate || '',
    };
    const ok = await saveStep(payload);
    if (ok) onContinue();
  }

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">Step 8 · Fulfillment</p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          How do you get the beef to buyers?
        </h2>
        <p className="text-sm text-saddle mt-1">
          Pick all that apply. Buyers see these options on your listing.
        </p>
      </header>

      <div className="border-t border-b border-divider divide-y divide-divider">
        {FULFILLMENT_OPTIONS.map((opt) => {
          const checked = types.includes(opt.value);
          return (
            <label
              key={opt.value}
              className="flex items-center gap-3 py-3 cursor-pointer text-charcoal/90"
            >
              <span
                aria-hidden
                className={`inline-flex items-center justify-center w-5 h-5 border transition-base ${
                  checked ? 'bg-charcoal border-charcoal text-bone' : 'bg-white border-charcoal text-transparent'
                }`}
              >
                ✓
              </span>
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={() => toggle(opt.value)}
              />
              <span className="text-sm">{opt.label}</span>
            </label>
          );
        })}
      </div>

      {hasPickup && (
        <Field
          label="Pickup city + state"
          required
          value={form['Pickup City']}
          onChange={(v) => setField('Pickup City', v)}
          placeholder="e.g., Bandera, TX"
        />
      )}

      {hasDelivery && (
        <Field
          label="Delivery radius (miles)"
          required
          type="number"
          value={form['Delivery Radius Miles']}
          onChange={(v) => setField('Delivery Radius Miles', v)}
          placeholder="50"
        />
      )}

      {hasShipping && (
        <Field
          label="Shipping lead time (days after processing)"
          required
          type="number"
          value={form['Shipping Lead Time Days']}
          onChange={(v) => setField('Shipping Lead Time Days', v)}
          placeholder="3"
        />
      )}

      <TextareaField
        label="Fulfillment cost notes (optional)"
        value={form['Fulfillment Cost Notes']}
        onChange={(v) => setField('Fulfillment Cost Notes', v)}
        rows={2}
        placeholder='e.g., "Cooler shipping $45 add-on, paid at pickup."'
      />

      {/* Next processing date — buyers see this as "next available processing
          date" so they know when they'll get their beef. Optional; native date
          picker stores an ISO YYYY-MM-DD string. Gentle warning if it's past. */}
      <label className="block">
        <span className="block text-sm font-medium text-charcoal mb-1.5">
          Next processing date{' '}
          <span className="text-saddle font-normal">(optional)</span>
        </span>
        <input
          type="date"
          value={nextProcessingDate}
          onChange={(e) => setField('Next Processing Date', e.target.value)}
          className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle"
        />
        <span className="block text-xs text-saddle mt-1 leading-relaxed">
          Buyers see this as your &ldquo;next available processing date&rdquo; —
          it tells them when their beef will be ready.
        </span>
        {processingDateIsPast && (
          <span className="block text-xs text-weathered mt-1 leading-relaxed">
            This date has passed — update it so buyers see an accurate timeline.
          </span>
        )}
      </label>

      <div className="space-y-1.5">
        <TextareaField
          label="Refund policy (required, 20–500 chars)"
          value={form['Refund Policy']}
          onChange={(v) =>
            setFieldAndAutoSave('Refund Policy', v, {
              // Auto-save only when within valid range so we don't churn
              // PATCHes while the rancher is mid-sentence.
              isValid: (val: any) => {
                const s = String(val || '');
                return s.length >= 20 && s.length <= 500;
              },
            })
          }
          rows={4}
          placeholder={`Tip: "Full refund within 7 days if cattle isn't processed yet. After processing, store credit only."`}
        />
        <p className="text-xs text-saddle italic">
          Shown verbatim to buyers on the pre-payment page. {refundLen}/500
          {refundLen < 20 && ' — need at least 20'}
          {refundLen > 500 && ' — too long, trim it down'}
          <AutoSaveIndicator status={autoSaveStatus['Refund Policy']} />
        </p>
      </div>

      <div className="bg-bone-warm border border-dust p-4 text-sm text-saddle">
        <strong className="text-charcoal">Why we ask:</strong> buyers see the
        refund policy verbatim on your deposit page so they can decide before
        paying. Less back-and-forth for you.
      </div>

      {localError && (
        <div role="alert" className="text-sm text-weathered border border-weathered/40 bg-weathered/5 p-3">
          {localError}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center pt-2 border-t border-dust">
        <button
          type="button"
          onClick={handleContinue}
          disabled={saving}
          className="inline-flex items-center gap-2 justify-center px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save & continue →'}
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
