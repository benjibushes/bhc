// AD ATTRIBUTION — the one parser for `bhc_source_v2` and the one map onto the
// Airtable Consumers columns.
//
// What these pin, in the order the bugs actually cost money:
//   1. THE FIELD NAMES. Every key is also the verbatim Consumers column name.
//      A rename on one side and not the other silently empties `fbclid`, which
//      makes reconstructFbc (lib/metaCapi) return undefined, which makes every
//      server Purchase fire with no fbc match key. That failure is invisible —
//      no error, no missing row, just unattributable ad spend. Pin the literals.
//   2. NEVER BLOCKS. A missing, blocked, throwing, or corrupt localStorage must
//      degrade to the empty snapshot. A buyer with storage disabled must still
//      be able to reserve and pay.
//   3. NEVER CLOBBERS. Only non-empty values are emitted, so a half-filled
//      snapshot can't blank a column that already holds a first-touch value.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_ATTRIBUTION_KEYS,
  AD_ATTRIBUTION_MAX_LEN,
  AD_ATTRIBUTION_STORAGE_KEY,
  attributionConsumerFields,
  emptyAdAttribution,
  hasAdAttribution,
  isUsableClickTimestamp,
  readStoredAttribution,
} from './adAttribution';

/** Minimal localStorage stand-in. */
function storageWith(value: string | null) {
  return { getItem: (k: string) => (k === AD_ATTRIBUTION_STORAGE_KEY ? value : null) };
}

const FULL_SNAPSHOT = {
  utm_source: 'facebook',
  utm_medium: 'paid',
  utm_campaign: 'az-half-cow',
  utm_content: 'video-a',
  utm_term: 'half cow phoenix',
  fbclid: 'IwAR0testclickid',
  fbclid_ts: '1755300000000',
  gclid: 'Cj0KCQtest',
  // Extra keys UtmCapture also writes — must be ignored, never forwarded.
  captured_at: '2026-08-17T00:00:00.000Z',
  landing_path: '/ranchers/granite-hollow-beef',
};

// ── The contract with Airtable ─────────────────────────────────────────────

test('the eight keys are exactly the Consumers columns /api/consumers writes', () => {
  // Literal list, deliberately not derived from the module — this test IS the
  // schema pin. Changing it must be a conscious act, matched in Airtable.
  assert.deepEqual([...AD_ATTRIBUTION_KEYS], [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'fbclid',
    'fbclid_ts',
    'gclid',
  ]);
});

test('fbclid + fbclid_ts both survive — reconstructFbc needs the PAIR', () => {
  // fbc = fb.1.<clickTimeMs>.<fbclid>. Dropping the timestamp silently kills
  // every server-side match, so assert them together and by name.
  const fields = attributionConsumerFields(FULL_SNAPSHOT);
  assert.equal(fields['fbclid'], 'IwAR0testclickid');
  assert.equal(fields['fbclid_ts'], '1755300000000');
});

// ── THE PAIR INVARIANT ─────────────────────────────────────────────────────
// A row holding an fbclid with no usable fbclid_ts LOOKS attributed in Airtable
// and silently yields no fbc forever. Worse than a blank column, because
// nothing surfaces it. Both halves or neither.

test('a lone fbclid is NEVER written (no timestamp = no match, ever)', () => {
  const fields = attributionConsumerFields({ utm_source: 'facebook', fbclid: 'IwAR0abc' });
  assert.equal('fbclid' in fields, false);
  assert.equal('fbclid_ts' in fields, false);
  // …and the rest of the snapshot is unaffected by the pair being dropped.
  assert.equal(fields['utm_source'], 'facebook');
});

test('a lone fbclid_ts is never written either (a bare timestamp is useless)', () => {
  const fields = attributionConsumerFields({ fbclid_ts: '1755300000000' });
  assert.deepEqual(fields, {});
});

