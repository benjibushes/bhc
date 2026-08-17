// lib/operatorSend.ts — the OPERATOR SEND rail: mint AND deliver, in one tap.
//
// THE GAP THIS CLOSES. Ben closes buyers who never touched the funnel — phone
// calls, texts, DMs, farmers markets. The sell console (app/admin/sell) mints
// the right link on all three rails (CONNECT /r/d, BROKER /r/b, PRODUCT /shop)
// and then hands delivery back to him: "copy link" and an `sms:` composer that
// opens HIS OWN Messages app. The PLATFORM has never sent anything. Every call
// therefore ends in a manual, forgettable step, and a minted-but-never-sent
// link is a Pending referral, a held slot, and a buyer who heard from nobody.
//
// WHAT LIVES HERE — every decision, none of the I/O. The route
// (app/api/admin/sell-links/send) supplies four injected effects (email, sms,
// claim, stamp); everything that decides ANYTHING is pure and pinned in
// lib/operatorSend.test.ts. That split is deliberate: this module carries the
// one rule the whole feature exists for —
//
//   ** NEVER REPORT SUCCESS WHEN DELIVERY FAILED. **
//
// A suppressed recipient is NOT a send. A cap-eaten email is NOT a send. An
// SMS on a platform whose ENABLE_SMS flag is off is NOT a send — it is a
// channel that must say so out loud, BEFORE the operator taps, and again in
// the outcome. The only state that means "the buyer has the link" is
// 'delivered'. Everything else names itself and its reason so the console can
// show Ben the truth while he is still on the phone and can read the link out.
//
// LINK SAFETY. The endpoint accepts a URL from the console, so it is a
// mail-anything primitive unless the URL is constrained. `resolveSendTarget`
// is that constraint, and it is cryptographic rather than cosmetic on two of
// three rails: an /r/d or /r/b link is only accepted if its token VERIFIES
// (which also yields the buyer's consumerId, exactly, with no email guessing),
// and a product link is only accepted as the durable PDP path. A raw Stripe
// checkout URL — the repo's #3 hard rule, ~24h expiry — cannot pass this gate
// from any rail, which is why the product rail emails /shop/<id> and not the
// session URL the console mints for Ben's own copy-paste.

import { verifyCampaignReserveToken, verifyBrokerReserveToken } from './campaignReserve';
import type { Cut } from './reserveDeposit';

// ---------------------------------------------------------------------------
// Outcomes — the vocabulary the console renders, one per channel.
// ---------------------------------------------------------------------------

/**
 * Per-channel truth. Exactly ONE of these means the buyer got the link.
 *
 *   delivered        the transport accepted it. The only success.
 *   already-sent     idempotency claim lost — an earlier tap in the same
 *                    window already delivered this exact link to this buyer.
 *                    Not a failure (the buyer HAS it) and not a fresh send.
 *   suppressed       the recipient is unsubscribed / bounced / complained, or
 *                    the frequency guard refused. Terminal — never retried.
 *   failed           the transport errored. `reason` carries what it said.
 *   channel-disabled the channel is off platform-wide (ENABLE_SMS unset).
 *   no-consent       SMS only: no TCPA opt-in on file, or globally suppressed.
 *   no-destination   nothing to send to (no email address / no phone).
 *   not-requested    the operator did not pick this channel.
 */
export type SendState =
  | 'delivered'
  | 'already-sent'
  | 'suppressed'
  | 'failed'
  | 'channel-disabled'
  | 'no-consent'
  | 'no-destination'
  | 'not-requested';

export interface ChannelOutcome {
  state: SendState;
  /** Operator-facing explanation. Empty on a clean delivery. */
  reason: string;
}

/** States in which the buyer demonstrably has the link. */
export function isReached(o: ChannelOutcome): boolean {
  return o.state === 'delivered' || o.state === 'already-sent';
}

/**
 * Roll the per-channel outcomes into what the console needs to render.
 *
 * `loud` is the "both channels failed" signal the brief asks for: nothing
 * reached the buyer AND at least one channel was actually attempted. A send
 * where the operator only picked email and email failed is just as loud — one
 * failed channel out of one is still a buyer who heard nothing.
 */
export function summarizeSend(channels: ChannelOutcome[]): {
  reached: boolean;
  loud: boolean;
} {
  const attempted = channels.filter((c) => c.state !== 'not-requested');
  const reached = attempted.some(isReached);
  return { reached, loud: attempted.length > 0 && !reached };
}

