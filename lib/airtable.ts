import Airtable from 'airtable';
import { withTimeout, AirtableTimeoutError, resolveAirtableTimeoutMs } from './airtableTimeout';
// DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
// lib/demo/demoMode.ts. Static import is safe: the module is pure and has no
// side effect when the flag is off (announceDemoModeOnce short-circuits). The
// fixture store is required LAZILY inside each gated branch below so its data
// never loads in production.
import { isDemoMode } from './demo/demoMode';

// Re-export so callers can `instanceof AirtableTimeoutError` without a
// separate import path.
export { withTimeout, AirtableTimeoutError, resolveAirtableTimeoutMs } from './airtableTimeout';

// Initialize Airtable
const apiKey = process.env.AIRTABLE_API_KEY;
const baseId = process.env.AIRTABLE_BASE_ID;

if (!apiKey || !baseId) {
  console.warn('Airtable API Key or Base ID is missing. Airtable client may not function correctly.');
}

const airtable = new Airtable({ apiKey: apiKey || 'dummy_key' });
const base = airtable.base(baseId || 'dummy_base');

// Table names
export const TABLES = {
  CONSUMERS: 'Consumers',
  RANCHERS: 'Ranchers',
  BRANDS: 'Brands',
  LAND_DEALS: 'Land Deals',
  NEWS_POSTS: 'News',
  INQUIRIES: 'Inquiries',
  CAMPAIGNS: 'Campaigns',
  REFERRALS: 'Referrals',
  AFFILIATES: 'Affiliates',
  CONVERSATIONS: 'Conversations',
  CRON_RUNS: 'Cron Runs',
  CRON_PAUSES: 'Cron Pauses',
  EMAIL_SENDS: 'Email Sends',
  PAYMENTS: 'Payments',
  AD_SPEND: 'Ad Spend',
  // Affiliate-products layer (Move 1). BHC recommends curated on-brand gear to
  // its own buyers and earns affiliate commission. RECOMMENDED_PRODUCTS is the
  // curated catalog (only Active=true renders anywhere); GEAR_CLICKS is the
  // best-effort click log fired by /go/product/[id] before the outbound 302.
  RECOMMENDED_PRODUCTS: 'Recommended Products',
  GEAR_CLICKS: 'Gear Clicks',
  // Low-ticket rancher products (jerky/sticks/boxes) + their orders — the
  // ship-nationwide, low-resistance offer. RANCHER_PRODUCTS = catalog (Display
  // Price = buyer pays, Rancher Base = rancher nets, spread = BHC margin skimmed
  // as the Stripe application fee, same money model as the deposit).
  // RANCHER_ORDERS = created by the product-purchase webhook.
  RANCHER_PRODUCTS: 'Rancher Products',
  RANCHER_ORDERS: 'Rancher Orders',
};

// Escape a string value for use in Airtable filterByFormula to prevent injection
export function escapeAirtableValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── Read-path formula builders + error classifiers (audit slice 9) ──────
// The rancher dashboard used to pull the ENTIRE Referrals table per load
// because ARRAYJOIN({Rancher}) renders linked-record PRIMARY FIELD VALUES,
// not record ids (the PR #36 trap). The proper fix is LOOKUP fields on
// Referrals that surface the Ranchers `Rancher Record Id` formula field:
//   • 'Rancher Record Id'           — lookup via the Rancher link
//   • 'Suggested Rancher Record Id' — lookup via the Suggested Rancher link
// The founder creates both manually (the API can't create lookups). Until
// they exist, a formula referencing them ERRORS the whole query — callers
// classify that with isInvalidFilterFormulaError and fall back to the scan.

// Server-side "referrals owned by this rancher" filter. Covers BOTH link
// fields because the dashboard's ownership test is
// rancher.includes(id) || suggested.includes(id) — filtering only the
// Rancher link would hide suggested-only (pre-accept) referrals.
export function referralsByRancherFormula(rancherId: string): string {
  const id = escapeAirtableValue(String(rancherId || ''));
  return `OR({Rancher Record Id} = "${id}", {Suggested Rancher Record Id} = "${id}")`;
}

