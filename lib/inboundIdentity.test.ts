import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchSenderByEmail,
  applyIdentityFallback,
  bareEmail,
  type InboundLinks,
} from './inboundIdentity';

// All fixtures are synthetic — repo is public, never use real sender data.

type Call = { table: string; formula: string };

function fakeLookup(byTable: Record<string, Array<Record<string, any>>>, calls: Call[]) {
  return async (table: string, formula: string) => {
    calls.push({ table, formula });
    return byTable[table] || [];
  };
}

// ── matchSenderByEmail ───────────────────────────────────────────────────────

test('found in Consumers → buyer, and Ranchers is never queried', async () => {
  const calls: Call[] = [];
  const match = await matchSenderByEmail('Fake Buyer <fake-buyer@example.com>', {
    lookup: fakeLookup({ Consumers: [{ id: 'recConsumer1', Email: 'fake-buyer@example.com' }] }, calls),
  });
  assert.deepEqual(match, { senderType: 'buyer', consumerId: 'recConsumer1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'Consumers');
});

test('not in Consumers, found in Ranchers → rancher', async () => {
  const calls: Call[] = [];
  const match = await matchSenderByEmail('fake-rancher@example.com', {
    lookup: fakeLookup({ Ranchers: [{ id: 'recRancher1', Email: 'fake-rancher@example.com' }] }, calls),
  });
  assert.deepEqual(match, { senderType: 'rancher', rancherId: 'recRancher1' });
  assert.deepEqual(
    calls.map((c) => c.table),
    ['Consumers', 'Ranchers'],
  );
});

test('found in neither → null', async () => {
  const match = await matchSenderByEmail('fake-stranger@example.com', {
    lookup: fakeLookup({}, []),
  });
  assert.equal(match, null);
});

test('lookup is case-insensitive and exact-address (anti-substring)', async () => {
  const calls: Call[] = [];
  await matchSenderByEmail('Fake Person <FAKE.Person@Example.COM>', {
    lookup: fakeLookup({}, calls),
  });
  // Formula lowercases the address and uses exact-or-bracketed matching only —
  // the same anti-substring pattern as findReferralByBuyerEmail (ben@x must
  // never match rueben@x).
  assert.match(calls[0].formula, /LOWER\(TRIM\(\{Email\}\)\) = "fake\.person@example\.com"/);
  assert.match(calls[0].formula, /FIND\("<fake\.person@example\.com>", LOWER\(\{Email\}\)\) > 0/);
  assert.doesNotMatch(calls[0].formula, /FIND\("fake\.person@example\.com",/);
});

test('invalid input (blank / no @) → null without any lookup', async () => {
  const calls: Call[] = [];
  assert.equal(await matchSenderByEmail('', { lookup: fakeLookup({}, calls) }), null);
  assert.equal(await matchSenderByEmail('not-an-email', { lookup: fakeLookup({}, calls) }), null);
  assert.equal(calls.length, 0);
});

test('lookup failure fails soft to null, then still tries Ranchers', async () => {
  const calls: Call[] = [];
  const match = await matchSenderByEmail('fake-rancher@example.com', {
    lookup: async (table: string, formula: string) => {
      calls.push({ table, formula });
      if (table === 'Consumers') throw new Error('airtable down');
      return [{ id: 'recRancher9', Email: 'fake-rancher@example.com' }];
    },
  });
  assert.deepEqual(match, { senderType: 'rancher', rancherId: 'recRancher9' });
});

// ── applyIdentityFallback — the never-overwrite guard ────────────────────────

test('NEVER overrides a token-derived context', () => {
  const links: InboundLinks = { referralId: 'recRefToken' };
  const out = applyIdentityFallback({
    context: { type: 'ref', recordId: 'recRefToken' },
    links,
    match: { senderType: 'rancher', rancherId: 'recRancherX' },
  });
  assert.equal(out.applied, false);
  assert.deepEqual(out.links, { referralId: 'recRefToken' });
});

test('never touches links an earlier fallback already resolved', () => {
  for (const links of [
    { referralId: 'recRef1' },
    { consumerId: 'recCon1' },
    { rancherId: 'recRan1' },
    { threadId: 'recThr1' },
  ] as InboundLinks[]) {
    const out = applyIdentityFallback({
      context: null,
      links,
      match: { senderType: 'buyer', consumerId: 'recConNew' },
    });
    assert.equal(out.applied, false, JSON.stringify(links));
    assert.deepEqual(out.links, links);
  }
});

test('applies a buyer match onto blank links', () => {
  const out = applyIdentityFallback({
    context: null,
    links: {},
    match: { senderType: 'buyer', consumerId: 'recCon2' },
  });
  assert.equal(out.applied, true);
  assert.deepEqual(out.links, { consumerId: 'recCon2' });
});

test('applies a rancher match onto blank links', () => {
  const out = applyIdentityFallback({
    context: null,
    links: {},
    match: { senderType: 'rancher', rancherId: 'recRan2' },
  });
  assert.equal(out.applied, true);
  assert.deepEqual(out.links, { rancherId: 'recRan2' });
});

test('no match → unchanged', () => {
  const out = applyIdentityFallback({ context: null, links: {}, match: null });
  assert.equal(out.applied, false);
  assert.deepEqual(out.links, {});
});

// ── bareEmail ────────────────────────────────────────────────────────────────

test('bareEmail unwraps display names and lowercases', () => {
  assert.equal(bareEmail('Fake Person <Fake@Example.com>'), 'fake@example.com');
  assert.equal(bareEmail('FAKE@EXAMPLE.COM'), 'fake@example.com');
  assert.equal(bareEmail(''), '');
});
