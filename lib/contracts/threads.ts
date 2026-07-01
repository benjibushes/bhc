// Threads — shared by Buyer + Rancher verticals via this contract.
// Each thread: one buyer ↔ one rancher, scoped to a referral. Both verticals
// post messages via postMessage(); neither imports the other's pages.
//
// Email mirror: when a message posts, the calling route emails the OTHER side
// with a Reply-To of thread-<id>@replies.<domain>. Inbound replies hit
// /api/webhooks/resend-inbound which routes back into the thread via the
// `thread-` reply tag (Task 10 wires the inbound side).

import { createRecord, updateRecord, getAllRecords, getRecordById, getRecordsByIds } from '@/lib/airtable';

export type SenderType = 'buyer' | 'rancher' | 'admin' | 'system';
export type SendVia = 'web' | 'email' | 'telegram';

export interface ThreadCreateInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  subject: string;
}

export interface MessageInput {
  threadId: string;
  senderType: SenderType;
  senderId: string;
  body: string;
  sentVia: SendVia;
  emailMessageId?: string;
}

export const THREADS_TABLE = 'Threads';
export const MESSAGES_TABLE = 'Thread Messages';

// ── Threads-by-referral lookup (same bug class as Payments G1/E6) ────────────
//
// Both Threads-by-referral lookups (the dedup in getOrCreateThreadForReferral
// below and the thread-close-on-terminal-close in contracts/rancher.recordClose)
// used to run `SEARCH("<refId>", ARRAYJOIN({Referral}))`. ARRAYJOIN over a link
// field joins the linked records' PRIMARY-FIELD values, and the Referrals
// primary field (`Name`, singleLineText) is empty on every prod row — verified
// 2026-07-01 against the live schema + Threads row samples (both live Threads
// rows link the SAME referral: the dedup never matched and duplicated the
// thread). So the scan NEVER matches: duplicate threads per referral, and
// threads never close on Closed Won/Lost.
//
// Fix mirrors lib/contracts/payments.ts: createThread denormalizes the referral
// record id into a plain `Referral Id Text` field on Threads; every by-referral
// lookup queries that with an exact match FIRST and only falls back to the
// legacy ARRAYJOIN scan for rows written before the field existed. (In this
// base the legacy scan can't actually match — kept one release purely to
// mirror the Payments back-compat discipline. Drop after 2026-07-01+1.)
//
// SCHEMA DEPENDENCY: `Referral Id Text` (single line text) must exist on the
// THREADS table (same field name as on Payments). If it doesn't,
// createRecord strips it with a console.warn + throttled operator Telegram
// alert (see lib/airtable.ts), and createThread below ALSO read-back-verifies
// the write and warns loudly with the exact fix.

export const THREADS_REFERRAL_ID_TEXT_FIELD = 'Referral Id Text';

// ── Threads-by-rancher lookup (rancher inbox — same bug class) ───────────────
//
// The rancher inbox (app/api/rancher/inbox) used to run
// `SEARCH("<rancherId>", ARRAYJOIN({Rancher}))`. ARRAYJOIN over a link field
// joins the linked records' PRIMARY-FIELD values — for Ranchers that's the
// Ranch Name, never the record id — so the scan NEVER matched and the inbox
// listed zero threads since it shipped.
//
// Fix mirrors the by-referral denorm above: createThread writes the rancher
// record id into a plain `Rancher Id Text` field, and listThreadsForRancher
// exact-matches it. There is NO legacy formula variant — the old scan could
// never match a record id, so the fallback for pre-field rows is a full
// Threads scan + JS filter on the {Rancher} link array (the API returns real
// record ids in link arrays; Threads is tiny — 2 rows prod — and unfiltered
// getAllRecords is TTL-cached).
//
// SCHEMA DEPENDENCY: `Rancher Id Text` (single line text) must exist on the
// THREADS table (sibling of `Referral Id Text`). Until it does, the fast path
// 422s (INVALID_FILTER_BY_FORMULA) and every lookup takes the full-scan
// fallback — correct, just unindexed. createThread read-back-verifies the
// write and warns loudly with the exact fix (same discipline as the referral
// field above).

export const THREADS_RANCHER_ID_TEXT_FIELD = 'Rancher Id Text';

// Airtable record ids are exactly `rec` + 14 alphanumerics. Validating the
// shape BEFORE interpolating means no quote/backslash can ever reach the
// formula string.
const AIRTABLE_RECORD_ID = /^rec[A-Za-z0-9]{14}$/;

/**
 * Build the Threads-by-referral filterByFormula clause. Pure — unit-tested in
 * threads.byReferral.test.ts.
 *
 *   - default: `{Referral Id Text} = "<refId>"` (exact match on the
 *     denormalized scalar).
 *   - { legacy: true }: the old `SEARCH("<refId>", ARRAYJOIN({Referral}))`
 *     scan, kept ONLY as a back-compat fallback for pre-field rows.
 *
 * A referralId that is not shaped like a record id returns `FALSE()` — a
 * never-matching clause — instead of interpolating attacker-controllable text
 * into the formula.
 */
