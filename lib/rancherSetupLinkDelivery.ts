// lib/rancherSetupLinkDelivery.ts
//
// WHO IS ALLOWED TO HOLD A rancher-setup TOKEN.
//
// THE HOLE THIS CLOSES (live in production until 2026-07-24):
//   /api/apply, /api/prospects/self-submit and /api/partners all dedupe an
//   incoming signup against the Ranchers table through
//   findOrCreateRancherByEmail, which matches on FOUR tiers:
//     email · team-email · phone · (ranch name + state)
//   On a match every one of those doors minted a 60-day `rancher-setup` JWT
//   for the MATCHED record and returned it in the HTTP response.
//
//   Ranch names and states are PUBLIC — every ranch is listed on /map and has
//   a public page at /ranchers/<slug>. So an anonymous stranger who typed a
//   known ranch's name and its state got a working 60-day setup token for that
//   rancher's record: their landing page, their PRICES, their fulfillment
//   settings, and the Stripe Connect onboarding entry point. Account takeover
//   from public information, with no signal to the real rancher.
//
// THE RULE:
//   A setup token may be RETURNED IN THE RESPONSE only to a submitter who
//   proved control of the address on the record — i.e. the submitted email is
//   the record's own primary `Email`. Every other match tier (team email,
//   phone, ranch+state, website host) gets the setup link EMAILED to the
//   address already on file instead. The link still reaches the real rancher;
//   it just never reaches whoever guessed a public ranch name.
//
//   A `team` match is deliberately email-only: a teammate listed on the row is
//   real, but the row's primary owner is who owns the prices and the payout
//   account. Emailing the owner still gets the teammate in — via the owner.
//
// NO ORACLE: callers must return the SAME body for every email-only outcome.
// Varying the response by match tier (or by whether an address was on file)
// turns these public endpoints into a "does this ranch exist / which field did
// I hit" probe. The real send outcome is alerted to the operator instead.
//
// PURE + ZERO-IMPORT so it unit-tests under `npm test` (lib/**/*.test.ts).
// The routes do the I/O.

/** Match tiers findOrCreateRancherByEmail reports, plus the self-submit
 *  secondary tier (website host) which is equally public. */
export type RancherMatchSignal =
  | 'email'
  | 'team'
  | 'phone'
  | 'ranch+state'
  | 'website'
  | null
  | undefined;

export type SetupLinkDelivery =
  /** Safe to hand the wizard URL back in the HTTP response. */
  | 'return-token'
  /** Mail the link to the address on file; return nothing link-shaped. */
  | 'email-only';

/**
 * The SAME normalizer lib/airtable.ts `_normalizeEmail` and the rancher-login
 * rail use: lower-case, and strip ALL whitespace (not just the edges — a
 * stored address with inner whitespace is a real shape in this base).
 */
export function normalizeRancherEmail(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Given the match tier and the two addresses, decide whether the caller may
 * see the token. Fails CLOSED: anything unrecognized is 'email-only'.
 *
 * Requiring BOTH `matchedBy === 'email'` AND the normalized addresses to be
 * equal is deliberate belt-and-braces — a future dedupe tier that mislabels
 * itself 'email', or a caller that passes the wrong record, still cannot leak
 * a token.
 */
export function decideSetupLinkDelivery(args: {
  matchedBy: RancherMatchSignal;
  submittedEmail?: unknown;
  recordEmail?: unknown;
}): SetupLinkDelivery {
  if (args.matchedBy !== 'email') return 'email-only';
  const submitted = normalizeRancherEmail(args.submittedEmail);
  const onFile = normalizeRancherEmail(args.recordEmail);
  if (!submitted || !onFile) return 'email-only';
  return submitted === onFile ? 'return-token' : 'email-only';
}

/**
 * Copy for the neutral 200. Says what happened without naming the address on
 * file (which would confirm a guessed ranch's contact email to a stranger) and
 * without naming which field matched.
 *
 * The recovery clause is load-bearing, not politeness. The response body must
 * be CONSTANT across every email-only outcome — sent, throttled, send failed,
 * no address on file — or it becomes a probe. That means it cannot promise
 * delivery it can't guarantee, so it names a human path that works in all four
 * cases. A real rancher is never dead-ended; a stranger learns nothing.
 */
export const SETUP_LINK_EMAILED_MESSAGE =
  "This ranch is already registered — we've sent the setup link to the email on file. " +
  "If it doesn't arrive, email ben@buyhalfcow.com and we'll verify you and get you in.";

/**
 * Rate-limit bucket for owner-directed setup-link sends, keyed on the RECORD
 * (not the caller's IP) so rotating IPs can't bomb one rancher's inbox.
 * Used with lib/rateLimit's `rateLimit()`.
 */
export function setupLinkResendKey(rancherId: string): string {
  return `setup-link-existing:${rancherId}`;
}

/** Two owner-directed sends per record per day is a re-send, not a mailbomb. */
export const SETUP_LINK_RESEND_LIMIT = { requests: 2, window: '24h' } as const;
