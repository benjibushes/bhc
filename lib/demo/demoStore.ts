// ─────────────────────────────────────────────────────────────────────────
// DEMO FIXTURE STORE — deterministic, in-memory FAKE data for demo mode.
//
// LOCAL ONLY. This module is only ever reached from a demo-gated branch
// (see lib/demo/demoMode.ts). It performs ZERO I/O — no Airtable, no network.
// Every record is shaped like a flattened Airtable row:
//   { id, ...fields, _createdTime }
// keyed by the REAL table names from lib/airtable TABLES so the whole
// platform (rancher dashboard, public landing page, buyer funnel, map, inbox)
// renders against it without any special-casing in the app layer.
//
// DETERMINISM: no Date.now() at module load. "Recent" timestamps are computed
// from a FIXED base date (DEMO_NOW) so every run produces byte-identical data.
// ─────────────────────────────────────────────────────────────────────────

import { TABLES } from '@/lib/airtable';

// Fixed reference "now" for the demo world. Everything recent is computed
// backward from here so the pipeline always looks the same age. (Deliberately
// a round date; the founder can bump it when recording so "3 days ago" reads
// current, without any nondeterminism at import time.)
const DEMO_NOW = new Date('2026-07-01T17:00:00.000Z');
function daysAgo(n: number): string {
  return new Date(DEMO_NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}
function hoursAgo(n: number): string {
  return new Date(DEMO_NOW.getTime() - n * 60 * 60 * 1000).toISOString();
}

// Recognizable 17-char record ids (rec + 14 alnum). The DEMO tag makes it
// obvious in logs/URLs that a record is fake.
export const DEMO_RANCHER_ID = 'recDEMOrancher01x'; // rec + 14 chars
export const DEMO_RANCHER_SLUG = 'demo-creek-cattle';

// ── Flagship demo rancher ────────────────────────────────────────────────
// tier_v2 + Stripe Connect 'active' + Page Live so the public landing page
// shows pricing + the deposit-reserve CTA, and the dashboard renders the full
// tier_v2 experience (deposit rail, no phantom commission invoice).
const DEMO_RANCHER: Record<string, any> = {
  id: DEMO_RANCHER_ID,
  'Operator Name': 'Sam Rivers',
  'Ranch Name': 'Demo Creek Cattle Co',
  Slug: DEMO_RANCHER_SLUG,
  State: 'MT',
  City: 'Bozeman',
  Email: 'sam@democreekcattle.example',
  Phone: '(406) 555-0142',
  'Verification Status': 'Verified',
  'Active Status': 'Active',
  // 'Live' (not 'Complete') — isRancherOperationalForBuyers gates onboarding
  // to '' | 'Live', so a demo buyer's reserve/quiz actually goes through
  // instead of 409ing "not taking orders". (2026-07-02 demo interactivity.)
  'Onboarding Status': 'Live',
  'Agreement Signed': true,
  'Agreement Signed At': daysAgo(45),
  'Page Live': true,
  'Public Map Hidden': false,
  // Money model
  'Pricing Model': 'tier_v2',
  // 'Ranch' — a VALID tier_v2 tier (VALID_TIER_NAMES: pasture/ranch/operator/
  // legacy_connect). 'Partner' failed hasValidTier, blocking online deposit.
  Tier: 'Ranch',
  'Stripe Connect Status': 'active',
  'Subscription Status': 'active',
  'Commission Rate': 0.06,
  'Max Active Referrals': 12,
  'Current Active Referrals': 4, // matches the count of active demo referrals below
  'Monthly Capacity': 8,
  // Public page content
  Tagline: 'Third-generation Black Angus, raised on Montana grass.',
  'About Text':
    'Demo Creek Cattle Co has run cattle in the Gallatin Valley for three generations. ' +
    'Our herd is 100% grass-fed and grass-finished, rotationally grazed across 1,200 acres of ' +
    'native Montana pasture. No hormones, no feedlots, ever. When you reserve a share you get ' +
    'beef from an animal we can point to by name — butchered by a local USDA facility and ready ' +
    'for your freezer.',
  'Beef Types': 'Black Angus grass-fed',
  'States Served': 'MT, ID, WY',
  'Preferred States': 'MT, ID, WY',
  'Routing States': 'MT, ID, WY',
  'Ships Nationwide': false,
  Certifications: 'USDA Processed, Grass-Fed, Hormone-Free',
  'Logo URL': 'https://picsum.photos/seed/democreeklogo/400/400',
  'Gallery Photos': JSON.stringify([
    'https://picsum.photos/seed/democreek1/1200/800',
    'https://picsum.photos/seed/democreek2/1200/800',
    'https://picsum.photos/seed/democreek3/1200/800',
  ]),
  'Video URL': '',
  Testimonials: JSON.stringify([
    { name: 'Dana P.', quote: 'Best beef we have ever had. The whole family tastes the difference.', location: 'Bozeman, MT' },
    { name: 'Marcus T.', quote: 'Reserved a half, freezer full, worth every penny. Sam kept me posted the whole way.', location: 'Idaho Falls, ID' },
  ]),
  // Full pricing — Quarter / Half / Whole
  'Quarter Price': 1050,
  'Quarter Deposit': 300,
  'Quarter Processing Fee': 0,
  'Quarter lbs': 110,
  'Half Price': 1950,
  'Half Deposit': 500,
  'Half Processing Fee': 0,
  'Half lbs': 220,
  'Whole Price': 3700,
  'Whole Deposit': 900,
  'Whole Processing Fee': 0,
  'Whole lbs': 440,
  'Tier Specialty': ['Quarter', 'Half', 'Whole'],
  'Next Processing Date': '2026-08-15',
  'Cal.com Slug': '',
  'Custom Notes': 'Pickup in Bozeman, or we can arrange chilled delivery within 200 miles.',
  'Processing Facility': 'Gallatin Valley USDA Meats',
  'Refund Policy': 'Deposit is refundable up to 14 days before processing.',
  _createdTime: daysAgo(60),
};

// ── Demo referrals ────────────────────────────────────────────────────────
// ~14 rows across ALL statuses so the pipeline looks alive. Buyer names follow
// the brand rule: first-initial + last-initial + state. Each links the demo
// rancher on BOTH the link array and the denorm 'Rancher Record Id' text field
// (mirrors createReferral's stampRancherRecordIds), so any read path resolves.
//
// Closed-won economics (6 rows) sum to a satisfying ~$18k revenue:
//   3700 + 3700 + 1950 + 3700 + 1950 + 3050 = 18,050
// Commission Due = 6% of Sale Amount on each.
type Ref = Record<string, any>;

function ref(partial: Ref): Ref {
  return {
    Rancher: [DEMO_RANCHER_ID],
    'Rancher Record Id': DEMO_RANCHER_ID,
    'Suggested Rancher': [DEMO_RANCHER_ID],
    'Suggested Rancher Record Id': DEMO_RANCHER_ID,
    ...partial,
  };
}

const DEMO_REFERRALS: Ref[] = [
  // ── Top of funnel ──
  ref({
    id: 'recDEMOreferral01',
    Status: 'Intro Sent',
    'Buyer Name': 'J.M. — MT',
    'Buyer Email': 'jm.mt@buyers.example',
    'Buyer Phone': '(406) 555-0111',
    'Buyer State': 'MT',
    'Order Type': 'Half',
    'Budget Range': '$1,500–$2,500',
    Notes: 'Wants grass-finished, first-time half buyer. Asked about delivery.',
    Buyer: ['recDEMObuyer0000001'],
    'Intro Sent At': daysAgo(2),
    'Last Rancher Activity At': daysAgo(2),
    _createdTime: daysAgo(2),
  }),
  ref({
    id: 'recDEMOreferral02',
    Status: 'Intro Sent',
    'Buyer Name': 'A.K. — ID',
    'Buyer Email': 'ak.id@buyers.example',
    'Buyer Phone': '(208) 555-0122',
    'Buyer State': 'ID',
    'Order Type': 'Quarter',
    'Budget Range': '$900–$1,200',
    Notes: 'Freezer space for a quarter. Wants pickup, not shipping.',
    Buyer: ['recDEMObuyer0000002'],
    'Intro Sent At': daysAgo(4),
    'Last Rancher Activity At': daysAgo(3),
    _createdTime: daysAgo(4),
  }),
  // ── Engaged ──
  ref({
    id: 'recDEMOreferral03',
    Status: 'Rancher Contacted',
    'Buyer Name': 'R.L. — WY',
    'Buyer Email': 'rl.wy@buyers.example',
    'Buyer Phone': '(307) 555-0133',
    'Buyer State': 'WY',
    'Order Type': 'Whole',
    'Budget Range': '$3,500–$4,000',
    Notes: 'Splitting a whole with a neighbor. Needs cut sheet help.',
    Buyer: ['recDEMObuyer0000003'],
    'Intro Sent At': daysAgo(6),
    'Rancher Accepted At': daysAgo(5),
    'Last Rancher Activity At': daysAgo(1),
    'Rancher Engaged Flag': true,
    _createdTime: daysAgo(6),
  }),
  ref({
    id: 'recDEMOreferral04',
    Status: 'Negotiation',
    'Buyer Name': 'T.N. — MT',
    'Buyer Email': 'tn.mt@buyers.example',
    'Buyer Phone': '(406) 555-0144',
    'Buyer State': 'MT',
    'Order Type': 'Half',
    'Budget Range': '$1,800–$2,200',
    Notes: 'Comparing cut sheets. Leaning toward a half, wants more ground beef.',
    Buyer: ['recDEMObuyer0000004'],
    'Intro Sent At': daysAgo(8),
    'Rancher Accepted At': daysAgo(7),
    'Last Rancher Activity At': hoursAgo(20),
    'Last Buyer Activity At': hoursAgo(18),
    'Rancher Engaged Flag': true,
    _createdTime: daysAgo(8),
  }),
  // ── Deposit rail ──
  ref({
    id: 'recDEMOreferral05',
    Status: 'Awaiting Payment',
    'Buyer Name': 'C.D. — ID',
    'Buyer Email': 'cd.id@buyers.example',
    'Buyer Phone': '(208) 555-0155',
    'Buyer State': 'ID',
    'Order Type': 'Half',
    'Budget Range': '$1,900',
    Notes: 'Verbally committed to a half. Deposit request sent, awaiting card.',
    Buyer: ['recDEMObuyer0000005'],
    'Intro Sent At': daysAgo(11),
    'Rancher Accepted At': daysAgo(10),
    'Deposit Requested At': daysAgo(1),
    'Deposit Amount': 500,
    'Total Sale Amount': 1950,
    'Last Rancher Activity At': daysAgo(1),
    _createdTime: daysAgo(11),
  }),
  ref({
    id: 'recDEMOreferral06',
    Status: 'Slot Locked',
    'Buyer Name': 'B.S. — MT',
    'Buyer Email': 'bs.mt@buyers.example',
    'Buyer Phone': '(406) 555-0166',
    'Buyer State': 'MT',
    'Order Type': 'Whole',
    'Budget Range': '$3,700',
    Notes: 'Deposit paid — slot locked for August processing. Whole cow.',
    Buyer: ['recDEMObuyer0000006'],
    'Intro Sent At': daysAgo(14),
    'Rancher Accepted At': daysAgo(13),
    'Deposit Requested At': daysAgo(9),
    'Deposit Paid At': daysAgo(8),
    'Deposit Amount': 900,
    'Total Sale Amount': 3700,
    'Last Rancher Activity At': daysAgo(8),
    _createdTime: daysAgo(14),
  }),
  // ── Closed Won (6 rows, ~$18,050 revenue) ──
  ref({
    id: 'recDEMOreferral07',
    Status: 'Closed Won',
    'Buyer Name': 'M.H. — WY',
    'Buyer Email': 'mh.wy@buyers.example',
    'Buyer Phone': '(307) 555-0177',
    'Buyer State': 'WY',
    'Order Type': 'Whole',
    'Budget Range': '$3,700',
    Notes: 'Whole cow, delivered. Repeat buyer from last season.',
    Buyer: ['recDEMObuyer0000007'],
    'Sale Amount': 3700,
    'Total Sale Amount': 3700,
    'Commission Due': 222,
    'Commission Paid': true,
    'Deposit Paid At': daysAgo(40),
    'Deposit Amount': 900,
    'Closed At': daysAgo(35),
    'Fulfillment Status': 'fulfilled',
    'Fulfillment Confirmed At': daysAgo(20),
    'Fulfillment Method': 'Delivery',
    'Shipping Carrier': 'Local chilled delivery',
    'Tracking Number': 'DEMO-DELIV-0007',
    _createdTime: daysAgo(48),
  }),
  ref({
    id: 'recDEMOreferral08',
    Status: 'Closed Won',
    'Buyer Name': 'K.W. — MT',
    'Buyer Email': 'kw.mt@buyers.example',
    'Buyer Phone': '(406) 555-0188',
    'Buyer State': 'MT',
    'Order Type': 'Whole',
    'Budget Range': '$3,700',
    Notes: 'Whole, picked up in Bozeman. Left a 5-star review.',
    Buyer: ['recDEMObuyer0000008'],
    'Sale Amount': 3700,
    'Total Sale Amount': 3700,
    'Commission Due': 222,
    'Commission Paid': true,
    'Deposit Paid At': daysAgo(38),
    'Deposit Amount': 900,
    'Closed At': daysAgo(30),
    'Fulfillment Status': 'fulfilled',
    'Fulfillment Confirmed At': daysAgo(16),
    'Fulfillment Method': 'Pickup',
    'Buyer Review': 'Incredible beef and Sam was a pleasure to work with. Freezer is full and happy.',
    'Buyer Rating': 5,
    'Review Submitted At': daysAgo(14),
    _createdTime: daysAgo(46),
  }),
  ref({
    id: 'recDEMOreferral09',
    Status: 'Closed Won',
    'Buyer Name': 'P.G. — ID',
    'Buyer Email': 'pg.id@buyers.example',
    'Buyer Phone': '(208) 555-0199',
    'Buyer State': 'ID',
    'Order Type': 'Half',
    'Budget Range': '$1,950',
    Notes: 'Half cow, processing complete.',
    Buyer: ['recDEMObuyer0000009'],
    'Sale Amount': 1950,
    'Total Sale Amount': 1950,
    'Commission Due': 117,
    'Commission Paid': false,
    'Deposit Paid At': daysAgo(26),
    'Deposit Amount': 500,
    'Closed At': daysAgo(21),
    'Fulfillment Status': 'processing',
    'Fulfillment Method': 'Pickup',
    'Buyer Rating': 5,
    'Buyer Review': 'Great communication and the ground beef is unreal.',
    'Review Submitted At': daysAgo(10),
    _createdTime: daysAgo(34),
  }),
  ref({
    id: 'recDEMOreferral10',
    Status: 'Closed Won',
    'Buyer Name': 'D.R. — WY',
    'Buyer Email': 'dr.wy@buyers.example',
    'Buyer Phone': '(307) 555-0210',
    'Buyer State': 'WY',
    'Order Type': 'Whole',
    'Budget Range': '$3,700',
    Notes: 'Whole cow, shipped frozen.',
    Buyer: ['recDEMObuyer0000010'],
    'Sale Amount': 3700,
    'Total Sale Amount': 3700,
    'Commission Due': 222,
    'Commission Paid': false,
    'Deposit Paid At': daysAgo(18),
    'Deposit Amount': 900,
    'Closed At': daysAgo(12),
    'Fulfillment Status': 'processing',
    'Fulfillment Method': 'Shipping',
    'Shipping Carrier': 'FedEx',
    'Tracking Number': 'DEMO-FDX-0010',
    _createdTime: daysAgo(24),
  }),
  ref({
    id: 'recDEMOreferral11',
    Status: 'Closed Won',
    'Buyer Name': 'S.F. — MT',
    'Buyer Email': 'sf.mt@buyers.example',
    'Buyer Phone': '(406) 555-0221',
    'Buyer State': 'MT',
    'Order Type': 'Half',
    'Budget Range': '$1,950',
    Notes: 'Half cow, first-time buyer, very happy.',
    Buyer: ['recDEMObuyer0000011'],
    'Sale Amount': 1950,
    'Total Sale Amount': 1950,
    'Commission Due': 117,
    'Commission Paid': false,
    'Deposit Paid At': daysAgo(14),
    'Deposit Amount': 500,
    'Closed At': daysAgo(9),
    'Fulfillment Method': 'Pickup',
    _createdTime: daysAgo(19),
  }),
  ref({
    id: 'recDEMOreferral12',
    Status: 'Closed Won',
    'Buyer Name': 'L.B. — ID',
    'Buyer Email': 'lb.id@buyers.example',
    'Buyer Phone': '(208) 555-0232',
    'Buyer State': 'ID',
    'Order Type': 'Custom split',
    'Budget Range': '$3,050',
    Notes: 'Two families split a whole; recorded as one $3,050 sale.',
    Buyer: ['recDEMObuyer0000012'],
    'Sale Amount': 3050,
    'Total Sale Amount': 3050,
    'Commission Due': 183,
    'Commission Paid': true,
    'Deposit Paid At': daysAgo(10),
    'Deposit Amount': 800,
    'Closed At': daysAgo(5),
    'Fulfillment Method': 'Pickup',
    _createdTime: daysAgo(15),
  }),
  // ── Closed Lost (2 rows) ──
  ref({
    id: 'recDEMOreferral13',
    Status: 'Closed Lost',
    'Buyer Name': 'N.V. — WY',
    'Buyer Email': 'nv.wy@buyers.example',
    'Buyer Phone': '(307) 555-0243',
    'Buyer State': 'WY',
    'Order Type': 'Quarter',
    'Budget Range': '$900',
    Notes: 'Went with a local ranch closer to home. Friendly, no hard feelings.',
    Buyer: ['recDEMObuyer0000013'],
    'Intro Sent At': daysAgo(20),
    'Closed At': daysAgo(13),
    _createdTime: daysAgo(20),
  }),
  ref({
    id: 'recDEMOreferral14',
    Status: 'Closed Lost',
    'Buyer Name': 'E.C. — MT',
    'Buyer Email': 'ec.mt@buyers.example',
    'Buyer Phone': '(406) 555-0254',
    'Buyer State': 'MT',
    'Order Type': 'Half',
    'Budget Range': '$1,800',
    Notes: 'Timing did not work out this season. Wants to revisit in the fall.',
    Buyer: ['recDEMObuyer0000014'],
    'Intro Sent At': daysAgo(25),
    'Closed At': daysAgo(16),
    _createdTime: daysAgo(25),
  }),
];

// ── Demo consumers (one per referral's Buyer link) ────────────────────────
const DEMO_CONSUMERS: Ref[] = DEMO_REFERRALS.map((r, i) => {
  const buyerId = (r['Buyer'] as string[])[0];
  return {
    id: buyerId,
    'Full Name': r['Buyer Name'],
    Email: r['Buyer Email'],
    Phone: r['Buyer Phone'],
    State: r['Buyer State'],
    Status: r['Status'] === 'Closed Won' ? 'Purchased' : 'Qualified',
    'Order Type': r['Order Type'],
    'Budget Range': r['Budget Range'],
    'Intent Score': 70 + (i % 30),
    'SMS Opt-In': false,
    Unsubscribed: false,
    _createdTime: r._createdTime,
  };
});

// ── Demo payments (one per referral that paid a deposit) ──────────────────
const DEMO_PAYMENTS: Ref[] = DEMO_REFERRALS.filter((r) => r['Deposit Paid At']).map(
  (r, i) => ({
    id: `recDEMOpayment${String(i + 1).padStart(2, '0')}xx`.slice(0, 17),
    'Referral Id Text': r.id,
    Referral: [r.id],
    Buyer: r['Buyer'],
    Rancher: [DEMO_RANCHER_ID],
    Amount: r['Deposit Amount'] || 0,
    'Amount Cents': (r['Deposit Amount'] || 0) * 100,
    Type: 'deposit',
    Status: 'succeeded',
    'Stripe Payment Intent Id': `pi_DEMO${String(i + 1).padStart(4, '0')}`,
    'Paid At': r['Deposit Paid At'],
    _createdTime: r['Deposit Paid At'],
  }),
);

// ── Demo threads + messages (so the inbox shows unread buyer messages) ────
const DEMO_THREADS: Ref[] = [
  {
    id: 'recDEMOthread0001',
    Subject: 'Delivery question — half cow',
    Rancher: [DEMO_RANCHER_ID],
    'Rancher Id Text': DEMO_RANCHER_ID,
    Buyer: ['recDEMObuyer0000001'],
    Referral: ['recDEMOreferral01'],
    'Referral Id Text': 'recDEMOreferral01',
    'Thread Messages': ['recDEMOmsg00000001', 'recDEMOmsg00000002', 'recDEMOmsg00000003'],
    Status: 'Active',
    'Last Message At': hoursAgo(3),
    _createdTime: daysAgo(2),
  },
  {
    id: 'recDEMOthread0002',
    Subject: 'Cut sheet help — whole',
    Rancher: [DEMO_RANCHER_ID],
    'Rancher Id Text': DEMO_RANCHER_ID,
    Buyer: ['recDEMObuyer0000003'],
    Referral: ['recDEMOreferral03'],
    'Referral Id Text': 'recDEMOreferral03',
    'Thread Messages': ['recDEMOmsg00000004', 'recDEMOmsg00000005'],
    Status: 'Active',
    'Last Message At': hoursAgo(26),
    _createdTime: daysAgo(6),
  },
];

const DEMO_THREAD_MESSAGES: Ref[] = [
  {
    id: 'recDEMOmsg00000001',
    Thread: ['recDEMOthread0001'],
    'Sender Type': 'rancher',
    Body: 'Hi J.M.! Thanks for your interest in a half. Happy to answer any questions.',
    'Sent Via': 'web',
    'Created At': hoursAgo(30),
    _createdTime: hoursAgo(30),
  },
  {
    id: 'recDEMOmsg00000002',
    Thread: ['recDEMOthread0001'],
    'Sender Type': 'buyer',
    Body: 'Thanks Sam! Do you deliver to the Bozeman area, or is it pickup only?',
    'Sent Via': 'web',
    'Created At': hoursAgo(5),
    _createdTime: hoursAgo(5),
  },
  {
    id: 'recDEMOmsg00000003',
    Thread: ['recDEMOthread0001'],
    'Sender Type': 'buyer',
    Body: 'Also — how much freezer space should I plan for?',
    'Sent Via': 'web',
    'Created At': hoursAgo(3),
    _createdTime: hoursAgo(3),
  },
  {
    id: 'recDEMOmsg00000004',
    Thread: ['recDEMOthread0002'],
    'Sender Type': 'rancher',
    Body: 'For a whole, I can walk you and your neighbor through the cut sheet on a quick call.',
    'Sent Via': 'web',
    'Created At': hoursAgo(50),
    _createdTime: hoursAgo(50),
  },
  {
    id: 'recDEMOmsg00000005',
    Thread: ['recDEMOthread0002'],
    'Sender Type': 'buyer',
    Body: 'That would be great. We are torn between more steaks vs. more ground.',
    'Sent Via': 'web',
    'Created At': hoursAgo(26),
    _createdTime: hoursAgo(26),
  },
];

// ── Table → fixtures index ────────────────────────────────────────────────
// Keyed by the REAL Airtable table names (TABLES.*).
//
// SHARED across ALL routes via globalThis (the standard Next.js dev pattern):
// Next bundles /api/checkout/* and /api/rancher/* as SEPARATE server modules,
// so a plain module-level `const` would give each route its OWN store — a
// buyer's reserve (checkout bundle) would never reach the rancher dashboard
// (rancher bundle). Pinning the mutable store on globalThis makes every route
// in the single dev process see the same interactive data. Reseeds on restart.
const _seed = (): Record<string, Ref[]> => ({
  [TABLES.RANCHERS]: [DEMO_RANCHER],
  [TABLES.REFERRALS]: DEMO_REFERRALS,
  [TABLES.CONSUMERS]: DEMO_CONSUMERS,
  [TABLES.PAYMENTS]: DEMO_PAYMENTS,
  ['Threads']: DEMO_THREADS,
  ['Thread Messages']: DEMO_THREAD_MESSAGES,
  [TABLES.BRANDS]: [],
  [TABLES.AFFILIATES]: [],
});
const _g = globalThis as unknown as { __BHC_DEMO_STORE__?: Record<string, Ref[]> };
if (!_g.__BHC_DEMO_STORE__) _g.__BHC_DEMO_STORE__ = _seed();
const TABLE_FIXTURES: Record<string, Ref[]> = _g.__BHC_DEMO_STORE__;

/**
 * All demo fixtures for a table, each shaped like a flattened Airtable record
 * ({ id, ...fields, _createdTime }). Returns a shallow COPY of the array (not
 * the records) so a caller that mutates the array can't corrupt the store.
 * Unknown table → [].
 */
export function demoTableRecords(tableName: string): any[] {
  return (TABLE_FIXTURES[tableName] || []).slice();
}

/**
 * Best-effort formula-aware read for the demo store (getAllRecords
 * interception). Most callers filter their result in JS anyway, so returning
 * everything is usually fine — BUT existence checks like the reserve rail's
 * `LOWER({Email}) = "x"` MUST return [] for a genuinely-new email, or the
 * route thinks the buyer already exists and sends a magic link instead of
 * creating the lead on camera. So we parse the simple equality patterns
 * (`{Field} = "v"`, `LOWER({Field}) = "v"`, AND-ed) and filter on them;
 * anything we don't recognize falls back to returning all rows.
 */
export function demoQuery(tableName: string, formula?: string): any[] {
  const rows = TABLE_FIXTURES[tableName] || [];
  if (!formula || !formula.trim()) return rows.slice();
  // Pull every `{Field} = "value"` / `LOWER({Field}) = "value"` clause.
  const clauses: Array<{ field: string; value: string; lower: boolean }> = [];
  const re = /(LOWER\()?\{([^}]+)\}\)?\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    clauses.push({ lower: !!m[1], field: m[2], value: m[3].replace(/\\"/g, '"').replace(/\\\\/g, '\\') });
  }
  if (clauses.length === 0) return rows.slice();
  // OR(...) → any clause matches (the rancher-scoped referral read is
  // `OR({Rancher Record Id}=x, {Suggested Rancher Record Id}=x)`, and a fresh
  // reserve/quiz lead only has one of the two — so AND would hide it). Default
  // AND for the common single-field existence check.
  const isOr = /^\s*OR\s*\(/i.test(formula);
  const test = (r: any, c: { field: string; value: string; lower: boolean }) => {
    const cell = r[c.field];
    const cellStr = Array.isArray(cell) ? cell.map(String).join(',') : String(cell ?? '');
    return c.lower ? cellStr.toLowerCase() === c.value.toLowerCase() : cellStr === c.value;
  };
  return rows.filter((r) => (isOr ? clauses.some((c) => test(r, c)) : clauses.every((c) => test(r, c))));
}

/**
 * A single demo record by id within a table, or null. Used by the
 * getRecordById / getRecord interception.
 */
export function demoRecordById(tableName: string, id: string): any | null {
  const rows = TABLE_FIXTURES[tableName] || [];
  return rows.find((r) => r.id === id) || null;
}

/**
 * Records within a table whose id is in the given set — used by the
 * getRecordsByIds interception so each demo thread shows only its own
 * messages (rather than every message in the table).
 */
export function demoRecordsByIds(tableName: string, ids: unknown): any[] {
  const wanted = new Set(
    (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === 'string'),
  );
  if (wanted.size === 0) return [];
  return (TABLE_FIXTURES[tableName] || []).filter((r) => wanted.has(r.id));
}

/**
 * The flagship demo rancher when the slug matches the demo slug — or, in demo
 * mode, for ANY slug (so a mistyped slug in a screen recording still lands on
 * the demo page instead of a 404). Returns the rancher record or null.
 */
export function demoRancherForSlug(_slug: string): any | null {
  // Every slug (incl. a typo on camera) resolves to the one demo rancher. Read
  // from the SHARED store so a landing-page edit made in the dashboard shows on
  // the public page.
  return (TABLE_FIXTURES[TABLES.RANCHERS] || [])[0] || DEMO_RANCHER;
}

// ── MUTABLE demo store (in-session interactivity) ─────────────────────────
// So a demo VIDEO is interactive: closing a sale, requesting a deposit,
// editing the landing page, or a buyer reserving all PERSIST for the life of
// the dev-server process (module-level backing arrays). A server restart
// reseeds to the fixtures above — the reset button is Ctrl-C + npm run dev.
// Still zero external calls: these mutate memory only, never Airtable.

let _demoSeq = 0;
/** Deterministic-ish demo record id (17-char rec shape) for a created row. */
function demoNewId(prefix = 'created'): string {
  _demoSeq += 1;
  // rec + 14 chars. Pad the sequence so ids stay the valid 17-char shape.
  return (`recDEMO${prefix}${_demoSeq}`.replace(/[^A-Za-z0-9]/g, '') + '00000000000000').slice(0, 17);
}

function backingArray(tableName: string): Ref[] | null {
  return TABLE_FIXTURES[tableName] || null;
}

/**
 * Append a record to the live demo table (createRecord interception). Returns
 * the flattened record. A brand-new table name is created on the fly so a demo
 * write to an un-seeded table still succeeds instead of vanishing.
 */
export function demoCreate(tableName: string, fields: Record<string, any>): any {
  if (!TABLE_FIXTURES[tableName]) TABLE_FIXTURES[tableName] = [];
  const nowIso = new Date().toISOString();
  const rec: any = { id: demoNewId(), ...fields, _createdTime: nowIso };
  TABLE_FIXTURES[tableName].push(rec);
  return rec;
}

/**
 * Merge fields into an existing demo record IN PLACE (updateRecord
 * interception) so the change is visible on the next read — close a sale, and
 * the dashboard's next fetch recomputes stats from the mutated row. Unknown id
 * → returns the merged shape without persisting (matches the old no-op so a
 * stray update can't throw).
 */
export function demoUpdate(tableName: string, id: string, fields: Record<string, any>): any {
  const rows = backingArray(tableName);
  const rec = rows?.find((r) => r.id === id);
  if (rec) {
    Object.assign(rec, fields);
    return rec;
  }
  return { id, ...fields };
}

/** Remove a demo record (deleteRecord interception). No-throw on unknown id. */
export function demoDelete(tableName: string, id: string): void {
  const rows = backingArray(tableName);
  if (!rows) return;
  const i = rows.findIndex((r) => r.id === id);
  if (i >= 0) rows.splice(i, 1);
}

/** The demo rancher record id (for the auth bypass + session object). */
export function demoRancher(): any {
  return (TABLE_FIXTURES[TABLES.RANCHERS] || [])[0] || DEMO_RANCHER;
}
