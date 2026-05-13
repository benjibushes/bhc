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

    const data = records.map((record) => ({
      id: record.id,
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
        delete currentFields[unknownField[1]];
        continue;
      }

      const badValueField = msg.match(/Field "([^"]+)" cannot accept/);
      if (badValueField && attempt < maxRetries) {
        console.warn(`Airtable: stripping incompatible field "${badValueField[1]}" from ${tableName} update`);
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
