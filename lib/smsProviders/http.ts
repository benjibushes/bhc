// lib/smsProviders/http.ts — the one HTTP primitive every REST adapter uses.
//
// Rules this enforces so no adapter has to remember them:
//   1. NEVER THROW. A DNS failure, a TLS error, an abort — all come back as a
//      shaped `{ ok:false, error }`. The SMS rail sits inside cron routes and
//      webhook handlers that must not 500 because a vendor blipped.
//   2. Always time-bounded. Vercel functions have a hard wall clock; a hung
//      vendor socket must not eat it.
//   3. Body is read ONCE as text, then JSON-parsed best-effort — vendors return
//      HTML error pages often enough that res.json() alone would throw.
//
// No new npm deps: plain fetch + AbortSignal.timeout (Node 18+, Next 16).

/** Default per-request budget. Well under every cron/webhook maxDuration. */
export const SMS_HTTP_TIMEOUT_MS = 10_000;

export interface PostJsonResult {
  /** true iff a response came back with a 2xx status. */
  ok: boolean;
  /** HTTP status, or 0 when the request never completed (network/timeout). */
  status: number;
  /** Parsed body when it was valid JSON, else null. */
  json: any;
  /** Raw body text (truncated) — the fallback error string when json is null. */
  text: string;
  /** Set only when the request itself failed (never reached a response). */
  transportError?: string;
}

/** Trim vendor error bodies so a stray HTML page can't flood the logs. */
function clip(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * POST a JSON body and return a fully-shaped result. Never rejects.
 */
export async function postJson(
  url: string,
  init: {
    headers: Record<string, string>;
    body: unknown;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<PostJsonResult> {
  const doFetch = init.fetchImpl || fetch;
  const timeoutMs = init.timeoutMs ?? SMS_HTTP_TIMEOUT_MS;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: res.ok, status: res.status, json, text: clip(text) };
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `request timed out after ${timeoutMs}ms`
      : String(e?.message || e);
    return { ok: false, status: 0, json: null, text: '', transportError: clip(msg) };
  }
}

/** RFC 7617 Basic credentials. Used by Plivo and Bandwidth. */
export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}
