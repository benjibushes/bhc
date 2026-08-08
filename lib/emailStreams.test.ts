import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_STREAM_BY_TEMPLATE,
  MARKETING_TEMPLATES,
  TRANSACTIONAL_TEMPLATES,
  MARKETING_TEMPLATE_PREFIXES,
  resolveEmailStream,
  sendDomainForStream,
  ensureListUnsubscribeHeaders,
} from './emailStreams';

// ─────────────────────────────────────────────────────────────────────
// P2.5 (marketing revamp 2026-08) — stream-keyed sending.
// The classification map is the single source of truth for which domain a
// send rides. The fail-safe direction is one-way: an unknown/missing name
// MUST resolve transactional (apex) — money mail can never accidentally
// ride the marketing subdomain, while a forgotten marketing entry merely
// keeps that lane on the apex (today's behavior).
// ─────────────────────────────────────────────────────────────────────

test('resolveEmailStream: unknown template names fail safe to transactional', () => {
  assert.equal(resolveEmailStream('someBrandNewSenderNobodyClassified'), 'transactional');
});

test('resolveEmailStream: missing/empty template name fails safe to transactional', () => {
  assert.equal(resolveEmailStream(undefined), 'transactional');
  assert.equal(resolveEmailStream(null), 'transactional');
  assert.equal(resolveEmailStream(''), 'transactional');
  assert.equal(resolveEmailStream('   '), 'transactional');
});

// Money-path templates that must NEVER ride the marketing domain. If one of
// these flips 'marketing' in the map, this test is the tripwire.
const MONEY_MUST_BE_TRANSACTIONAL = [
  'sendMagicLink',
  'sendBuyerFinalInvoice',
  'sendInstantCommissionInvoice',
  'sendMonthlyCommissionInvoice',
  'sendPostPurchaseWelcome',
  'sendBuyerShippingNotification',
  'sendBuyerFulfillmentConfirmation',
  'sendRancherDepositPaid',
  'sendRancherFinalPaid',
  'sendWelcomeAndReadyToBuy',
  'buyer_deposit_invoice',
  'deposit_request_nudge_1',
  'deposit_request_nudge_2',
  'quiz_complete_deposit_invite',
  'quiz_complete_cal_invite',
  'buyer_refund_notice',
  'buyer_order_delay',
  'buyer_deposit_delay',
  'sendRancherStopShip',
  'broker_rancher_order',
  'broker_buyer_receipt',
  'broker_represent_confirmation',
  'sendEmail', // the generic default name — callers who never classify
];

for (const t of MONEY_MUST_BE_TRANSACTIONAL) {
  test(`stream map: money/auth template stays transactional: ${t}`, () => {
    assert.equal(resolveEmailStream(t), 'transactional');
  });
}

// The marketing lanes the panel called out (nurture/nudge/digest/campaign/
// reconfirm) — these are the sends that must carry forced List-Unsubscribe
// headers and migrate to MARKETING_SEND_DOMAIN when Ben flips it.
const MARKETING_LANES = [
  'sendNurtureCheckIn',
  'sendNurtureEducation',
  'sendNurtureLongHaul',
  'sendNurtureShopBridge',
  'sendIncompleteProfileAsk',
  'sendWaitingActivationNudge',
  'sendReadyChaseNudge',
  'sendNudgeToEngage',
  'still_looking_reconfirm',
  'ranch_stand_digest',
  'sendBroadcastEmail',
  'state_coverage_opened',
  'sendAbandonedQuizNudge',
  'sendStateWaitlistLetter',
  'sendBackerMonthlyLetter',
  'sendClosedMonthlyLetter',
  'demandRouterMsg1',
  'demandRouterMsg2',
  'demandRouterMsg3',
  'shop_drop_announce',
];

for (const t of MARKETING_LANES) {
  test(`stream map: marketing lane resolves marketing: ${t}`, () => {
    assert.equal(resolveEmailStream(t), 'marketing');
  });
}