export function threadsByReferralFormula(
  referralId: string,
  opts: { legacy?: boolean } = {},
): string {
  if (!AIRTABLE_RECORD_ID.test(referralId)) {
    console.warn(
      `[threadsByReferralFormula] refusing non-record-id referralId ${JSON.stringify(String(referralId).slice(0, 40))} — returning never-match clause`,
    );
    return 'FALSE()';
  }
  return opts.legacy
    ? `SEARCH("${referralId}", ARRAYJOIN({Referral}))`
    : `{${THREADS_REFERRAL_ID_TEXT_FIELD}} = "${referralId}"`;
}

/**
 * Build the Threads-by-rancher filterByFormula clause. Pure — unit-tested in
 * threads.byRancher.test.ts.
 *
 *   `{Rancher Id Text} = "<rancherId>"` (exact match on the denormalized
 *   scalar). No legacy variant — see the block comment above.
 *
 * A rancherId that is not shaped like a record id returns `FALSE()` — a
 * never-matching clause — instead of interpolating attacker-controllable text
 * into the formula.
 */
export function threadsByRancherFormula(rancherId: string): string {
  if (!AIRTABLE_RECORD_ID.test(rancherId)) {
    console.warn(
      `[threadsByRancherFormula] refusing non-record-id rancherId ${JSON.stringify(String(rancherId).slice(0, 40))} — returning never-match clause`,
    );
    return 'FALSE()';
  }
  return `{${THREADS_RANCHER_ID_TEXT_FIELD}} = "${rancherId}"`;
}

/**
 * List every Thread linked to a rancher. NEVER-ERROR: returns [] on total
 * failure rather than throwing — an inbox that renders empty beats a 500.
 *
 *   1. Fast path: exact match on the denormalized `Rancher Id Text`.
 *   2. Fallback (fast path threw — e.g. field doesn't exist yet — or found
 *      nothing): full Threads scan + JS filter on the {Rancher} link array,
 *      which carries real record ids. Correct for pre-field rows; fine while
 *      Threads is tiny (2 rows prod) and the unfiltered read is TTL-cached.
 *
 * Belt: fast-path rows are ALSO JS-filtered on the {Rancher} link array, so a
 * stale/mis-backfilled text field can never leak another rancher's thread.
 */
export async function listThreadsForRancher(rancherId: string): Promise<any[]> {
  const linkedToRancher = (t: any): boolean =>
    Array.isArray(t?.['Rancher']) && t['Rancher'].includes(rancherId);

  let rows: any[] = [];
  try {
    rows = ((await getAllRecords(
      THREADS_TABLE,
      threadsByRancherFormula(rancherId),
    )) as any[]).filter(linkedToRancher);
  } catch (e: any) {
    console.warn(
      `[listThreadsForRancher] fast path failed (likely '${THREADS_RANCHER_ID_TEXT_FIELD}' missing on Threads) — full-scan fallback:`,
      e?.message,
    );
  }
  if (rows.length > 0) return rows;
  // Full-scan fallback — catches pre-field rows the fast path can't see.
  try {
    const all: any[] = (await getAllRecords(THREADS_TABLE)) as any[];
    return all.filter(linkedToRancher);
  } catch (e: any) {
    console.warn('[listThreadsForRancher] full-scan fallback failed — returning empty:', e?.message);
    return [];
  }
}

export async function createThread(input: ThreadCreateInput): Promise<{ id: string }> {
  const created: any = await createRecord(THREADS_TABLE, {
    'Referral': [input.referralId],
    'Buyer': [input.buyerId],
    'Rancher': [input.rancherId],
    'Subject': input.subject,
    'Created At': new Date().toISOString(),
    'Last Message At': new Date().toISOString(),
    'Status': 'Active',
    // Denormalized referral id — the ONLY way a Threads row can be found
    // by referral (see threadsByReferralFormula above).
    [THREADS_REFERRAL_ID_TEXT_FIELD]: input.referralId,
    // Denormalized rancher id — the fast path for the rancher inbox
    // (see threadsByRancherFormula / listThreadsForRancher above).
    [THREADS_RANCHER_ID_TEXT_FIELD]: input.rancherId,
  });
  // VERIFY the denormalized field persisted. createRecord auto-strips unknown
  // fields (with its own warn + throttled operator alert — see lib/airtable.ts)
  // and returns the record AS SAVED, so a missing key here means the field
  // doesn't exist on the Threads table yet. Zero extra API calls — inspects
  // the create response.
  const savedRefIdText = created?.fields?.[THREADS_REFERRAL_ID_TEXT_FIELD];
  if (savedRefIdText !== input.referralId) {
    console.warn(
      `[createThread] '${THREADS_REFERRAL_ID_TEXT_FIELD}' did NOT persist on Threads row ${created?.id} ` +
      `(got ${JSON.stringify(savedRefIdText)}). ACTION REQUIRED: add '${THREADS_REFERRAL_ID_TEXT_FIELD}' ` +
      `(single line text) to the Threads table in Airtable. Until it exists, thread dedup ` +
      `(getOrCreateThreadForReferral) creates a duplicate thread per call and ` +
      `thread-close-on-terminal-close (contracts/rancher.recordClose) never finds the thread.`,
    );
  }
  const savedRancherIdText = created?.fields?.[THREADS_RANCHER_ID_TEXT_FIELD];
  if (savedRancherIdText !== input.rancherId) {
    console.warn(
      `[createThread] '${THREADS_RANCHER_ID_TEXT_FIELD}' did NOT persist on Threads row ${created?.id} ` +
      `(got ${JSON.stringify(savedRancherIdText)}). ACTION REQUIRED: add '${THREADS_RANCHER_ID_TEXT_FIELD}' ` +
      `(single line text) to the Threads table in Airtable. Until it exists, the rancher inbox ` +
      `(listThreadsForRancher) works but takes the full-Threads-scan fallback on every request.`,
    );
  }
  return { id: created.id };
}

