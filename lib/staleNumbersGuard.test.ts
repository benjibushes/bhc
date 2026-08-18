// lib/staleNumbersGuard.test.ts
//
// Wave B "stats-truth" sweep (2026-08-17): source guards for stale
// buyer/backer-visible numbers that live outside the stats/tier modules.
//
//  • lib/email.ts claimed "buying a Quarter is $1,500–$2,000" while the live
//    network's quarters ranged $740–$2,200 (5 of 12 priced quarters at or
//    below $1,290) — the templates were talking buyers out of purchases they
//    could afford. Rule: buyer email templates assert NO dollar range for
//    shares. Quote weights; the rancher's page is the only price truth.
//
//  • The Telegram operator bot's system prompt was grounded in the dead
//    2026-Q1 model (flat 10% rancher-pays commission, 24-month term,
//    invitation-only, frozen "~245 consumers / ~26 ranchers / ~80 referrals"
//    pipeline). Rule: the prompt asserts no pipeline counts and none of the
//    dead-model claims — the bot has live data commands and must look counts
//    up. (The legacy-rail email footers deeper in the same file still say
//    "10% commission" — that is the real legacy-rancher rate and is NOT
//    covered by this guard.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('share-price ranges are gone from the buyer email templates', () => {
  const src = read('./email.ts');
  assert.doesNotMatch(src, /1,500\s*[–—-]\s*\$?2,000/);
  assert.doesNotMatch(src, /\$1,500/);
});

