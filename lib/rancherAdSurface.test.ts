// lib/rancherAdSurface.test.ts
// Runner: npm test  (glob picks this up as lib/**/*.test.ts)
//
// Pins for the six paid-ads defects found in the 2026-08-18 live ad-readiness
// audit of /ranchers/[slug]. Every pin is asserted BOTH directions — the true
// case renders, the false case does not — because each of these bugs was a
// claim that rendered unconditionally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickOgImage,
  SITE_OG_DEFAULT,
  heroTrustPill,
  reachLine,
  normalizeFulfillmentTypes,
  isWriteAReviewUrl,
  readableReviewsUrl,
  getVideoEmbedUrl,
} from './rancherAdSurface';

// ── 1. og:image — the hero photo, not the logo ───────────────────────────────
// LIVE BUG: the logo won unconditionally, so every FB/IG/LinkedIn preview for
// every ranch was a black-and-white logo on white instead of cattle or food,
// AND the declared 800x600 was wrong for every real asset (802x659 / 1000x1000
// / 1500x541), so the crop was wrong too.

test('pickOgImage prefers the first gallery photo (the hero) over the logo', () => {
  const og = pickOgImage(
    {
      'Gallery Photos': JSON.stringify([
        'https://renickvalley.com/wp-content/uploads/2025/11/ribeyeshome.jpg',
        'https://renickvalley.com/second.jpg',
      ]),
      'Logo URL': 'https://renickvalley.com/wp-content/uploads/2025/03/Logo-original.png',
    },
    'Renick Valley Meats',
  );
  assert.equal(og.url, 'https://renickvalley.com/wp-content/uploads/2025/11/ribeyeshome.jpg');
  assert.equal(og.alt, 'Renick Valley Meats');
});

test('pickOgImage falls back to the logo ONLY when there is no gallery photo', () => {
  const og = pickOgImage(
    { 'Gallery Photos': '[]', 'Logo URL': 'https://s3.example.com/2m-cattle-logo.png' },
    '2M Cattle Co.',
  );
  assert.equal(og.url, 'https://s3.example.com/2m-cattle-logo.png');
  assert.equal(og.alt, '2M Cattle Co.');
});

test('pickOgImage falls back to the site card when there is neither (ZK Ranches)', () => {
  const og = pickOgImage({ 'Gallery Photos': '', 'Logo URL': '' }, 'ZK Ranches');
  assert.equal(og.url, SITE_OG_DEFAULT);
  assert.equal(og.alt, 'BuyHalfCow');
  // The site card is OURS — we know its real dimensions, so we may declare them.
  assert.equal(og.width, 1200);
  assert.equal(og.height, 630);
});

test('pickOgImage NEVER declares dimensions for a rancher-supplied asset', () => {
  // Root cause of the wrong crop: the page hardcoded 800x600 for assets whose
  // real sizes are 802x659 / 1000x1000 / 1500x541. We cannot know a remote
  // asset's size at build time, so we omit the hint rather than lie about it.
  const hero = pickOgImage(
    { 'Gallery Photos': JSON.stringify(['https://cdn.example.com/cattle.jpg']), 'Logo URL': '' },
    'Champion Valley Farm',
  );
  assert.equal(hero.width, undefined);
  assert.equal(hero.height, undefined);

  const logo = pickOgImage({ 'Gallery Photos': '', 'Logo URL': 'https://cdn.example.com/logo.png' }, 'X');
  assert.equal(logo.width, undefined);
  assert.equal(logo.height, undefined);
});

test('pickOgImage survives bad Gallery Photos JSON and non-URL junk', () => {
  assert.equal(
    pickOgImage({ 'Gallery Photos': '{not json', 'Logo URL': 'https://cdn.example.com/logo.png' }, 'X').url,
    'https://cdn.example.com/logo.png',
  );
  // A relative path / handle in the gallery must not become an og:image.
  assert.equal(
    pickOgImage(
      { 'Gallery Photos': JSON.stringify(['/uploads/cow.jpg', 'coming soon']), 'Logo URL': '' },
      'X',
    ).url,
    SITE_OG_DEFAULT,
  );
  assert.equal(pickOgImage(null, 'X').url, SITE_OG_DEFAULT);
});