// Server-side "referrals for this buyer email" filter — the same
// exact-or-wrapped match findReferralByBuyerEmail uses (never a bare
// substring: ben@x must not match rueben@x). Returns null when the input
// isn't a usable email so callers can fall back to their scan path.
export function referralsByBuyerEmailFormula(email: string): string | null {
  const e = String(email || '').toLowerCase().replace(/"/g, '').trim();
  if (!e || !e.includes('@')) return null;
  return `OR(LOWER(TRIM({Buyer Email})) = "${e}", FIND("<${e}>", LOWER({Buyer Email})) > 0)`;
}

// True when Airtable rejected the filterByFormula itself — the signature of
// a formula referencing a field that doesn't exist yet (e.g. the lookup
// fields above before the founder creates them). airtable.js throws
// AirtableError with .error = type code; message fallback covers rewraps.
export function isInvalidFilterFormulaError(error: any): boolean {
  if (!error) return false;
  if (error.error === 'INVALID_FILTER_BY_FORMULA') return true;
  return /formula for filtering records is invalid/i.test(String(error.message || ''));
}

// True when Airtable rejected a fields[] projection entry (unknown field).
// Message fallback is anchored on the singular `name: "` so it can NEVER
// match the formula error's plural "Unknown field names: ..." text.
export function isUnknownFieldNameError(error: any): boolean {
  if (!error) return false;
  if (error.error === 'UNKNOWN_FIELD_NAME') return true;
  return /unknown field name: "/i.test(String(error.message || ''));
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// C3: `label` (pass the table name) is surfaced in the timeout error message
// for debuggability. Each individual ATTEMPT gets its own timeout budget —
// the timeout wraps the attempt, NOT the whole retry loop — so the existing
// 429 exponential backoff is unchanged and every retry gets a fresh ~10s
// before we declare the connection hung.
async function withRateLimitRetry<T>(fn: () => Promise<T>, label = 'Airtable'): Promise<T> {
  const maxWait = 32000;
  let delay = 1000;
  while (true) {
    try {
      return await withTimeout(fn(), resolveAirtableTimeoutMs(), label);
    } catch (error: any) {
      // A hung connection is a transient FAILURE, not a rate limit: propagate
      // as a throw so callers' existing catch/retry/5xx logic fires. Never
      // swallow it or return empty data — an empty return would render "no
      // ranchers" lies. (Explicit instanceof check also guards against the
      // timeout message ever matching the '429' substring test below.)
      if (error instanceof AirtableTimeoutError) throw error;
      const msg = error?.message || error?.error?.message || String(error);
      const isRateLimit = error?.statusCode === 429 || msg.includes('429') || msg.toLowerCase().includes('rate limit');
      if (isRateLimit && delay <= maxWait) {
        console.warn(`Airtable rate limit hit, retrying in ${delay}ms...`);
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
}

// Helper function to create a record (auto-strips problematic Airtable fields)
export async function createRecord(tableName: string, fields: any) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Append to the in-memory demo store so the created
  // row PERSISTS for the session (a reserved buyer shows up in the pipeline on
  // camera). Zero external calls; resets on dev-server restart.
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoCreate(tableName, fields);
  let currentFields = { ...fields };
  const maxRetries = 8;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const records = await withRateLimitRetry(() => base(tableName).create([{ fields: currentFields }], { typecast: true }), tableName);
      if (_cacheKey(tableName)) invalidateAirtableCache(tableName);
      return records[0];
    } catch (error: any) {
      const msg = error?.message || error?.error?.message || String(error);

      const unknownField = msg.match(/Unknown field name: "([^"]+)"/);
      if (unknownField && attempt < maxRetries) {
        console.warn(`Airtable: stripping unknown field "${unknownField[1]}" from ${tableName}`);
        // T4 (2026-06-10): Telegram alert on silent-strip — the 2026-05-06
        // chaos pattern. Throttled per (table, field) so a single bad ship
        // doesn't flood Ben.
        try {
          const { sendOperatorSignal } = await import('./operatorSignal');
          await sendOperatorSignal({
            urgency: 'normal',
            kind: 'system-error',
            summary: `Airtable strip ${tableName}.${unknownField[1]}`,
            detail: `Code wrote a field that doesn't exist on the table. Silent-strip retry succeeded but the data is LOST. Add the field via Airtable MCP or remove the write.`,
            dedupeKey: `airtable-strip:${tableName}:${unknownField[1]}`,
            dedupeWindowMs: 24 * 60 * 60 * 1000, // 1 alert per (table,field) per day
          });
        } catch {}
        delete currentFields[unknownField[1]];
        continue;
      }

      const selectErr = msg.match(/Insufficient permissions to create new select option "([^"]*)"/) ||
                         msg.match(/Insufficient permissions to create new select option ""([^"]*)""/) ;
      if (selectErr && attempt < maxRetries) {
        const badValue = selectErr[1];
        const badKey = Object.keys(currentFields).find(k => String(currentFields[k]) === badValue);
        if (badKey) {
          console.warn(`Airtable: stripping field "${badKey}" with invalid select value from ${tableName}`);
          try {
            const { sendOperatorSignal } = await import('./operatorSignal');
            await sendOperatorSignal({
              urgency: 'normal',
              kind: 'system-error',
              summary: `Airtable bad-choice strip ${tableName}.${badKey}`,
              detail: `Wrote value "${badValue}" but it's not a valid singleSelect option. Add the choice to the field or fix the write.`,
              dedupeKey: `airtable-badchoice:${tableName}:${badKey}:${badValue}`,
              dedupeWindowMs: 24 * 60 * 60 * 1000,
            });
          } catch {}
          delete currentFields[badKey];
          continue;
        }
      }

      if (msg.includes('Insufficient permissions') && msg.includes('select option') && attempt < maxRetries) {
        const fieldWithIssue = Object.keys(currentFields).find(k =>
          typeof currentFields[k] === 'string' && currentFields[k].length > 0 &&
          !['Full Name', 'Email', 'Phone', 'State', 'Notes', 'Ranch Name', 'Operator Name',
            'Buyer Name', 'Buyer Email', 'Buyer Phone', 'Buyer State', 'Suggested Rancher Name',
            'Suggested Rancher State', 'Description', 'Operation Details', 'Certifications'].includes(k)
        );
        if (fieldWithIssue) {
          console.warn(`Airtable: stripping suspected select field "${fieldWithIssue}" from ${tableName}`);
          delete currentFields[fieldWithIssue];
          continue;
        }
      }

      console.error(`Error creating record in ${tableName}:`, error);
      throw error;
    }
  }
  throw new Error(`Failed to create record in ${tableName} after ${maxRetries} retries`);
}

// Create a Referrals row with the denormalized rancher-record-id text fields
// stamped from the Rancher / Suggested Rancher links (scale-ladder #1,
// 2026-07-02). Every referral CREATE must go through this — a fresh lead is
// then filterable on the /rancher dashboard the instant it exists instead of
// forcing a full-table scan. stampRancherRecordIds is pure + no-ops when no
// link is present (waitlist referrals). The backfill cron is the self-heal
// belt for the reassign/approve UPDATE paths that don't create.
export async function createReferral(fields: any) {
  const { stampRancherRecordIds } = await import('./referralRecordId');
  return createRecord(TABLES.REFERRALS, stampRancherRecordIds(fields));
}

// ── Two-layer cache for hot tables (L1 in-process + L2 shared Redis) ──────
// Spike-readiness: matching/suggest + consumers signup both call
// getAllRecords(RANCHERS) on every hit. At 30+ signups/sec that detonates
// the Airtable 5 req/sec per-base limit, which then triggers exponential
// backoff inside withRateLimitRetry and blows past maxDuration.
//
// L1 (this module's _cache): per-lambda in-process, CACHE_TTL_MS. Absorbs a
//   burst served by a single warm instance without touching Redis.
// L2 (lib/sharedCache → Upstash Redis): SHARED across all serverless
//   instances, same CACHE_TTL_MS. Under ad-driven fan-out, N cold lambdas
//   with empty L1 share ONE Airtable read instead of each re-reading — this
//   is scale-ladder item #2. Fail-open: if Upstash env is unset (local/dev/
//   test) or Redis errors, L2 is a transparent no-op and behavior is EXACTLY
//   the pre-Redis in-process path.
//
// Single-record reads (getRecordById) still bypass cache, so capacity bumps
// stay live-correct. Filtered/projected selects skip cache because the
// formula space is unbounded and a projected result stored under the full
// key would starve other callers of fields.
import { cacheGet as sharedCacheGet, cacheSet as sharedCacheSet, cacheDel as sharedCacheDel } from './sharedCache';

type Cached = { ts: number; data: Array<Record<string, any>> };
const CACHE_TTL_MS = 10_000;
const _cache: Record<string, Cached> = {};
// Tables hot enough to cache (scale audit 2026-07-07). Measured read volume:
//   RANCHERS — matching/suggest + consumers signup, every buyer hit (#254).
//   RANCHER_PRODUCTS — /access (paid-ad front door), /shop checkout page,
//     buy/intent gates, every rancher page: full-scan per hit before this.
//   RECOMMENDED_PRODUCTS — /gear (force-dynamic) + /api/gear (client-fetched
//     on /member + success): weekly-fresh content re-read per view.
// NOT cacheable: Referrals/Consumers/Payments (capacity + money logic reads
// must stay live-correct). Writes self-bust: createRecord/updateRecord call
// invalidateAirtableCache(tableName) whenever _cacheKey(tableName) is set,
// so a rancher's product edit is visible fleet-wide immediately.
const CACHED_TABLES = new Set<string>([
  TABLES.RANCHERS,
  TABLES.RANCHER_PRODUCTS,
  TABLES.RECOMMENDED_PRODUCTS,
]);
function _cacheKey(tableName: string): string | null {
  return CACHED_TABLES.has(tableName) ? `${tableName}::full` : null;
}
// Redis (L2) key for a table's full-list cache. Distinct namespace from the
// L1 key so the shared value is self-describing across instances/services.
function _redisCacheKey(tableName: string): string {
  return `airtable:cache:${tableName}`;
}
export function invalidateAirtableCache(tableName?: string): void {
  // L1: synchronous clear (unchanged contract — callers invoke this inline
  // after a create/update without awaiting).
  if (!tableName) {
    for (const k of Object.keys(_cache)) delete _cache[k];
  } else {
    for (const k of Object.keys(_cache)) {
      if (k.startsWith(`${tableName}::`)) delete _cache[k];
    }
  }
  // L2: fire-and-forget delete of the shared Redis key(s) so an edit on one
  // instance clears the cache for ALL instances immediately (otherwise a
  // stale rancher list would linger up to CACHE_TTL_MS across the fleet after
  // an edit). cacheDel never throws; the .catch is belt-and-suspenders so an
  // unexpected rejection can't surface as an unhandled promise. Fire-and-
  // forget keeps this function synchronous, preserving every existing call
  // site (createRecord/updateRecord invoke it inline).
  if (!tableName) {
    // Clear-all: clear every allowlisted table's shared key.
    for (const t of CACHED_TABLES) {
      void sharedCacheDel(_redisCacheKey(t)).catch(() => {});
    }
  } else if (_cacheKey(tableName)) {
    void sharedCacheDel(_redisCacheKey(tableName)).catch(() => {});
  }
}

// Helper function to get all records from a table.
// opts.fields — optional projection, passed straight to the SDK's
// select({fields}) so Airtable only serializes those columns (bandwidth +
// latency; request COUNT is governed by pagination, not projection). A
// projected read NEVER reads from or writes to the in-process cache: the
// cache stores the FULL row shape and a projected result stored under the
// full key would silently starve other callers of fields. NOTE: a fields[]
// entry naming a nonexistent field errors the whole query
// (UNKNOWN_FIELD_NAME) — callers that project must classify with
// isUnknownFieldNameError and retry unprojected.
export async function getAllRecords(
  tableName: string,
  filterByFormula?: string,
  opts?: { fields?: string[] },
) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Return in-memory fixtures, best-effort formula-
  // filtered (demoQuery honors simple {Field}="x" / LOWER(...) equality so
  // existence checks like the reserve rail's email lookup behave correctly;
  // unrecognized formulas fall back to all rows and the caller's JS narrows).
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoQuery(tableName, filterByFormula);
  try {
    const projected = !!(opts?.fields && opts.fields.length);
    const key = !filterByFormula && !projected ? _cacheKey(tableName) : null;
    if (key) {
      // L1: in-process. A warm lambda serving a burst answers from here and
      // never touches Redis or Airtable.
      const hit = _cache[key];
      if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
      // L2: shared Redis. On an L1 miss (cold instance, or L1 expired), pull
      // the value another instance already read. Populate L1 and return so
      // this instance's subsequent hits stay in-process. Fail-open: cacheGet
      // returns undefined when Upstash is unset or Redis errors → falls
      // through to the Airtable read below (today's behavior).
      const shared = await sharedCacheGet<Array<Record<string, any>>>(_redisCacheKey(tableName));
      if (shared !== undefined) {
        _cache[key] = { ts: Date.now(), data: shared };
        return shared;
      }
    }
    const records = await withRateLimitRetry(() =>
      base(tableName)
        .select({
          ...(filterByFormula && { filterByFormula }),
          ...(projected && { fields: opts!.fields }),
        })
        .all(),
      tableName
    );

    // Preserve Airtable's autogen createdTime (record metadata, NOT a field).
    // Multiple callers want "when was this row created" for cohort + recency
    // analysis (/admin/health new_signups_7d, etc). Without exposing it here,
    // callers see undefined and report 0. _createdTime is ISO 8601 string.
    const data = records.map((record) => ({
      id: record.id,
      _createdTime: (record as any)._rawJson?.createdTime || '',
      ...record.fields,
    }));
    if (key) {
      // Write BOTH layers. L1 synchronously; L2 shared so the NEXT cold
      // instance skips Airtable. Await the L2 write (it's fail-safe internally
      // — never throws) so we don't leave a dangling promise; cost is one
      // fast REST round-trip on the miss path only, not on every read.
      _cache[key] = { ts: Date.now(), data };
      await sharedCacheSet(_redisCacheKey(tableName), data, CACHE_TTL_MS);
    }
    return data;
  } catch (error) {
    console.error(`Error fetching records from ${tableName}:`, error);
    throw error;
  }
}

// Fetch records by their record ids (e.g. the ids carried by an inverse link
// field), chunked so each filterByFormula stays well under Airtable's URL
// limit. Ids that are not shaped like record ids are dropped BEFORE
// interpolation — no quote/backslash can ever reach the formula string.
// Row shape matches getAllRecords (id + _createdTime + fields spread).
// Throws on fetch failure (same contract as getAllRecords) — callers own
// their fallback.
const AIRTABLE_RECORD_ID_SHAPE = /^rec[A-Za-z0-9]{14}$/;
export async function getRecordsByIds(
  tableName: string,
  ids: unknown, // typically a link-field value: string[] | undefined
): Promise<Record<string, any>[]> {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Return only the requested demo rows (so each demo
  // thread shows just its own messages).
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoRecordsByIds(tableName, ids);
  const valid = (Array.isArray(ids) ? ids : []).filter(
    (id): id is string => typeof id === 'string' && AIRTABLE_RECORD_ID_SHAPE.test(id),
  );
  if (valid.length === 0) return [];
  const rows: Record<string, any>[] = [];
  const CHUNK = 100; // keep filterByFormula well under Airtable's URL limit
  for (let i = 0; i < valid.length; i += CHUNK) {
    const clause = `OR(${valid.slice(i, i + CHUNK).map((id) => `RECORD_ID() = "${id}"`).join(', ')})`;
    rows.push(...((await getAllRecords(tableName, clause)) as Record<string, any>[]));
  }
  return rows;
}

// Exact unique-key lookup — fetch AT MOST ONE record matching a formula.
// getAllRecords(table, formula) walks EVERY page of the (server-filtered)
// result set even when the caller only ever reads rows[0] of a unique-key
// match (Payments by Stripe Payment Intent Id, Stripe Events by Event Id,
// Ranchers by Connect Account Id). maxRecords:1 + pageSize:1 tells Airtable
// to stop after the first hit — one round-trip, no full pagination. Mirrors
// getRancherBySlug's select shape; retry/error semantics mirror getAllRecords
// (withRateLimitRetry, throw on failure) so swapped callers behave identically.
// Returns the record flattened EXACTLY like a getAllRecords row
// (id + _createdTime + fields spread at top level), or null when no match.
export async function getFirstRecord(
  tableName: string,
  filterByFormula: string,
): Promise<Record<string, any> | null> {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. First row matching the (best-effort parsed) formula,
  // so an existence check returns null when nothing matches.
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoQuery(tableName, filterByFormula)[0] || null;
  try {
    const records = await withRateLimitRetry(
      () =>
        base(tableName)
          .select({ filterByFormula, maxRecords: 1, pageSize: 1 })
          .all(),
      tableName,
    );
    if (records.length === 0) return null;
    return {
      id: records[0].id,
      _createdTime: (records[0] as any)._rawJson?.createdTime || '',
      ...records[0].fields,
    };
  } catch (error) {
    console.error(`Error fetching first record from ${tableName}:`, error);
    throw error;
  }
}

// Helper function to get a single record by ID
export async function getRecordById(tableName: string, recordId: string) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Resolve the demo record by id, else a sensible demo
  // row for the table (so the dashboard's rancher lookup always resolves).
  if (isDemoMode()) {
    const demo = require('./demo/demoStore') as typeof import('./demo/demoStore');
    return demo.demoRecordById(tableName, recordId) || demo.demoTableRecords(tableName)[0] || null;
  }
  try {
    const record = await withRateLimitRetry(() => base(tableName).find(recordId), tableName);
    return {
      id: record.id,
      ...record.fields,
    };
  } catch (error) {
    console.error(`Error fetching record ${recordId} from ${tableName}:`, error);
    throw error;
  }
}

// Resolve the best-fit referral for an inbound BUYER reply that arrived WITHOUT
// a ref-<id> Reply-To tag. This is the COMMON case: most buyer-facing emails
// fall back to inbox@replies.buyhalfcow.com (no _replyContext), and buyers also
// reply to old threads — so the tagged-Reply-To path almost never fires. We
// match the bare From address against {Buyer Email}. When a buyer has several
// referrals (~22% do), disambiguate: prefer an OPEN referral (not Closed
// Lost/Won), then the most recent by Intro Sent At / Approved At. Returns the
// referral record (id + fields) or null. Read-only — never mutates.
export async function findReferralByBuyerEmail(email: string) {
  // Strip quotes to keep the formula safe; emails are otherwise injection-safe.
  const e = String(email || '').toLowerCase().replace(/"/g, '').trim();
  if (!e || !e.includes('@')) return null;
  try {
    const records = await withRateLimitRetry(() =>
      base(TABLES.REFERRALS)
        .select({
          // Exact bare match, or exact match inside a "Name <addr>" wrapper.
          // Avoids substring false positives (e.g. ben@x vs rueben@x).
          filterByFormula: `OR(LOWER(TRIM({Buyer Email})) = "${e}", FIND("<${e}>", LOWER({Buyer Email})) > 0)`,
          maxRecords: 50,
        })
        .all(),
      TABLES.REFERRALS,
    );
    if (!records.length) return null;
    const CLOSED = new Set(['Closed Lost', 'Closed Won', 'Dormant']);
    const ts = (v: any) => {
      const t = v ? new Date(v as string).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    };
    const best = records
      .map((r) => ({
        id: r.id,
        fields: r.fields as Record<string, any>,
        open: !CLOSED.has(String(r.fields['Status'] || '')),
        recency: Math.max(ts(r.fields['Intro Sent At']), ts(r.fields['Approved At'])),
      }))
      .sort((a, b) => (a.open !== b.open ? (a.open ? -1 : 1) : b.recency - a.recency))[0];
    return { id: best.id, ...best.fields };
  } catch (error) {
    console.error(`Error resolving referral by buyer email "${e}":`, error);
    return null;
  }
}

// Alias for consistency
export async function getRecord(tableName: string, recordId: string) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. This helper returns the { id, fields } shape.
  if (isDemoMode()) {
    const demo = require('./demo/demoStore') as typeof import('./demo/demoStore');
    const rec = demo.demoRecordById(tableName, recordId) || demo.demoTableRecords(tableName)[0];
    if (!rec) return { id: recordId, fields: {} };
    const { id, _createdTime, ...fields } = rec;
    return { id, fields };
  }
  try {
    // C3: this helper never had retry; give the bare SDK call the same
    // per-attempt timeout so a hung connection throws instead of dangling.
    const record = await withTimeout(base(tableName).find(recordId), resolveAirtableTimeoutMs(), tableName);
    return {
      id: record.id,
      fields: record.fields,
    };
  } catch (error) {
    console.error(`Error fetching record ${recordId} from ${tableName}:`, error);
    throw error;
  }
}

// Helper function to update a record (auto-strips problematic Airtable fields)
export async function updateRecord(tableName: string, recordId: string, fields: any) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Merge into the in-memory demo record IN PLACE so the
  // change PERSISTS on camera — "close sale", "request deposit", capacity /
  // landing-page edits all stick for the session. Zero external calls.
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoUpdate(tableName, recordId, fields);
  let currentFields = { ...fields };
  const maxRetries = 8;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const records = await withRateLimitRetry(() => base(tableName).update([
        {
          id: recordId,
          fields: currentFields,
        },
      ], { typecast: true }), tableName);
      // Bust the in-process cache for this table so callers don't read
      // back stale data on the next getAllRecords. Cheap; runs only on
      // tables we cache (currently just RANCHERS).
      if (_cacheKey(tableName)) invalidateAirtableCache(tableName);
      return {
        id: records[0].id,
        ...records[0].fields,
      };
    } catch (error: any) {
      const msg = error?.message || error?.error?.message || String(error);

      const unknownField = msg.match(/Unknown field name: "([^"]+)"/);
      if (unknownField && attempt < maxRetries) {
        console.warn(`Airtable: stripping unknown field "${unknownField[1]}" from ${tableName} update`);
        try {
          const { sendOperatorSignal } = await import('./operatorSignal');
          await sendOperatorSignal({
            urgency: 'normal',
            kind: 'system-error',
            summary: `Airtable strip ${tableName}.${unknownField[1]} (update)`,
            detail: `updateRecord wrote a field that doesn't exist. Data lost. Fix: add field via MCP or remove the write.`,
            dedupeKey: `airtable-strip-update:${tableName}:${unknownField[1]}`,
            dedupeWindowMs: 24 * 60 * 60 * 1000,
          });
        } catch {}
        delete currentFields[unknownField[1]];
        continue;
      }

      const badValueField = msg.match(/Field "([^"]+)" cannot accept/);
      if (badValueField && attempt < maxRetries) {
        console.warn(`Airtable: stripping incompatible field "${badValueField[1]}" from ${tableName} update`);
        try {
          const { sendOperatorSignal } = await import('./operatorSignal');
          await sendOperatorSignal({
            urgency: 'normal',
            kind: 'system-error',
            summary: `Airtable type-mismatch ${tableName}.${badValueField[1]}`,
            detail: `Wrote wrong type to field. Strip + retry succeeded but data is lost.`,
            dedupeKey: `airtable-type:${tableName}:${badValueField[1]}`,
            dedupeWindowMs: 24 * 60 * 60 * 1000,
          });
        } catch {}
        delete currentFields[badValueField[1]];
        continue;
      }

      // Mirror createRecord's precise handler. The OLD updateRecord code stripped
      // the FIRST non-empty string field on this error — which on a money-path
      // write like {Status, Deposit Paid At, ...} could silently drop
      // "Deposit Paid At" when it was actually "Status" whose option didn't
      // exist, corrupting the deal record + capacity. Instead: identify the
      // offending field by the bad VALUE in the error, strip exactly that;
      // fall back to a denylist that protects free-text data fields; and if we
      // still can't identify it, FAIL LOUD rather than strip-and-corrupt.
      const selectValErr = msg.match(/Insufficient permissions to create new select option "([^"]*)"/) ||
                           msg.match(/Insufficient permissions to create new select option ""([^"]*)""/);
      if (selectValErr && attempt < maxRetries) {
        const badValue = selectValErr[1];
        const badKey = Object.keys(currentFields).find(k => String(currentFields[k]) === badValue);
        if (badKey) {
          console.warn(`Airtable: stripping field "${badKey}" with invalid select value from ${tableName} update`);
          try {
            const { sendOperatorSignal } = await import('./operatorSignal');
            await sendOperatorSignal({
              urgency: 'loud',
              kind: 'system-error',
              summary: `Airtable bad-choice strip ${tableName}.${badKey} (update)`,
              detail: `updateRecord wrote value "${badValue}" but it isn't a valid singleSelect option and the key can't create it. Add the choice to ${tableName}.${badKey} (e.g. the deposit-rail Status options "Awaiting Payment"/"Slot Locked") or fix the write. Data for this field was dropped this write.`,
              dedupeKey: `airtable-badchoice-upd:${tableName}:${badKey}:${badValue}`,
              dedupeWindowMs: 24 * 60 * 60 * 1000,
            });
          } catch {}
          delete currentFields[badKey];
          continue;
        }
      }

      if (msg.includes('Insufficient permissions') && msg.includes('select option') && attempt < maxRetries) {
        // Couldn't match the value to a field. Strip a suspected select field but
        // NEVER a known free-text data field (those carry buyer/rancher data).
        const fieldWithIssue = Object.keys(currentFields).find(k =>
          typeof currentFields[k] === 'string' && currentFields[k].length > 0 &&
          !['Full Name', 'Email', 'Phone', 'State', 'Notes', 'Ranch Name', 'Operator Name',
            'Buyer Name', 'Buyer Email', 'Buyer Phone', 'Buyer State', 'Suggested Rancher Name',
            'Suggested Rancher State', 'Description', 'Operation Details', 'Certifications'].includes(k)
        );
        if (fieldWithIssue) {
          console.warn(`Airtable: stripping suspected select field "${fieldWithIssue}" from ${tableName} update`);
          try {
            const { sendOperatorSignal } = await import('./operatorSignal');
            await sendOperatorSignal({
              urgency: 'loud',
              kind: 'system-error',
              summary: `Airtable select-perm strip ${tableName}.${fieldWithIssue} (update)`,
              detail: `updateRecord hit "cannot create select option" but the value wasn't matchable to a field; stripped suspected select field "${fieldWithIssue}". Add the missing option or grant the API key create-option permission.`,
              dedupeKey: `airtable-selectperm-upd:${tableName}:${fieldWithIssue}`,
              dedupeWindowMs: 24 * 60 * 60 * 1000,
            });
          } catch {}
          delete currentFields[fieldWithIssue];
          continue;
        }
        // Nothing safe to strip — fail loud instead of corrupting the record.
      }

      console.error(`Error updating record ${recordId} in ${tableName}:`, error);
      throw error;
    }
  }
  throw new Error(`Failed to update record in ${tableName} after ${maxRetries} retries`);
}