test('resolveEmailStream: campaign_ prefix (dynamic campaign names) is marketing', () => {
  assert.equal(resolveEmailStream('campaign_reactivation-tx-300'), 'marketing');
  assert.ok(MARKETING_TEMPLATE_PREFIXES.includes('campaign_'));
});

test('stream map: built from two disjoint lists (no template classified twice)', () => {
  const overlap = MARKETING_TEMPLATES.filter((t) => TRANSACTIONAL_TEMPLATES.includes(t));
  assert.deepEqual(overlap, [], `templates classified BOTH ways: ${overlap.join(', ')}`);
  // No silent duplicate-key overwrite inside either list.
  assert.equal(new Set(MARKETING_TEMPLATES).size, MARKETING_TEMPLATES.length);
  assert.equal(new Set(TRANSACTIONAL_TEMPLATES).size, TRANSACTIONAL_TEMPLATES.length);
  assert.equal(
    Object.keys(EMAIL_STREAM_BY_TEMPLATE).length,
    MARKETING_TEMPLATES.length + TRANSACTIONAL_TEMPLATES.length,
  );
});

test('stream map: every entry is a valid stream', () => {
  for (const [name, stream] of Object.entries(EMAIL_STREAM_BY_TEMPLATE)) {
    assert.ok(
      stream === 'transactional' || stream === 'marketing',
      `${name} has invalid stream ${stream}`,
    );
  }
});

// Every template minted in lib/emailMinimal.ts must be explicitly classified
// (the file routes through generic sendEmail, so nothing else pins it).
const EMAIL_MINIMAL_TEMPLATES = [
  'quiz_complete_cal_invite',
  'quiz_complete_deposit_invite',
  'buyer_deposit_invoice',
  'deposit_request_nudge_1',
  'deposit_request_nudge_2',
  'deposit_request_nudge_mid',
  'still_looking_reconfirm',
  'ranch_stand_digest',
  'sunset_repermission',
  'sendRancherStopShip',
  'buyer_refund_notice',
  'buyer_order_delay',
  'buyer_deposit_delay',
];