test('telegram operator prompt asserts neither the dead business model nor frozen pipeline counts', () => {
  const src = read('../app/api/webhooks/telegram/route.ts');
  assert.doesNotMatch(src, /24-month/);
  assert.doesNotMatch(src, /invitation-only/);
  assert.doesNotMatch(src, /~245|~26 ranchers|~80 referrals/);
  assert.doesNotMatch(src, /ranchers pay Ben 10% commission/);
  assert.doesNotMatch(src, /earns a 10% commission/);
  // The prompt must instruct the model to look pipeline numbers up live.
  assert.match(src, /NEVER assert counts from memory/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAIGN REWRITE (2026-08-18) — source pins for the fleet's copy surgery.
// Each pin below guards a specific truth fix the campaign-perfection fleet
// shipped: a restored old line must turn the suite red.
// ═══════════════════════════════════════════════════════════════════════════

// ── buyer auto-reply templates: weights-only, prices defer to the ranch page ─
test('buyer reply templates quote no dollar figures and no middleman-markup claim', () => {
  const src = stripComments(read('./buyerReplyTemplates.ts'));
  // The machine must never quote a price a ranch didn't set. $-digit literals
  // (the old "$1,000 to $1,400" / "$7 to $9 a pound" anchors) are banned in
  // this file outright — weights come from SHARE_WEIGHTS, prices from the
  // ranch's own page.
  assert.doesNotMatch(src, /\$\d/, 'buyerReplyTemplates quotes a dollar figure');
  assert.doesNotMatch(src, /1,000|1,400/);
  assert.doesNotMatch(src, /no middleman markup/i, 'collides with buyer-pays-on-top on Connect');
  // Weights must ride the ONE truth table, not inline numbers.
  assert.match(src, /import \{ SHARE_WEIGHTS \} from '\.\/beefWeights'/);
  assert.match(src, /SHARE_WEIGHTS\.half\.cuFt/, 'capacity answer must use the canonical cu-ft figure');
  assert.doesNotMatch(src, /four cubic feet/, 'contradicted lib/beefWeights (~6–8 cu ft for a half)');
  assert.doesNotMatch(src, /fills a normal freezer shelf/, 'a half is ~170 lbs — chest freezer territory');
});

// ── reach-out clock promises: forbidden in buyer-bound templates ─────────────
// The fleet's #1 systemic finding: "reach out within 24–48 hours" promises
// with no machine behind the clock — structurally false on the broker rail
// (a represented ranch never reaches out) and cron-unbacked on Connect.
// Every survivor below is allowlisted WITH the machine (or rail) that backs
// it; any new/restored clock promise outside the allowlist fails here.
// Copy-tails widen (2026-08-18): the original regex only saw "reach out" /
// "hear back from us" phrasings, which let two clock promises walk past it —
// sendPartnerConfirmation ("You'll hear from me within 24-48 hours") and
// sendRerouteNotification ("This usually takes 24-48 hours"). Now also
// catches the "hear (back) from me/us" and bare "within/takes 24-48 hours"
// families. Deliberately NOT matched: "24-48 hrs" thaw instructions (no
// "hours", no promise verb) and the "if you don't hear back within 48
// hours, reply" escape hatches (no "from us/me", no 24-48 pair).
const REACHOUT_CLOCK = new RegExp(
  [
    // verb-anchored: a reach-out / hear-from promise with a 24/48h clock
    /(?:reach(?:es|ing)?\s+out|hear\s+(?:back\s+)?from\s+(?:us|me))[^.]{0,80}?\b(?:24|48)\b[^.]{0,15}hours?/.source,
    // bare clock: "within/takes 24-48 hours" is a promise with no verb needed
    /\b(?:within|takes)\b[^.]{0,20}?\b24\s*(?:[-–—]|to)\s*48\s*hours?/.source,
  ].join('|'),
  'i',
);
const REACHOUT_ALLOWLIST: Record<string, string> = {
  // Signup ack: consumers auto-approve at POST time and the welcome rail
  // fires within minutes — the 24h "hear back" is machine-kept trivially.
  sendConsumerConfirmation: 'auto-approval + welcome fire at signup time',
  // Post-YES launch warmup: rail-aware since #639 — the broker branch swaps
  // the promise line for deposit-first truth; the Connect branch's intro is
  // chased by the referral-chasup cron when the rancher goes quiet.
  sendRancherLaunchWarmup: 'broker branch swaps the line; referral-chasup chases Connect intros',
  // Live Connect intro (rancher contact info in hand): the warm-handoff
  // expectation block; referral-chasup chases, and the email itself carries
  // the 48h reply-to-Ben escape hatch.
  sendBuyerIntroNotification: 'referral-chasup cron + in-email escape hatch',
  // Backer-bound (not the buyer purchase funnel): Title Founder white-glove
  // promise Ben keeps by hand — v55 kept it deliberately.
  sendFoundingHerdWelcome: 'Title Founder white-glove; kept by v55',
  // B2B wholesale ack — Ben personally works these.
  sendWholesaleConfirmation: 'operator-handled B2B lane',
  // Rancher-bound claim flow — Ben's own onboarding promise.
  sendProspectClaimMagicLink: 'rancher-bound; Ben-run onboarding',
  // Partner-application ack ("You'll hear from me within 24-48 hours"):
  // Ben-personal, NOT machine-backed — he manually reviews every partner
  // application and replies himself, and this is a promise he does keep.
  // Caught by the copy-tails regex widen (2026-08-18); kept deliberately.
  sendPartnerConfirmation: 'Ben-personal promise — he hand-reviews every partner application',
};

// Comments legitimately QUOTE the struck lines (that's how the fixes are
// documented at the fix site), so every scan below runs on comment-stripped
// source: block comments (incl. the ${''/* … */} inline-doc idiom inside
// template literals) and comment-only lines go; `//` inside URLs on code
// lines survives because only whole-line comments are dropped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function functionBlocks(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /export async function (\w+)/g;
  let m: RegExpExecArray | null;
  const marks: Array<{ name: string; idx: number }> = [];
  while ((m = re.exec(src))) marks.push({ name: m[1], idx: m.index });
  for (let i = 0; i < marks.length; i++) {
    out.push({
      name: marks[i].name,
      body: src.slice(marks[i].idx, i + 1 < marks.length ? marks[i + 1].idx : src.length),
    });
  }
  return out;
}

test('no unbacked reach-out clock promise in any email template (allowlist = machine-backed)', () => {
  for (const file of ['./email.ts', './emailMinimal.ts']) {
    const src = stripComments(read(file));
    for (const fn of functionBlocks(src)) {
      if (REACHOUT_CLOCK.test(fn.body)) {
        assert.ok(
          REACHOUT_ALLOWLIST[fn.name],
          `${file} ${fn.name} promises a reach-out clock with no machine behind it — ` +
            `rail-false on broker, cron-unbacked on Connect. Fix the copy or allowlist WITH the backing machine.`,
        );
      }
    }
  }
});

// ── the specific false-promise lines the fleet struck: none may return ───────
test('struck false-promise and stale-copy lines stay dead (lib/email.ts)', () => {
  const src = stripComments(read('./email.ts'));
  const struck: Array<[RegExp, string]> = [
    [/They'll reach out within 24[–-]48 hours/, 'welcome-family rail-false reach-out promise (v21 family)'],
    [/Direct contact info<\/strong> — name, email, phone/, 'broker rail withholds contact info by design (v21)'],
    [/you started reserving a beef share/, 'WAITING pool never started a reservation (v5)'],
    [/their fall harvest/, 'hardcoded season, false most of the year (v20)'],
    [/send rancher info within 24 hours/, 'rail-false + wrong-direction clock (v20)'],
    [/full info within 24 hours/, 'rail-false + wrong-direction clock (v43)'],
    [/funds the recruiting team/, 'there is no team — founder-led (v46)'],
    [/share spot is still held/, 'no hold exists for an unrouted WAITING buyer (v45)'],
    [/starting at \$13/, 'hardcoded shop price — pages carry prices (v45/v32)'],
    [/first-print/, 'hyphen rule (v55) — "first print"'],
    [/co-build access/, 'hyphen rule (v55) — "build access"'],
    [/getting in at the price the next/, 'manufactured scarcity — the F100 cap is forever (v55)'],
    [/\$\{dollars\} a year toward/, 'Herd sells monthly AND annual — cadence-unsafe money line (v55)'],
    [/still want buyers from us/, 'warm reactivation tier never got a buyer — false history (v52)'],
    [/buyers in the pipeline looking for ranchers like you/, 'vendor-vague, skirts never-promise-leads (v53)'],
    [/Processing facility tours/, 'rolling unverifiable founder-letter claim (v47)'],
    [/Active conversations with ranchers in your area/, 'rolling unverifiable founder-letter claim (v47)'],
    [/\$7\/lb instead of \$4\/lb/, 'hardcoded price framing (v50)'],
    [/are searching BuyHalfCow for a half or whole cow right now/, 'unverifiable live-demand claim (v50)'],
    [/a smaller freezer-full/, 'hyphen rule (v32) — subject is "a smaller way to start"'],
    [/w\/ a small platform/, 'voice fix (v11) — "with a small outfit"'],
  ];
  for (const [re, why] of struck) {
    assert.doesNotMatch(src, re, `struck line returned: ${why}`);
  }
});

test('struck lines stay dead (emailMinimal / demandRouter / productRecovery / abandoned-quiz-nudge / quick-action)', () => {
  const minimal = stripComments(read('./emailMinimal.ts'));
  assert.doesNotMatch(minimal, /will reach out within 24[–-]48 hours/, 'deposit-invite passive reach-out promise (v22)');

  const router = stripComments(read('./demandRouter.ts'));
  assert.doesNotMatch(router, /cold-chain/, 'hyphen rule (v2) — "cold chain the whole way"');
  assert.doesNotMatch(router, /your beef.s ready/i, 'Msg1 order-status open-bait subject (v2)');
  assert.doesNotMatch(router, /going fast and we don't want you to miss out/, 'forbidden fake-urgency family (v3)');

  const recovery = stripComments(read('./productRecovery.ts'));
  assert.doesNotMatch(recovery, /best price per pound/, 'sell-on-savings superlative, unverifiable (v35)');
  assert.doesNotMatch(recovery, /here's the freezer-fill/, 'hyphen rule (v35) — "the freezer fill is next"');

  const quizNudge = stripComments(read('../app/api/cron/abandoned-quiz-nudge/route.ts'));
  assert.doesNotMatch(quizNudge, /60-second|Sixty seconds/, 'quiz-length standardized on 90 seconds (v4)');
  assert.match(quizNudge, /90 second/, 'the canonical quiz-length claim');

  const quickAction = stripComments(read('../app/api/rancher/quick-action/route.ts'));
  assert.doesNotMatch(quickAction, /a 10% commission invoice/, 'confirm page must quote the derived rate (F15 rider)');
  assert.match(quickAction, /commissionPercentLabelForRancher/, 'derived label wired');
});

// ── F15 riders: the two rancher-facing footers derive the commission rate ────
test('inquiry/contact footers derive the commission percent — never a hardcoded 10%', () => {
  const src = stripComments(read('./email.ts'));
  const blocks = functionBlocks(src);
  for (const name of ['sendInquiryToRancher', 'sendTrackedContactEmail']) {
    const fn = blocks.find((b) => b.name === name);
    assert.ok(fn, `${name} missing from lib/email.ts`);
    assert.match(fn!.body, /commissionPercentLabelForRancher/, `${name} footer must derive the rate`);
    assert.doesNotMatch(fn!.body, /our 10%/, `${name} footer hardcodes 10%`);
  }
});

// ── swapped templates: no literal dollar-digit — every $ is derived ──────────
test('swapped templates carry no literal $-figures (derived values only)', () => {
  const src = stripComments(read('./email.ts'));
  const blocks = functionBlocks(src);
  for (const name of [
    'sendNoBudgetFounderPitch',
    'sendLossRecoveryDownsell',
    'sendNurtureShopBridge',
    'sendNurtureEducation',
    'sendFoundingHerdWelcome',
    'sendRancherOnboardingDripDay5',
    'sendWelcomeAndReadyToBuy',
    'sendWarmLeadReadyCheck',
    'sendMatchNowRescue',
    'sendNudgeToEngage',
    'sendFounderLetterWaiting',
  ]) {
    const fn = blocks.find((b) => b.name === name);
    assert.ok(fn, `${name} missing from lib/email.ts`);
    assert.doesNotMatch(fn!.body, /\$\d/, `${name} hardcodes a dollar figure — derive it or drop it`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// COPY TAILS (2026-08-18) — follow-ups from the #645 review notes.
// ═══════════════════════════════════════════════════════════════════════════

// ── quiz-length canon: 90 seconds (docs/BHC.md CTA library) ─────────────────
// #645 standardized the abandoned-quiz nudge on 90 seconds (v4) but left
// 60-second claims on sibling surfaces: sendQuizInvite subject+body,
// resend-link, the manychat closer prompt (×4), the SMS quiz invite, and
// abandoned-recovery stage 1. One number everywhere a send or prompt can
// claim it — this scan keeps every send-capable file at 90.
const SIXTY_SECOND = /\b(?:60|sixty)(?:[-\s]?sec(?:ond)?s?|s)\b/i;
test('no 60-second quiz claims in send-capable code — canon is 90 (docs/BHC.md)', () => {
  const files = [
    './email.ts',
    './emailMinimal.ts',
    './smsEvents.ts',
    './buyerReplyTemplates.ts',
    './demandRouter.ts',
    './productRecovery.ts',
    './requalifyCampaign.ts',
    '../app/api/qualify/resend-link/route.ts',
    '../app/api/webhooks/manychat/route.ts',
    '../app/api/cron/abandoned-quiz-nudge/route.ts',
  ];
  for (const f of files) {
    assert.doesNotMatch(
      stripComments(read(f)),
      SIXTY_SECOND,
      `${f} carries a 60-second claim — the quiz is 90 seconds (docs/BHC.md CTA library)`,
    );
  }
  // The two primary quiz surfaces must carry the canonical number, not just
  // lack the stale one.
  assert.match(stripComments(read('./email.ts')), /90-second match quiz/);
  assert.match(stripComments(read('../app/api/qualify/resend-link/route.ts')), /90-second qualification quiz/);
});

// ── count-interpolation grammar: 1 renders singular ─────────────────────────
// The #645 Day-2 drip demand line rendered "1 families in AZ have asked us"
// at count 1. The template must carry an n===1 branch ("1 family … has").
test('day-2 drip demand line has a grammatical singular at count 1', () => {
  const src = stripComments(read('./email.ts'));
  const fn = functionBlocks(src).find((b) => b.name === 'sendRancherOnboardingDripDay2');
  assert.ok(fn, 'sendRancherOnboardingDripDay2 missing from lib/email.ts');
  assert.match(
    fn!.body,
    /1 family in \$\{esc\(data\.state\)\} has asked us/,
    'singular branch missing — count 1 must render "1 family … has asked", not "1 families … have"',
  );
});