// Helper function to delete a record
export async function deleteRecord(tableName: string, recordId: string) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Remove from the in-memory store, no external call.
  if (isDemoMode()) {
    (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoDelete(tableName, recordId);
    return { id: recordId, fields: {} } as any;
  }
  try {
    const deletedRecords = await withTimeout(base(tableName).destroy([recordId]), resolveAirtableTimeoutMs(), tableName);
    return deletedRecords[0];
  } catch (error) {
    console.error(`Error deleting record ${recordId} from ${tableName}:`, error);
    throw error;
  }
}

// Get all ranchers with active landing pages (Page Live = true)
export async function getActiveRancherPages() {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. The demo rancher is Page Live, so it's the one
  // active page (drives generateStaticParams + the discovery map).
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoTableRecords(TABLES.RANCHERS);
  try {
    const records = await withTimeout(
      base(TABLES.RANCHERS)
        .select({
          // Mirror getRancherOrProspectBySlug's visibility gates: a hidden or
          // removed rancher must not appear in the directory/map only to
          // soft-404 when clicked (au-beef asymmetry).
          filterByFormula:
            'AND({Page Live} = 1, NOT({Public Map Hidden} = 1), {Verification Status} != "Removed")',
        })
        .all(),
      resolveAirtableTimeoutMs(),
      TABLES.RANCHERS,
    );
    return records.map((record) => ({
      id: record.id,
      ...record.fields,
    }));
  } catch (error) {
    console.error('Error fetching active rancher pages:', error);
    throw error;
  }
}

