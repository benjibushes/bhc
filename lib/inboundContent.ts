// Resend "Receiving" API client — fetches the CONTENT of an inbound email.
//
// WHY THIS EXISTS (2026-08-03): Resend's `email.received` webhook event
// carries ONLY envelope metadata — data.email_id, from, to, subject,
// message_id, attachment metadata. The body (`text`/`html`) and the full
// headers are NOT in the webhook payload; they must be fetched separately:
//
//   GET https://api.resend.com/emails/receiving/{email_id}   → full content
//   GET https://api.resend.com/emails/receiving              → paginated list
//
// (Verified against resend.com/docs api-reference/emails/retrieve-received-
// email + list-received-emails, 2026-08-03.)
//
// The inbound webhook used to read `d.text || ''` off the payload, so every
// real email reply logged an ENVELOPE-ONLY Conversations row (empty Body /
// Body Plain / Raw Headers = '{}') and the AI classifier ran on an empty
// string → everything classified unknown/ben-eyes. This module is the fix's
// backbone: the webhook calls fetchReceivedEmailContent when the payload has
// no content, and the admin backfill uses listReceivedEmails to recover the
// historical blind rows.
//
// Every function fails SOFT (returns { ok: false }) — inbound capture must
// never be dropped because a content fetch failed. Callers write the
// CONTENT_FETCH_FAILED_MARKER so blindness stays visible instead of silent.

// Markers written into `Body Plain` so an operator (and the backfill's
// idempotency check) can tell a blind row from an empty reply.
export const CONTENT_FETCH_FAILED_MARKER = '[content fetch failed — see inbox]';
export const CONTENT_UNRECOVERABLE_MARKER = '[content unrecoverable]';

/**
 * Fetch-failed marker WITH the Resend received-email id embedded, e.g.
 *   "[content fetch failed — see inbox] [rid:1a2b3c4d-...]"
 *
 * WHY (2026-08-10, recVUDVwrSvVrDZNz post-mortem): the webhook never persisted
 * data.email_id anywhere, so once a fetch failed the ONLY recovery path was
 * the backfill's fuzzy From+timestamp match against the listing. Embedding
 * the id in the marker gives the backfill a direct, exact fetch key. The bare
 * marker (no id) remains valid — pre-existing rows carry it.
 */
export function contentFetchFailedMarker(emailId?: string): string {
  const id = String(emailId || '').trim();
  return id ? `${CONTENT_FETCH_FAILED_MARKER} [rid:${id}]` : CONTENT_FETCH_FAILED_MARKER;
}

/** True when a Body Plain value is a fetch-failed marker (with or without rid). */
export function isContentFetchFailedMarker(bodyPlain: unknown): boolean {
  return String(bodyPlain || '').trim().startsWith(CONTENT_FETCH_FAILED_MARKER);
}

/** Extract the embedded Resend received-email id from a marker, '' if absent. */
export function parseMarkerRid(bodyPlain: unknown): string {
  const m = String(bodyPlain || '').match(/\[rid:([A-Za-z0-9_-]+)\]/);
  return m ? m[1] : '';
}

const RECEIVING_API_BASE = 'https://api.resend.com/emails/receiving';
const DEFAULT_TIMEOUT_MS = 5000;

export interface ReceivedEmailContent {
  text: string;
  html: string;
  headers: Record<string, string>;
  /** RFC 2822 Message-Id from the stored email (dedup key downstream). */
  messageId: string;
}

export type FetchContentResult =
  | { ok: true; content: ReceivedEmailContent }
  | { ok: false; status?: number; error: string };

export interface ReceivedEmailListItem {
  id: string;
  from: string;
  to: string[];
  subject: string;
  createdAt: string;
  messageId: string;
}

export type ListReceivedResult =
  | { ok: true; items: ReceivedEmailListItem[] }
  | { ok: false; status?: number; error: string };

type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

export interface ResendReceivingDeps {
  fetchImpl?: FetchLike;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Resend returns headers either as a plain object or as an array of
 * { name, value } pairs depending on surface. Normalize to a flat object so
 * downstream `headers['message-id']`-style reads always work.
 */
export function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      const name = String((entry as any)?.name || '').trim();
      if (name) out[name] = String((entry as any)?.value ?? '');
    }
    return out;
  }
  if (typeof raw === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  }
  return {};
}

/** Case-insensitive header lookup ('message-id' vs 'Message-Id' vs 'Message-ID'). */
export function headerValue(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === want) return String(v || '');
  }
  return '';
}