for (const t of EMAIL_MINIMAL_TEMPLATES) {
  test(`stream map: emailMinimal template explicitly classified: ${t}`, () => {
    assert.ok(t in EMAIL_STREAM_BY_TEMPLATE, `${t} missing from EMAIL_STREAM_BY_TEMPLATE`);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Domain selection — the round-robin is dead. Same stream, same domain,
// every single call. Defaults keep today's behavior byte-identical.
// ─────────────────────────────────────────────────────────────────────

test('sendDomainForStream: default env → apex for BOTH streams (byte-identical today)', () => {
  assert.equal(sendDomainForStream('transactional', {}), 'buyhalfcow.com');
  assert.equal(sendDomainForStream('marketing', {}), 'buyhalfcow.com');
});

test('sendDomainForStream: multi-entry SEND_DOMAINS never rotates — first entry always wins', () => {
  const env = { SEND_DOMAINS: 'buyhalfcow.com, mail.buyhalfcow.com, bhcbeef.com' };
  for (let i = 0; i < 5; i++) {
    assert.equal(sendDomainForStream('transactional', env), 'buyhalfcow.com');
    assert.equal(sendDomainForStream('marketing', env), 'buyhalfcow.com');
  }
});

test('sendDomainForStream: MARKETING_SEND_DOMAIN moves ONLY the marketing stream', () => {
  const env = { MARKETING_SEND_DOMAIN: 'updates.buyhalfcow.com' };
  assert.equal(sendDomainForStream('marketing', env), 'updates.buyhalfcow.com');
  assert.equal(sendDomainForStream('transactional', env), 'buyhalfcow.com');
});

test('sendDomainForStream: blank/whitespace MARKETING_SEND_DOMAIN falls back to apex', () => {
  assert.equal(sendDomainForStream('marketing', { MARKETING_SEND_DOMAIN: '' }), 'buyhalfcow.com');
  assert.equal(sendDomainForStream('marketing', { MARKETING_SEND_DOMAIN: '   ' }), 'buyhalfcow.com');
});

test('sendDomainForStream: SEND_DOMAINS apex + marketing subdomain coexist', () => {
  const env = { SEND_DOMAINS: 'buyhalfcow.com', MARKETING_SEND_DOMAIN: 'updates.buyhalfcow.com' };
  assert.equal(sendDomainForStream('transactional', env), 'buyhalfcow.com');
  assert.equal(sendDomainForStream('marketing', env), 'updates.buyhalfcow.com');
});

// ─────────────────────────────────────────────────────────────────────
// Centralized List-Unsubscribe injection (panel finding: headers were
// per-caller opt-in while the CAN-SPAM footer was centrally injected — a
// future marketing sender could silently ship without them).
// ─────────────────────────────────────────────────────────────────────

const FAKE_HEADERS = {
  'List-Unsubscribe': '<https://example.com/api/unsubscribe?token=jwt>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

test('ensureListUnsubscribeHeaders: marketing send with no headers gets both headers', () => {
  const out = ensureListUnsubscribeHeaders('marketing', undefined, () => ({ ...FAKE_HEADERS }));
  assert.deepEqual(out, FAKE_HEADERS);
});

test('ensureListUnsubscribeHeaders: marketing send with unrelated headers keeps them and adds both', () => {
  const out = ensureListUnsubscribeHeaders(
    'marketing',
    { 'X-Entity-Ref-ID': 'abc' },
    () => ({ ...FAKE_HEADERS }),
  );
  assert.equal(out?.['X-Entity-Ref-ID'], 'abc');
  assert.equal(out?.['List-Unsubscribe'], FAKE_HEADERS['List-Unsubscribe']);
  assert.equal(out?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('ensureListUnsubscribeHeaders: caller-passed values win on conflict (no duplication)', () => {
  const out = ensureListUnsubscribeHeaders(
    'marketing',
    { 'List-Unsubscribe': '<https://caller.example/custom>' },
    () => ({ ...FAKE_HEADERS }),
  );
  // Existing caller value preserved; only the missing Post header added.
  assert.equal(out?.['List-Unsubscribe'], '<https://caller.example/custom>');
  assert.equal(out?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('ensureListUnsubscribeHeaders: complete marketing headers pass through untouched (builder not called)', () => {
  let builderCalls = 0;
  const existing = { ...FAKE_HEADERS };
  const out = ensureListUnsubscribeHeaders('marketing', existing, () => {
    builderCalls++;
    return { ...FAKE_HEADERS };
  });
  assert.equal(out, existing);
  assert.equal(builderCalls, 0, 'must not mint a fresh JWT when headers already present');
});

test('ensureListUnsubscribeHeaders: header detection is case-insensitive', () => {
  let builderCalls = 0;
  const existing = {
    'list-unsubscribe': '<https://example.com/u>',
    'LIST-UNSUBSCRIBE-POST': 'List-Unsubscribe=One-Click',
  };
  const out = ensureListUnsubscribeHeaders('marketing', existing, () => {
    builderCalls++;
    return { ...FAKE_HEADERS };
  });
  assert.equal(out, existing);
  assert.equal(builderCalls, 0);
});

test('ensureListUnsubscribeHeaders: transactional sends keep current behavior — untouched either way', () => {
  let builderCalls = 0;
  const build = () => {
    builderCalls++;
    return { ...FAKE_HEADERS };
  };
  // Header-less transactional (admin alerts / operator briefs) stays header-less.
  assert.equal(ensureListUnsubscribeHeaders('transactional', undefined, build), undefined);
  // Transactional with caller headers keeps exactly those.
  const existing = { 'List-Unsubscribe': '<https://example.com/u>' };
  assert.equal(ensureListUnsubscribeHeaders('transactional', existing, build), existing);
  assert.equal(builderCalls, 0);
});
