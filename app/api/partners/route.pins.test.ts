// POST /api/partners — phone-required pins (#413 parity, doors wave 2026-08-18).
//
// WHAT THESE PROTECT: /api/apply has enforced a server-side "phone or 400"
// rule since Vale Creek Ranch signed up with a typo'd email and no phone —
// approved, sent a setup link that could never arrive, permanently
// unreachable. /api/partners (the /partner long-form rancher door) formatted
// the phone but never REQUIRED it, so a direct POST or a stale client could
// still create an email-only rancher. These pins hold the rancher branch of
// /partner to the same rule the other doors obey:
//   1. rancher application without a phone → 400, before anything is written;
//   2. a junk phone (7 digits) → the same 400 (isValidUsPhone, not "non-empty");
//   3. a real phone — including the country-code form the old client
//      formatter used to corrupt — passes the gate and the application runs
//      to its 201 + wizardUrl;
//   4. (source pin) the gate sits INSIDE the rancher branch, ahead of the
//      dedupe lookup and the Airtable create, and uses the shared
//      isValidUsPhone helper — not a local digit-count.
//
// DEMO MODE below makes test 3 hermetic: isDemoMode() is read lazily at call
// time, and with it on, every Airtable/Resend/Telegram touch in the route is
// an in-memory no-op (lib/demo) — the full rancher path runs to 201 with zero
// network and zero creds. Tests 1–2 reject before any I/O regardless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { POST } from './route';

process.env.DEMO_MODE = 'true';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

// The route rate-limits 2/min per IP (in-memory fallback when Upstash is
// unset) — every request gets its own documentation-range IP so the pins
// never trip it.
let ipCounter = 0;
function partnerPost(body: Record<string, unknown>): ReturnType<typeof POST> {
  ipCounter++;
  return POST(
    new Request('https://www.buyhalfcow.com/api/partners', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': `203.0.113.${ipCounter}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

// Unique per call so the with-phone test can never collide with a row a
// previous test created in the demo store (the dedupe matches on email,
// phone digits, and ranch+state).
let seq = 0;
function rancherBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  return {
    partnerType: 'rancher',
    ranchName: `Phone Gate Pin Ranch ${seq}`,
    operatorName: 'Pin Tester',
    email: `phone-gate-pin-${seq}-${Date.now()}@example.com`,
    state: 'MT',
    beefTypes: 'Grass-finished',
    monthlyCapacity: '4',
    ...over,
  };
}

test('PIN: rancher application without a phone → 400 (the #413 rule holds on /partner)', async () => {
  const res = await partnerPost(rancherBody());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(String(data.error || ''), /phone/i);
});

test('PIN: a junk 7-digit phone → the same 400 (isValidUsPhone, not "non-empty")', async () => {
  const res = await partnerPost(rancherBody({ phone: '555-1234' }));
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(String(data.error || ''), /phone/i);
});

test('PIN: a country-code phone passes the gate and the application completes', async () => {
  // `1 (212) 555-0187` is the exact shape the old client formatter corrupted
  // into a wrong-but-10-digit number — isValidUsPhone strips the leading 1.
  // (212, deliberately: the demo fixtures use 406/208/307 numbers, and the
  // dedupe matches on raw phone digits — a 406 pin number literally collided
  // with Demo Creek Cattle Co's row on the first run of this file.)
  const res = await partnerPost(rancherBody({ phone: '1 (212) 555-0187' }));
  const data = await res.json();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(data)}`);
  assert.equal(data.success, true);
  assert.ok(data.wizardUrl, 'a fresh rancher application must return the setup-wizard URL');
});

test('PIN (source): the gate lives in the rancher branch, before dedupe and create', () => {
  assert.match(
    src,
    /import \{[^}]*isValidUsPhone[^}]*\} from '@\/lib\/phoneFormat'/,
    'must use the shared helper — a local digit-count is how the corrupted-phone bug shipped',
  );
  const rancherBranch = src.indexOf("partnerType === 'rancher'");
  const gate = src.indexOf('isValidUsPhone', rancherBranch);
  const dedupe = src.indexOf('findOrCreateRancherByEmail(', rancherBranch);
  const create = src.indexOf('createRecord(', rancherBranch);
  assert.ok(rancherBranch > -1 && gate > -1 && dedupe > -1 && create > -1);
  assert.ok(gate < dedupe, 'phone gate must run before the dedupe lookup');
  assert.ok(gate < create, 'phone gate must run before the Airtable create');
});