/** Minimal HTML → plain-text used when a stored email has html but no text part. */
export function htmlToPlain(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveDeps(deps?: ResendReceivingDeps) {
  return {
    fetchImpl: deps?.fetchImpl || (fetch as unknown as FetchLike),
    apiKey: deps?.apiKey ?? (process.env.RESEND_API_KEY || ''),
    timeoutMs: deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function timedGet(
  url: string,
  deps: Required<Pick<ResendReceivingDeps, 'fetchImpl' | 'apiKey' | 'timeoutMs'>>,
): Promise<{ ok: boolean; status: number; body: any } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${deps.apiKey}` },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''));
    return { error: aborted ? `timeout after ${deps.timeoutMs}ms` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the full stored content of a received email by its Resend email id
 * (the `data.email_id` from the `email.received` webhook event).
 *
 * Timeout-guarded (default 5s) and fail-soft: any failure returns
 * { ok: false } — the caller decides how to degrade (marker row, retry, …).
 */
export async function fetchReceivedEmailContent(
  emailId: string,
  deps?: ResendReceivingDeps,
): Promise<FetchContentResult> {
  const id = String(emailId || '').trim();
  if (!id) return { ok: false, error: 'no email id' };
  const d = resolveDeps(deps);
  if (!d.apiKey) return { ok: false, error: 'RESEND_API_KEY unset' };

  const res = await timedGet(`${RECEIVING_API_BASE}/${encodeURIComponent(id)}`, d);
  if ('error' in res) return { ok: false, error: res.error };
  if (!res.ok) {
    return { ok: false, status: res.status, error: `resend receiving GET ${res.status}` };
  }
  const b = res.body || {};
  const headers = normalizeHeaders(b.headers);
  return {
    ok: true,
    content: {
      text: String(b.text || ''),
      html: String(b.html || ''),
      headers,
      messageId: String(b.message_id || headerValue(headers, 'message-id') || ''),
    },
  };
}

/** Default retry schedule for the webhook's content fetch (ms between tries). */
export const CONTENT_FETCH_RETRY_BACKOFF_MS = [400, 900];

/**
 * fetchReceivedEmailContent with bounded retries — the webhook's entry point.
 *
 * WHY (2026-08-10): a single 5s attempt made ANY transient Resend hiccup —
 * timeout, 5xx, or the ingest race where `email.received` fires before the
 * stored content is readable (404) — permanently blind the row (marker, no
 * body). Up to 3 attempts, short backoff, still bounded well under the
 * route's maxDuration. NOT retried: 401/403 (dead/revoked key — retrying
 * can't help and burns the lambda budget; the email-canary cron owns that
 * alarm) and 400 (malformed id).
 */
export async function fetchReceivedEmailContentWithRetry(
  emailId: string,
  deps?: ResendReceivingDeps & { attempts?: number; backoffMs?: number[]; sleep?: (ms: number) => Promise<void> },
): Promise<FetchContentResult> {
  const attempts = Math.max(1, deps?.attempts ?? 3);
  const backoff = deps?.backoffMs ?? CONTENT_FETCH_RETRY_BACKOFF_MS;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: FetchContentResult = { ok: false, error: 'no attempt made' };
  for (let i = 0; i < attempts; i++) {
    last = await fetchReceivedEmailContent(emailId, deps);
    if (last.ok) return last;
    const s = last.status;
    const retryable = s === undefined || s === 404 || s === 429 || s >= 500;
    if (!retryable) return last;
    if (i < attempts - 1) await sleep(backoff[Math.min(i, backoff.length - 1)] ?? 500);
  }
  return last;
}

/**
 * Walk Resend's received-emails listing (newest-first, `after` cursor).
 * Returns envelope metadata only — content still needs a per-id fetch.
 * Capped at `maxPages` pages of 100 to bound a runaway walk.
 */
export async function listReceivedEmails(
  deps?: ResendReceivingDeps & { maxPages?: number },
): Promise<ListReceivedResult> {
  const d = resolveDeps(deps);
  if (!d.apiKey) return { ok: false, error: 'RESEND_API_KEY unset' };
  const maxPages = deps?.maxPages ?? 10;

  const items: ReceivedEmailListItem[] = [];
  let after = '';
  for (let page = 0; page < maxPages; page++) {
    const url = `${RECEIVING_API_BASE}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const res = await timedGet(url, d);
    if ('error' in res) return { ok: false, error: res.error };
    if (!res.ok) return { ok: false, status: res.status, error: `resend receiving list ${res.status}` };
    const raw: any[] = Array.isArray(res.body?.data)
      ? res.body.data
      : Array.isArray(res.body)
        ? res.body
        : [];
    for (const r of raw) {
      items.push({
        id: String(r?.id || ''),
        from: String(r?.from || ''),
        to: Array.isArray(r?.to) ? r.to.map((t: any) => String(t)) : [String(r?.to || '')],
        subject: String(r?.subject || ''),
        createdAt: String(r?.created_at || ''),
        messageId: String(r?.message_id || ''),
      });
    }
    if (raw.length < 100) break;
    after = String(raw[raw.length - 1]?.id || '');
    if (!after) break;
  }
  return { ok: true, items };
}
