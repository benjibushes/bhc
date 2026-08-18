// REPRESENTED-RANCH WORDING RULING (Ben, 2026-08-18) — SOURCE PINS.
//
// Broker-rail self-serve ranches are officially "represented ranches". A
// represented ranch never ran verification and signed nothing — so no
// buyer-visible surface may assert "verified" (or vetted / USDA-confirmed)
// over a set that INCLUDES one:
//
//   • the routing pool (isRancherOperationalForBuyers admits broker supply
//     since #628),
//   • the discovery counts (stateDiscoveryRanchersFormula /
//     getActiveRancherPages / lib/stateSupply — Wave A carve-out),
//   • and the represented ranch's OWN page (rancherOrProspectBySlugFormula
//     resolves it since #617).
//
// Genuine verified claims about actually-verified ranchers SURVIVE — the
// map's per-status "Verified" badge, the shop set (lib/marketplaceProducts
// drops broker rows wholesale), the deposit page (broker referrals redirect
// to /checkout/[refId]/broker). These pins guard only the mixed-set
// surfaces, same grep-pin pattern as lib/email.pins.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

// ── /half-a-cow/[state] — hero count is the shared discovery formula (mixed) ─

test('PIN: half-a-cow hero never says "verified" over the mixed live-ranch count', () => {
  const page = src('app/half-a-cow/[state]/page.tsx');
  // The exact live-supply hero line, minus the old false adjective.
  assert.match(page, /\{liveRanchers\} \{liveRanchers === 1 \? 'ranch is' : 'ranches are'\} live/);
  // The old claim must never come back in any spacing.
  assert.doesNotMatch(page, /\{liveRanchers\}\s*verified/i);
});

test('PIN: half-a-cow metadata + steps no longer promise a verified match', () => {
  const page = src('app/half-a-cow/[state]/page.tsx');
  assert.match(page, /a real local ranch/);
  assert.match(page, /get matched with a local family ranch/);
  // The only "verified family ranches" left is the market-strip fallback,
  // which is scoped to marketplace products (broker rows dropped wholesale
  // by lib/marketplaceProducts) — a genuinely verified set.
  const hits = page.match(/verified family ranches/g) || [];
  assert.equal(hits.length, 1, `expected exactly the shop-scoped hit, got ${hits.length}`);
  assert.match(page, /real beef from verified family ranches, shipped to your door/);
});

// ── /ranchers directory — grid is getActiveRancherPages (includes represented) ─

test('PIN: /ranchers header stat and body never assert "verified"/"vetted" over the mixed grid', () => {
  const page = src('app/ranchers/page.tsx');
  // Count renders bare: `${rancherCount} rancher(s)` with no trust adjective.
  assert.match(page, /\$\{rancherCount\} \$\{rancherCount === 1 \? 'rancher' : 'ranchers'\}/);
  assert.doesNotMatch(page, /verified/i);
  assert.doesNotMatch(page, /vetted/i);
  assert.doesNotMatch(page, /USDA/);
});

// ── the represented ranch's OWN page (e.g. Gila River Cattle) ────────────────

test('PIN: rancher page hero renders "Represented ranch", never "Verified partner", for broker self-serve', () => {
  const page = src('app/ranchers/[slug]/page.tsx');
  // The three-way pill: prospect → unclaimed; brokerSelfServe → represented;
  // else → the earned Verified pill. Order matters: the broker arm must be
  // checked BEFORE the Verified fallthrough.
  // Match the rendered pill bodies (not the ruling comments above them).
  const prospectIdx = page.indexOf('Unclaimed listing</Pill>');
  const brokerArmIdx = page.indexOf(') : brokerSelfServe ? (');
  const representedIdx = page.indexOf('Represented ranch\n                  </Pill>');
  const verifiedIdx = page.indexOf('Verified partner\n                  </Pill>');
  assert.ok(prospectIdx > -1, 'prospect pill exists');
  assert.ok(brokerArmIdx > -1, 'brokerSelfServe pill arm exists');
  assert.ok(representedIdx > -1, 'Represented ranch pill exists');
  assert.ok(verifiedIdx > -1, 'Verified partner pill survives for earned verification');
  assert.ok(
    prospectIdx < brokerArmIdx && brokerArmIdx < representedIdx && representedIdx < verifiedIdx,
    'pill branch order must be prospect → represented → verified',
  );
});

test('PIN: rancher page USDA quick-fact is neutral ("Processed at") on the broker branch', () => {
  const page = src('app/ranchers/[slug]/page.tsx');
  assert.match(page, /\{brokerSelfServe \? 'Processed at' : 'USDA inspected'\}/);
});

// ── the launch-warmup email (fires for broker go-lives, e.g. AZ) ─────────────

test('PIN: launch warmup never claims "passed our verification" on the broker rail', () => {
  const email = src('lib/email.ts');
  // Broker arm: represent + deposits-open truth.
  assert.match(email, /is a ranch we represent — deposits are open/);
  // Connect arm keeps the earned claim, gated on !isBroker.
  assert.match(email, /const wentLiveLine = isBroker\n/);
  assert.match(email, /just passed our verification/);
});

test('PIN: routing-pool emails no longer promise "a verified rancher in your state"', () => {
  const email = src('lib/email.ts');
  // The routing pool includes represented ranches (#628) — the blanket
  // per-match promise is gone from every buyer template.
  assert.doesNotMatch(email, /match you with a verified rancher/i);
  assert.doesNotMatch(email, /matched you with a verified rancher/i);
  assert.doesNotMatch(email, /ranchers I've verified/i);
  // State-coverage letter (broker-driven AZ flip) is neutral.
  assert.match(email, /A rancher is live in your area now/);
});
