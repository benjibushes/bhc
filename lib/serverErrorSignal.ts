// lib/serverErrorSignal.ts
//
// Pure helpers behind the instrumentation.ts `onRequestError` → operator
// signal wire (runtime audit 2026-07-28). A route 500ing all night must be
// ONE Telegram alarm, not hundreds — so the dedupe key is a hash of
// (routePath + normalized error message), where normalization strips the
// variable parts (record ids, timings, counts) that would otherwise make
// every retry of the same failure look like a brand-new error.
//
// Pure + dependency-free so it's unit-testable and safe to import from
// instrumentation.ts in any runtime.

export interface ServerErrorSignalInput {
  routePath?: string;
  routerKind?: string;
  routeType?: string;
  method?: string;
  message: unknown;
}

/** Signal shape consumed by lib/operatorSignal's sendOperatorSignal. */
export interface ServerErrorSignal {
  urgency: 'loud';
  kind: 'system-error';
  summary: string;
  detail: string;
  dedupeKey: string;
  dedupeWindowMs: number;
}

const MAX_NORMALIZED_LEN = 200;

/**
 * Collapse an error message to its stable shape: lowercase, digits → '#'
 * (record ids / ms timings / attempt counts vary per request), whitespace
 * collapsed, hard-truncated. Never throws on non-string input.
 */
export function normalizeErrorMessage(message: unknown): string {
  let s: string;
  try {
    s = typeof message === 'string' ? message : String(message ?? '');
  } catch {
    s = '';
  }
  return s
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NORMALIZED_LEN);
}

// djb2 — tiny, stable, dependency-free. Collisions are acceptable here (a
// collision only merges two alarms into one dedupe window, never drops data).
function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function serverErrorDedupeKey(routePath: string, message: unknown): string {
  const route = String(routePath || 'unknown-route');
  return `server-error:${route}:${djb2Hex(normalizeErrorMessage(message))}`;
}

/**
 * Build the loud operator signal for an unhandled server error. 1h dedupe
 * window (mirrors cronRun's alert cooldown): the same failure on the same
 * route re-alarms at most hourly; a DIFFERENT error message alarms fresh.
 */
export function buildServerErrorSignal(input: ServerErrorSignalInput): ServerErrorSignal {
  const route = String(input.routePath || 'unknown-route');
  const rawMessage = (() => {
    try {
      return typeof input.message === 'string' ? input.message : String(input.message ?? 'unknown error');
    } catch {
      return 'unknown error';
    }
  })();
  const contextBits = [input.routerKind, input.routeType, input.method].filter(Boolean).join(' · ');
  return {
    urgency: 'loud',
    kind: 'system-error',
    summary: `SERVER ERROR ${route}`,
    detail: `${rawMessage.slice(0, 500)}${contextBits ? `\n${contextBits}` : ''}`,
    dedupeKey: serverErrorDedupeKey(route, input.message),
    dedupeWindowMs: 60 * 60 * 1000,
  };
}
