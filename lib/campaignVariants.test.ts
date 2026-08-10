import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignVariant,
  campaignVariantIndex,
  requalifySubject,
  variantMode,
} from './campaignVariants';

// ── kill switch — tri-state, FAIL-TO-OFF ────────────────────────────────────

test('variantMode: only the exact string "true" goes live', () => {
  assert.equal(variantMode('true'), 'live');
  assert.equal(variantMode('dry-run'), 'shadow');
  // Everything else fails to off — unset, negatives, casing typos, junk.
  for (const raw of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'live', 'on', ' true']) {
    assert.equal(variantMode(raw), 'off', JSON.stringify(raw));
  }
});

// ── deterministic split ─────────────────────────────────────────────────────

test('split is deterministic: same (consumerId, templateName) always lands the same arm', () => {
  for (let i = 0; i < 50; i++) {
    const id = `rec${i.toString(16).padStart(14, '0')}`;
    assert.equal(
      campaignVariant(id, 'campaign_cv-requalify'),
      campaignVariant(id, 'campaign_cv-requalify'),
    );
  }
});

test('split re-randomizes across templates (templateName is in the hash)', () => {
  // At least one of many ids must flip arms between two templates — if the
  // template were ignored, every id would keep its arm and this fails.
  let flipped = 0;
  for (let i = 0; i < 200; i++) {
    const id = `rec${i.toString(16).padStart(14, '0')}`;
    if (campaignVariant(id, 'campaign_alpha') !== campaignVariant(id, 'campaign_beta')) {
      flipped += 1;
    }
  }
  assert.ok(flipped > 0, 'no id changed arm across templates — template not hashed');
});

test('split is roughly 50/50 over a synthetic pool', () => {
  let b = 0;
  const n = 1000;
  for (let i = 0; i < n; i++) {
    const id = `rec${i.toString(16).padStart(14, '0')}`;
    if (campaignVariantIndex(id, 'campaign_cv-requalify') === 1) b += 1;
  }
  // Deterministic (no flake): a hash this skewed would be a real bug.
  assert.ok(b > n * 0.4 && b < n * 0.6, `B arm got ${b}/${n}`);
});

test('index and letter agree (0→A, 1→B)', () => {
  for (let i = 0; i < 20; i++) {
    const id = `rec${i}`;
    const idx = campaignVariantIndex(id, 't');
    assert.equal(campaignVariant(id, 't'), idx === 0 ? 'A' : 'B');
  }
});

// ── subjects — repo-versioned copy pins ─────────────────────────────────────

test('variant A subject is BYTE-IDENTICAL to the historical requalify subject', () => {
  // The pre-variant subject, verbatim. Default path must be indistinguishable
  // from pre-PR behavior — if this fails you changed live campaign copy.
  assert.equal(requalifySubject('Jane Doe'), `Jane, there's a ranch for you now`);
  assert.equal(requalifySubject('Jane Doe', 'A'), `Jane, there's a ranch for you now`);
});

test('variant B differs from A and both honor the copy rules (no hyphens)', () => {
  const a = requalifySubject('Jane Doe', 'A');
  const b = requalifySubject('Jane Doe', 'B');
  assert.notEqual(a, b);
  assert.ok(!a.includes('-'), 'no hyphens in outbound copy (A)');
  assert.ok(!b.includes('-'), 'no hyphens in outbound copy (B)');
  // Both open with the first name, matching the body's greeting.
  assert.match(a, /^Jane, /);
  assert.match(b, /^Jane, /);
});

test('blank name falls back to "there" on both arms', () => {
  assert.match(requalifySubject('', 'A'), /^there, /);
  assert.match(requalifySubject('', 'B'), /^there, /);
});
