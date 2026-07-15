// lib/stripeReconcile.ts
//
// Pure decision logic for the stripe-reconcile cron (app/api/cron/
// stripe-reconcile) — the nightly Stripe↔Airtable truth sync for rancher TIER
// SUBSCRIPTIONS and CONNECT ACCOUNT status.
//
// Failure class it closes (bulletproof audit 2026-07-15): webhooks are the
// ONLY bridge for subscription + Connect state. A missed event (unregistered
// endpoint, secret drift, Stripe's ~3-day retry horizon exceeded, deploy gap)
// drifts SILENTLY FOREVER — there is no paying customer to complain. Live
// proof: Champion Valley Farm (rec2ni15F7NXtY9Ij) has a REAL active Stripe
// subscription but an EMPTY 'Stripe Subscription Id' in Airtable, so all
// three rails that key on that field (dunning, tier-change, cancellation)
// are blind to it.
//
// ZERO imports on purpose (mirrors lib/connectResync.ts / lib/
// connectStatusClassify.ts): no Stripe client, no Airtable, no secrets chain
// — every reconciliation decision is unit-testable under the standard
// `npm test` harness. The route owns all I/O.
//
// SAFETY DOCTRINE (bhc-mutation-guardrails):
//   - Ambiguous matches (0 or >1 candidate rows) are REPORTED, never written.
//   - Phantom subscribers (Airtable says active+Tier, Stripe has no sub) are
//     REPORTED, never auto-downgraded — clearing a Tier is a Ben decision.
//   - 'Legacy Connect' ranchers carry a SYNTHETIC Subscription Status='active'
//     with NO Stripe subscription by design (lib/tiers.ts) — any real Stripe
//     sub matching one is reported, never written.
//   - A non-empty 'Stripe Subscription Id' that disagrees with Stripe is
//     reported, never overwritten (only EMPTY ids are backfilled).

// ---------------------------------------------------------------------------
// Lite shapes — the route flattens Airtable rows / Stripe objects into these
// so the pure logic never touches SDK objects.
// ---------------------------------------------------------------------------

export interface RancherLite {
  id: string;
  /** Display label for reports (Ranch Name || Operator Name || id). */
  name: string;
  /** Raw {Email} field. */
  email: string;
  /** Raw {Team Emails} field (whitespace/comma/semicolon/newline separated). */
  teamEmails: string;
  /** {Stripe Connect Account Id} (acct_*) or ''. */
  connectAccountId: string;
  /** {Stripe Subscription Id} (lowercase 'd' on Ranchers — field-name landmine). */
  subscriptionId: string;
  /** {Subscription Status} normalized to a plain string. */
  subscriptionStatus: string;
  /** {Tier} normalized to a plain string ('Pasture'|'Ranch'|'Operator'|'Legacy Connect'|'None'|''). */
  tier: string;
}

export interface SubLite {
  id: string;
  /** Raw Stripe subscription status ('active'|'trialing'|'past_due'|...). */
  status: string;
  /** Unix seconds created — recency tiebreak. */
  created: number;
  /** V2 customer_account (acct_*) — V2 tier subs bill the connected account
   *  AS the customer (lib/stripeSubscription.ts); sub.customer does not exist. */
  customerAccount: string;
  /** Expanded customer email when available, else ''. */
  customerEmail: string;
  /** metadata.rancherId stamped by createTierCheckoutSession. */
  metadataRancherId: string;
  /** metadata.tier ('pasture'|'ranch'|'operator') when stamped. */
  metadataTier: string;
  /** First line item's price id. Tier subs have exactly one item. */
  priceId: string;
}

export type TierPriceSlug = 'pasture' | 'ranch' | 'operator';

// ---------------------------------------------------------------------------
// Airtable value normalization — singleSelect fields can come back as either
// a plain string or {id, name, color} (same landmine tierFor() handles).
// ---------------------------------------------------------------------------

export function selectValue(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'name' in (raw as any)) {
    return String((raw as any).name ?? '');
  }
  return String(raw ?? '');
}