// Get a single rancher by their URL slug
export async function getRancherBySlug(slug: string) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Any slug resolves to the demo rancher.
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoRancherForSlug(slug);
  try {
    const safeSlug = escapeAirtableValue(slug);
    const records = await withTimeout(
      base(TABLES.RANCHERS)
        .select({ filterByFormula: `AND({Slug} = "${safeSlug}", {Page Live} = 1)`, maxRecords: 1 })
        .all(),
      resolveAirtableTimeoutMs(),
      TABLES.RANCHERS,
    );
    if (records.length === 0) return null;
    return { id: records[0].id, ...records[0].fields };
  } catch (error) {
    console.error(`Error fetching rancher by slug "${slug}":`, error);
    throw error;
  }
}

// Slug-rename fallback (dashboard-audit rank 10): find the LIVE rancher whose
// 'Previous Slugs' history contains this slug, so links shared before a rename
// 308-redirect instead of 404ing. Token-exact match on the ", "-joined list
// (", a," in ", a, b," — never a substring hit on a longer slug). LOWER() on
// both sides because Airtable FIND is case-sensitive (slugs are stored
// lowercase; the incoming URL may not be).
//
// DEFENSIVE: the 'Previous Slugs' field may not exist in the base yet — an
// INVALID_FILTER_BY_FORMULA (or any other failure) returns null (plain miss →
// the caller 404s exactly as before this feature), NEVER throws into the
// public page. The live-slug lookup always runs first, so a current slug wins
// over any history match by construction.
export async function getRancherByPreviousSlug(slug: string) {
  if (isDemoMode()) return null; // demo store has no rename history
  try {
    const safeSlug = escapeAirtableValue(String(slug || '').toLowerCase());
    if (!safeSlug) return null;
    const records = await withTimeout(
      base(TABLES.RANCHERS)
        .select({
          filterByFormula:
            `AND({Page Live} = 1, NOT({Public Map Hidden} = 1), ` +
            `{Verification Status} != "Removed", ` +
            `FIND(", " & "${safeSlug}" & ",", ", " & LOWER({Previous Slugs} & "") & ","))`,
          maxRecords: 1,
        })
        .all(),
      resolveAirtableTimeoutMs(),
      TABLES.RANCHERS,
    );
    if (records.length === 0) return null;
    return { id: records[0].id, ...records[0].fields };
  } catch (error: any) {
    console.warn(
      `[previous-slug] lookup failed for "${slug}" (field may not exist yet):`,
      error?.message,
    );
    return null;
  }
}

