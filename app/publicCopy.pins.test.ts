// app/publicCopy.pins.test.ts
//
// SOURCE PINS — the buyer-facing pages may not claim BHC adds no markup.
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
// NOT COVERED — app/sell/page.tsx, deliberately. That page is the RANCHER
// pitch, and "no middleman markup" is true from the rancher's side under the
// locked money model (docs/BUSINESS-MODEL.md: the rancher keeps 100% of their
// price; BHC's fee is added to the buyer on top, never skimmed off the
// rancher). The phrase is only a lie when a BUYER reads it, so the scan is
// scoped to buyer-facing surfaces — with one exception below: the exact
// string "marketplace markup" is banned repo-wide, because there is no
// audience and no rail for which THAT one is true.
//
// NOTE on placement: this file deliberately lives at app/ root, not inside
// app/access/[state]/ or app/half-a-cow/[state]/. The npm test glob is
// 'app/**/*.test.ts' and a literal `[state]` path segment reads as a glob
// character class, so a test inside one is silently never collected (the
// 2026-08-02 missing-tests landmine).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(APP, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// Comments legitimately quote the struck lines (that is how a fix documents
// itself at the fix site — see the /half-a-cow subhead), so every scan below
// runs on comment-stripped source.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every buyer-facing surface that carried, or could plausibly regrow, the claim. */
const BUYER_FACING = [
  'app/page.tsx',
  'app/components/FullHomepage.tsx',
  'app/access/page.tsx',
  'app/access/layout.tsx',
  'app/access/[state]/page.tsx',
  'app/half-a-cow/[state]/page.tsx',
  'app/guide/page.tsx',
  'app/about/page.tsx',
  'app/r/[code]/page.tsx',
  'app/shop/page.tsx',
  'app/map/page.tsx',
];

/**
 * Any claim that BHC adds no markup / takes no cut off the top. Matches the
 * whole family, not just the two exact strings the audit found:
 *   "no marketplace markup" · "No middleman markup." · "no middleman markups"
 *   "never a markup on your beef" · "zero markup" · "without any markup"
 */
const NO_MARKUP_CLAIM =
  /\b(?:no|never|zero|without)\b[^.<>]{0,40}\bmark[- ]?ups?\b|\bmark[- ]?up\b[^.<>]{0,25}\b(?:on your beef|on the beef)\b/i;

test('PIN: no buyer-facing page claims BHC adds no markup (the buyer pays it on top)', () => {
  // Collect every offender rather than throwing on the first, so a revert
  // reports the full blast radius instead of one file at a time.
  //
  // Scan the WHITESPACE-COLLAPSED file, not line by line: JSX wraps prose
  // mid-claim ("no\n  marketplace markup") and a per-line scan walked straight
  // past both /half-a-cow subheads and the /r/[code] line.
  const offenders: string[] = [];
  for (const rel of BUYER_FACING) {
    const flat = stripComments(read(rel)).replace(/\s+/g, ' ');
    for (const m of flat.matchAll(new RegExp(NO_MARKUP_CLAIM, 'gi'))) {
      offenders.push(`${rel}: …${flat.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).trim()}…`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a buyer-facing page claims BHC adds no markup — Connect charges the buyer the ` +
      `platform fee ON TOP (lib/tiers.ts: "the buyer pays our 10% on top"). Delete the ` +
      `money claim; "no middleman" is the true half.\n  ${offenders.join('\n  ')}`,
  );
});

test('PIN: the surviving true claim ("no middleman") is still on the pages', () => {
  // A regression that deleted the whole sentence instead of the false half
  // would pass the scan above while gutting the page's differentiator.
  for (const rel of ['app/access/layout.tsx', 'app/access/[state]/page.tsx', 'app/half-a-cow/[state]/page.tsx']) {
    assert.match(
      stripComments(read(rel)),
      /no middleman/i,
      `${rel} lost the true "no middleman" claim along with the false markup one`,
    );
  }
});

test('PIN: the string "marketplace markup" appears nowhere under app/ or lib/', () => {
  // Repo-wide, no audience exemption: there is no rail on which "no
  // marketplace markup" is true, so the phrase should not exist even in
  // rancher-facing or internal copy waiting to be reused.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
      // This pin file quotes the banned phrase on purpose.
      if (full === fileURLToPath(import.meta.url)) continue;
      const flat = stripComments(readFileSync(full, 'utf8')).replace(/\s+/g, ' ');
      if (/marketplace\s+mark[- ]?up/i.test(flat)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'app'));
  walk(path.join(ROOT, 'lib'));
  assert.deepEqual(offenders, [], `"marketplace markup" is false on every rail — found in: ${offenders.join(', ')}`);
});
