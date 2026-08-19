// app/publicCopy.pins.test.ts
//
// SOURCE PINS — no buyer-facing surface may claim BHC adds no markup.
//
// WHAT THIS KILLS (live post-launch audit, 2026-08-18): 101 ad-bound public
// pages carried "no marketplace markup" — the 50 /half-a-cow/[state] hero
// subheads, the 51 /access/[state] SERP descriptions and the /access layout
// description. The claim is false on every rail we run:
//
//   • share deposit (Connect) — the buyer is charged deposit + the platform
//     fee ON TOP (`application_fee_amount`, up to 10% by tier). The fee is
//     not even itemized: lib/stripeConnect bakes it into ONE line item by
//     founder directive, so the buyer sees a bigger number, never a "fee".
//   • product (Connect)       — docs/BUSINESS-MODEL.md calls BHC's cut on
//     this rail literally "the markup".
//   • broker                  — the buyer's total is unchanged, so no markup
//     there, but one true rail does not make the claim true on the page a
//     Connect buyer actually lands on.
//
// The repo's own ground truth contradicted the pages: lib/tiers.ts says "the
// buyer pays our 10% on top", and a comment ~50 lines above the /half-a-cow
// subhead already said the buyer's card is charged "the deposit PLUS the
// platform fee on the full price".
//
// WHAT SURVIVED, and why: "no middleman" is TRUE and stays. The buyer is
// matched to a named ranch, talks to it before committing, and pays the
// balance to that ranch directly at final weight. Nobody buys the beef and
// resells it. So the fix deletes the money claim and keeps the relationship
// claim.
//
// ── 2026-08-18, SECOND PASS — why there are now TWO scans ───────────────────
// The first version of this pin scanned an OPT-IN list (BUYER_FACING) and
// nothing else, so it went green while three live surfaces still carried the
// exact claim it exists to kill:
//
//   1. app/half-a-cow/page.tsx — the OpenGraph description of the HUB page
//      that fronts all 50 state ad pages. The regex below MATCHES that
//      string; the file simply was not on the list.
//   2. lib/email.ts sendConsumerApproval — a live email to every approved
//      beef buyer ("You purchase directly from the rancher at their price.
//      No middlemen, no markup."). Emails were not scanned AT ALL.
//   3. docs/BHC.md — the copy bible. Its verbatim press one-liner ("Real
//      beef, no middleman, no markup on your meat") is the ROOT: it is the
//      single source of truth the marketing skill generates every new asset
//      from, so an opt-in page scan would keep mowing regrowth forever.
//
// A pin that certifies an incomplete sweep is worse than no pin, so the scan
// is now EXHAUSTIVE (every .ts/.tsx/.js/.jsx under app/ and lib/, plus the
// copy bible) with a short, justified exemption list. New files are covered
// by default; nobody has to remember to add them. BUYER_FACING survives as
// the named-surface enumeration: it gives a buyer-specific failure message,
// and CHECKED_PATHS_EXIST catches a rename that would silently drop a page.
//
// NOT COVERED — app/sell/page.tsx, deliberately. That page is the RANCHER
// pitch, and "no middleman markup" is true from the rancher's side under the
// locked money model (docs/BUSINESS-MODEL.md: the rancher keeps 100% of their
// price; BHC's fee is added to the buyer on top, never skimmed off the
// rancher). The phrase is only a lie when a BUYER reads it, so the exhaustive
// scan exempts that ONE file — with one exception below: the exact string
// "marketplace markup" is banned repo-wide, because there is no audience and
// no rail for which THAT one is true.
//
// Test files are also skipped: several legitimately quote the struck claim as
// a fixture or as their own doesNotMatch guard (lib/staleNumbersGuard.test.ts
// pins buyerReplyTemplates against it). Tests are not shipped copy.
//
// NOTE on placement: this file deliberately lives at app/ root, not inside
// app/access/[state]/ or app/half-a-cow/[state]/. The npm test glob is
// 'app/**/*.test.ts' and a literal `[state]` path segment reads as a glob
// character class, so a test inside one is silently never collected (the
// 2026-08-02 missing-tests landmine).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(APP, '..');
const SELF = fileURLToPath(import.meta.url);
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// Comments legitimately quote the struck lines (that is how a fix documents
// itself at the fix site — see the /half-a-cow subhead), so every scan below
// runs on comment-stripped source.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Named buyer-facing surfaces — the pages and email templates that carried the
 * claim, or that sell the money story hard enough to regrow it. This list does
 * NOT have to be exhaustive any more (the exhaustive scan below is the
 * completeness guarantee); it exists so the common case fails with a
 * buyer-specific message, and so a rename cannot quietly drop a known surface.
 */