test('pickOgImage normalizes Drive/Dropbox share links into raw-asset URLs', () => {
  const og = pickOgImage(
    {
      'Gallery Photos': JSON.stringify(['https://drive.google.com/file/d/ABC123/view?usp=sharing']),
      'Logo URL': '',
    },
    'X',
  );
  assert.equal(og.url, 'https://drive.google.com/uc?export=view&id=ABC123');
});

// ── 2. the verified pill must be earned ──────────────────────────────────────
// LIVE BUG: "✓ Verified partner" rendered for every non-prospect, non-broker
// ranch regardless of Verification Status. Live false claims on 2026-08-18:
// Champion Valley Farm ('Not Started'), DD Ranch (blank), Thomas Cattle (blank).

test('heroTrustPill renders `verified` ONLY for a genuinely Verified ranch', () => {
  assert.equal(heroTrustPill({ 'Verification Status': 'Verified' }), 'verified');
  // Airtable single-selects can arrive as {name}.
  assert.equal(heroTrustPill({ 'Verification Status': { name: 'Verified' } }), 'verified');
});

test('heroTrustPill renders NOTHING for the live false-claim ranches', () => {
  // Champion Valley Farm — Verification Status = 'Not Started', Onboarding Live.
  assert.equal(heroTrustPill({ 'Verification Status': 'Not Started', 'Onboarding Status': 'Live' }), null);
  // DD Ranch / Thomas Cattle — Verification Status blank, Onboarding Live.
  assert.equal(heroTrustPill({ 'Verification Status': '', 'Onboarding Status': 'Live' }), null);
  assert.equal(heroTrustPill({ 'Onboarding Status': 'Live' }), null);
  assert.equal(heroTrustPill({}), null);
  assert.equal(heroTrustPill(null), null);
});

test('heroTrustPill: Onboarding Status = Live does NOT buy the verified pill', () => {
  // Deliberate divergence from lib/mapPinStatus.derivePinStatus, which treats
  // Live as verified for PIN BUCKETING. A pin colour is not a trust claim; the
  // words "Verified partner" on an ad landing page are. Only the verification
  // field itself may assert verification.
  assert.notEqual(heroTrustPill({ 'Onboarding Status': 'Live' }), 'verified');
});

test('heroTrustPill: prospect wins over everything (unclaimed listing)', () => {
  assert.equal(heroTrustPill({ 'Verification Status': 'Prospect' }), 'prospect');
});

test('heroTrustPill: a represented (broker self-serve) ranch keeps its own pill', () => {
  const gilaRiver = { 'Broker Rail': true, 'Broker Self Serve': true, 'Ranch Name': 'Gila River Cattle' };
  assert.equal(heroTrustPill(gilaRiver), 'represented');
  // ...and never the verified one, even if someone stamps the field.
  assert.equal(heroTrustPill({ ...gilaRiver, 'Verification Status': 'Verified' }), 'verified');
});

// ── 3. "Ships to" must mean the ranch ships ──────────────────────────────────
// LIVE BUG: Champion Valley (Local Pickup + Local Delivery ONLY) rendered
// "Ships to NE, CO, KS". So did Renick Valley (WV, VA) and Gift Farms
// (OK, TX, KS, NM, CO) — none of the three ship.

test('normalizeFulfillmentTypes handles string[] and legacy [{name}]', () => {
  assert.deepEqual(normalizeFulfillmentTypes(['Local Pickup', 'Local Delivery']), ['Local Pickup', 'Local Delivery']);
  assert.deepEqual(normalizeFulfillmentTypes([{ name: 'Cold-Chain Shipping' }]), ['Cold-Chain Shipping']);
  assert.deepEqual(normalizeFulfillmentTypes(undefined), []);
  assert.deepEqual(normalizeFulfillmentTypes('Local Pickup'), []);
});

