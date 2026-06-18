import Airtable from 'airtable';

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
};

// Escape a string value for use in Airtable filterByFormula to prevent injection
export function escapeAirtableValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxWait = 32000;
  let delay = 1000;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
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
  let currentFields = { ...fields };
  const maxRetries = 8;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const records = await withRateLimitRetry(() => base(tableName).create([{ fields: currentFields }], { typecast: true }));
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

// ── In-process cache for hot tables ─────────────────────────────────────
// Spike-readiness: matching/suggest + consumers signup both call
// getAllRecords(RANCHERS) on every hit. At 30+ signups/sec that detonates
// the Airtable 5 req/sec per-base limit, which then triggers exponential
// backoff inside withRateLimitRetry and blows past maxDuration. Cache the
// ranchers full-list for a short TTL so steady-state concurrent signups
// share one read. Single-record reads (getRecordById) still bypass cache,
// so capacity bumps stay live-correct. Filtered selects skip cache because
// the formula space is unbounded.
type Cached = { ts: number; data: Array<Record<string, any>> };
const CACHE_TTL_MS = 10_000;
const _cache: Record<string, Cached> = {};
function _cacheKey(tableName: string): string | null {
  // Only the full ranchers list is hot enough to cache. Add more tables
  // here only after measuring read volume — stale cache on referrals or
  // consumers would break the capacity logic.
  return tableName === TABLES.RANCHERS ? `${tableName}::full` : null;
}
export function invalidateAirtableCache(tableName?: string): void {
  if (!tableName) { for (const k of Object.keys(_cache)) delete _cache[k]; return; }
  for (const k of Object.keys(_cache)) {
    if (k.startsWith(`${tableName}::`)) delete _cache[k];
  }
}

// Helper function to get all records from a table
export async function getAllRecords(tableName: string, filterByFormula?: string) {
  try {
    const key = !filterByFormula ? _cacheKey(tableName) : null;
    if (key) {
      const hit = _cache[key];
      if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
    }
    const records = await withRateLimitRetry(() =>
      base(tableName)
        .select({
          ...(filterByFormula && { filterByFormula }),
        })
        .all()
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
    if (key) _cache[key] = { ts: Date.now(), data };
    return data;
  } catch (error) {
    console.error(`Error fetching records from ${tableName}:`, error);
    throw error;
  }
}

// Helper function to get a single record by ID
export async function getRecordById(tableName: string, recordId: string) {
  try {
    const record = await withRateLimitRetry(() => base(tableName).find(recordId));
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
    );
    if (!records.length) return null;
    const CLOSED = new Set(['Closed Lost', 'Closed Won']);
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
  try {
    const record = await base(tableName).find(recordId);
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
  let currentFields = { ...fields };
  const maxRetries = 8;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const records = await withRateLimitRetry(() => base(tableName).update([
        {
          id: recordId,
          fields: currentFields,
        },
      ], { typecast: true }));
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

      const selectErr = msg.match(/Insufficient permissions to create new select option/);
      if (selectErr && attempt < maxRetries) {
        const fieldWithIssue = Object.keys(currentFields).find(k =>
          typeof currentFields[k] === 'string' && currentFields[k].length > 0
        );
        if (fieldWithIssue) {
          console.warn(`Airtable: stripping select field "${fieldWithIssue}" from ${tableName} update`);
          delete currentFields[fieldWithIssue];
          continue;
        }
      }

      console.error(`Error updating record ${recordId} in ${tableName}:`, error);
      throw error;
    }
  }
  throw new Error(`Failed to update record in ${tableName} after ${maxRetries} retries`);
}

// Helper function to delete a record
export async function deleteRecord(tableName: string, recordId: string) {
  try {
    const deletedRecords = await base(tableName).destroy([recordId]);
    return deletedRecords[0];
  } catch (error) {
    console.error(`Error deleting record ${recordId} from ${tableName}:`, error);
    throw error;
  }
}

// Get all ranchers with active landing pages (Page Live = true)
export async function getActiveRancherPages() {
  try {
    const records = await base(TABLES.RANCHERS)
      .select({ filterByFormula: '{Page Live} = 1' })
      .all();
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
  try {
    const safeSlug = escapeAirtableValue(slug);
    const records = await base(TABLES.RANCHERS)
      .select({ filterByFormula: `AND({Slug} = "${safeSlug}", {Page Live} = 1)`, maxRecords: 1 })
      .all();
    if (records.length === 0) return null;
    return { id: records[0].id, ...records[0].fields };
  } catch (error) {
    console.error(`Error fetching rancher by slug "${slug}":`, error);
    throw error;
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
  const all = (await getAllRecords(TABLES.RANCHERS)) as any[];
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
  try {
    const safeSlug = escapeAirtableValue(slug);
    const records = await base(TABLES.RANCHERS)
      .select({
        filterByFormula:
          `AND({Slug} = "${safeSlug}", NOT({Public Map Hidden} = 1), ` +
          `{Verification Status} != "Removed", ` +
          `OR({Page Live} = 1, {Verification Status} = "Prospect"))`,
        maxRecords: 1,
      })
      .all();
    if (records.length === 0) return null;
    return { id: records[0].id, ...records[0].fields };
  } catch (error) {
    console.error(`Error fetching rancher/prospect by slug "${slug}":`, error);
    throw error;
  }
}

export default base;