test('an UNUSABLE fbclid_ts drops the pair — matches reconstructFbc exactly', () => {
  // reconstructFbc (lib/metaCapi) requires a finite number > 0. Anything it
  // would reject must not be persisted alongside an fbclid.
  for (const ts of ['', '   ', '0', '-1', 'abc', 'NaN', '1e400', 'null']) {
    const fields = attributionConsumerFields({ fbclid: 'IwAR0abc', fbclid_ts: ts });
    assert.equal('fbclid' in fields, false, `fbclid must be dropped for ts=${JSON.stringify(ts)}`);
    assert.equal('fbclid_ts' in fields, false, `fbclid_ts must be dropped for ts=${JSON.stringify(ts)}`);
  }
  assert.equal(isUsableClickTimestamp('1755300000000'), true);
  assert.equal(isUsableClickTimestamp('0'), false);
  assert.equal(isUsableClickTimestamp(1755300000000 as unknown), false, 'non-strings are not usable');
});

test('THE UPDATE PATH: a partial re-post can never half-write the pair', () => {
  // /api/consumers' funnel branch feeds this map into an updateRecord on an
  // EXISTING row. Simulate the dangerous sequence: a first visit stores the
  // full pair, a later visit re-posts a snapshot whose timestamp was lost.
  const firstTouch = attributionConsumerFields(FULL_SNAPSHOT);
  assert.equal(firstTouch['fbclid_ts'], '1755300000000');

  const laterPartial = attributionConsumerFields({
    ...FULL_SNAPSHOT,
    fbclid: 'IwAR0differentclick',
    fbclid_ts: '',
  });
  // The update carries neither half, so it cannot overwrite fbclid and leave
  // the stored fbclid_ts describing a DIFFERENT click.
  assert.equal('fbclid' in laterPartial, false);
  assert.equal('fbclid_ts' in laterPartial, false);
  // Non-click fields still update normally — the invariant is scoped.
  assert.equal(laterPartial['utm_source'], 'facebook');
});

// ── LENGTH CLAMP (unauthenticated endpoint → Airtable write) ───────────────

test('over-length values are DROPPED, never truncated', () => {
  // A truncated fbclid would be a valid-looking match key that never matches.
  const huge = 'x'.repeat(AD_ATTRIBUTION_MAX_LEN + 1);
  const fields = attributionConsumerFields({
    utm_source: huge,
    utm_medium: 'paid',
    fbclid: huge,
    fbclid_ts: '1755300000000',
  });
  assert.equal('utm_source' in fields, false);
  assert.equal('fbclid' in fields, false);
  // Dropping the oversized fbclid drops its timestamp too (pair invariant).
  assert.equal('fbclid_ts' in fields, false);
  // A sane sibling value still lands — one bad key doesn't poison the record.
  assert.equal(fields['utm_medium'], 'paid');
});

test('a value exactly at the limit is kept (the boundary is inclusive)', () => {
  const atLimit = 'y'.repeat(AD_ATTRIBUTION_MAX_LEN);
  assert.equal(attributionConsumerFields({ utm_campaign: atLimit })['utm_campaign'], atLimit);
});

test('the reader applies the same clamp — garbage never rides the POST body', () => {
  const huge = 'z'.repeat(AD_ATTRIBUTION_MAX_LEN + 1);
  const got = readStoredAttribution(storageWith(JSON.stringify({ gclid: huge, utm_term: 'ok' })));
  assert.equal(got.gclid, '');
  assert.equal(got.utm_term, 'ok');
});

// ── readStoredAttribution — total, never throws ────────────────────────────

test('reads a full snapshot and drops keys that are not attribution', () => {
  const got = readStoredAttribution(storageWith(JSON.stringify(FULL_SNAPSHOT)));
  assert.equal(got.utm_source, 'facebook');
  assert.equal(got.gclid, 'Cj0KCQtest');
  assert.equal('captured_at' in got, false);
  assert.equal('landing_path' in got, false);
});

test('a partial snapshot yields empty strings for the rest (stable POST shape)', () => {
  const got = readStoredAttribution(storageWith(JSON.stringify({ fbclid: 'abc', fbclid_ts: '17' })));
  assert.equal(got.fbclid, 'abc');
  assert.equal(got.utm_source, '');
  assert.deepEqual(Object.keys(got).sort(), [...AD_ATTRIBUTION_KEYS].sort());
});