// ── Duplicate-rancher guard ─────────────────────────────────────────────
// Single chokepoint for "does a Ranchers row already exist for this rancher?"
// Root cause of the "3 Jesses" incident: every signup path
// (/api/apply, /api/prospects/self-submit, /api/partners) ran its OWN ad-hoc
// dedupe with a DIFFERENT normalizer + DIFFERENT match set, so the same human
// could open multiple rows by varying email / using a team email / a different
// ranch-name casing. Routing all three through this one helper makes them
// normalize + match IDENTICALLY.
//
// Match order (case-insensitive, in-memory over the cached full list):
//   1. Email          — SAME normalizer as app/api/auth/rancher/login/route.ts
//                       (trim().toLowerCase().replace(/\s+/g,'')) so a row
//                       login can reach is a row we dedupe against.
//   2. Team Emails     — split on /[\s,;\n]+/, normalized; covers the
//                       consultant/spouse/hired-help case no path checked before.
//   3. Phone           — digits-only (opts.phone), >=10 digits.
//   4. Ranch + State   — case-insensitive (opts.ranchName + opts.state).
//
// CRITICAL: an empty/absent email NEVER participates in the email or
// team-email match — otherwise two rows that both happen to have a blank Email
// would "match" each other and collapse. Empty-email callers fall straight
// through to phone / ranch+state (or create).
//
// When createIfMissing !== false and nothing matched → creates the row.
// When createIfMissing === false → pure lookup, returns {record:null,...}.
//
// Returns the matched record in the SAME shape getAllRecords yields (fields
// flattened at top level + id + _createdTime); the created record in the shape
// createRecord yields (raw Airtable record exposing .id). Both expose `.id`.
const _normalizeEmail = (raw: any): string =>
  String(raw || '').trim().toLowerCase().replace(/\s+/g, '');