// ---------------------------------------------------------------------------
// Tier price map — price id → tier slug. Env names are pinned in lib/tiers.ts
// (STRIPE_<TIER>_PRICE_ID); taken as a plain env object so the mapping is
// pure. legacy_connect intentionally has NO price (never a subscription).
// ---------------------------------------------------------------------------

const TIER_PRICE_ENVS: ReadonlyArray<{ slug: TierPriceSlug; env: string }> = [
  { slug: 'pasture', env: 'STRIPE_PASTURE_PRICE_ID' },
  { slug: 'ranch', env: 'STRIPE_RANCH_PRICE_ID' },
  { slug: 'operator', env: 'STRIPE_OPERATOR_PRICE_ID' },
];

export function tierPriceMapFromEnv(
  env: Record<string, string | undefined>,
): Record<string, TierPriceSlug> {
  const map: Record<string, TierPriceSlug> = {};
  for (const { slug, env: name } of TIER_PRICE_ENVS) {
    const v = String(env[name] || '').trim();
    if (v) map[v] = slug;
  }
  return map;
}

/**
 * Is this platform subscription a RANCHER TIER subscription (vs a Brand
 * sponsorship / Consumer founder sub, which the platform webhook routes to
 * entirely different tables)? Two independent signals, either suffices:
 *   1. its price id is one of the three tier prices;
 *   2. metadata.rancherId is stamped (only createTierCheckoutSession does).
 * metadata.tier alone is deliberately NOT trusted — other products could
 * plausibly carry a 'tier' key; only rancherId is unambiguous.
 */
export function isTierSubscription(
  sub: SubLite,
  priceMap: Record<string, TierPriceSlug>,
): boolean {
  if (sub.priceId && priceMap[sub.priceId]) return true;
  return !!sub.metadataRancherId;
}

/** Tier slug for a sub: the PRICE is the money truth; metadata.tier is only a
 *  fallback for a sub whose price isn't in the map (e.g. env var rotated). */
