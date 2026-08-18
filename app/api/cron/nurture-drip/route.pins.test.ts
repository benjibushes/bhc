import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for nurture-drip's cross-rail marketing cooldown (F18, Wave 1
// rails hardening 2026-08-18). Grep-based — route files can't be imported
// under tsx --test (same convention as the other route.pins tests).
//
// WHAT THIS PROTECTS: the drip had NO cross-rail recency check — a buyer the
// demand-router or email-sequences emailed this morning could get a nurture
// touch the same afternoon. The candidate filter must consult the ONE shared
// cooldown (lib/marketingTouch) and skip WITHOUT stamping (the touch stays
// due and fires on a later run).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN F18: the route imports the shared cross-rail cooldown', () => {
  assert.match(src, /import \{ cooledDown \} from '@\/lib\/marketingTouch'/);
});

test('PIN F18: the candidate filter consults cooledDown BEFORE a buyer enters the due list', () => {
  const gateIdx = src.indexOf('cooledDown(c, now)');
  assert.ok(gateIdx > -1, 'the candidate loop must gate on cooledDown');
  const duePushIdx = src.indexOf('due.push(');
  assert.ok(duePushIdx > -1 && gateIdx < duePushIdx, 'the gate must precede due.push');
});

test('PIN F18: cooldown skips are COUNTED (operator-visible, not silent)', () => {
  assert.match(src, /skippedCooldown/);
  assert.match(src, /'cross-rail-cooldown'/);
});
