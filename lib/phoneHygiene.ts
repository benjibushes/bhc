// lib/phoneHygiene.ts
//
// ONE pure module for US phone handling (close-the-loop 2026-07-15). Three
// consumers, one truth:
//   - the funnel reveal + buyer intro email ("text your rancher now") need an
//     sms: deep link that never renders broken, plus a pretty display form;
//   - the /api/consumers funnel branch stores the normalized E.164 form so
//     downstream sms:/tel: links and Twilio sends never re-parse freeform;
//   - the rancher lead email appends a quiet "area code looks out-of-state"
//     line when the buyer's area code provably maps to a different state.
//
// Deliberately stricter than lib/twilio's normalizeToE164 (which exists to
// not lose a send): this module answers "is this a REAL, textable US number
// we'd put a CTA behind?" — NANP shape rules + junk rejection. Unknown area
// code → null state, never a guess.
//
// COUNTRY-CODE RULE IS NOT OURS (rebase reconciliation 2026-07-24): stripping
// a leading US `1` is owned by lib/phoneFormat.normalizePhoneDigits, which
// exists specifically to kill the `digits.slice(0, 10)` truncation bug that
// turned `1 (406) 555-1234` into a plausible-looking, permanently WRONG
// `(140) 655-5123` on every signup door. This module originally re-derived
// that same rule inline — a second dialect of the exact logic main had just
// centralized, which would silently keep the old behavior if the shared rule
// ever changed. It now CALLS the shared helper and layers only its own
// strictness (NANP shape + junk rejection) on top. One leading-1 rule,
// repo-wide.
//
// Pure + dependency-light (lib/states' normalizeState + lib/phoneFormat,
// which has zero imports) so client components (BuyerFunnel) can import it
// without dragging server modules.

import { normalizeState } from './states';
import { normalizePhoneDigits } from './phoneFormat';

/**
 * Normalize a US phone to strict E.164 (+1XXXXXXXXXX).
 *
 * Rules (NANP): exactly 10 digits after stripping (or 11 with leading 1);
 * area code and exchange must start 2-9; reject obvious junk (all-same
 * digits like 5555555555, the 555-01xx fiction block, sequential
 * 1234567890). Anything else → null — callers render NO link rather than a
 * broken one.
 */
export function normalizePhoneE164(raw: unknown): string | null {
  if (raw == null) return null;
  // Shared leading-`1` strip (lib/phoneFormat) — see header. Never truncates,
  // so an over-long paste stays over-long and is REJECTED by the length gate
  // below rather than silently becoming a different, wrong, valid-looking
  // number.
  const digits = normalizePhoneDigits(String(raw));
  if (digits.length !== 10) return null;
  // NANP: area code (NXX) and exchange (NXX) must start 2-9.
  if (digits[0] < '2' || digits[3] < '2') return null;
  // Junk: all ten digits identical (0000000000, 5555555555, …).
  if (/^(\d)\1{9}$/.test(digits)) return null;
  // Junk: the ascending test string.
  if (digits === '1234567890' || digits === '2345678901') return null;
  // Junk: 555-01XX is the reserved fictional block (and bare exchange 555
  // numbers outside directory assistance are near-certain fakes).
  if (digits.slice(3, 6) === '555') return null;
  return `+1${digits}`;
}

/** True when the value normalizes to a strict US E.164 number. */
export function isLikelyUsMobileShape(raw: unknown): boolean {
  return normalizePhoneE164(raw) !== null;
}

/**
 * Pretty display form: '(720) 240-1234'. Falls back to the trimmed input
 * when it doesn't normalize (never invents digits, never empties a value the
 * caller chose to show).
 */