test('missing / corrupt / hostile storage all degrade to the empty snapshot', () => {
  const empty = emptyAdAttribution();
  assert.deepEqual(readStoredAttribution(null), empty);
  assert.deepEqual(readStoredAttribution(storageWith(null)), empty);
  assert.deepEqual(readStoredAttribution(storageWith('')), empty);
  assert.deepEqual(readStoredAttribution(storageWith('{not json')), empty);
  assert.deepEqual(readStoredAttribution(storageWith('"a string"')), empty);
  assert.deepEqual(readStoredAttribution(storageWith('[1,2,3]')), empty);
  assert.deepEqual(readStoredAttribution(storageWith('null')), empty);
  // Non-string values in an otherwise-valid snapshot are skipped, not coerced.
  assert.deepEqual(
    readStoredAttribution(storageWith(JSON.stringify({ fbclid: 12345, gclid: null, utm_source: {} }))),
    empty,
  );
});

test('a THROWING getItem (locked-down browser) never propagates', () => {
  const hostile = {
    getItem() {
      throw new Error('SecurityError: storage disabled');
    },
  };
  assert.deepEqual(readStoredAttribution(hostile), emptyAdAttribution());
});

test('values are trimmed; whitespace-only is treated as absent', () => {
  const got = readStoredAttribution(
    storageWith(JSON.stringify({ utm_source: '  facebook  ', utm_medium: '   ' })),
  );
  assert.equal(got.utm_source, 'facebook');
  assert.equal(got.utm_medium, '');
});

test('emptyAdAttribution returns a FRESH object each call (no shared mutable)', () => {
  const a = emptyAdAttribution();
  a.fbclid = 'mutated';
  assert.equal(emptyAdAttribution().fbclid, '');
});

// ── hasAdAttribution — "is there anything worth posting?" ──────────────────

test('hasAdAttribution is false for empty/nullish, true for any one value', () => {
  assert.equal(hasAdAttribution(null), false);
  assert.equal(hasAdAttribution(undefined), false);
  assert.equal(hasAdAttribution(emptyAdAttribution()), false);
  assert.equal(hasAdAttribution({ ...emptyAdAttribution(), utm_term: '  ' }), false);
  assert.equal(hasAdAttribution({ ...emptyAdAttribution(), fbclid: 'x' }), true);
});

// ── attributionConsumerFields — the write map ──────────────────────────────

test('only NON-EMPTY values are emitted — an empty snapshot writes nothing', () => {
  assert.deepEqual(attributionConsumerFields(emptyAdAttribution()), {});
  const partial = attributionConsumerFields({ ...emptyAdAttribution(), utm_source: 'facebook' });
  assert.deepEqual(partial, { utm_source: 'facebook' });
});

test('a malformed payload maps to {} — signup/reserve always completes', () => {
  assert.deepEqual(attributionConsumerFields(undefined), {});
  assert.deepEqual(attributionConsumerFields(null), {});
  assert.deepEqual(attributionConsumerFields('fbclid=abc'), {});
  assert.deepEqual(attributionConsumerFields(['fbclid']), {});
  assert.deepEqual(attributionConsumerFields(42), {});
  assert.deepEqual(attributionConsumerFields({ fbclid: { nested: true }, gclid: 7 }), {});
});

test('reader → mapper round-trips the whole snapshot', () => {
  const fields = attributionConsumerFields(
    readStoredAttribution(storageWith(JSON.stringify(FULL_SNAPSHOT))),
  );
  assert.deepEqual(fields, {
    utm_source: 'facebook',
    utm_medium: 'paid',
    utm_campaign: 'az-half-cow',
    utm_content: 'video-a',
    utm_term: 'half cow phoenix',
    fbclid: 'IwAR0testclickid',
    fbclid_ts: '1755300000000',
    gclid: 'Cj0KCQtest',
  });
});
