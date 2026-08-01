// lib/followUpQueue.ts
//
// PROMISED FOLLOW-UPS — "I'll call you in two weeks", made real.
//
// Ben works the phone. On a good day he tells four buyers he will follow up —
// one in two days, one in two weeks — and until now the only record of that was
// a free-text note nothing reads. The promise lived in his head, and heads
// leak. This module is the selector that makes those promises resurface on the
// day they come due, and refuses to let a bad one be written in the first
// place.
//
// WHERE THIS SITS ON THE DESK: directly BELOW the inbound callback rail
// (lib/callbackQueue — they asked for a call) and ABOVE every cold bucket. The
// ranking encodes a rule worth stating out loud: a promise YOU made outranks a
// cold dial, because breaking it costs trust you already earned — but it does
// not outrank a buyer actively raising their hand right now.
//
// ── THE LANDMINE THIS MODULE EXISTS TO CONTAIN ────────────────────────────
//
// Consumers.'Next Follow Up At' (fldLpCco9KGJf1LxN) is a DATE field, not a
// dateTime. Airtable stores and returns it as a bare 'YYYY-MM-DD' with no time
// and no timezone. "Due today" is therefore a CALENDAR question, and every
// comparison here is done on 'YYYY-MM-DD' strings.
//
// Doing it the obvious way instead — Date.parse(dueDate) vs Date.now() — is
// wrong in two compounding ways:
//   1. Date.parse('2026-08-02') is midnight UTC. Compared against a clock in
//      Denver (UTC-6) every follow-up appears due six hours early, so on any
//      evening the desk shows tomorrow's promises as due today.
//   2. Differencing two local midnights across a DST boundary yields 22.96
//      days, which floors to 22. The "days overdue" number Ben reads would be
//      off by one for part of every year.
// String comparison of date-only values has neither failure mode, and the day
// arithmetic below is anchored at UTC noon so no offset can push it across a
// boundary. Do not "simplify" this into epoch math.
//
// PURE: no I/O, no Date.now() (the caller passes `today`), no mutation of
// input. Airtable field names stay at the boundary; callers get camelCase.

/** How far ahead a follow-up may be promised. ~1 year — see validateFollowUpDate. */
export const FOLLOW_UP_MAX_DAYS_AHEAD = 365;

/** Snooze presets offered on the desk, in days. */
export const FOLLOW_UP_SNOOZE_DAYS = [3, 7] as const;

/** Default page size for the desk section. */
export const DEFAULT_FOLLOW_UP_LIMIT = 50;

/**
 * Buyer Stages that end the relationship. A promise to follow up does not
 * survive the deal closing — CLOSED is the terminal state in the Consumers
 * `Buyer Stage` singleSelect (NEW|WAITING|READY|MATCHED|CLOSED|NURTURE|
 * PRODUCT_BUYER). NURTURE and PRODUCT_BUYER are deliberately NOT terminal:
 * both are live relationships worth a call.
 */
export const TERMINAL_FOLLOW_UP_STAGES = new Set(['CLOSED']);

const DAY_MS = 86_400_000;
/** Anchor day math at UTC noon: 12h of slack in both directions, so no
 *  offset, leap second, or DST jump can round a day across a boundary. */
const NOON_MS = 12 * 3_600_000;

/** A Consumers row, as much of it as this module reads. */
export interface FollowUpConsumerLike {
  id?: string;
  /** Consumers.'Next Follow Up At' (fldLpCco9KGJf1LxN) — DATE, 'YYYY-MM-DD'. */
  'Next Follow Up At'?: unknown;
  /** Consumers.'Admin Notes' (fldHOfrr92OrgaPoP) — why we promised to call. */
  'Admin Notes'?: unknown;
  'Buyer Stage'?: unknown;
  'Full Name'?: unknown;
  Email?: unknown;
  Phone?: unknown;
  State?: unknown;
  Unsubscribed?: unknown;
  Bounced?: unknown;
  Complained?: unknown;
  [key: string]: unknown;
}

/** One promise coming due, shaped for the desk card and the digest line. */
export interface DueFollowUp {
  id: string;
  name: string;
  email: string;
  phone: string;
  state: string;
  /** Consumers.'Admin Notes' — the context that makes the call make sense. */
  notes: string;
  /** The promised date, normalized to 'YYYY-MM-DD'. */
  dueAt: string;
  /** Whole calendar days late. 0 = promised for today. Never negative here. */
  daysOverdue: number;
}