export function formatPhonePretty(raw: unknown): string {
  const e164 = normalizePhoneE164(raw);
  if (!e164) return String(raw ?? '').trim();
  const d = e164.slice(2); // drop '+1'
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * sms: deep link with a prefilled body. `?&body=` is the one separator that
 * works on both iOS (which wants `&body=` after an implicit `;`-less target)
 * and Android (which wants `?body=`) — the shipping cross-platform idiom.
 * Returns null when the phone doesn't normalize — callers must render
 * nothing rather than a dead link.
 */
export function smsHref(phone: unknown, body: string): string | null {
  const e164 = normalizePhoneE164(phone);
  if (!e164) return null;
  const encoded = encodeURIComponent(body || '');
  return encoded ? `sms:${e164}?&body=${encoded}` : `sms:${e164}`;
}

/** tel: link, or null when the phone doesn't normalize. */
export function telHref(phone: unknown): string | null {
  const e164 = normalizePhoneE164(phone);
  return e164 ? `tel:${e164}` : null;
}

/**
 * The prefilled "text your rancher now" body — shared by the funnel reveal
 * and the buyer intro email so the two surfaces can never drift. Lowercase
 * brand voice; short enough to feel typed, specific enough to save the buyer
 * composing anything.
 */
export function buyerIntroSmsBody(
  rancherFirstName: string,
  buyerFirstName: string,
  cut?: string,
): string {
  const r = (rancherFirstName || '').trim() || 'there';
  const b = (buyerFirstName || '').trim();
  const want = (cut || '').trim().toLowerCase();
  const wantLabel = want && want !== 'not sure' ? `a ${want}` : 'a beef share';
  const sig = b ? ` — ${b}` : '';
  return `hi ${r}, just matched with you on buyhalfcow — i'm looking for ${wantLabel}.${sig}`;
}

// ── Area code → state (top codes covering BHC states + neighbors) ────────────
//
// HONESTY RULE: only long-established, unambiguous geographic area codes are
// listed — no recent overlays we aren't sure of, no toll-free, no Canadian.
// A code not in this table returns null ("we don't know"), and the ONE
// consumer of that null (rancherLeadEmail) renders nothing. Never guess.
export const AREA_CODE_STATE: Readonly<Record<string, string>> = {
  // OK
  '405': 'OK', '918': 'OK', '580': 'OK', '539': 'OK',
  // TX
  '214': 'TX', '469': 'TX', '972': 'TX', '254': 'TX', '281': 'TX', '713': 'TX',
  '832': 'TX', '210': 'TX', '512': 'TX', '737': 'TX', '361': 'TX', '409': 'TX',
  '430': 'TX', '903': 'TX', '806': 'TX', '817': 'TX', '682': 'TX', '830': 'TX',
  '915': 'TX', '936': 'TX', '940': 'TX', '956': 'TX', '979': 'TX', '325': 'TX',
  '432': 'TX',
  // KS
  '316': 'KS', '620': 'KS', '785': 'KS', '913': 'KS',
  // NM
  '505': 'NM', '575': 'NM',
  // CO
  '303': 'CO', '720': 'CO', '719': 'CO', '970': 'CO',
  // CA
  '209': 'CA', '213': 'CA', '310': 'CA', '323': 'CA', '408': 'CA', '415': 'CA',
  '424': 'CA', '510': 'CA', '530': 'CA', '559': 'CA', '562': 'CA', '619': 'CA',
  '626': 'CA', '650': 'CA', '657': 'CA', '661': 'CA', '707': 'CA', '714': 'CA',
  '747': 'CA', '760': 'CA', '805': 'CA', '818': 'CA', '831': 'CA', '858': 'CA',
  '909': 'CA', '916': 'CA', '925': 'CA', '949': 'CA', '951': 'CA',
  // GA
  '404': 'GA', '470': 'GA', '678': 'GA', '770': 'GA', '706': 'GA', '762': 'GA',
  '912': 'GA', '229': 'GA', '478': 'GA',
  // FL
  '305': 'FL', '786': 'FL', '954': 'FL', '754': 'FL', '561': 'FL', '772': 'FL',
  '407': 'FL', '321': 'FL', '813': 'FL', '727': 'FL', '941': 'FL', '239': 'FL',
  '863': 'FL', '352': 'FL', '386': 'FL', '904': 'FL', '850': 'FL',
  // AZ
  '480': 'AZ', '602': 'AZ', '623': 'AZ', '928': 'AZ', '520': 'AZ',
  // TN
  '615': 'TN', '629': 'TN', '731': 'TN', '865': 'TN', '901': 'TN', '423': 'TN',
  '931': 'TN',
  // OH
  '216': 'OH', '330': 'OH', '234': 'OH', '419': 'OH', '567': 'OH', '440': 'OH',
  '513': 'OH', '614': 'OH', '740': 'OH', '937': 'OH',
  // IL
  '312': 'IL', '773': 'IL', '872': 'IL', '630': 'IL', '331': 'IL', '708': 'IL',
  '847': 'IL', '224': 'IL', '815': 'IL', '618': 'IL', '217': 'IL', '309': 'IL',
  // MO
  '314': 'MO', '636': 'MO', '660': 'MO', '816': 'MO', '417': 'MO', '573': 'MO',
  // MT
  '406': 'MT',
  // NE
  '402': 'NE', '531': 'NE', '308': 'NE',
  // ME
  '207': 'ME',
  // UT
  '801': 'UT', '385': 'UT', '435': 'UT',
  // NC
  '704': 'NC', '980': 'NC', '336': 'NC', '919': 'NC', '984': 'NC', '910': 'NC',
  '252': 'NC', '828': 'NC',
  // Neighbors of BHC states (routes cross borders; buyers move) —
  // AR / LA / MS / AL / KY / IA / SD / ND / WY / ID / NV / OR / WA / VA / SC / IN / MN / WI
  '501': 'AR', '479': 'AR', '870': 'AR',
  '504': 'LA', '985': 'LA', '225': 'LA', '318': 'LA', '337': 'LA',
  '601': 'MS', '769': 'MS', '662': 'MS', '228': 'MS',
  '205': 'AL', '251': 'AL', '256': 'AL', '334': 'AL',
  '502': 'KY', '859': 'KY', '606': 'KY', '270': 'KY',
  '515': 'IA', '319': 'IA', '563': 'IA', '641': 'IA', '712': 'IA',
  '605': 'SD',
  '701': 'ND',
  '307': 'WY',
  '208': 'ID',
  '702': 'NV', '775': 'NV',
  '503': 'OR', '971': 'OR', '541': 'OR',
  '206': 'WA', '253': 'WA', '425': 'WA', '360': 'WA', '509': 'WA',
  '703': 'VA', '571': 'VA', '757': 'VA', '804': 'VA', '434': 'VA', '540': 'VA',
  '803': 'SC', '843': 'SC', '864': 'SC',
  '317': 'IN', '219': 'IN', '260': 'IN', '574': 'IN', '765': 'IN', '812': 'IN',
  '612': 'MN', '651': 'MN', '763': 'MN', '952': 'MN', '218': 'MN', '320': 'MN',
  '507': 'MN',
  '414': 'WI', '262': 'WI', '608': 'WI', '715': 'WI', '920': 'WI',
};

/**
 * The 2-letter state a phone's area code maps to, or null when the phone
 * doesn't normalize or the code isn't in the honest table. Null means "no
 * claim" — callers render nothing.
 */
export function areaCodeState(phone: unknown): string | null {
  const e164 = normalizePhoneE164(phone);
  if (!e164) return null;
  return AREA_CODE_STATE[e164.slice(2, 5)] ?? null;
}

/**
 * True ONLY when we positively know the phone's area-code state AND it
 * differs from the buyer's (normalized) state. Unknown code, unparseable
 * phone, or unknown buyer state → false (no claim).
 */
export function phoneLooksOutOfState(phone: unknown, buyerState: unknown): boolean {
  const codeState = areaCodeState(phone);
  if (!codeState) return false;
  const buyer = normalizeState(buyerState);
  if (!buyer) return false;
  return codeState !== buyer;
}
