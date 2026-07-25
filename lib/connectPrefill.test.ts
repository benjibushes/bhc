import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectPrefill, DEFAULT_PRODUCT_DESCRIPTION } from './connectPrefill';

const SITE = 'https://www.buyhalfcow.com';

const FULL = {
  'Slug': 'rep-provisions',
  'About Text': 'Regenerative Oklahoma beef, raised on native prairie.',
  'Phone': '(918) 519-1605',
  'Email': 'justin@repprovisions.com',
  'Ranch Name': 'Rep Provisions',
};

test('full record → every prefill field populated', () => {
  const p = buildConnectPrefill(FULL, SITE);
  assert.equal(p.businessUrl, 'https://www.buyhalfcow.com/ranchers/rep-provisions');
  assert.equal(p.supportUrl, 'https://www.buyhalfcow.com/ranchers/rep-provisions');
  assert.equal(p.productDescription, 'Regenerative Oklahoma beef, raised on native prairie.');
  assert.equal(p.supportPhone, '+19185191605');
  assert.equal(p.businessPhone, '+19185191605');
  assert.equal(p.supportEmail, 'justin@repprovisions.com');
  assert.equal(p.doingBusinessAs, 'Rep Provisions');
});

test('missing slug → no url, but the rest still prefills', () => {
  const p = buildConnectPrefill({ ...FULL, 'Slug': '' }, SITE);
  assert.equal(p.businessUrl, undefined);
  assert.equal(p.supportUrl, undefined);
  assert.equal(p.supportPhone, '+19185191605');
  assert.equal(p.productDescription, FULL['About Text']);
});

test('slug that is not a bare path segment is rejected (never build a broken url)', () => {
  for (const bad of ['https://repprovisions.com', 'a/b', 'has space', '../etc', '/leading']) {
    const p = buildConnectPrefill({ ...FULL, 'Slug': bad }, SITE);
    assert.equal(p.businessUrl, undefined, `slug ${bad} should not produce a url`);
  }
  // the odd-but-legal slug actually in the base today must still work
  assert.equal(
    buildConnectPrefill({ ...FULL, 'Slug': 'https-repprovisions-com' }, SITE).businessUrl,
    'https://www.buyhalfcow.com/ranchers/https-repprovisions-com',
  );
});

test('missing / blank phone → no support_phone and no business phone', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const p = buildConnectPrefill({ ...FULL, 'Phone': blank }, SITE);
    assert.equal(p.supportPhone, undefined);
    assert.equal(p.businessPhone, undefined);
  }
});

test('junk phone is OMITTED, never sent as garbage', () => {
  const junk = [
    '555',                // too short
    'call me',            // no digits
    '000-000-0000',       // repeated-digit placeholder
    '0000000000',         // the old hardcoded placeholder
    '1111111111',
    '(123) 45',           // partial
    '+44 20 7946 0958',   // non-US, would be mangled by a US normalizer
    '019-555-1234',       // invalid NANP area code (leading 0)
    '155-555-1234',       // invalid NANP area code (leading 1)
  ];
  for (const j of junk) {
    const p = buildConnectPrefill({ ...FULL, 'Phone': j }, SITE);
    assert.equal(p.supportPhone, undefined, `junk phone ${j} must be omitted`);
    assert.equal(p.businessPhone, undefined, `junk phone ${j} must be omitted`);
  }
});

test('phone accepts the formats ranchers actually type, incl. leading country code', () => {
  const same = ['9185191605', '918-519-1605', '(918) 519-1605', '+1 918 519 1605', '1 (918) 519-1605'];
  for (const v of same) {
    assert.equal(buildConnectPrefill({ ...FULL, 'Phone': v }, SITE).supportPhone, '+19185191605', v);
  }
});

test('missing About Text → safe default description, never empty', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const p = buildConnectPrefill({ ...FULL, 'About Text': blank }, SITE);
    assert.equal(p.productDescription, DEFAULT_PRODUCT_DESCRIPTION);
  }
});

test('About Text is collapsed to one line and capped for Stripe', () => {
  const p = buildConnectPrefill({ ...FULL, 'About Text': `  line one\n\nline   two  ` }, SITE);
  assert.equal(p.productDescription, 'line one line two');

  const long = buildConnectPrefill({ ...FULL, 'About Text': 'x'.repeat(900) }, SITE);
  assert.ok(long.productDescription.length <= 500, 'description capped');
});

test('invalid email → no support email (never send garbage)', () => {
  for (const bad of ['', 'not-an-email', 'a@b', null]) {
    assert.equal(buildConnectPrefill({ ...FULL, 'Email': bad }, SITE).supportEmail, undefined, String(bad));
  }
});

test('empty record never throws and still yields a usable description', () => {
  const p = buildConnectPrefill({}, SITE);
  assert.equal(p.productDescription, DEFAULT_PRODUCT_DESCRIPTION);
  assert.equal(p.businessUrl, undefined);
  assert.equal(p.supportPhone, undefined);
  assert.equal(p.doingBusinessAs, undefined);
});

test('null/garbage rancher never throws', () => {
  assert.equal(buildConnectPrefill(null as any, SITE).productDescription, DEFAULT_PRODUCT_DESCRIPTION);
  assert.equal(buildConnectPrefill(undefined as any, SITE).productDescription, DEFAULT_PRODUCT_DESCRIPTION);
});

test('trailing slash on siteUrl does not double up', () => {
  const p = buildConnectPrefill(FULL, 'https://www.buyhalfcow.com/');
  assert.equal(p.businessUrl, 'https://www.buyhalfcow.com/ranchers/rep-provisions');
});

test('Airtable {name} object form for Slug/Phone is tolerated', () => {
  const p = buildConnectPrefill({ ...FULL, 'Ranch Name': { name: 'Rep Provisions' } }, SITE);
  assert.equal(p.doingBusinessAs, 'Rep Provisions');
});