// ── date normalization ─────────────────────────────────────────────────────

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Normalize any date-ish value to a calendar 'YYYY-MM-DD', or null.
 *
 * Accepts a bare date (what Airtable returns), a full ISO datetime (whose DATE
 * portion is taken verbatim — never re-zoned; 23:30Z on the 2nd is the 2nd),
 * and a Date. Everything else — blanks, 'next tuesday', US-format dates, and
 * impossible calendar dates like 2026-02-30 — is null.
 *
 * The round-trip check is what rejects impossible dates: JS Date silently
 * rolls Feb 30 forward to Mar 2, so we rebuild the string and require it to
 * match what we were given.
 */
export function toFollowUpYmd(value: unknown): string | null {
  if (value == null) return null;

  let s: string;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    s = value.toISOString();
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    return null;
  }
  if (!s) return null;

  // Take the date portion of an ISO datetime as-is. No timezone conversion:
  // the field has no time, so inventing one only creates off-by-a-day bugs.
  const head = s.slice(0, 10);
  const m = YMD_RE.exec(head);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(probe.getTime())) return null;
  // Round-trip: catches Feb 30, Apr 31, and non-leap Feb 29.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return head;
}

/** 'YYYY-MM-DD' → epoch ms at UTC noon on that day. Null when unusable. */
function ymdToNoonMs(ymd: string | null): number | null {
  if (!ymd) return null;
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + NOON_MS;
}

/** epoch ms → 'YYYY-MM-DD' in UTC. */
function msToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The operator's timezone. Ben runs the desk from Colorado, and the repo
 * already stamps operator-facing dates in America/Denver (lib/aiTools.ts,
 * lib/email.ts pre-call brief).
 */
export const OPERATOR_TZ = 'America/Denver';

/**
 * What calendar day is it FOR BEN right now?
 *
 * Not `toISOString().slice(0,10)`. The desk is open at all hours, and from 6pm
 * Denver onward UTC has already rolled over — a UTC "today" would surface
 * tomorrow's promises tonight, every single evening. The digest cron is
 * scheduled at 14:07 UTC, where the two happen to agree, which is exactly the
 * kind of coincidence that hides this bug until someone reschedules the cron.
 *
 * 'en-CA' is the locale whose numeric format IS 'YYYY-MM-DD'. Falls back to UTC
 * only if the runtime has no ICU data.
 */
