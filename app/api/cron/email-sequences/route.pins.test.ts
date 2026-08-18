import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for email-sequences' Wave-1 hardening (2026-08-18). Grep-based —
// route files can't be imported under tsx --test (same convention as the
// other route.pins tests).
//
//   F18 — the "never two automated emails to the same buyer in 1 day" gate
//         used to read ONLY this rail's own stamp (Sequence Sent At), so a
//         demand-router wave / nurture touch / warmup sent hours earlier was
//         invisible and the buyer got a second marketing email the same day.
//         The gate must consult the ONE shared cross-rail cooldown.
//   F17 — the MATCH_NOW fallback branch (auto-route FAILED — no rancher was
//         matched) sent copy promising a named-rancher intro "within the
//         next 24 hours" and rancher outreach "within 48 hours". No machine
//         backs either clock: the path ends at a manual operator /match.
//         The rescue copy must carry no machine-unbacked deadline.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');
const ROOT = path.join(HERE, '..', '..', '..', '..');
const emailSrc = readFileSync(path.join(ROOT, 'lib', 'email.ts'), 'utf8');

// ── F18 — the 24h gate is cross-rail ───────────────────────────────────────

test('PIN F18: the route imports the shared cross-rail cooldown', () => {
  assert.match(src, /import \{ cooledDown \} from '@\/lib\/marketingTouch'/);
});

test('PIN F18: the 24h frequency gate consults cooledDown (all rails), not just Sequence Sent At', () => {
  const gateIdx = src.indexOf('cooledDown(consumer, now)');
  assert.ok(gateIdx > -1, 'the per-buyer 24h gate must use the shared cooldown');
  // The gate still lives in the approved-consumer loop, before any branch fires.
  const branchIdx = src.indexOf("segment === 'MATCH_NOW'");
  assert.ok(branchIdx > -1 && gateIdx < branchIdx, 'the gate must precede every send branch');
  // The old own-stamp-only check is gone (it read Sequence Sent At alone).
  assert.doesNotMatch(
    src,
    /lastSentAt && \(now - new Date\(lastSentAt\)\.getTime\(\)\) < DAY_MS/,
    'the own-stamp-only 24h check must not survive alongside the shared gate',
  );
});

// ── F17 — no machine-unbacked clock in the failed-auto-route rescue ────────

test('PIN F17: sendMatchNowRescue promises no 24h/48h clock and no already-matched rancher', () => {
  const fnIdx = emailSrc.indexOf('export async function sendMatchNowRescue(');
  assert.ok(fnIdx > -1, 'sendMatchNowRescue must still exist');
  const fnEnd = emailSrc.indexOf('export async function', fnIdx + 1);
  const fnSrc = emailSrc.slice(fnIdx, fnEnd > -1 ? fnEnd : fnIdx + 3000);
  assert.doesNotMatch(fnSrc, /24 hours/i, 'no machine backs a 24h intro promise on the FAILED-route path');
  assert.doesNotMatch(fnSrc, /48 hours/i, 'no machine backs a 48h rancher-outreach promise');
  assert.doesNotMatch(
    fnSrc,
    /I've matched you/i,
    'the branch fires when auto-route FAILED — nobody has been matched',
  );
});