const BUYER_FACING = [
  // ── pages ──
  'app/page.tsx',
  'app/components/FullHomepage.tsx',
  'app/access/page.tsx',
  'app/access/layout.tsx',
  'app/access/[state]/page.tsx',
  'app/half-a-cow/page.tsx', // the HUB fronting all 50 state ad pages — was missing
  'app/half-a-cow/[state]/page.tsx',
  'app/guide/page.tsx',
  'app/about/page.tsx',
  'app/r/[code]/page.tsx',
  'app/shop/page.tsx',
  'app/shop/[id]/page.tsx',
  'app/map/page.tsx',
  'app/faq/page.tsx',
  'app/promise/page.tsx',
  'app/matched/page.tsx',
  'app/marketplace/page.tsx',
  'app/ranchers/page.tsx',
  'app/ranchers/[slug]/page.tsx',
  'app/checkout/[refId]/deposit/page.tsx',
  'app/checkout/[refId]/broker/page.tsx',
  'app/qualify/page.tsx',
  'app/links/page.tsx',
  // ── email templates (buyer-addressed copy) ──
  'lib/email.ts', // sendConsumerApproval carried it to every approved buyer
  'lib/emailMinimal.ts',
  'lib/emailStreams.ts',
  'lib/nurtureDrip.ts',
  'lib/buyerReplyTemplates.ts',
  'lib/depositRequestNudge.ts',
  'lib/brokerNotify.ts',
  'lib/productSettlement.ts',
  'lib/ranchStandDigest.ts',
];

/**
 * The RANCHER pitch, where "no middleman markup" is true (they keep 100% of
 * their price). Exempt from the exhaustive scan, never from the repo-wide
 * "marketplace markup" ban. Adding to this list is a money-model claim —
 * justify it against docs/BUSINESS-MODEL.md or do not add it.
 */
const RANCHER_FACING_EXEMPT = ['app/sell/page.tsx'];

/** The copy bible the marketing skill generates every new asset from. */
const COPY_SOURCE_DOCS = ['docs/BHC.md'];

/**
 * Any claim that BHC adds no markup / takes no cut off the top. Matches the
 * whole family, not just the two exact strings the audit found:
 *   "no marketplace markup" · "No middleman markup." · "no middleman markups"
 *   "never a markup on your beef" · "zero markup" · "without any markup"
 */
const NO_MARKUP_CLAIM =
  /\b(?:no|never|zero|without)\b[^.<>]{0,40}\bmark[- ]?ups?\b|\bmark[- ]?up\b[^.<>]{0,25}\b(?:on your beef|on the beef)\b/i;

const FAILURE_NOTE =
  `Connect charges the buyer the platform fee ON TOP (lib/tiers.ts: "the buyer pays ` +
  `our 10% on top"). Delete the money claim; "no middleman" is the true half.`;

/**
 * Scan one file's shipped copy. Reads the WHITESPACE-COLLAPSED source, not
 * line by line: JSX wraps prose mid-claim ("no\n  marketplace markup") and a
 * per-line scan walked straight past both /half-a-cow subheads and /r/[code].
 */
function claimsIn(rel: string, src: string): string[] {
  const flat = stripComments(src).replace(/\s+/g, ' ');
  return [...flat.matchAll(new RegExp(NO_MARKUP_CLAIM, 'gi'))].map(
    (m) => `${rel}: …${flat.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).trim()}…`,
  );
}

function walkSource(dir: string, visit: (full: string) => void) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkSource(full, visit);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
    visit(full);
  }
}

test('PIN: every named buyer-facing surface exists (a rename must not drop coverage)', () => {
  const missing = [...BUYER_FACING, ...RANCHER_FACING_EXEMPT, ...COPY_SOURCE_DOCS].filter(
    (rel) => !existsSync(path.join(ROOT, rel)),
  );
  assert.deepEqual(
    missing,
    [],
    `a pinned copy surface moved or was deleted — repoint the list, do not just delete the entry: ${missing.join(', ')}`,
  );
});