export function operatorToday(
  now: Date | number = Date.now(),
  timeZone: string = OPERATOR_TZ,
): string {
  const d = typeof now === 'number' ? new Date(now) : now;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Whole calendar days between a promised date and `today`.
 * Positive = late, 0 = due today, negative = still in the future.
 * Null when either side is unusable.
 */
export function followUpDaysOverdue(dueAt: unknown, today: unknown): number | null {
  const due = ymdToNoonMs(toFollowUpYmd(dueAt));
  const now = ymdToNoonMs(toFollowUpYmd(today));
  if (due == null || now == null) return null;
  return Math.round((now - due) / DAY_MS);
}

// ── contactability ─────────────────────────────────────────────────────────

/**
 * The repo's standard Consumers suppression trio (mirrors
 * lib/waitingActivation, replenishment, and every nurture rail).
 *
 * Note this rail never emails anyone — it is an OPERATOR reminder for a phone
 * call. Suppression is still honored because these flags mean "this person
 * asked us to stop" or "this contact is dead", and a desk that keeps surfacing
 * someone who unsubscribed is wasting Ben's most expensive hour.
 */
export function isFollowUpSuppressed(c: FollowUpConsumerLike): boolean {
  return c?.Unsubscribed === true || c?.Bounced === true || c?.Complained === true;
}

/** Is this buyer's stage terminal (deal over)? Case/whitespace tolerant. */
export function isTerminalFollowUpStage(stage: unknown): boolean {
  return TERMINAL_FOLLOW_UP_STAGES.has(String(stage ?? '').trim().toUpperCase());
}

// ── the selector ───────────────────────────────────────────────────────────

/**
 * Which promised follow-ups are due as of `today`?
 *
 * DUE means all of:
 *   • 'Next Follow Up At' is set and is a real calendar date
 *   • that date is today or earlier
 *   • the buyer is not unsubscribed / bounced / complained
 *   • the buyer is not in a terminal stage (CLOSED)
 *
 * Sorted MOST-OVERDUE FIRST — the promise that has been broken longest is the
 * one closest to costing the relationship — then by record id so the order is
 * total and two renders of the same desk never swap rows.
 *
 * FAILS TOWARD SILENCE, unlike the callback rail next door. An unparseable
 * `today` returns nothing rather than treating every promise as due: the two
 * consumers of this function are a desk section and a Telegram digest, and the
 * failure mode of a wrong-way default is blasting Ben with every follow-up ever
 * recorded. A missed day is recoverable; a digest that cries wolf gets muted,
 * and a muted digest is a rail that no longer exists.
 *
 * @param consumers Raw Consumers rows (Airtable field names).
 * @param today     'YYYY-MM-DD' (or a Date / ISO string) — the operator's day.
 */
export function selectDueFollowUps(
  consumers: FollowUpConsumerLike[],
  today: unknown,
  limit: number = DEFAULT_FOLLOW_UP_LIMIT,
): DueFollowUp[] {
  const todayYmd = toFollowUpYmd(today);
  if (!todayYmd) return [];
  if (!Array.isArray(consumers)) return [];

  const due: DueFollowUp[] = [];

  for (const c of consumers) {
    if (!c) continue;
    const dueAt = toFollowUpYmd(c['Next Follow Up At']);
    if (!dueAt) continue;
    // Calendar-string comparison. See the landmine note at the top of the file.
    if (dueAt > todayYmd) continue;
    if (isFollowUpSuppressed(c)) continue;
    if (isTerminalFollowUpStage(c['Buyer Stage'])) continue;

    const daysOverdue = followUpDaysOverdue(dueAt, todayYmd);
    if (daysOverdue == null) continue;

    due.push({
      id: String(c.id ?? ''),
      name: String(c['Full Name'] ?? '').trim() || '(no name)',
      email: String(c.Email ?? '').trim(),
      phone: String(c.Phone ?? '').trim(),
      state: String(c.State ?? '').trim(),
      notes: String(c['Admin Notes'] ?? '').trim(),
      dueAt,
      daysOverdue,
    });
  }

  due.sort((a, b) => {
    if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1; // oldest promise first
    return a.id.localeCompare(b.id); // total + stable
  });

  return due.slice(0, Math.max(0, limit));
}

// ── digest formatting ──────────────────────────────────────────────────────

/** Max follow-up lines in one Telegram digest before it collapses to a count. */
export const FOLLOW_UP_DIGEST_MAX_LINES = 10;

/**
 * Squeeze 'Admin Notes' into ONE line of context for the morning digest.
 *
 * Takes the first non-empty line — operators write the headline first and the
 * history below it — collapses whitespace, and truncates on a word boundary.
 * Telegram messages cap at 4096 characters and this rail shares that budget
 * with the rest of the digest, so a buyer with a wall of call history cannot be
 * allowed to push the supply numbers off the bottom.
 */
export function followUpContextLine(notes: unknown, maxLen = 80): string {
  const raw = String(notes ?? '');
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return '';
  const flat = first.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  const cut = flat.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  // Only break on a word boundary if one exists reasonably near the end;
  // otherwise a single long token would collapse the line to almost nothing.
  const body = lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

// ── the write path ─────────────────────────────────────────────────────────

export type FollowUpDateValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate a follow-up date before it is written to Airtable.
 *
 * Rules: a real calendar date, today or later, and no further out than
 * FOLLOW_UP_MAX_DAYS_AHEAD (~1 year). The horizon cap is not bureaucracy —
 * it catches the two typos that actually happen, a wrong year ('2126-08-02')
 * and a pasted epoch, either of which writes a row that silently never comes
 * due again. Rejecting the past matters just as much: a follow-up set to
 * yesterday is instantly "overdue" and lands at the TOP of the desk forever.
 *
 * Returns the NORMALIZED 'YYYY-MM-DD' so callers write the field's own shape
 * rather than an ISO datetime Airtable would have to coerce.
 */
export function validateFollowUpDate(input: unknown, today: unknown): FollowUpDateValidation {
  const todayYmd = toFollowUpYmd(today);
  if (!todayYmd) return { ok: false, error: 'cannot resolve today' };

  const value = toFollowUpYmd(input);
  if (!value) {
    return { ok: false, error: 'follow-up date must be a calendar date (YYYY-MM-DD)' };
  }
  if (value < todayYmd) {
    return { ok: false, error: 'follow-up date cannot be in the past' };
  }
  const ahead = -(followUpDaysOverdue(value, todayYmd) as number);
  if (ahead > FOLLOW_UP_MAX_DAYS_AHEAD) {
    return { ok: false, error: `follow-up date cannot be more than a year out` };
  }
  return { ok: true, value };
}

/**
 * Advance a follow-up by `days`, returning 'YYYY-MM-DD'.
 *
 * Callers pass TODAY as the base, never the missed date. Snoozing "+3d" from a
 * three-week-old promise would produce a date still in the past and the row
 * would never leave the desk — the operator would tap snooze and watch nothing
 * happen, which is worse than no button at all.
 */
export function snoozeFollowUpDate(fromYmd: unknown, days: number): string | null {
  const base = ymdToNoonMs(toFollowUpYmd(fromYmd));
  if (base == null) return null;
  if (!Number.isFinite(days)) return null;
  return msToYmd(base + Math.round(days) * DAY_MS);
}