// ---------------------------------------------------------------------------
// Link gate — what this endpoint is allowed to put in front of a buyer.
// ---------------------------------------------------------------------------

export type SendRail = 'connect' | 'broker' | 'product';

export interface SendTarget {
  rail: SendRail;
  /** Buyer's Consumers record id, read from the token. '' on the product rail. */
  consumerId: string;
  cut: Cut | '';
  /** Normalized absolute URL, safe to put in an email. */
  url: string;
  /** Rancher Products record id — product rail only, '' elsewhere. Returned
   *  here rather than re-split off the URL by the caller: a re-split keeps any
   *  query string attached and turns a liveness lookup into a miss (and its
   *  refusal message into a lie about which product is dark). */
  productId: string;
}

export type SendTargetResult =
  | { ok: true; target: SendTarget }
  | { ok: false; error: string };

/** Airtable record id shape — the only thing /shop/<id> may name. */
const REC_ID = /^rec[A-Za-z0-9]{14}$/;

/**
 * Decide whether a URL is a link this platform is willing to SEND, and who it
 * belongs to.
 *
 * DURABLE-ONLY, by construction. Three shapes pass and nothing else:
 *   /r/d/<token>   CONNECT share deposit — token must verify (campaign-reserve)
 *   /r/b/<token>   BROKER share deposit  — token must verify (broker-reserve)
 *   /shop/<recId>  PRODUCT detail page   — durable, never expires
 *
 * The token verification is not decoration: it proves the link was minted by
 * this platform for THIS buyer, and it hands back the consumerId so the
 * stamp lands on the right record without a second email lookup (which can
 * resolve to several rows — see the duplicate-pair note in docs/WRITE-MAP.md).
 *
 * A raw Stripe checkout URL fails on the host check and again on the path
 * check. That is the point: the console still mints one for Ben to read out
 * during the call, and it must never reach an inbox it can expire inside of.
 */
export function resolveSendTarget(
  rawUrl: string,
  siteUrl: string,
): SendTargetResult {
  const raw = String(rawUrl || '').trim();
  if (!raw) return { ok: false, error: 'a link is required' };

  let parsed: URL;
  let site: URL;
  try {
    parsed = new URL(raw);
    site = new URL(siteUrl);
  } catch {
    return { ok: false, error: 'that is not a valid link' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'only http(s) links can be sent' };
  }
  if (parsed.host.toLowerCase() !== site.host.toLowerCase()) {
    return {
      ok: false,
      error: 'only buyhalfcow links can be sent — never a Stripe checkout URL (it expires)',
    };
  }

  // EXACT segments off the RAW pathname. `split('/').filter(Boolean)` was
  // wrong: it collapsed empty segments, so '//r//d//<token>' parsed as a valid
  // three-segment path — while the URL that actually got emailed kept its
  // double slashes and resolved to nothing. Reject ANY empty segment (that
  // also rejects a trailing slash) and match the shapes exactly.
  const segs = parsed.pathname.split('/');
  const parts = segs.slice(1);
  const notFound = {
    ok: false as const,
    error: 'that link is not a durable BuyHalfCow deposit or product link',
  };
  if (segs[0] !== '' || parts.length === 0 || parts.some((seg) => seg === '')) return notFound;

  // ── CONNECT share deposit ───────────────────────────────────────────────
  if (parts.length === 3 && parts[0] === 'r' && parts[1] === 'd') {
    const v = verifyCampaignReserveToken(parts[2]);
    if (!v.ok) return { ok: false, error: `that deposit link is ${v.reason} — mint a fresh one` };
    return {
      ok: true,
      target: {
        rail: 'connect',
        consumerId: v.payload.consumerId,
        cut: v.payload.cut,
        url: parsed.toString(),
        productId: '',
      },
    };
  }

  // ── BROKER share deposit ────────────────────────────────────────────────
  if (parts.length === 3 && parts[0] === 'r' && parts[1] === 'b') {
    const v = verifyBrokerReserveToken(parts[2]);
    if (!v.ok) return { ok: false, error: `that broker link is ${v.reason} — mint a fresh one` };
    return {
      ok: true,
      target: {
        rail: 'broker',
        consumerId: v.payload.consumerId,
        cut: v.payload.cut,
        url: parsed.toString(),
        productId: '',
      },
    };
  }

  // ── PRODUCT (low-ticket) ────────────────────────────────────────────────
  // The DURABLE product page, never the Stripe session the console mints for
  // Ben's own copy-paste. There is no per-buyer product token, so the
  // consumerId is resolved by the route (best-effort, stamp-only).
  if (parts.length === 2 && parts[0] === 'shop' && REC_ID.test(parts[1])) {
    return {
      ok: true,
      target: { rail: 'product', consumerId: '', cut: '', url: parsed.toString(), productId: parts[1] },
    };
  }

  return notFound;
}

