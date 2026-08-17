// AD ATTRIBUTION — the ONE parser for the first-touch snapshot, and the ONE
// mapper from that snapshot to Airtable Consumers columns.
//
// WHY THIS MODULE EXISTS
// ---------------------
// app/components/UtmCapture.tsx (mounted site-wide from app/layout.tsx) writes
// a first-touch-wins JSON snapshot to localStorage under `bhc_source_v2`. Three
// buyer entry points now need to READ it (the /access funnel, the Connect
// reserve form, the broker reserve form) and three server routes need to WRITE
// it onto a Consumer. Before this module the parse lived inline in BuyerFunnel
// and the write lived inline (twice) in /api/consumers.
//
// The rail that actually LOST attribution is broker self-serve
// (/api/checkout/broker-reserve): it mints its own Consumer, and that record
// was created with an empty `fbclid`, so reconstructFbc() returned undefined
// and the broker deposit Purchase fired with NO fbc match key. The Connect
// direct-reserve rail could NOT hit that bug — its quiz gate
// (app/api/checkout/reserve/route.ts:246) bounces every brand-new email to
// /access, which has written these columns all along. It is wired there for
// the day that gate is lifted; see buildReserveConsumerFields.
//
// One parser + one field map means a key can never drift between the surface
// that captures it and the surface that persists it.
//
// HERMETIC BY DESIGN: no imports. It is pulled into 'use client' bundles AND
// into route handlers AND into bare node:test runs.
//
// EVERY KEY BELOW IS ALSO THE VERBATIM AIRTABLE FIELD NAME on Consumers (see
// app/api/consumers/route.ts, which has written these columns since the funnel
// rail shipped). Do not rename one side without the other.

export const AD_ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  // Millisecond click timestamp captured by UtmCapture the first time an
  // fbclid is seen. Meta's _fbc match key is fb.1.<clickTimeMs>.<fbclid> and
  // the timestamp MUST be the click time — without this column
  // reconstructFbc() (lib/metaCapi) returns undefined and every server-side
  // Purchase fires unmatched.
  'fbclid_ts',
  'gclid',
] as const;

export type AdAttributionKey = (typeof AD_ATTRIBUTION_KEYS)[number];

/** All eight keys, always present, '' when absent — a stable POST body shape. */
export type AdAttribution = Record<AdAttributionKey, string>;

/** localStorage key written by app/components/UtmCapture.tsx. */
export const AD_ATTRIBUTION_STORAGE_KEY = 'bhc_source_v2';

/**
 * Max accepted length for a single attribution value.
 *
 * These are UTM labels and click ids: real fbclids run ~90-200 chars, gclids
 * ~90, UTM labels a handful of words. 300 is generous headroom for every real
 * value and still bounds what a client can push into an Airtable write on an
 * UNAUTHENTICATED endpoint. createRecord (lib/airtable) only self-heals
 * 'Unknown field name' and bad-select 422s — anything else rethrows and fails
 * the whole consumer create, so an oversized localStorage value would stop a
 * buyer from reserving at all.
 *
 * OVER-LENGTH VALUES ARE DROPPED, NEVER TRUNCATED. A truncated fbclid is worse
 * than an absent one: it still looks attributed in Airtable but can never
 * match, which is exactly the silent failure this module exists to prevent.
 */
export const AD_ATTRIBUTION_MAX_LEN = 300;

/**
 * Trim + validate one value. Returns '' for anything unusable: non-strings,
 * blank/whitespace, and over-length values.
 */
function cleanAttributionValue(v: unknown): string {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  if (!trimmed) return '';
  if (trimmed.length > AD_ATTRIBUTION_MAX_LEN) return '';
  return trimmed;
}

/**
 * Is this stored `fbclid_ts` actually usable as Meta's click time?
 *
 * Mirrors the guard in reconstructFbc (lib/metaCapi): the value must parse to
 * a finite number greater than zero. Kept in lockstep — if reconstructFbc
 * would reject it, persisting it is worse than useless, because it makes the
 * row LOOK attributed while producing no fbc.
 */
export function isUsableClickTimestamp(raw: unknown): boolean {
  const s = cleanAttributionValue(raw);
  if (!s) return false;
  const n = Number(s);
  return Number.isFinite(n) && n > 0;
}

