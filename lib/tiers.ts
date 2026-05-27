// lib/tiers.ts
//
// Single source of truth for the 3-tier rancher subscription model + add-ons.
// Any code that needs price, commission rate, Stripe Price ID, or perks
// imports from here. Tier changes happen in ONE place.
//
// AIRTABLE TABLE IDS (verified 2026-05-25):
//   Ranchers          : tbl08y9Be45zNG0OG
//   Payments          : tblPfESJ4lxwtGThy
//   Payouts           : tbl2lEnCbz0o3VqbH
//   Add-On Purchases  : tblebGHKDzRMc9epT
//
// STRIPE PRICE IDS (LIVE mode on acct_1TSn5PGTWWNqassH):
//   Pasture          : price_1Tb3IWGTWWNqassHaIvpNXeC
//   Ranch            : price_1Tb3IyGTWWNqassHynt7qAJn
//   Operator         : price_1Tb3JLGTWWNqassH0UPyua3j
//   Add-on Video     : price_1Tb3JhGTWWNqassHXZ8nSuW5
//   Add-on Photo     : price_1Tb3K4GTWWNqassHvTC4w9KE
//   Add-on Founder Letter : price_1Tb3KPGTWWNqassHdBaWY8Z8

export type TierSlug = 'pasture' | 'ranch' | 'operator';

export interface TierConfig {
  slug: TierSlug;
  label: string;
  monthlyCents: number;
  commissionRate: number; // 0.07 = 7%
  stripePriceIdEnv: string;
  promise: string;
  perks: string[];
}

export const TIERS: Record<TierSlug, TierConfig> = {
  pasture: {
    slug: 'pasture',
    label: 'Pasture',
    monthlyCents: 15000,
    commissionRate: 0.07,
    stripePriceIdEnv: 'STRIPE_PASTURE_PRICE_ID',
    promise: 'We send you buyers',
    perks: [
      'Verified green-pin listing on /map (organic buyer discovery)',
      'Custom landing page at buyhalfcow.com/ranchers/[your-ranch] — SEO-optimized, photos, story, pricing',
      'Automatic buyer matching when someone in your state takes the /access quiz',
      'Intro emails fired to the buyer with your contact + ranch profile',
      'Reply tracking in your rancher dashboard (you see every conversation)',
      'Capacity controls — you set max active leads, we never overload you',
      'Listing mention in the monthly buyer newsletter when you close a deal',
      'Self-serve onboarding wizard (live in 5 minutes)',
    ],
  },
  ranch: {
    slug: 'ranch',
    label: 'Ranch',
    monthlyCents: 35000,
    commissionRate: 0.03,
    stripePriceIdEnv: 'STRIPE_RANCH_PRICE_ID',
    promise: 'We send you buyers AND make sure they see you first',
    perks: [
      'Everything in Pasture',
      'Priority routing — when a buyer in your state qualifies, you get the match before any other rancher',
      'Listing optimization — Ben personally rewrites your landing page copy quarterly',
      'Case study post to BHC Instagram + Twitter every time you close a deal',
      'Featured rancher in 1 founder letter per quarter (1,600+ qualified buyers)',
      'Inclusion on the /wins page — public proof wall of closed deals',
      'Monthly performance review — 30-min call or written breakdown',
      'First-dibs on brand partner co-marketing',
    ],
  },
  operator: {
    slug: 'operator',
    label: 'Operator',
    monthlyCents: 50000,
    commissionRate: 0, // zero commission — flat subscription only
    stripePriceIdEnv: 'STRIPE_OPERATOR_PRICE_ID',
    promise: 'We send you buyers, position you, and run your marketing',
    perks: [
      'Everything in Ranch',
      '2 custom reels per month produced for your ranch',
      '1 founder-voice email per month written for your direct customer list',
      'Listing fully managed — pricing, photos, copy refreshes all handled',
      'Quarterly feature in BHC YouTube long-form',
      'Brand partner intros, warm-handoff',
      'Quarterly 1:1 strategy call with Ben',
      'Zero commission on deals — every dollar a buyer pays you is yours',
      'First call on speaking + podcast opportunities when BHC books regen-ag media',
    ],
  },
};

// Add-ons (à la carte, any tier)
export interface AddOnConfig {
  slug: 'video' | 'photo' | 'founder_letter' | 'brand_intro' | 'ppc';
  label: string;
  description: string;
  pricing:
    | { kind: 'one_time'; cents: number }
    | { kind: 'percent_of_deal'; rate: number }
    | { kind: 'percent_plus_minimum'; rate: number; monthlyMinCents: number };
  stripePriceIdEnv?: string;
}

export const ADD_ONS: AddOnConfig[] = [
  {
    slug: 'video',
    label: 'Custom on-site video shoot (Ben travels)',
    description: '$2,500 + travel expenses billed separately',
    pricing: { kind: 'one_time', cents: 250000 },
    stripePriceIdEnv: 'STRIPE_ADDON_VIDEO_PRICE_ID',
  },
  {
    slug: 'photo',
    label: 'Annual brand photo refresh',
    description: 'On-site photo shoot, full delivery within 30 days',
    pricing: { kind: 'one_time', cents: 150000 },
    stripePriceIdEnv: 'STRIPE_ADDON_PHOTO_PRICE_ID',
  },
  {
    slug: 'founder_letter',
    label: 'Founder-letter campaign',
    description: '3-email sequence written + sent to your direct customer list',
    pricing: { kind: 'one_time', cents: 75000 },
    stripePriceIdEnv: 'STRIPE_ADDON_FOUNDER_LETTER_PRICE_ID',
  },
  {
    slug: 'brand_intro',
    label: 'Brand partner intro + negotiation',
    description: 'We pair you with cooler/knife/supplement brands looking for D2C rancher partners',
    // No Stripe Price ID — billed manually (15% of closed deal value).
    pricing: { kind: 'percent_of_deal', rate: 0.15 },
  },
  {
    slug: 'ppc',
    label: 'PPC management for your direct site',
    description: 'Google + Meta ads for your own ranch site (not BHC)',
    // No Stripe Price ID — billed manually (15% of ad spend, $500/mo min).
    pricing: { kind: 'percent_plus_minimum', rate: 0.15, monthlyMinCents: 50000 },
  },
];

export function tierFor(rancher: any): TierSlug | null {
  const raw = rancher?.['Tier'];
  // Airtable singleSelect fields can return either a string ('Pasture') or
  // an object ({id, name, color}). Handle both shapes.
  const tierStr = (raw && typeof raw === 'object' && 'name' in raw)
    ? String(raw.name)
    : (raw ?? '');
  const slug = String(tierStr).toLowerCase();
  if (slug === 'pasture' || slug === 'ranch' || slug === 'operator') return slug as TierSlug;
  return null;
}

export function commissionRateForTier(tier: TierSlug | null): number {
  if (!tier) return Number(process.env.COMMISSION_RATE_DEFAULT || '0.10');
  return TIERS[tier].commissionRate;
}

// Brand Partner Founding 100 cap — shared between /brand-partners page +
// /api/stats/public endpoint. Single source of truth so cap can never
// drift between display + enforcement.
export const FOUNDING_BRAND_PARTNER_CAP = 100;

// Founding Herd cap — already enforced in app/api/founders/checkout/route.ts
// via lib/secrets.ts FOUNDING_100_CAP. Re-exported here for shared
// reference w/ frontend display logic.
export { FOUNDING_100_CAP } from './secrets';