test('reachLine says "Ships to" only when Cold-Chain Shipping is on the record', () => {
  // Foodstead — Cold-Chain Shipping + Local Pickup, MT → MT, ID, WA.
  assert.deepEqual(
    reachLine({
      'Fulfillment Types': ['Cold-Chain Shipping', 'Local Pickup'],
      'States Served': 'MT, ID, WA',
      State: 'MT',
    }),
    { label: 'Ships to', states: 'MT, ID, WA' },
  );
  // Silverline — shipping only.
  assert.deepEqual(
    reachLine({ 'Fulfillment Types': ['Cold-Chain Shipping'], 'States Served': 'MO, KS', State: 'MO' }),
    { label: 'Ships to', states: 'MO, KS' },
  );
});

test('reachLine NEVER says ships for a pickup/delivery ranch (Champion Valley)', () => {
  const champion = {
    'Fulfillment Types': ['Local Delivery', 'Local Pickup'],
    'States Served': 'NE, CO, KS',
    State: 'NE',
  };
  const line = reachLine(champion);
  assert.deepEqual(line, { label: 'Pickup and local delivery in', states: 'NE, CO, KS' });
  assert.doesNotMatch(String(line?.label), /ship/i);
});

test('reachLine covers every fulfillment branch truthfully', () => {
  const base = { 'States Served': 'OK, TX', State: 'OK' };
  // Gift Farms — Local Delivery only, across 5 states.
  assert.equal(reachLine({ ...base, 'Fulfillment Types': ['Local Delivery'] })?.label, 'Local delivery in');
  assert.equal(reachLine({ ...base, 'Fulfillment Types': ['Local Pickup'] })?.label, 'Local pickup in');
  assert.equal(
    reachLine({ ...base, 'Fulfillment Types': ['Local Pickup', 'Local Delivery'] })?.label,
    'Pickup and local delivery in',
  );
  // Unknown fulfillment (All Natural Homestead Beef: no Fulfillment Types,
  // States Served = 'CO, WY') — the neutral verb claims no method at all.
  assert.equal(reachLine({ ...base, 'Fulfillment Types': [] })?.label, 'Serves');
  assert.equal(reachLine(base)?.label, 'Serves');
  // Shipping wins whenever it is present, whatever else is.
  assert.equal(
    reachLine({ ...base, 'Fulfillment Types': ['Local Pickup', 'Local Delivery', 'Cold-Chain Shipping'] })?.label,
    'Ships to',
  );
});

test('reachLine hides when there is nothing extra to say', () => {
  assert.equal(reachLine({ 'States Served': '', State: 'TX' }), null);
  // Redundant with the ranch's own state (TX PRIME, 5 Bar, JC's, Matula).
  assert.equal(reachLine({ 'States Served': 'TX', State: 'TX', 'Fulfillment Types': ['Cold-Chain Shipping'] }), null);
  assert.equal(reachLine({ 'States Served': '  tx ', State: 'TX' }), null);
  assert.equal(reachLine(null), null);
});

// ── 5. YouTube Shorts ────────────────────────────────────────────────────────
// LIVE BUG: the matcher handled youtu.be/, ?v=, /embed and vimeo — but not
// /shorts/. Renick Valley AND 5 Bar Beef both store Shorts URLs, so both
// videos silently never rendered.

test('getVideoEmbedUrl matches youtube.com/shorts (the live misses)', () => {
  assert.equal(
    getVideoEmbedUrl('https://www.youtube.com/shorts/vaRyPu4hqFw'),
    'https://www.youtube.com/embed/vaRyPu4hqFw',
  );
  // 5 Bar Beef: no www, and a share-tracking query.
  assert.equal(
    getVideoEmbedUrl('https://youtube.com/shorts/T001fLY61L4?si=d3-Zuz4gH9zUfzTY'),
    'https://www.youtube.com/embed/T001fLY61L4',
  );
  assert.equal(getVideoEmbedUrl('youtube.com/shorts/T001fLY61L4'), 'https://www.youtube.com/embed/T001fLY61L4');
});

test('getVideoEmbedUrl keeps every form it already handled', () => {
  assert.equal(getVideoEmbedUrl('https://youtu.be/euZSFSTivIw'), 'https://www.youtube.com/embed/euZSFSTivIw');
  assert.equal(getVideoEmbedUrl('https://youtu.be/ZtLIBLxfMBE?t=30'), 'https://www.youtube.com/embed/ZtLIBLxfMBE');
  assert.equal(
    getVideoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  );
  assert.equal(
    getVideoEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'),
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  );
});

