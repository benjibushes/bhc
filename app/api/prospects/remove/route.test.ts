// POST /api/prospects/remove — anonymous opt-out door pins.
//
// WHAT THESE PROTECT. This endpoint is unauthenticated ON PURPOSE: the
// listings it retracts were built from public information about ranchers who
// never consented, so a real operator must be able to get off the map in one
// tap. That property must survive every future edit — pin 3 holds it.
//
// The hazard is the OTHER half. The route resolved its target by slug alone,
// and slugs are public (they are the /ranchers/<slug> URLs and /api/public/
// ranchers enumerates them). The write it performs, Verification Status =
// 'Removed', is the most destructive flag on a rancher row: it stops buyer
// routing (lib/rancherEligibility.isRancherOperationalForBuyers) AND refuses
// the operator's own magic-link login (app/api/auth/rancher/verify), so a
// partner delisted this way could not sign in to undo it. Pins 1, 2 and 4
// hold live/represented/signed accounts out of reach of this door, and pin 5
// caps how fast anyone can walk the roster.
//
// DEMO MODE makes these hermetic: isDemoMode() is read lazily inside
// lib/airtable, so every read/write below lands in the in-memory demo store
// (lib/demo/demoStore) with zero network and zero credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DEMO_MODE = 'true';

import { POST } from './route';
import { TABLES } from '@/lib/airtable';
import { demoCreate, demoRecordById } from '@/lib/demo/demoStore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

let ipCounter = 0;
/** Each call gets its own documentation-range IP so the abuse cap (pin 5)
 *  never bleeds into the behavioural pins. */
function removePost(
  body: Record<string, unknown>,
  opts: { ip?: string } = {},
): ReturnType<typeof POST> {
  ipCounter++;
  const ip = opts.ip || `203.0.113.${ipCounter % 250}`;
  return POST(
    new Request('https://www.buyhalfcow.com/api/prospects/remove', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vercel-forwarded-for': ip,
        'x-forwarded-for': ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

let seq = 0;
function seedRancher(fields: Record<string, unknown>): { id: string; slug: string } {
  seq++;
  const slug = `pin-remove-${seq}-${Date.now()}`;
  const rec = demoCreate(TABLES.RANCHERS, {
    'Ranch Name': `Pin Remove Ranch ${seq}`,
    Slug: slug,
    State: 'MT',
    'Page Live': true,
    ...fields,
  });
  return { id: rec.id, slug };
}

function row(id: string): any {
  return demoRecordById(TABLES.RANCHERS, id);
}

// ── 1. A LIVE partner cannot be taken dark by an anonymous caller ──────────

test('an anonymous POST cannot remove a live, signed, routable rancher', async () => {
  const { id, slug } = seedRancher({
    'Verification Status': 'Verified',
    'Active Status': 'Active',
    'Onboarding Status': 'Live',
    'Agreement Signed': true,
    'Stripe Connect Status': 'active',
  });

  const res = await removePost({ slug, reason: 'delist me' });
  assert.equal(res.status, 403, 'a live partner must be refused, not honored');

  const after = row(id);
  assert.equal(after['Verification Status'], 'Verified', 'status must be untouched');
  assert.equal(after['Page Live'], true, 'Page Live must be untouched');
  assert.notEqual(after['Claim Status'], 'removed-on-request');
  assert.notEqual(after['Public Map Hidden'], true);
});

// ── 2. "Reads like a prospect, is a real relationship" ────────────────────

test('an anonymous POST cannot remove a represented (broker-rail) ranch', async () => {
  // Broker ranches carry Verification Status='Prospect'-ish rows with an EMPTY
  // Active Status by design — they route off isBrokerRoutable. A gate that
  // only asked "is Active Status set?" would wave this one straight through.
  const { id, slug } = seedRancher({
    'Verification Status': 'Prospect',
    'Broker Rail': true,
    'Active Status': '',
  });

  const res = await removePost({ slug });
  assert.equal(res.status, 403);
  assert.equal(row(id)['Verification Status'], 'Prospect', 'must be untouched');
  assert.notEqual(row(id)['Page Live'], false);
});

test('an anonymous POST cannot remove a prospect that already signed the agreement', async () => {
  const { id, slug } = seedRancher({
    'Verification Status': 'Prospect',
    'Agreement Signed': true,
  });
  const res = await removePost({ slug });
  assert.equal(res.status, 403);
  assert.equal(row(id)['Verification Status'], 'Prospect');
});

// ── 3. The legal-compliance path still works, anonymously ─────────────────

test('a genuine unclaimed prospect can still opt out with no authentication', async () => {
  const { id, slug } = seedRancher({ 'Verification Status': 'Prospect' });

  const res = await removePost({ slug, reason: 'not interested', contactEmail: 'op@example.com' });
  assert.equal(res.status, 200, 'the compliance door must stay open');
  const json: any = await res.json();
  assert.equal(json.success, true);

  const after = row(id);
  assert.equal(after['Verification Status'], 'Removed');
  assert.equal(after['Page Live'], false);
  assert.equal(after['Public Map Hidden'], true);
  assert.equal(after['Claim Status'], 'removed-on-request');
});

test('a second opt-out on an already-removed listing is an idempotent 200', async () => {
  const { slug } = seedRancher({ 'Verification Status': 'Removed' });
  const res = await removePost({ slug });
  assert.equal(res.status, 200);
});

// ── 4. Shape errors ───────────────────────────────────────────────────────

test('an unknown slug is a 404 and a missing slug is a 400', async () => {
  assert.equal((await removePost({ slug: 'no-such-listing-anywhere-xyz' })).status, 404);
  assert.equal((await removePost({})).status, 400);
});

// ── 5. Abuse cap ──────────────────────────────────────────────────────────

test('one caller cannot walk the roster — the per-IP burst cap returns 429', async () => {
  const ip = '198.51.100.7';
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const { slug } = seedRancher({ 'Verification Status': 'Prospect' });
    statuses.push((await removePost({ slug }, { ip })).status);
  }
  assert.ok(
    statuses.includes(429),
    `expected a 429 within 8 rapid removals from one IP, got ${statuses.join(',')}`,
  );
});

test('the per-slug cap stops a distributed flood against ONE listing', async () => {
  const { slug } = seedRancher({ 'Verification Status': 'Prospect' });
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    // Fresh IP each time — only the slug bucket can stop this.
    statuses.push((await removePost({ slug }, { ip: `192.0.2.${i + 1}` })).status);
  }
  assert.ok(
    statuses.includes(429),
    `expected a 429 within 6 removals of one slug from 6 IPs, got ${statuses.join(',')}`,
  );
});

// ── 6. Source pins — the gate must stay wired to the SHARED helpers ────────

test('(source pin) the route delegates to the shared verdict + shared rate limiter', () => {
  assert.match(
    src,
    /from '@\/lib\/prospectOptOut'/,
    'the status gate must be the shared, unit-tested predicate — not a local re-implementation',
  );
  assert.match(src, /prospectOptOutVerdict\(/, 'the verdict must actually be consulted');
  assert.match(
    src,
    /from '@\/lib\/rateLimit'/,
    'reuse the repo rate limiter rather than inventing one',
  );
  assert.match(
    src,
    /rateLimitStrict\(/,
    'the abuse cap on a destructive anonymous write must never fail OPEN when Upstash is unset',
  );
});
