// WAVE 3a (2026-06-30): the find/awareness operating-system layer for the
// rancher dashboard. Three pure, dependency-free helpers powering the new
// read-only views:
//
//   1. groupReferralsByBuyer  → the CRM (customers list)
//   2. deriveActivityEvents   → the notification / activity feed
//   3. matchesSearch          → global search filter
//
// All three operate on data the dashboard ALREADY has (the rancher's own
// referrals — already scoped to the logged-in rancher in
// /api/rancher/dashboard). No money/settlement logic. No Airtable writes.
// Kept pure + in lib/ so `npm test` (lib/**/*.test.ts) can lock them down.

// ──────────────────────────────────────────────────────────────────────────
// Shared minimal referral shape. Mirrors the fields the dashboard maps in
// /api/rancher/dashboard/route.ts referralsList. We only depend on the subset
// these helpers read, so callers can pass the existing Referral objects.
// ──────────────────────────────────────────────────────────────────────────
export interface CrmReferral {
  id: string;
  status: string;
  buyer_name?: string;
  buyer_email?: string;
  buyer_phone?: string;
  buyer_state?: string;
  order_type?: string;
  sale_amount?: number;
  created_at?: string;
  intro_sent_at?: string;
  closed_at?: string;
  // Activity-feed timestamps (already fetched in dashboard/route.ts ~91-122 but
  // previously discarded). Surfacing them is the whole point of the feed.
  rancher_accepted_at?: string;
  deposit_requested_at?: string;
  deposit_paid_at?: string;
  final_invoice_sent_at?: string;
  final_paid_at?: string;
  fulfillment_confirmed_at?: string;
  last_buyer_activity_at?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. CUSTOMERS / CRM — group a rancher's referrals by buyer.
//
// A D2C beef business lives on repeat buyers, but the dashboard only ever
// showed referrals as flat rows — the same buyer across two deals looked like
// two unrelated leads. This collapses them into one customer record with
// lifetime aggregates so the rancher can see who their real customers are.
// ──────────────────────────────────────────────────────────────────────────

export interface Customer {
  // Stable key for this buyer: lowercased email, else phone, else name.
  key: string;
  name: string;
  email: string;
  phone: string;
  state: string;
  totalDeals: number;
  // Count of deals that actually closed-won (drives the repeat-buyer flag +
  // lifetime $ — an "Intro Sent" lead isn't a customer yet).
  closedWonDeals: number;
  // Sum of Sale Amount across this buyer's Closed Won referrals.
  lifetimeValue: number;
  // A repeat buyer = 2+ CLOSED-WON deals. The thing a beef business chases.
  isRepeat: boolean;
  // Most recent meaningful date across this buyer's deals (closed > intro >
  // created). ISO string or '' if none parseable.
  lastDealDate: string;
  // The referral ids backing this customer, newest-first — so the UI can link
  // to the buyer's deal(s)/thread.
  referralIds: string[];
  // The single newest referral id (the one to jump to on click). '' for a
  // customer known only from shop orders (no referral exists yet).
  latestReferralId: string;
  // ── SHOP-CUSTOMER DEALS (2026-08-03) — optional shop-order annotations ──
  // Set by mergeOrderBuyersIntoCustomers when this buyer has Rancher Orders
  // rows. A customer with orders but NO referrals is the "Track as deal"
  // case: she bought through the ranch's shop/site and has no Deals-tab row.
  orderCount?: number;
  latestOrderId?: string;
  latestOrderRef?: string;
  // ISO date of the newest order — display + recency-sort fallback for
  // order-only customers (whose lastDealDate is '').
  lastOrderDate?: string;
}

// Normalize a buyer identity key. Email is the strongest signal; fall back to
// phone digits, then a normalized name. Returns '' only when all are blank
// (those referrals are skipped — a buyer-less referral isn't a customer).
export function buyerKey(r: CrmReferral): string {
  const email = String(r.buyer_email || '').trim().toLowerCase();
  if (email) return `e:${email}`;
  const phone = String(r.buyer_phone || '').replace(/\D/g, '');
  if (phone) return `p:${phone}`;
  const name = String(r.buyer_name || '').trim().toLowerCase();
  if (name) return `n:${name}`;
  return '';
}

function dealDateMs(r: CrmReferral): number {
  const raw = r.closed_at || r.intro_sent_at || r.created_at || '';
  const t = new Date(String(raw)).getTime();
  return isNaN(t) ? 0 : t;
}

export function groupReferralsByBuyer(referrals: CrmReferral[]): Customer[] {
  const map = new Map<string, CrmReferral[]>();
  for (const r of referrals) {
    const key = buyerKey(r);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }

  const customers: Customer[] = [];
  for (const [key, refs] of map) {
    // newest-first so the first ref is the one to jump to + the freshest
    // contact details win.
    const sorted = [...refs].sort((a, b) => dealDateMs(b) - dealDateMs(a));
    const newest = sorted[0];
    const closedWon = sorted.filter((r) => r.status === 'Closed Won');
    const lifetimeValue = closedWon.reduce(
      (sum, r) => sum + (Number(r.sale_amount) || 0),
      0,
    );
    // Prefer the freshest non-blank contact field across the buyer's deals.
    const pick = (f: keyof CrmReferral): string => {
      for (const r of sorted) {
        const v = String(r[f] || '').trim();
        if (v) return v;
      }
      return '';
    };
    const lastMs = dealDateMs(newest);
    customers.push({
      key,
      name: pick('buyer_name') || pick('buyer_email') || 'unknown buyer',
      email: pick('buyer_email'),
      phone: pick('buyer_phone'),
      state: pick('buyer_state'),
      totalDeals: sorted.length,
      closedWonDeals: closedWon.length,
      lifetimeValue,
      isRepeat: closedWon.length >= 2,
      lastDealDate: lastMs > 0 ? new Date(lastMs).toISOString() : '',
      referralIds: sorted.map((r) => r.id),
      latestReferralId: newest.id,
    });
  }

  // Default sort: highest lifetime value first, then most recent deal. Puts the
  // rancher's best customers at the top.
  customers.sort((a, b) => {
    if (b.lifetimeValue !== a.lifetimeValue) return b.lifetimeValue - a.lifetimeValue;
    return (
      new Date(b.lastDealDate || 0).getTime() -
      new Date(a.lastDealDate || 0).getTime()
    );
  });
  return customers;
}

// ──────────────────────────────────────────────────────────────────────────
// 1b. SHOP-CUSTOMER DEALS (2026-08-03) — fold Rancher Orders buyers into the
// customers list.
//
// A buyer who purchased through the ranch's own shop/site writes a Rancher
// Orders row, never a Referral — so she was invisible to the CRM grouping
// above and the rancher had no row to promote into a trackable deal. This
// merges order buyers into the SAME Customer list: an existing customer
// (matched by email, else name — orders carry no phone) gets order
// annotations; a buyer with no referrals becomes a new order-only Customer
// row (referralIds [], latestReferralId '') that the dashboard can offer
// "Track as deal" on. Pure; refunded orders are skipped (not a customer to
// chase); money aggregates (lifetimeValue) stay referral-only so a promoted
// + closed-won deal never double-counts the same sale.
// ──────────────────────────────────────────────────────────────────────────

export interface CrmOrder {
  id: string;
  buyerName?: string;
  buyerEmail?: string;
  orderedAt?: string;
  /** Order Ref, e.g. "Quarter Beef — Test Buyer" */
  ref?: string;
  status?: string;
}

// Identity key for an order buyer — SAME keyspace as buyerKey so merges with
// referral-derived customers line up (email wins, orders have no phone).
export function orderBuyerKey(o: CrmOrder): string {
  const email = String(o.buyerEmail || '').trim().toLowerCase();
  if (email) return `e:${email}`;
  const name = String(o.buyerName || '').trim().toLowerCase();
  if (name) return `n:${name}`;
  return '';
}

export function mergeOrderBuyersIntoCustomers(
  customers: Customer[],
  orders: CrmOrder[],
): Customer[] {
  const merged: Customer[] = customers.map((c) => ({ ...c }));
  const byKey = new Map<string, Customer>(merged.map((c) => [c.key, c]));

  // Newest order first so latestOrder* wins deterministically.
  const usable = (orders || [])
    .filter((o) => String(o?.status || '').trim() !== 'Refunded')
    .sort((a, b) => String(b?.orderedAt || '').localeCompare(String(a?.orderedAt || '')));

  for (const o of usable) {
    const key = orderBuyerKey(o);
    if (!key) continue; // identity-less order — not a customer row
    let c = byKey.get(key);
    if (!c) {
      c = {
        key,
        name:
          String(o.buyerName || '').trim() ||
          String(o.buyerEmail || '').trim().toLowerCase() ||
          'unknown buyer',
        email: String(o.buyerEmail || '').trim().toLowerCase(),
        phone: '',
        state: '',
        totalDeals: 0,
        closedWonDeals: 0,
        lifetimeValue: 0,
        isRepeat: false,
        lastDealDate: '',
        referralIds: [],
        latestReferralId: '',
        orderCount: 0,
      };
      merged.push(c);
      byKey.set(key, c);
    }
    c.orderCount = (c.orderCount || 0) + 1;
    if (!c.latestOrderId) {
      c.latestOrderId = o.id;
      c.latestOrderRef = String(o.ref || '');
      const t = new Date(String(o.orderedAt || '')).getTime();
      c.lastOrderDate = isNaN(t) || t <= 0 ? '' : new Date(t).toISOString();
    }
  }

  // Same comparator as groupReferralsByBuyer, with order recency backing up
  // lastDealDate so a fresh shop buyer doesn't sink to the bottom.
  const recencyMs = (c: Customer): number => {
    const deal = new Date(c.lastDealDate || 0).getTime();
    const order = new Date(c.lastOrderDate || 0).getTime();
    return Math.max(isNaN(deal) ? 0 : deal, isNaN(order) ? 0 : order);
  };
  merged.sort((a, b) => {
    if (b.lifetimeValue !== a.lifetimeValue) return b.lifetimeValue - a.lifetimeValue;
    return recencyMs(b) - recencyMs(a);
  });
  return merged;
}

// ──────────────────────────────────────────────────────────────────────────
// 2. ACTIVITY / NOTIFICATION FEED — derive timestamped events.
//
// /api/rancher/dashboard fetches ~9 per-referral timestamps then throws most
// of them away. This turns each non-blank timestamp into a readable feed event
// so a rancher who isn't on Telegram can see "what happened" in-product.
// Reverse-chron. Pure: caller decides read/unread (localStorage-backed).
// ──────────────────────────────────────────────────────────────────────────

export type ActivityEventType =
  | 'new_lead'
  | 'slot_accepted'
  | 'deposit_requested'
  | 'deposit_paid'
  | 'final_invoice_sent'
  | 'final_paid'
  | 'deal_closed'
  | 'fulfillment_confirmed'
  | 'buyer_reply';

export interface ActivityEvent {
  // Stable, deterministic id: `${referralId}:${type}` — so localStorage
  // read-state survives refetches (the same event always hashes the same).
  id: string;
  type: ActivityEventType;
  referralId: string;
  buyerName: string;
  // ISO timestamp the event happened at.
  at: string;
  atMs: number;
  // Pre-rendered plain-English headline (lowercase brand voice).
  title: string;
}

// Per-type config: which referral field stamps the event + how to phrase it.
// Ordered roughly along the deal lifecycle; sort by timestamp handles display.
const EVENT_DEFS: {
  type: ActivityEventType;
  field: keyof CrmReferral;
  title: (buyer: string) => string;
}[] = [
  { type: 'new_lead', field: 'intro_sent_at', title: (b) => `new lead — ${b} was introduced` },
  { type: 'buyer_reply', field: 'last_buyer_activity_at', title: (b) => `${b} replied` },
  { type: 'slot_accepted', field: 'rancher_accepted_at', title: (b) => `you accepted ${b}'s slot` },
  { type: 'deposit_requested', field: 'deposit_requested_at', title: (b) => `deposit requested from ${b}` },
  { type: 'deposit_paid', field: 'deposit_paid_at', title: (b) => `${b} paid their deposit` },
  { type: 'final_invoice_sent', field: 'final_invoice_sent_at', title: (b) => `final invoice sent to ${b}` },
  { type: 'final_paid', field: 'final_paid_at', title: (b) => `${b} paid their balance` },
  { type: 'deal_closed', field: 'closed_at', title: (b) => `deal closed with ${b}` },
  { type: 'fulfillment_confirmed', field: 'fulfillment_confirmed_at', title: (b) => `beef delivered to ${b}` },
];

export function deriveActivityEvents(referrals: CrmReferral[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const r of referrals) {
    const buyer = String(r.buyer_name || r.buyer_email || 'a buyer').trim() || 'a buyer';
    for (const def of EVENT_DEFS) {
      const raw = r[def.field];
      if (!raw) continue;
      const atMs = new Date(String(raw)).getTime();
      if (isNaN(atMs) || atMs <= 0) continue;
      events.push({
        id: `${r.id}:${def.type}`,
        type: def.type,
        referralId: r.id,
        buyerName: buyer,
        at: new Date(atMs).toISOString(),
        atMs,
        title: def.title(buyer),
      });
    }
  }
  // Reverse-chron (newest first).
  events.sort((a, b) => b.atMs - a.atMs);
  return events;
}

// Count events not in the read set. Pure — read set comes from localStorage.
export function countUnread(events: ActivityEvent[], readIds: Set<string>): number {
  return events.reduce((n, e) => (readIds.has(e.id) ? n : n + 1), 0);
}

// ──────────────────────────────────────────────────────────────────────────
// 3. GLOBAL SEARCH — does a referral/customer match a free-text query?
//
// Matches across name / email / phone (phone compared digits-only so
// "(406) 555" matches "4065551234"). Case-insensitive substring. Used by the
// always-available header search to filter both leads and customers.
// ──────────────────────────────────────────────────────────────────────────

export function matchesSearch(
  fields: { name?: string; email?: string; phone?: string; state?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const name = String(fields.name || '').toLowerCase();
  const email = String(fields.email || '').toLowerCase();
  const state = String(fields.state || '').toLowerCase();
  if (name.includes(q) || email.includes(q) || state.includes(q)) return true;
  // Phone: compare digits-only on both sides so punctuation never blocks a match.
  const qDigits = q.replace(/\D/g, '');
  if (qDigits.length >= 3) {
    const phoneDigits = String(fields.phone || '').replace(/\D/g, '');
    if (phoneDigits.includes(qDigits)) return true;
  }
  return false;
}
