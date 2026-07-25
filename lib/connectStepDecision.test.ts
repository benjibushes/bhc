import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectStateFrom,
  humanizeRequirement,
  humanizeRequirements,
  decideConnectReturnStep,
  goLiveReadiness,
  hasSellablePrice,
} from './connectStepDecision';

// ── connectStateFrom ───────────────────────────────────────────────────────

test('connectStateFrom maps the #480 handoff vocabulary', () => {
  assert.equal(connectStateFrom('active'), 'active');
  assert.equal(connectStateFrom('restricted'), 'restricted');
  assert.equal(connectStateFrom('incomplete'), 'incomplete');
  assert.equal(connectStateFrom('never_started'), 'never_started');
});

test('connectStateFrom maps the Airtable-cache vocabulary', () => {
  assert.equal(connectStateFrom('onboarding'), 'incomplete');
  assert.equal(connectStateFrom('not_connected'), 'never_started');
  assert.equal(connectStateFrom('Active'), 'active');
  assert.equal(connectStateFrom('  RESTRICTED  '), 'restricted');
});

test('connectStateFrom returns null for "we do not know" — never never_started', () => {
  // The distinction that matters: a FAILED read must not render a
  // start-from-scratch CTA to a rancher who is already mid-KYC.
  for (const unknown of ['', '   ', null, undefined, 'unknown', 'banana', 0, {}, []]) {
    assert.equal(connectStateFrom(unknown), null, JSON.stringify(unknown));
  }
});

// ── humanizeRequirement ────────────────────────────────────────────────────

test('humanizeRequirement translates the codes our five stalled ranchers hit', () => {
  assert.equal(
    humanizeRequirement('identity.attestations.terms_of_service.account'),
    'Accept Stripe’s terms of service',
  );
  assert.equal(
    humanizeRequirement('payout_method.bank_account'),
    'Add your bank account (routing + account number)',
  );
  assert.equal(
    humanizeRequirement('identity.individual.id_numbers'),
    'Verify your identity (last 4 of your SSN)',
  );
});

test('humanizeRequirement covers the rest of the common V2 due list', () => {
  const cases: Array<[string, string]> = [
    ['identity.individual.verification.document', 'Upload a photo ID'],
    ['identity.entity.tax_id', 'Add your business tax ID (EIN)'],
    ['identity.individual.date_of_birth', 'Add your date of birth'],
    ['identity.business_details.product_description', 'Describe what you sell in a sentence'],
    ['identity.business_details.url', 'Add your website (or a note about where you sell)'],
    ['identity.entity.ownership_declaration', 'Confirm who owns or represents the ranch'],
    ['identity.individual.address', 'Confirm your address'],
    ['identity.individual.phone', 'Confirm your phone number'],
    ['identity.individual.email', 'Confirm your email address'],
    ['identity.individual.name', 'Confirm your legal name'],
  ];
  for (const [code, expected] of cases) {
    assert.equal(humanizeRequirement(code), expected, code);
  }
});

test('humanizeRequirement degrades to a readable code, never to a blank bullet', () => {
  assert.equal(humanizeRequirement('identity.some_future.thing_stripe_adds'), 'Some future thing stripe adds');
  assert.equal(humanizeRequirement('mystery'), 'Mystery');
  assert.equal(humanizeRequirement(''), '');
  assert.equal(humanizeRequirement(null), '');
  assert.equal(humanizeRequirement(undefined), '');
});