export async function getOrCreateThreadForReferral(
  refId: string,
  buyerId: string,
  rancherId: string,
): Promise<{ id: string; isNew: boolean }> {
  // Exact-match on the denormalized referral id first; legacy ARRAYJOIN scan
  // only when that returns nothing (pre-field rows). NEVER-ERROR: a lookup
  // failure must not 500 the ask-thread request — fall through and create
  // (worst case a duplicate thread, which is exactly the pre-fix behavior).
  try {
    let existing: any[] = await getAllRecords(
      THREADS_TABLE,
      threadsByReferralFormula(refId),
    );
    if (existing.length === 0) {
      existing = await getAllRecords(
        THREADS_TABLE,
        threadsByReferralFormula(refId, { legacy: true }),
      );
    }
    if (existing.length > 0) {
      return { id: existing[0].id, isNew: false };
    }
  } catch (e: any) {
    console.warn('[getOrCreateThreadForReferral] lookup failed (non-fatal) — creating new thread:', e?.message);
  }
  const { id } = await createThread({
    referralId: refId,
    buyerId,
    rancherId,
    subject: 'Pre-purchase questions',
  });
  return { id, isNew: true };
}

export async function postMessage(input: MessageInput): Promise<{ id: string }> {
  // Idempotency on inbound email: if emailMessageId matches existing message,
  // no-op. Prevents Resend retries from creating duplicate Thread Messages.
  if (input.emailMessageId) {
    const safeMsgId = input.emailMessageId.replace(/"/g, '\\"');
    const existing: any[] = await getAllRecords(
      MESSAGES_TABLE,
      `{Email Message Id} = "${safeMsgId}"`
    );
    if (existing.length > 0) return { id: existing[0].id };
  }
  const created: any = await createRecord(MESSAGES_TABLE, {
    'Thread': [input.threadId],
    'Sender Type': input.senderType,
    'Sender Id': input.senderId,
    'Body': input.body.slice(0, 5000),
    'Sent Via': input.sentVia,
    'Created At': new Date().toISOString(),
    'Email Message Id': input.emailMessageId || '',
  });
  // Bump thread's Last Message At so inbox sort stays accurate.
  try {
    await updateRecord(THREADS_TABLE, input.threadId, {
      'Last Message At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn('[contracts.postMessage] Last Message At bump failed (non-fatal):', e?.message);
  }
  return { id: created.id };
}

export async function listThreadMessages(threadId: string): Promise<any[]> {
  // SAME BUG CLASS as the by-referral lookups above: the old
  // `SEARCH("<threadId>", ARRAYJOIN({Thread}))` scan compares the thread
  // RECORD ID against the linked Thread's PRIMARY-FIELD value — which is
  // `Subject` ("Pre-purchase questions"; verified against the live schema
  // 2026-07-01), never the record id — so it returned [] for EVERY thread and
  // the whole message history rendered empty on both sides.
  //
  // Exact path (no schema change needed): read the Thread row's inverse
  // 'Thread Messages' link field (an array of message record ids — exists on
  // the live Threads table) and fetch those messages via getRecordsByIds
  // (chunked RECORD_ID() formula; validates id shape before interpolation).
  // NEVER-ERROR: any failure falls back to the legacy scan (harmless — worst
  // case the pre-fix empty list), never a 500.
  try {
    const thread: any = await getRecordById(THREADS_TABLE, threadId);
    const rows: any[] = await getRecordsByIds(MESSAGES_TABLE, thread?.['Thread Messages']);
    // Sort ascending by Created At so the UI renders chronologically.
    rows.sort((a, b) => new Date(a['Created At']).getTime() - new Date(b['Created At']).getTime());
    return rows;
  } catch (e: any) {
    console.warn('[listThreadMessages] exact lookup failed — legacy fallback:', e?.message);
  }
  // LEGACY FALLBACK — behavior-identical to the pre-fix code path.
  try {
    const safeId = threadId.replace(/"/g, '\\"');
    const rows: any[] = await getAllRecords(
      MESSAGES_TABLE,
      `SEARCH("${safeId}", ARRAYJOIN({Thread}))`
    );
    rows.sort((a, b) => new Date(a['Created At']).getTime() - new Date(b['Created At']).getTime());
    return rows;
  } catch (e: any) {
    console.warn('[listThreadMessages] legacy fallback failed — returning empty:', e?.message);
    return [];
  }
}