/** Fresh all-empty snapshot. Never share one object — callers mutate copies. */
export function emptyAdAttribution(): AdAttribution {
  const out = {} as AdAttribution;
  for (const k of AD_ATTRIBUTION_KEYS) out[k] = '';
  return out;
}

/** Minimal surface we need from localStorage (keeps this testable + SSR-safe). */
export interface AttributionStorage {
  getItem(key: string): string | null;
}

/**
 * Parse the `bhc_source_v2` first-touch snapshot into the canonical shape.
 *
 * BEST-EFFORT, ALWAYS. Missing storage, blocked storage (private mode), a
 * throwing getItem, corrupt JSON, a JSON array/scalar, or non-string values all
 * degrade to the all-empty snapshot. Attribution is measurement, never a gate:
 * a buyer must be able to reserve and pay with localStorage wiped.
 *
 * @param storage defaults to window.localStorage when a browser is present.
 */
export function readStoredAttribution(storage?: AttributionStorage | null): AdAttribution {
  const out = emptyAdAttribution();
  let store: AttributionStorage | null | undefined = storage;
  if (store === undefined) {
    try {
      store = typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
      store = null; // storage access itself can throw in locked-down browsers
    }
  }
  if (!store) return out;
  try {
    const raw = store.getItem(AD_ATTRIBUTION_STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    const snap = parsed as Record<string, unknown>;
    for (const k of AD_ATTRIBUTION_KEYS) {
      // Same clamp the write path applies, so a garbage localStorage value
      // never even rides the POST body off an unauthenticated page.
      out[k] = cleanAttributionValue(snap[k]);
    }
  } catch {
    // corrupt JSON / blocked storage — the empty snapshot is the answer.
  }
  return out;
}

/** True when at least one attribution value is present (worth POSTing at all). */
export function hasAdAttribution(attr: Partial<AdAttribution> | null | undefined): boolean {
  if (!attr) return false;
  return AD_ATTRIBUTION_KEYS.some((k) => typeof attr[k] === 'string' && (attr[k] as string).trim() !== '');
}

/**
 * Map a posted `attribution` object onto Airtable Consumers fields.
 *
 * SEMANTICS (identical on every rail that calls this):
 *   • only NON-EMPTY trimmed strings within AD_ATTRIBUTION_MAX_LEN are emitted,
 *     so an absent, half-filled, or garbage snapshot can never blank a column
 *     that already holds a value — and can never 422 an Airtable write;
 *   • a malformed payload (null, string, array, numbers) yields {} — signup and
 *     reserve always complete;
 *   • `fbclid` and `fbclid_ts` are written as an ATOMIC PAIR (see below);
 *   • CALLERS decide WHERE to apply it. First-touch is preserved by only
 *     spreading this into the CREATE field set of a brand-new Consumer; an
 *     adopted/reused Consumer keeps whatever attribution its first visit wrote.
 *
 * THE PAIR INVARIANT. fbc = fb.1.<clickTimeMs>.<fbclid> — reconstructFbc needs
 * BOTH halves and returns undefined without them. This map is also reachable
 * from an UPDATE (the funnel branch of /api/consumers upserts an existing row),
 * so emitting the halves independently could leave a row holding an `fbclid`
 * with no `fbclid_ts`: a record that looks attributed in Airtable but silently
 * yields no match key forever — precisely the failure this work exists to
 * prevent. So: both halves, or neither. A blank column is honest; a populated
 * dead one is not.
 */
export function attributionConsumerFields(raw: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fields;
  const src = raw as Record<string, unknown>;

  for (const k of AD_ATTRIBUTION_KEYS) {
    // The click-id pair is decided together, below — never in this loop.
    if (k === 'fbclid' || k === 'fbclid_ts') continue;
    const v = cleanAttributionValue(src[k]);
    if (v) fields[k] = v;
  }

  const fbclid = cleanAttributionValue(src['fbclid']);
  const fbclidTs = cleanAttributionValue(src['fbclid_ts']);
  if (fbclid && isUsableClickTimestamp(fbclidTs)) {
    fields['fbclid'] = fbclid;
    fields['fbclid_ts'] = fbclidTs;
  }

  return fields;
}