test('humanizeRequirements de-dupes phrases and survives garbage input', () => {
  assert.deepEqual(
    humanizeRequirements([
      'identity.attestations.terms_of_service.account',
      'identity.attestations.terms_of_service.shipping',
      'payout_method.bank_account',
    ]),
    ['Accept Stripe’s terms of service', 'Add your bank account (routing + account number)'],
  );
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(humanizeRequirements(bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(humanizeRequirements(['', null, undefined]), []);
});

// ── decideConnectReturnStep — the 11→6 loop, every combination ─────────────

const STATES = ['active', 'incomplete', 'restricted', 'never_started', 'unknown', '', null] as const;

test('decideConnectReturnStep: full matrix — nothing advances past 9 unless active', () => {
  for (const connectStatus of STATES) {
    for (const fulfillmentDone of [true, false]) {
      for (const agreementSigned of [true, false]) {
        const { step } = decideConnectReturnStep({
          connectStatus,
          fulfillmentDone,
          agreementSigned,
        });
        const label = `${String(connectStatus)}/${fulfillmentDone}/${agreementSigned}`;
        if (connectStatus === 'active') {
          const expected = !fulfillmentDone ? 8 : agreementSigned ? 6 : 5;
          assert.equal(step, expected, label);
        } else {
          assert.equal(step, 9, label);
        }
      }
    }
  }
});

test('decideConnectReturnStep: the exact bug — pending KYC no longer walks to Sign', () => {
  // BEFORE: fulfillmentDone && !agreementSigned → step 5 regardless of Connect.
  // They signed, did not go live, and the Done screen told them to connect the
  // bank they thought they had just connected.
  assert.deepEqual(
    decideConnectReturnStep({ connectStatus: 'incomplete', fulfillmentDone: true, agreementSigned: false }),
    { step: 9, reason: 'connect-not-active' },
  );
  assert.deepEqual(
    decideConnectReturnStep({ connectStatus: 'restricted', fulfillmentDone: true, agreementSigned: false }),
    { step: 9, reason: 'connect-not-active' },
  );
});

test('decideConnectReturnStep: an unread status fails CLOSED', () => {
  for (const unknown of [null, undefined, '', 'unknown']) {
    assert.equal(
      decideConnectReturnStep({
        connectStatus: unknown,
        fulfillmentDone: true,
        agreementSigned: false,
      }).step,
      9,
      String(unknown),
    );
  }
});

test('decideConnectReturnStep: active + every downstream combination', () => {
  assert.deepEqual(
    decideConnectReturnStep({ connectStatus: 'active', fulfillmentDone: false, agreementSigned: false }),
    { step: 8, reason: 'fulfillment-missing' },
  );
  assert.deepEqual(
    decideConnectReturnStep({ connectStatus: 'active', fulfillmentDone: false, agreementSigned: true }),
    { step: 8, reason: 'fulfillment-missing' },
  );
  assert.deepEqual(
    decideConnectReturnStep({ connectStatus: 'active', fulfillmentDone: true, agreementSigned: true }),
    { step: 6, reason: 'already-signed' },
  );
  assert.deepEqual(
    decideConnectReturnStep({ connectStatus: 'active', fulfillmentDone: true, agreementSigned: false }),
    { step: 5, reason: 'ready-to-sign' },
  );
});

test('decideConnectReturnStep: legacy ranchers are never gated on Connect', () => {
  // connectRequired:false is the legacy (non-tier_v2) road — own payment link,
  // commission invoiced. Gating them on Connect would strand every one of them.
  assert.deepEqual(
    decideConnectReturnStep({
      connectStatus: 'never_started',
      fulfillmentDone: true,
      agreementSigned: false,
      connectRequired: false,
    }),
    { step: 5, reason: 'ready-to-sign' },
  );
  assert.deepEqual(
    decideConnectReturnStep({
      connectStatus: null,
      fulfillmentDone: false,
      agreementSigned: false,
      connectRequired: false,
    }),
    { step: 8, reason: 'fulfillment-missing' },
  );
  assert.deepEqual(
    decideConnectReturnStep({
      connectStatus: null,
      fulfillmentDone: true,
      agreementSigned: true,
      connectRequired: false,
    }),
    { step: 6, reason: 'already-signed' },
  );
});

test('decideConnectReturnStep: connectRequired defaults to true (gated) when omitted', () => {
  assert.equal(
    decideConnectReturnStep({ connectStatus: 'incomplete', fulfillmentDone: true, agreementSigned: false }).step,
    9,
  );
  assert.equal(
    decideConnectReturnStep({
      connectStatus: 'incomplete',
      fulfillmentDone: true,
      agreementSigned: false,
      connectRequired: undefined,
    }).step,
    9,
  );
});

test('decideConnectReturnStep never emits a step outside the road', () => {
  for (const connectStatus of STATES) {
    for (const fulfillmentDone of [true, false]) {
      for (const agreementSigned of [true, false]) {
        for (const connectRequired of [true, false, undefined]) {
          const { step } = decideConnectReturnStep({
            connectStatus,
            fulfillmentDone,
            agreementSigned,
            connectRequired,
          });
          assert.ok([5, 6, 8, 9].includes(step), `${String(connectStatus)} → ${step}`);
        }
      }
    }
  }
});

// ── goLiveReadiness — mirrors sign-agreement's readyToGoLive exactly ───────

test('goLiveReadiness: tier_v2 needs slug + price + ACTIVE connect', () => {
  const base = { pricingModel: 'tier_v2', hasSlug: true, hasPrice: true, hasPaymentLink: false };
  assert.equal(goLiveReadiness({ ...base, connectStatus: 'active' }).readyToGoLive, true);
  assert.equal(goLiveReadiness({ ...base, connectStatus: 'onboarding' }).readyToGoLive, false);
  assert.equal(goLiveReadiness({ ...base, connectStatus: 'restricted' }).readyToGoLive, false);
  assert.equal(goLiveReadiness({ ...base, connectStatus: '' }).readyToGoLive, false);
});

test('goLiveReadiness: tier_v2 does NOT require a legacy payment link', () => {
  // Gating tier_v2 on hasPaymentLink would leave every one of them dark —
  // sign-agreement is explicit about this.
  const r = goLiveReadiness({
    pricingModel: 'tier_v2',
    hasSlug: true,
    hasPrice: true,
    hasPaymentLink: false,
    connectStatus: 'active',
  });
  assert.equal(r.readyToGoLive, true);
  assert.deepEqual(r.blockers, []);
});

test('goLiveReadiness: legacy needs slug + price + payment link, and IGNORES connect', () => {
  const base = { pricingModel: 'legacy', hasSlug: true, hasPrice: true, hasPaymentLink: true };
  assert.equal(goLiveReadiness({ ...base, connectStatus: 'not_connected' }).readyToGoLive, true);
  assert.equal(goLiveReadiness({ ...base, connectStatus: 'restricted' }).readyToGoLive, true);
  assert.equal(
    goLiveReadiness({ ...base, hasPaymentLink: false, connectStatus: 'active' }).readyToGoLive,
    false,
  );
  assert.deepEqual(
    goLiveReadiness({ ...base, hasPaymentLink: false }).blockers.map((b) => b.key),
    ['payment_link'],
  );
});

test('goLiveReadiness: an unset/blank pricing model is treated as legacy', () => {
  // Mirrors sign-agreement: String(rancher['Pricing Model'] || 'legacy').
  for (const model of ['', null, undefined, 'legacy', 'LEGACY']) {
    const r = goLiveReadiness({
      pricingModel: model,
      hasSlug: true,
      hasPrice: true,
      hasPaymentLink: true,
      connectStatus: 'never_started',
    });
    assert.equal(r.readyToGoLive, true, String(model));
  }
  assert.equal(
    goLiveReadiness({
      pricingModel: 'TIER_V2',
      hasSlug: true,
      hasPrice: true,
      hasPaymentLink: true,
      connectStatus: 'never_started',
    }).readyToGoLive,
    false,
  );
});

test('goLiveReadiness: missing slug and price are both reported, in order', () => {
  const r = goLiveReadiness({
    pricingModel: 'tier_v2',
    hasSlug: false,
    hasPrice: false,
    hasPaymentLink: false,
    connectStatus: 'incomplete',
  });
  assert.deepEqual(r.blockers.map((b) => b.key), ['slug', 'price', 'connect']);
  assert.equal(r.readyToGoLive, false);
});

test('goLiveReadiness: the CTA never over-promises', () => {
  const ready = goLiveReadiness({
    pricingModel: 'tier_v2',
    hasSlug: true,
    hasPrice: true,
    hasPaymentLink: false,
    connectStatus: 'active',
  });
  assert.equal(ready.ctaLabel, 'Sign & go live →');
  assert.match(ready.promise, /your page goes live/);

  const notReady = goLiveReadiness({
    pricingModel: 'tier_v2',
    hasSlug: true,
    hasPrice: false,
    hasPaymentLink: false,
    connectStatus: 'incomplete',
  });
  assert.equal(notReady.ctaLabel, 'Sign the agreement →');
  // It must NOT claim the page goes live on signature…
  assert.ok(!/Sign and your page goes live/.test(notReady.promise));
  // …and it must name exactly what is left.
  assert.match(notReady.promise, /a price on at least one share/);
  assert.match(notReady.promise, /your bank connected through Stripe/);
});

test('goLiveReadiness: blocker list reads as English at 1, 2 and 3 items', () => {
  const one = goLiveReadiness({
    pricingModel: 'legacy',
    hasSlug: true,
    hasPrice: false,
    hasPaymentLink: true,
  });
  assert.match(one.promise, /once you add a price on at least one share\./);

  const two = goLiveReadiness({
    pricingModel: 'legacy',
    hasSlug: true,
    hasPrice: false,
    hasPaymentLink: false,
  });
  assert.match(two.promise, /a price on at least one share and a payment link on at least one share\./);

  const three = goLiveReadiness({
    pricingModel: 'legacy',
    hasSlug: false,
    hasPrice: false,
    hasPaymentLink: false,
  });
  assert.match(three.promise, /your page address, a price on at least one share, and a payment link/);
});

// ── hasSellablePrice — step 3's money guard ───────────────────────────────

test('hasSellablePrice: a price only counts on a tier the rancher SELLS', () => {
  // Step 3 nulls unsold tiers before saving, so a price on an unsold tier is
  // about to be erased — counting it would wave a rancher through to a page
  // with no buyable price on it.
  assert.equal(hasSellablePrice(['Half'], { 'Half Price': 1800 }), true);
  assert.equal(hasSellablePrice(['Half'], { 'Quarter Price': 900 }), false);
  assert.equal(hasSellablePrice(['Quarter', 'Whole'], { 'Whole Price': '3400' }), true);
});

test('hasSellablePrice: no tiers selected is never sellable', () => {
  assert.equal(hasSellablePrice([], { 'Half Price': 1800 }), false);
  assert.equal(hasSellablePrice(null, { 'Half Price': 1800 }), false);
  assert.equal(hasSellablePrice(undefined, { 'Half Price': 1800 }), false);
  assert.equal(hasSellablePrice('Half', { 'Half Price': 1800 }), false);
});

test('hasSellablePrice: blank, zero, negative and non-numeric prices do not count', () => {
  for (const bad of ['', null, undefined, 0, '0', -1, 'abc', NaN, {}]) {
    assert.equal(
      hasSellablePrice(['Half'], { 'Half Price': bad }),
      false,
      JSON.stringify(bad),
    );
  }
});

test('hasSellablePrice: one good tier among several is enough', () => {
  assert.equal(
    hasSellablePrice(['Quarter', 'Half', 'Whole'], {
      'Quarter Price': '',
      'Half Price': 0,
      'Whole Price': 3400,
    }),
    true,
  );
});

test('hasSellablePrice: a missing prices object never throws', () => {
  assert.equal(hasSellablePrice(['Half'], null), false);
  assert.equal(hasSellablePrice(['Half'], undefined), false);
  assert.equal(hasSellablePrice(['Half'], {}), false);
});