test('getVideoEmbedUrl handles the other common YouTube shapes', () => {
  assert.equal(getVideoEmbedUrl('https://www.youtube.com/live/abcdefghijk'), 'https://www.youtube.com/embed/abcdefghijk');
  assert.equal(getVideoEmbedUrl('https://www.youtube.com/v/abcdefghijk'), 'https://www.youtube.com/embed/abcdefghijk');
  assert.equal(
    getVideoEmbedUrl('https://m.youtube.com/watch?app=desktop&v=abcdefghijk'),
    'https://www.youtube.com/embed/abcdefghijk',
  );
});

test('getVideoEmbedUrl turns a plain vimeo link into an embeddable player URL', () => {
  // A bare vimeo.com/<id> was returned as-is and refuses to load in an iframe.
  assert.equal(getVideoEmbedUrl('https://vimeo.com/76979871'), 'https://player.vimeo.com/video/76979871');
  assert.equal(
    getVideoEmbedUrl('https://player.vimeo.com/video/76979871'),
    'https://player.vimeo.com/video/76979871',
  );
});

test('getVideoEmbedUrl returns null for junk (the section stays hidden)', () => {
  assert.equal(getVideoEmbedUrl(''), null);
  assert.equal(getVideoEmbedUrl('coming soon'), null);
  assert.equal(getVideoEmbedUrl('https://www.tiktok.com/@x/video/123'), null);
  assert.equal(getVideoEmbedUrl('https://www.youtube.com/shorts/tooshort'), null);
  assert.equal(getVideoEmbedUrl(null as any), null);
});

// ── 6. a "Reviews" link must lead to reviews you can READ ────────────────────
// LIVE BUG: Renick Valley's Google Reviews URL is g.page/r/<CID>/review — a
// WRITE-a-review deep link that dead-ends at a Google sign-in wall — rendered
// under the label "Reviews".

test('isWriteAReviewUrl catches the Google write-a-review shapes', () => {
  assert.equal(isWriteAReviewUrl('https://g.page/r/CRvZcrCGhd__EAE/review'), true);
  assert.equal(isWriteAReviewUrl('https://g.page/renick-valley/review/'), true);
  assert.equal(isWriteAReviewUrl('https://search.google.com/local/writereview?placeid=ChIJabc'), true);
  assert.equal(isWriteAReviewUrl('https://www.yelp.com/writeareview/biz/abc123'), true);
});

test('isWriteAReviewUrl leaves genuine reviews-to-READ links alone', () => {
  // ZK Ranches — a Google search results URL for "<ranch> reviews".
  assert.equal(isWriteAReviewUrl('https://www.google.com/search?q=zk+ranches+reviews'), false);
  // Silverline — a Facebook reviews TAB (plural path, a read surface).
  assert.equal(
    isWriteAReviewUrl('https://www.facebook.com/silverlinecattleco/reviews/?id=615&sk=reviews'),
    false,
  );
  // Brimstone — a Google share shortlink.
  assert.equal(isWriteAReviewUrl('https://share.google/PBiIVvAt34Dc58DiZ'), false);
  // Trustpilot's READ page is /review/<domain> — must not be mistaken for a form.
  assert.equal(isWriteAReviewUrl('https://www.trustpilot.com/review/buyhalfcow.com'), false);
  assert.equal(isWriteAReviewUrl(''), false);
});

test('readableReviewsUrl suppresses a write-a-review link and passes a readable one', () => {
  assert.equal(readableReviewsUrl('https://g.page/r/CRvZcrCGhd__EAE/review'), '');
  assert.equal(
    readableReviewsUrl('https://www.google.com/search?q=zk+ranches+reviews'),
    'https://www.google.com/search?q=zk+ranches+reviews',
  );
  // Still inherits the safeExternalUrl guard: handles/statuses never become hrefs.
  assert.equal(readableReviewsUrl('coming soon'), '');
  assert.equal(readableReviewsUrl('javascript:alert(1)'), '');
});