// ---------------------------------------------------------------------------
// Recipient binding — the link belongs to ONE buyer.
// ---------------------------------------------------------------------------

/**
 * Exactly one deliverable address. `includes('@')` is not enough: Resend takes
 * a comma-separated `to`, and lib/email.ts's suppression check does an EXACT
 * string lookup on the whole field — so "ok@x.com, unsubscribed@y.com" walks
 * straight past the suppression list and mails someone who opted out. One
 * address, no commas, no semicolons, no whitespace, no display name.
 */
export function isSingleEmailAddress(raw: string): boolean {
  const v = String(raw || '').trim();
  if (!v || v.length > 254) return false;
  if (/[,;<>\s"]/.test(v)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(v);
}

/**
 * Does this link actually belong to the person we are about to mail?
 *
 * WHY THIS EXISTS — the share rails' link is not a brochure, it is a CREDENTIAL.
 * /r/d and /r/b exchange the token for a deposit grant scoped to that buyer's
 * referral: whoever opens it can read the buyer↔rancher message history, set
 * cut preferences, and pay that buyer's deposit. Mailing it to a different
 * address is therefore an account-access handoff, not a typo.
 *
 * The console makes that a ONE-TAP slip: the result bar survives edits to the
 * buyer-email field, so a freshly typed address can sit above a link minted
 * for the previous caller. The button relabels itself; the token does not.
 *
 * REFUSE — no confirm-and-proceed escape hatch. There is no legitimate reason
 * to mail buyer A's deposit grant to address B; the legitimate operation
 * ("send this cut to the person I am talking to now") is one re-mint away and
 * takes a single tap. A checkbox would only ever be ticked in exactly the
 * distracted moment this guard exists to catch.
 *
 * FAILS CLOSED. A buyer record with no email on file cannot be verified, so it
 * is refused rather than assumed to match.
 */
export function checkRecipientBinding(input: {
  /** `Email` on the Consumers row the token names. */
  recordEmail: unknown;
  /** The address the operator is about to send to. */
  buyerEmail: string;
}): { ok: true } | { ok: false; error: string } {
  const onFile = String(input.recordEmail ?? '').trim().toLowerCase();
  const asked = String(input.buyerEmail || '').trim().toLowerCase();
  if (!onFile) {
    return {
      ok: false,
      error: 'that link\u2019s buyer record has no email on file — mint a fresh link for this buyer',
    };
  }
  if (onFile !== asked) {
    return {
      ok: false,
      // Never echo the address on file: it belongs to a different buyer, and
      // the operator does not need it to fix this.
      error:
        'that link was minted for a different buyer — it is a deposit grant for their referral, so it cannot be sent to this address. mint a fresh link for this buyer.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Copy — Ben's voice, per rail. Pure so the money language can be pinned.
// ---------------------------------------------------------------------------

export interface SendCopyInput {
  rail: SendRail;
  url: string;
  /** Buyer's first name, already trimmed. Optional. */
  firstName?: string;
  /** "Half Cow" / product name — what they just agreed to. */
  itemLabel: string;
  /** Ranch / seller name. */
  sellerName?: string;
  /**
   * The buyer's DUE-NOW figure in dollars, and only ever that.
   *
   * BROKER rail: the deposit, which IS the whole charge on that rail.
   * PRODUCT rail: the price the buyer is actually charged (all-in — the BHC
   *   margin is skimmed out of it, never added on top).
   * CONNECT rail: IGNORED. See the fee note in buildSendCopy — the Connect
   *   buyer is charged deposit + service fee, and that fee is not knowable
   *   here, so this rail states no number at all.
   */
  amount?: number;
  /** Share total in dollars (BROKER only). 0/absent = don't state one. */
  total?: number;
  /** Weight-priced ceiling — presence turns every total into a RANGE. */
  totalMax?: number;
  /**
   * PRODUCT rail: this is a deposit-style listing — `amount` RESERVES the box
   * and the rancher confirms size + balance before shipping. Presenting one of
   * these as a full-price shipped purchase is the exact mis-sell
   * app/api/admin/products/route.ts warns about, so the copy branches on it
   * the same way both consoles' manual copy already does.
   */
  depositStyle?: boolean;
  /** PRODUCT deposit-style: human range for the eventual total, e.g. "$400-$600". */
  priceRange?: string;
}

export interface SendCopy {
  subject: string;
  html: string;
  text: string;
  sms: string;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function money(n: number): string {
  return `$${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Compose the operator send.
 *
 * VOICE (docs/BHC.md): lowercase subject, 2-4 words, no hype, one CTA, signed
 * "— Ben". This is a FOLLOW-UP to a conversation that happened five minutes
 * ago, not a campaign — so it opens by referencing the call and it never
 * explains the company.
 *
 * ── THE MONEY RULES, PER RAIL. Not cosmetic; each one is a specific way this
 *    email could lie to someone about to spend four figures. ──
 *
 * CONNECT — STATES NO NUMBER, DELIBERATELY.
 *   The console's mint response carries the RANCHER's pre-fee numbers
 *   (deriveDeposit(tierPrice)). What the buyer is actually charged is
 *   `deposit + round(fullSale × feeRate)` (lib/stripeConnect) — the BHC
 *   service fee rides ON TOP on this rail. Quoting the pre-fee deposit would
 *   email one number and charge a bigger one (the same bait-and-switch class
 *   an earlier audit caught on a rancher page: $500 quoted, $695 charged), and
 *   because the delta IS the fee, it would also publish BHC's rate by
 *   subtraction. The correct figure is not computable here either: the rate is
 *   a per-rancher LOCKED value resolved at checkout time, and these tokens
 *   live ~30 days, so any number baked in now can drift out of true before the
 *   buyer taps. So the Connect email names the ranch and the cut, and points
 *   at the page — which shows the exact, current, all-in figure before anyone
 *   pays. Pinned by test: Connect copy contains no '$'.
 *
 * BROKER — EXACT NUMBERS, because there is no fee on top: the deposit IS the
 *   whole charge and BHC's entire commission. But the buyer is NEVER told that
 *   split. Their total is identical either way, so how it divides is not their
 *   business, and saying it reads as a middleman fee on a call Ben just
 *   closed. Copy says: a deposit toward your share, balance to the ranch.
 *   Pinned by test — no "commission", no "fee", no "our cut", ever.
 *
 * PRODUCT — the listed price IS the charge (BHC's margin is skimmed out of it,
 *   never added), so the number is safe to state. Deposit-style listings are
 *   the exception and must say so: the amount RESERVES the box and the ranch
 *   confirms size and balance before it ships.
 */
export function buildSendCopy(input: SendCopyInput): SendCopy {
  const first = String(input.firstName || '').trim().split(/\s+/)[0] || '';
  const hi = first ? `hey ${first}` : 'hey';
  const seller = String(input.sellerName || '').trim();
  const item = String(input.itemLabel || 'your order').trim();
  const amount = Number(input.amount || 0);
  const total = Number(input.total || 0);
  const totalMax = Number(input.totalMax || 0);
  const ranged = totalMax > total && total > 0;
  const from = seller ? ` from ${seller}` : '';

  const totalPhrase = ranged
    ? `estimated ${money(total)}–${money(totalMax)} total, final price set by hanging weight`
    : total > 0
      ? `${money(total)} total`
      : '';

  let subject: string;
  let lines: string[];
  let sms: string;
  const cta = input.rail === 'product' ? 'get it →' : 'hold my share →';

  if (input.rail === 'product') {
    subject = 'your link';
    const range = String(input.priceRange || '').trim();
    if (input.depositStyle) {
      // DEPOSIT-STYLE BOX. `amount` reserves it; it is NOT the price, and the
      // buyer must not read "$X, shipped" and expect nothing further to pay.
      lines = [
        `${hi} — good talking to you.`,
        `here is the ${item}${from}.`,
        amount > 0
          ? `${money(amount)} reserves it${range ? ` (${range} depending on size)` : ''} — the ranch confirms your size and the balance with you before it ships.`
          : `the deposit reserves it${range ? ` (${range} depending on size)` : ''} — the ranch confirms your size and the balance with you before it ships.`,
      ];
      sms =
        `${hi} — Ben from BuyHalfCow. here is the ${item}${from}: ${input.url}` +
        (amount > 0
          ? ` — ${money(amount)} reserves it${range ? ` (${range} depending on size)` : ''}, they confirm your size + the balance before it ships.`
          : ` — the deposit reserves it, they confirm your size + the balance before it ships.`);
    } else {
      lines = [
        `${hi} — good talking to you.`,
        `here is the ${item}${from}${amount > 0 ? ` — ${money(amount)}, shipping included` : ''}.`,
        'tap the link, pay, and it goes out from the ranch.',
      ];
      sms =
        `${hi} — Ben from BuyHalfCow. here is the ${item}${from}: ${input.url}` +
        (amount > 0 ? ` — ${money(amount)}, shipping included.` : '.');
    }
  } else if (input.rail === 'broker') {
    subject = 'your share link';
    lines = [
      `${hi} — good talking to you.`,
      `here is your link for the ${item}${from}.`,
      amount > 0
        ? `${money(amount)} today is a deposit toward your share${totalPhrase ? ` (${totalPhrase})` : ''}, and you settle the balance directly with the ranch.`
        : 'the deposit holds your share, and you settle the balance directly with the ranch.',
      'they will reach out with pickup and cut details.',
    ];
    sms =
      `${hi} — Ben from BuyHalfCow. here is your link for the ${item}${from}: ${input.url}` +
      (amount > 0
        ? ` — ${money(amount)} today holds your share${totalPhrase ? ` (${totalPhrase})` : ''}, balance direct to the ranch.`
        : ' — the deposit holds your share, balance direct to the ranch.');
  } else {
    // CONNECT — numberless by design. See the fee note above.
    subject = 'your share link';
    lines = [
      `${hi} — good talking to you.`,
      `here is your link to lock in the ${item}${from}.`,
      'the page shows your deposit before you pay anything, and it is refundable right up until the ranch accepts.',
      'they call you after that to set pickup and cuts.',
    ];
    sms =
      `${hi} — Ben from BuyHalfCow. here is your link to lock in the ${item}${from}: ${input.url}` +
      ' — the deposit is shown before you pay, and it is refundable until they accept.';
  }

  const text = [...lines, '', input.url, '', '— Ben'].join('\n');

  const html = `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-size:13px;margin:16px 0}.raw{font-size:12px;color:#6B4F3F;word-break:break-all}.sig{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:13px;color:#6B4F3F}</style>
</head><body><div class="container">
${lines.map((l) => `  <p>${esc(l)}</p>`).join('\n')}
  <p style="text-align:center;"><a href="${esc(input.url)}" class="cta">${esc(cta)}</a></p>
  <p class="raw">or paste this: ${esc(input.url)}</p>
  <div class="sig"><p>— Ben<br>BuyHalfCow</p></div>
</div></body></html>`;

  return { subject, html, text, sms };
}

// ---------------------------------------------------------------------------
// Channel classification.
// ---------------------------------------------------------------------------

/** The `{success, suppressed?, reason?}` contract every lib/email.ts sender returns. */
export interface GuardedSendResult {
  success: boolean;
  suppressed?: boolean;
  reason?: string;
}

/**
 * Turn a guardedSend result into an outcome.
 *
 * THE BUG THIS FUNCTION IS: `success:false, suppressed:true` is the shape a
 * blocked send returns — unsubscribed, hard-bounced, complained, or
 * frequency-capped. Treating it as anything but "the buyer did NOT get this"
 * is how a console reports a green check on an email that never left. The
 * sibling broker-rail bug being fixed in parallel is exactly this.
 */
export function classifyEmailResult(res: GuardedSendResult | null | undefined): ChannelOutcome {
  if (!res) return { state: 'failed', reason: 'no result from the mailer' };
  if (res.success) return { state: 'delivered', reason: '' };
  if (res.suppressed) {
    return { state: 'suppressed', reason: res.reason || 'unsubscribed, bounced or complained' };
  }
  return { state: 'failed', reason: res.reason || 'the mailer refused it' };
}

/**
 * Whether a FAILED send is worth one more immediate attempt.
 *
 * Retry the shapes that are about the wire — a socket died, a gateway
 * hiccuped, a request timed out. NEVER retry a suppression, a hard bounce, an
 * invalid address or an auth/validation refusal: those are terminal, and
 * re-firing them burns sender reputation on a recipient the system has already
 * been told to leave alone.
 *
 * Bounded to ONE extra attempt by the caller. There is no loop here — an
 * unbounded retry inside a request is how a phone call turns into a 30-second
 * spinner while Ben is talking.
 */
export function isRetryableFailure(o: ChannelOutcome): boolean {
  if (o.state !== 'failed') return false;
  const r = (o.reason || '').toLowerCase();
  if (!r) return false;
  // Terminal first — a message can contain both words, and terminal wins.
  if (/(suppress|unsubscrib|bounce|complain|invalid|not a valid|forbidden|unauthor|validation|blocked)/.test(r)) {
    return false;
  }
  return /(timeout|timed ?out|econn|enotfound|eai_again|socket|network|fetch failed|temporarily|try again|rate.?limit|429|50[0234]|bad gateway|service unavailable)/.test(r);
}

export interface SmsGateInput {
  /** smsEnabled() — the platform-wide ENABLE_SMS master gate. */
  enabled: boolean;
  /** The Consumers record, or null when the buyer has no row yet. */
  consumer: Record<string, any> | null | undefined;
}

export type SmsGateResult =
  | { ok: true; to: string }
  | { ok: false; outcome: ChannelOutcome };

/**
 * Decide, WITHOUT sending, whether an SMS can go — and say precisely why not.
 *
 * This mirrors (never replaces) the gates inside lib/twilio.sendSMSToConsumer,
 * which stays the only thing that actually fires. The duplication is the whole
 * point: sendSMSToConsumer collapses every refusal to `false`, so a console
 * built on it can only ever say "didn't send" with no reason. Reading the same
 * conditions here lets the outcome name itself, and the real gate still runs
 * underneath — so a future loosening here cannot leak an SMS past TCPA.
 *
 * ENABLE_SMS is checked FIRST and reported as its own state, because that is
 * the honest answer platform-wide: the flag defaults OFF, so on today's deploy
 * every SMS outcome is 'channel-disabled'. The console must say so before the
 * tap, not after.
 */
export function resolveSmsGate(input: SmsGateInput): SmsGateResult {
  if (!input.enabled) {
    return {
      ok: false,
      outcome: { state: 'channel-disabled', reason: 'sms is off platform-wide (ENABLE_SMS)' },
    };
  }
  const c = input.consumer;
  if (c && c['Unsubscribed'] === true) {
    return { ok: false, outcome: { state: 'no-consent', reason: 'this buyer is unsubscribed' } };
  }
  if (!c || c['SMS Opt-In'] !== true) {
    return {
      ok: false,
      outcome: { state: 'no-consent', reason: 'no sms opt-in on file (TCPA) — email or text from your phone' },
    };
  }
  // THE NUMBER COMES OFF THE CONSENTED RECORD, FULL STOP. An operator-supplied
  // override used to be accepted here, and lib/twilio checks consent against
  // the RECORD — so a hand-crafted request could have texted an arbitrary
  // number under someone else's TCPA opt-in. Latent (the UI never sent one,
  // and ENABLE_SMS is off) but it had to close before that flag is ever
  // flipped. Same binding rule as the email side: the link, the consent and
  // the destination all name one buyer.
  const to = String(c['Phone'] || '').trim();
  if (!to) {
    return { ok: false, outcome: { state: 'no-destination', reason: 'no phone number on file' } };
  }
  return { ok: true, to };
}

// ---------------------------------------------------------------------------
// Idempotency.
// ---------------------------------------------------------------------------

/**
 * The once-only claim key for one (buyer, link, channel) send.
 *
 * Keyed on the LINK, not on the rancher+cut: two taps on the same button mint
 * the same URL for the same buyer, so the URL is the natural identity of "this
 * send". A DIFFERENT cut, a different ranch, or a re-mint after a real failure
 * all produce a different token and therefore a different key — Ben can always
 * send again on purpose, he just cannot send twice by accident.
 *
 * Channel-scoped so a delivered email never blocks the SMS beside it.
 *
 * Recipient-scoped too: the same link mailed to a corrected address is a new
 * send, not a duplicate (a typo'd email on a live call is a normal event).
 */
export function sendClaimKey(input: {
  url: string;
  channel: 'email' | 'sms';
  recipient: string;
}): string {
  const url = String(input.url || '').trim();
  const recipient = String(input.recipient || '').trim().toLowerCase();
  // Tokens are long; the tail is the entropy-bearing part and Redis keys are
  // cheaper short. Keep enough to be collision-free in practice.
  const linkPart = url.length > 80 ? url.slice(-80) : url;
  return `operator-send:${input.channel}:${recipient}:${linkPart}`;
}

/**
 * The companion "this one actually went out" marker.
 *
 * TWO KEYS, NOT ONE — and this is the fix for the worst failure this rail can
 * have. With a single claim taken before the send and never released, a FAILED
 * send left its claim behind; the operator's retry then lost the claim and got
 * reported as "already sent", green, reached, and stamped, for mail that never
 * left. That is precisely the sibling broker-rail bug (#624).
 *
 * So the claim is now released on every non-delivery (a retry genuinely
 * retries), and 'already-sent' is only ever reported when THIS marker proves a
 * previous attempt delivered under that claim. A lost claim with no marker
 * means another attempt is still in flight or already failed — reported as a
 * failure, because as far as this request can prove, the buyer has nothing.
 */
export function sendDeliveredKey(claimKey: string): string {
  return `${claimKey}:done`;
}

/** Window in which a repeat tap counts as the SAME send. */
export const SEND_CLAIM_TTL_SEC = 180;

// ---------------------------------------------------------------------------
// Orchestration — injected effects, so the whole rail is testable offline.
// ---------------------------------------------------------------------------

export interface DeliverInput {
  target: SendTarget;
  copy: SendCopy;
  /** Buyer email. '' means the email channel has no destination. */
  email: string;
  /** Channels the operator picked. */
  wantEmail: boolean;
  wantSms: boolean;
  sms: SmsGateInput;
}

export interface DeliverDeps {
  /** guardedSend-backed mailer. Resolves the {success,suppressed,reason} shape. */
  sendEmail: (args: { to: string; copy: SendCopy; consumerId: string }) => Promise<GuardedSendResult>;
  /** Consent-gated SMS. Returns false for every refusal, like lib/twilio. */
  sendSms: (args: { to: string; body: string; consumer: Record<string, any> | null | undefined }) => Promise<boolean>;
  /** claimOnce — true when THIS caller won the claim. Degrades OPEN. */
  claim: (key: string, ttlSec: number) => Promise<boolean>;
  /** releaseClaim — free a claim whose send did NOT reach the buyer. */
  release: (key: string) => Promise<void>;
  /** claimExists — pure read: did a previous attempt mark a real delivery? */
  wasDelivered: (key: string) => Promise<boolean>;
  /** Persist the send on the buyer's record. Never throws; never blocks. */
  stamp: (args: { consumerId: string; at: string }) => Promise<void>;
  now?: () => Date;
}

export interface DeliverResult {
  email: ChannelOutcome;
  sms: ChannelOutcome;
  reached: boolean;
  loud: boolean;
  /** True when a Consumers stamp was written (money/comms truth persisted). */
  stamped: boolean;
}

const NOT_REQUESTED: ChannelOutcome = { state: 'not-requested', reason: '' };

/**
 * Deliver one minted link on the operator's chosen channels and report the
 * TRUTH for each.
 *
 * Order of operations per channel, and why:
 *   1. gate    — a channel that cannot send says so without touching a wire.
 *   2. claim   — a double-tap loses the claim and reports 'already-sent'. The
 *                claim is taken BEFORE the send, which is the only ordering
 *                that can prevent a second delivery; the cost is that a
 *                crashed send holds the claim for the (short) TTL, which is
 *                the right trade for a buyer's inbox.
 *   3. send    — once, plus at most ONE retry, and only for wire-shaped
 *                failures (isRetryableFailure).
 *   4. stamp   — only if something actually reached the buyer. Stamping a
 *                failed send would tell the marketing rails to back off from a
 *                buyer who was never contacted.
 *
 * Never throws. A thrown transport becomes a 'failed' outcome carrying its
 * message, because the caller still owes Ben the link for manual fallback.
 */
export async function deliverOperatorSend(
  input: DeliverInput,
  deps: DeliverDeps,
): Promise<DeliverResult> {
  const now = deps.now || (() => new Date());

  // ── EMAIL ────────────────────────────────────────────────────────────────
  let email: ChannelOutcome = NOT_REQUESTED;
  if (input.wantEmail) {
    const to = String(input.email || '').trim();
    if (!to.includes('@')) {
      email = { state: 'no-destination', reason: 'no email address' };
    } else {
      email = await guardedChannel(
        deps,
        sendClaimKey({ url: input.target.url, channel: 'email', recipient: to }),
        'already sent to this address moments ago',
        () =>
          deps
            .sendEmail({ to, copy: input.copy, consumerId: input.target.consumerId })
            .then(classifyEmailResult)
            .catch((e: any) => ({
              state: 'failed' as const,
              reason: String(e?.message || e || 'the mailer threw').slice(0, 200),
            })),
      );
    }
  }

  // ── SMS ──────────────────────────────────────────────────────────────────
  let sms: ChannelOutcome = NOT_REQUESTED;
  if (input.wantSms) {
    const gate = resolveSmsGate(input.sms);
    if (!gate.ok) {
      sms = gate.outcome;
    } else {
      sms = await guardedChannel(
        deps,
        sendClaimKey({ url: input.target.url, channel: 'sms', recipient: gate.to }),
        'already texted to this number moments ago',
        () =>
          deps
            .sendSms({ to: gate.to, body: input.copy.sms, consumer: input.sms.consumer })
            .then((ok): ChannelOutcome =>
              ok
                ? { state: 'delivered', reason: '' }
                : { state: 'failed', reason: 'the sms provider refused it' },
            )
            .catch((e: any) => ({
              state: 'failed' as const,
              reason: String(e?.message || e || 'the sms provider threw').slice(0, 200),
            })),
      );
    }
  }

  const { reached, loud } = summarizeSend([email, sms]);

  // MONEY/COMMS TRUTH GETS PERSISTED (repo hard rule #2). The Email Sends row
  // is written inside guardedSend for every email outcome; this is the BUYER-
  // side stamp, and it is written only when the buyer was actually reached.
  let stamped = false;
  if (reached && input.target.consumerId) {
    try {
      await deps.stamp({ consumerId: input.target.consumerId, at: now().toISOString() });
      stamped = true;
    } catch {
      // A stamp failure must never turn a real delivery into a reported
      // failure — the buyer has the link either way.
    }
  }

  return { email, sms, reached, loud, stamped };
}

/**
 * Run ONE channel under the two-key idempotency scheme.
 *
 *   claim won  → send (with at most one retry). Delivered: leave the claim AND
 *                write the delivered marker. Anything else: RELEASE the claim,
 *                so the operator's next tap is a real retry rather than a
 *                fabricated "already sent".
 *   claim lost → someone else holds it. Only the marker can say whether that
 *                someone succeeded. Marker present → 'already-sent' (true).
 *                Marker absent → in flight or already failed, which this
 *                request cannot report as reached without guessing.
 */
async function guardedChannel(
  deps: DeliverDeps,
  key: string,
  alreadyReason: string,
  run: () => Promise<ChannelOutcome>,
): Promise<ChannelOutcome> {
  const doneKey = sendDeliveredKey(key);
  // claimOnce degrades OPEN, and so does a thrown claim: never block a send
  // Ben asked for because Redis is having a day.
  const won = await deps.claim(key, SEND_CLAIM_TTL_SEC).catch(() => true);
  if (!won) {
    const delivered = await deps.wasDelivered(doneKey).catch(() => false);
    return delivered
      ? { state: 'already-sent', reason: alreadyReason }
      : {
          state: 'failed',
          reason: 'another send for this link is already in flight — give it a moment, then send again',
        };
  }

  const outcome = await attempt(run);
  if (outcome.state === 'delivered') {
    await deps.claim(doneKey, SEND_CLAIM_TTL_SEC).catch(() => false);
  } else {
    await deps.release(key).catch(() => {});
  }
  return outcome;
}

/** One send, plus at most one retry for wire-shaped failures. */
async function attempt(run: () => Promise<ChannelOutcome>): Promise<ChannelOutcome> {
  const first = await run();
  if (!isRetryableFailure(first)) return first;
  const second = await run();
  // Report the SECOND attempt — but keep the first reason when the retry came
  // back with nothing useful, so the operator sees a cause either way.
  if (second.state === 'failed' && !second.reason) return first;
  return second;
}