test('PIN: no buyer-facing page or email claims BHC adds no markup (the buyer pays it on top)', () => {
  // Collect every offender rather than throwing on the first, so a revert
  // reports the full blast radius instead of one file at a time.
  const offenders = BUYER_FACING.flatMap((rel) => claimsIn(rel, read(rel)));
  assert.deepEqual(
    offenders,
    [],
    `a buyer-facing surface claims BHC adds no markup — ${FAILURE_NOTE}\n  ${offenders.join('\n  ')}`,
  );
});

test('PIN: the sweep is EXHAUSTIVE — nothing under app/ or lib/ carries the claim', () => {
  // The completeness guarantee. An opt-in list is what let the /half-a-cow hub
  // page and sendConsumerApproval survive the first sweep; this scan covers
  // every file by default and makes the exemptions explicit and few.
  const exempt = new Set(RANCHER_FACING_EXEMPT.map((rel) => path.join(ROOT, rel)));
  const offenders: string[] = [];
  const visit = (full: string) => {
    if (exempt.has(full) || full === SELF) return;
    if (/\.test\.(ts|tsx|mjs|js)$/.test(full)) return; // fixtures + doesNotMatch guards quote it on purpose
    offenders.push(...claimsIn(path.relative(ROOT, full), readFileSync(full, 'utf8')));
  };
  walkSource(path.join(ROOT, 'app'), visit);
  walkSource(path.join(ROOT, 'lib'), visit);
  assert.deepEqual(
    offenders,
    [],
    `a shipped surface claims BHC adds no markup — ${FAILURE_NOTE} If this really is ` +
      `rancher-facing copy, add it to RANCHER_FACING_EXEMPT with a reason.\n  ${offenders.join('\n  ')}`,
  );
});

test('PIN: the copy bible does not re-seed the claim', () => {
  // docs/BHC.md is the single source of truth the bhc-marketing skill writes
  // every new asset from. Leave the claim in the verbatim pitch bank and it
  // regrows onto pages faster than a page scan can mow it.
  const offenders = COPY_SOURCE_DOCS.flatMap((rel) => claimsIn(rel, read(rel)));
  assert.deepEqual(
    offenders,
    [],
    `the copy bible still hands out the markup claim as approved copy — ${FAILURE_NOTE}\n  ${offenders.join('\n  ')}`,
  );
});

test('PIN: the surviving true claim ("no middleman") is still on the pages', () => {
  // A regression that deleted the whole sentence instead of the false half
  // would pass the scans above while gutting the page's differentiator.
  for (const rel of [
    'app/access/layout.tsx',
    'app/access/[state]/page.tsx',
    'app/half-a-cow/page.tsx',
    'app/half-a-cow/[state]/page.tsx',
    'lib/email.ts',
  ]) {
    assert.match(
      stripComments(read(rel)),
      // [ae] on purpose: the hub page and sendConsumerApproval say "middlemen".
      // The original /no middleman/i would have false-failed on every plural.
      /no middlem[ae]n/i,
      `${rel} lost the true "no middleman" claim along with the false markup one`,
    );
  }
});

test('PIN: the string "marketplace markup" appears nowhere under app/ or lib/', () => {
  // Repo-wide, no audience exemption: there is no rail on which "no
  // marketplace markup" is true, so the phrase should not exist even in
  // rancher-facing or internal copy waiting to be reused.
  const offenders: string[] = [];
  const visit = (full: string) => {
    // This pin file quotes the banned phrase on purpose.
    if (full === SELF) return;
    const flat = stripComments(readFileSync(full, 'utf8')).replace(/\s+/g, ' ');
    if (/marketplace\s+mark[- ]?up/i.test(flat)) offenders.push(path.relative(ROOT, full));
  };
  walkSource(path.join(ROOT, 'app'), visit);
  walkSource(path.join(ROOT, 'lib'), visit);
  assert.deepEqual(offenders, [], `"marketplace markup" is false on every rail — found in: ${offenders.join(', ')}`);
});