const _rancherRecencyMs = (r: any): number => {
  const candidates = [
    r['Last Assigned At'],
    r['Agreement Signed At'],
    r['Docs Sent At'],
    r._createdTime,
  ].map((d) => (d ? new Date(d).getTime() : 0));
  return Math.max(...candidates, 0);
};

// Pick the canonical row when several match in the same tier: most-recently
// active wins. Mirrors the tiebreak in the rancher-login Team Emails branch so
// dedupe + login resolve to the SAME row even if a duplicate still exists.
function _pickCanonical(matches: any[]): any {
  if (matches.length <= 1) return matches[0];
  return [...matches].sort((a, b) => _rancherRecencyMs(b) - _rancherRecencyMs(a))[0];
}

// Server-side filter that returns a SUPERSET of every dedupe tier's true
// matches (2026-07-23 hardening — the Justin incident). findOrCreateRancherByEmail
// used to pull the ENTIRE Ranchers table on every signup and filter in JS; under
// Airtable's 5 req/s cap that unfiltered scan threw/timed out in the pre-record-
// write window and stranded the rancher with no record + no alert. This narrows
// the read to rows that COULD match so the caller's JS narrowing (unchanged) is
// behavior-equivalent — only the candidate set shrinks. Pure/testable.
//   • Email       — exact (trim+lower); JS re-checks with the same normalizer.
//   • Team Emails  — substring superset; JS narrows to an exact split-list element.
//   • Phone        — FIND on the last 4 digits (contiguous in every common US
//                    format) is a superset; JS narrows to full digits-only equality.
//   • Ranch+State  — exact (trim+lower) on both.
// Returns null when there is NOTHING to match on (no email/phone/ranch+state) so
// the caller can skip the read entirely and go straight to create.
export function buildRancherDedupeFormula(args: {
  normalizedEmail: string;
  normalizedPhone: string; // digits only; only used when >= 10 digits
  ranchName?: string;
  state?: string;
}): string | null {
  const clauses: string[] = [];
  if (args.normalizedEmail) {
    const e = escapeAirtableValue(args.normalizedEmail);
    clauses.push(`LOWER(TRIM({Email})) = "${e}"`);
    clauses.push(`FIND("${e}", LOWER({Team Emails})) > 0`);
  }
  if ((args.normalizedPhone || '').length >= 10) {
    const last4 = escapeAirtableValue(args.normalizedPhone.slice(-4));
    clauses.push(`FIND("${last4}", {Phone}) > 0`);
  }
  const ranch = (args.ranchName || '').trim();
  const state = (args.state || '').trim();
  if (ranch && state) {
    clauses.push(
      `AND(LOWER(TRIM({Ranch Name})) = "${escapeAirtableValue(ranch.toLowerCase())}", ` +
        `LOWER(TRIM({State})) = "${escapeAirtableValue(state.toLowerCase())}")`,
    );
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `OR(${clauses.join(', ')})`;
}

export async function findOrCreateRancherByEmail(
  email: string,
  fields: Record<string, any>,
  opts?: { phone?: string; ranchName?: string; state?: string; createIfMissing?: boolean },
): Promise<{
  record: any;
  created: boolean;
  matchedBy: 'email' | 'team' | 'phone' | 'ranch+state' | null;
}> {
  const normalizedEmail = _normalizeEmail(email);
  // Filtered candidate read (2026-07-23) — replaces the unfiltered full-table
  // scan that threw/timed out in the pre-write window (the Justin incident).
  // buildRancherDedupeFormula returns a SUPERSET of every tier's true matches,
  // so the JS narrowing below is unchanged + behavior-equivalent. When there is
  // nothing to match on it returns null → skip the read and go straight to
  // create. getAllRecords wraps the read in withRateLimitRetry, so a transient
  // 429/5xx backs off + retries instead of throwing bare.
  const dedupeFormula = buildRancherDedupeFormula({
    normalizedEmail,
    normalizedPhone: (opts?.phone || '').replace(/\D/g, ''),
    ranchName: opts?.ranchName,
    state: opts?.state,
  });
  const all = (dedupeFormula
    ? ((await getAllRecords(TABLES.RANCHERS, dedupeFormula)) as any[])
    : []) as any[];
  const splitRe = /[\s,;\n]+/;

  // 1 + 2: email-based matches — SKIPPED ENTIRELY when there's no email, so we
  // never collapse two blank-email rows together.
  if (normalizedEmail) {
    const emailMatches = all.filter(
      (r) => _normalizeEmail(r['Email']) === normalizedEmail,
    );
    if (emailMatches.length) {
      return { record: _pickCanonical(emailMatches), created: false, matchedBy: 'email' };
    }

    const teamMatches = all.filter((r) => {
      const teamRaw = String(r['Team Emails'] || '').toLowerCase();
      if (!teamRaw) return false;
      const list = teamRaw.split(splitRe).map((s) => s.trim()).filter(Boolean);
      return list.includes(normalizedEmail);
    });
    if (teamMatches.length) {
      return { record: _pickCanonical(teamMatches), created: false, matchedBy: 'team' };
    }
  }

  // 3: phone — digits-only, only meaningful with >=10 digits.
  const normalizedPhone = (opts?.phone || '').replace(/\D/g, '');
  if (normalizedPhone.length >= 10) {
    const phoneMatches = all.filter(
      (r) => String(r['Phone'] || '').replace(/\D/g, '') === normalizedPhone,
    );
    if (phoneMatches.length) {
      return { record: _pickCanonical(phoneMatches), created: false, matchedBy: 'phone' };
    }
  }

  // 4: ranch name + state — case-insensitive on both.
  const normalizedRanch = (opts?.ranchName || '').trim().toLowerCase();
  const normalizedState = (opts?.state || '').trim().toLowerCase();
  if (normalizedRanch && normalizedState) {
    const rsMatches = all.filter(
      (r) =>
        String(r['Ranch Name'] || '').trim().toLowerCase() === normalizedRanch &&
        String(r['State'] || '').trim().toLowerCase() === normalizedState,
    );
    if (rsMatches.length) {
      return { record: _pickCanonical(rsMatches), created: false, matchedBy: 'ranch+state' };
    }
  }

  // No match.
  if (opts?.createIfMissing === false) {
    return { record: null, created: false, matchedBy: null };
  }
  const created = await createRecord(TABLES.RANCHERS, fields);
  return { record: created, created: true, matchedBy: null };
}

// Get a single rancher by slug INCLUDING Prospect records (Page Live=false).
// Used by the public landing page when the slug points to a Prospect that
// hasn't been claimed yet. Filters out hidden / removed records so opted-out
// ranchers cannot be reached even by direct URL.
export async function getRancherOrProspectBySlug(slug: string) {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Any slug resolves to the demo rancher so the public
  // landing page renders.
  if (isDemoMode()) return (require('./demo/demoStore') as typeof import('./demo/demoStore')).demoRancherForSlug(slug);
  try {
    const safeSlug = escapeAirtableValue(slug);
    // U17: wrap in withRateLimitRetry — this powers the PUBLIC rancher page,
    // where paid ads land. An un-retried Airtable 429 here threw straight
    // through to a generic error page = a wasted ad click. Now transient rate
    // limits back off + recover; a genuine hard failure still throws (caught by
    // the route's error.tsx boundary, which offers a forward path).
    const records = await withRateLimitRetry(() =>
      base(TABLES.RANCHERS)
        .select({
          filterByFormula:
            `AND({Slug} = "${safeSlug}", NOT({Public Map Hidden} = 1), ` +
            `{Verification Status} != "Removed", ` +
            `OR({Page Live} = 1, {Verification Status} = "Prospect"))`,
          maxRecords: 1,
        })
        .all(),
      TABLES.RANCHERS,
    );
    if (records.length === 0) return null;
    return { id: records[0].id, ...records[0].fields };
  } catch (error) {
    console.error(`Error fetching rancher/prospect by slug "${slug}":`, error);
    throw error;
  }
}

export default base;