export function tierSlugForSub(
  sub: SubLite,
  priceMap: Record<string, TierPriceSlug>,
): TierPriceSlug | null {
  const fromPrice = sub.priceId ? priceMap[sub.priceId] : undefined;
  if (fromPrice) return fromPrice;
  const metaTier = String(sub.metadataTier || '').toLowerCase().trim();
  if (metaTier === 'pasture' || metaTier === 'ranch' || metaTier === 'operator') {
    return metaTier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Current-subscription pick — a rancher can have history (canceled sub A,
// live sub B). Reconcile against the LIVEST one; recency breaks ties.
// ---------------------------------------------------------------------------

const SUB_STATUS_RANK: Readonly<Record<string, number>> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  unpaid: 3,
  paused: 4,
  incomplete: 5,
  incomplete_expired: 6,
  canceled: 7,
};

export function pickCurrentSubscription(subs: SubLite[]): SubLite | null {
  if (subs.length === 0) return null;
  return [...subs].sort((a, b) => {
    const ra = SUB_STATUS_RANK[a.status] ?? 8;
    const rb = SUB_STATUS_RANK[b.status] ?? 8;
    if (ra !== rb) return ra - rb;
    return (b.created || 0) - (a.created || 0); // newer first
  })[0];
}

/**
 * Stripe status → the exact choice set the platform webhook writes to
 * Ranchers.{Subscription Status}: handleTierSubscriptionUpsert stamps
 * sub.status RAW ('active','trialing','past_due',...), the deleted handler
 * stamps 'canceled', invoice-failure stamps 'past_due'. Identity mapping,
 * with one normalization: 'incomplete_expired' (a checkout that died before
 * first payment) is what the webhook would eventually record as the deleted
 * handler's 'canceled'.
 */
export function mapStripeSubStatus(status: string): string {
  const s = String(status || '').toLowerCase().trim();
  if (s === 'incomplete_expired') return 'canceled';
  return s;
}

// ---------------------------------------------------------------------------
// Sub → Rancher matching. Mirrors the webhook's resolution order
// (metadata.rancherId → customer_account → nothing) and adds the email
// fallback for subs created outside the normal checkout path. 0 or >1
// candidates is NEVER a write.
// ---------------------------------------------------------------------------

export type SubMatch =
  | { kind: 'matched'; rancher: RancherLite; via: 'metadata' | 'connect-account' | 'email' }
  | { kind: 'unmatched'; reason: string }
  | { kind: 'ambiguous'; reason: string; candidateIds: string[] };

function splitTeamEmails(raw: string): string[] {
  return String(raw || '')
    .toLowerCase()
    .split(/[\s,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function matchSubToRancher(sub: SubLite, ranchers: RancherLite[]): SubMatch {
  // 1. metadata.rancherId — stamped by createTierCheckoutSession; authoritative.
  if (sub.metadataRancherId) {
    const hit = ranchers.find((r) => r.id === sub.metadataRancherId);
    if (hit) return { kind: 'matched', rancher: hit, via: 'metadata' };
    return {
      kind: 'unmatched',
      reason: `metadata.rancherId ${sub.metadataRancherId} has no Ranchers row (deleted/merged?)`,
    };
  }

  // 2. V2 customer_account → {Stripe Connect Account Id}. The webhook's own
  //    fallback (rancherIdFromSubscription); two rows sharing an acct id is a
  //    setup bug — report, never guess.
  if (sub.customerAccount) {
    const hits = ranchers.filter(
      (r) => r.connectAccountId && r.connectAccountId === sub.customerAccount,
    );
    if (hits.length === 1) return { kind: 'matched', rancher: hits[0], via: 'connect-account' };
    if (hits.length > 1) {
      return {
        kind: 'ambiguous',
        reason: `${hits.length} ranchers share Connect acct ${sub.customerAccount}`,
        candidateIds: hits.map((r) => r.id),
      };
    }
    // 0 hits → fall through to email.
  }

  // 3. Unique email match against {Email}, then {Team Emails} contains.
  const email = String(sub.customerEmail || '').toLowerCase().trim();
  if (!email) {
    return { kind: 'unmatched', reason: 'no rancherId metadata, no customer_account match, no customer email' };
  }
  const hits = ranchers.filter(
    (r) =>
      String(r.email || '').toLowerCase().trim() === email ||
      splitTeamEmails(r.teamEmails).includes(email),
  );
  if (hits.length === 1) return { kind: 'matched', rancher: hits[0], via: 'email' };
  if (hits.length === 0) return { kind: 'unmatched', reason: `no rancher matches email ${email}` };
  return {
    kind: 'ambiguous',
    reason: `${hits.length} ranchers match email ${email}`,
    candidateIds: hits.map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// The per-rancher subscription reconcile decision.
// ---------------------------------------------------------------------------

export interface SubReconcileDecision {
  /** Fields to write to the Ranchers row (empty when nothing heals). */
  writeFields: Record<string, string>;
  /** Human lines describing each field healed (for Telegram/notes). */
  changes: string[];
  /** Drift observed but deliberately NOT written — needs eyes. */
  reports: string[];
  /** True when the heal takes a live-looking Airtable status to a terminal
   *  one (webhook missed a cancellation) — flagged loud in the summary. */
  cancellationHealed: boolean;
}

const TIER_LABELS: Readonly<Record<TierPriceSlug, string>> = {
  pasture: 'Pasture',
  ranch: 'Ranch',
  operator: 'Operator',
};

const LIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const TERMINAL_SUB_STATUSES = new Set(['canceled', 'incomplete_expired', 'unpaid']);

function normTier(raw: string): string {
  return String(raw || '').toLowerCase().trim();
}

export function computeSubscriptionReconcile(
  rancher: RancherLite,
  sub: SubLite,
  tierSlug: TierPriceSlug | null,
): SubReconcileDecision {
  const writeFields: Record<string, string> = {};
  const changes: string[] = [];
  const reports: string[] = [];
  let cancellationHealed = false;

  const mappedStatus = mapStripeSubStatus(sub.status);
  const currentStatus = String(rancher.subscriptionStatus || '').toLowerCase().trim();
  const currentTier = normTier(rancher.tier);

  // Legacy Connect carries a SYNTHETIC 'active' with no Stripe sub by design.
  // A real Stripe sub matching one means either a mid-upgrade rancher or a
  // mis-match — both are Ben decisions, never cron writes.
  if (currentTier === 'legacy connect' || currentTier === 'legacy_connect') {
    reports.push(
      `${rancher.name}: Legacy Connect rancher has a real Stripe sub ${sub.id} (${sub.status}) — synthetic-status tier, NOT auto-synced; review manually`,
    );
    return { writeFields, changes, reports, cancellationHealed };
  }

  // 1. Sub id — backfill ONLY when empty (the Champion Valley class). A
  //    non-empty disagreement could mean our current-sub pick is wrong; report.
  const storedSubId = String(rancher.subscriptionId || '').trim();
  if (!storedSubId) {
    writeFields['Stripe Subscription Id'] = sub.id;
    changes.push(`backfilled Stripe Subscription Id ← ${sub.id}`);
  } else if (storedSubId !== sub.id) {
    reports.push(
      `${rancher.name}: Stripe Subscription Id mismatch — Airtable ${storedSubId} vs Stripe current ${sub.id} (${sub.status}); NOT overwritten`,
    );
  }

  // 2. Subscription Status — same value set the webhook writes.
  if (currentStatus !== mappedStatus) {
    writeFields['Subscription Status'] = mappedStatus;
    changes.push(`Subscription Status '${rancher.subscriptionStatus || '(empty)'}' → '${mappedStatus}'`);
    if (LIVE_SUB_STATUSES.has(currentStatus) && TERMINAL_SUB_STATUSES.has(mappedStatus)) {
      cancellationHealed = true;
    }
  }

  // 3. Tier from the price — the money truth — but only re-stamped from a
  //    LIVE sub. A dead sub's price proves what the tier WAS, not what it is;
  //    tier consequences of a cancellation stay a report (the webhook's
  //    deleted handler sets Tier='None' + comms — comms are webhook-owned).
  if (tierSlug) {
    const priceTierLabel = TIER_LABELS[tierSlug];
    if (currentTier !== tierSlug) {
      if (LIVE_SUB_STATUSES.has(mappedStatus)) {
        writeFields['Tier'] = priceTierLabel;
        changes.push(`Tier '${rancher.tier || '(empty)'}' → '${priceTierLabel}' (from price)`);
      } else {
        reports.push(
          `${rancher.name}: Tier '${rancher.tier || '(empty)'}' disagrees with ${mappedStatus} sub's price (${priceTierLabel}) — not written from a non-live sub`,
        );
      }
    }
  }

  return { writeFields, changes, reports, cancellationHealed };
}

// ---------------------------------------------------------------------------
// Reverse drift — phantom subscribers. Airtable claims a paying tier, Stripe
// has no subscription at all for them. REPORT ONLY: auto-downgrading a tier
// (routing + deposit consequences) is a Ben decision, and the missing sub
// could equally mean our listing/matching missed one.
// ---------------------------------------------------------------------------

const PAID_TIERS = new Set(['pasture', 'ranch', 'operator']);

export function findPhantomSubscribers(
  ranchers: RancherLite[],
  matchedRancherIds: ReadonlySet<string>,
): RancherLite[] {
  return ranchers.filter((r) => {
    if (matchedRancherIds.has(r.id)) return false;
    const status = String(r.subscriptionStatus || '').toLowerCase().trim();
    if (status !== 'active' && status !== 'trialing') return false;
    // Legacy Connect's synthetic 'active' has no Stripe sub BY DESIGN.
    return PAID_TIERS.has(normTier(r.tier));
  });
}
