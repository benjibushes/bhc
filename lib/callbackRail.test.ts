import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isCallbackRailEnabled,
  resolveCallbackPhone,
  isPaidLiveDeal,
  isStalledOnRancher,
  resolveMemberCallbackReason,
  STALLED_ON_RANCHER_DAYS,
  CALLBACK_RAIL_FLAG_ENV,
  CALLBACK_PHONE_ENV,
  type EnvBag,
  type MemberCallbackDeal,
} from './callbackRail';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// Synthetic numbers only. This repo is PUBLIC — no real line ever appears in a
// fixture, a comment, or the source. 555-01xx is the reserved fictional block.
const env = (over: EnvBag = {}): EnvBag => ({ ...over });

// ── the master flag ────────────────────────────────────────────────────────

test('the rail is OFF by default — unset env means unset feature', () => {
  assert.equal(isCallbackRailEnabled(env()), false);
  assert.equal(isCallbackRailEnabled({}), false);
});

test('only explicit truthy words turn the rail on', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'On', ' enabled ']) {
    assert.equal(isCallbackRailEnabled(env({ [CALLBACK_RAIL_FLAG_ENV]: on })), true, on);
  }
});

test('anything else leaves the rail off, including near-misses and typos', () => {
  for (const off of ['', '  ', '0', 'false', 'off', 'no', 'disabled', 'ture', 'ON!', 'null']) {
    assert.equal(isCallbackRailEnabled(env({ [CALLBACK_RAIL_FLAG_ENV]: off })), false, off);
  }
});

// ── the phone ──────────────────────────────────────────────────────────────

test('NO number is baked in — unset CALLBACK_PHONE resolves to nothing at all', () => {
  assert.equal(resolveCallbackPhone(env()), null);
  assert.equal(resolveCallbackPhone(env({ [CALLBACK_PHONE_ENV]: '' })), null);
  assert.equal(resolveCallbackPhone(env({ [CALLBACK_PHONE_ENV]: '   ' })), null);
});

test('an unparseable number fails CLOSED rather than rendering a dead tel: link', () => {
  for (const junk of ['call me', '555', '+', '12345', 'n/a']) {
    assert.equal(resolveCallbackPhone(env({ [CALLBACK_PHONE_ENV]: junk })), null, junk);
  }
});

test('a configured US number resolves to E.164, a display form, and both hrefs', () => {
  const p = resolveCallbackPhone(env({ [CALLBACK_PHONE_ENV]: '(555) 010-1234' }));
  assert.ok(p);
  assert.equal(p.e164, '+15550101234');
  assert.equal(p.display, '(555) 010-1234');
  assert.equal(p.telHref, 'tel:+15550101234');
  assert.equal(p.smsHref, 'sms:+15550101234');
});

test('formatting is accepted in any shape a human might paste', () => {
  const shapes = ['5550101234', '555-010-1234', '+1 555 010 1234', '1 (555) 010-1234'];
  for (const s of shapes) {
    assert.equal(resolveCallbackPhone(env({ [CALLBACK_PHONE_ENV]: s }))?.e164, '+15550101234', s);
  }
});

test('a non-US number keeps its E.164 as the display rather than mangling it', () => {
  const p = resolveCallbackPhone(env({ [CALLBACK_PHONE_ENV]: '+442071234567' }));
  assert.ok(p);
  assert.equal(p.e164, '+442071234567');
  assert.equal(p.display, '+442071234567');
});

test('THE TWO SWITCHES ARE INDEPENDENT — flag on with no phone is a real state', () => {
  const e = env({ [CALLBACK_RAIL_FLAG_ENV]: 'true' });
  assert.equal(isCallbackRailEnabled(e), true, 'rail runs...');
  assert.equal(resolveCallbackPhone(e), null, '...with no number to show');

  // …and the mirror: a number configured while the rail is still dark.
  const e2 = env({ [CALLBACK_PHONE_ENV]: '5550101234' });
  assert.equal(isCallbackRailEnabled(e2), false);
  assert.ok(resolveCallbackPhone(e2));
});

// ── who gets the affordance on /member ─────────────────────────────────────

function deal(over: Partial<MemberCallbackDeal> = {}): MemberCallbackDeal {
  return { status: 'Slot Locked', depositPaidAt: daysAgo(30), ...over };
}

test('an unpaid deal is not a paid live deal', () => {
  assert.equal(isPaidLiveDeal(deal({ depositPaidAt: '' })), false);
});

test('a dead deal is never live, however much was paid', () => {
  for (const status of ['Closed Lost', 'Refunded', 'Rejected', 'Lost']) {
    assert.equal(isPaidLiveDeal(deal({ status })), false, status);
  }
});

test('a paid, non-dead deal is live', () => {
  assert.equal(isPaidLiveDeal(deal()), true);
  assert.equal(isPaidLiveDeal(deal({ status: 'Closed Won' })), true);
});

test('stalled needs acceptance AND silence past the window', () => {
  const stalled = deal({ rancherAcceptedAt: daysAgo(STALLED_ON_RANCHER_DAYS + 1) });
  assert.equal(isStalledOnRancher(stalled, NOW), true);
});

test('a deal not yet past the window is quiet, not stalled', () => {
  const young = deal({ rancherAcceptedAt: daysAgo(STALLED_ON_RANCHER_DAYS - 1) });
  assert.equal(isStalledOnRancher(young, NOW), false);
});

test('the window boundary counts as stalled', () => {
  const exact = deal({ rancherAcceptedAt: daysAgo(STALLED_ON_RANCHER_DAYS) });
  assert.equal(isStalledOnRancher(exact, NOW), true);
});

test('never accepted is not stalled — that is a different problem', () => {
  assert.equal(isStalledOnRancher(deal({ rancherAcceptedAt: '' }), NOW), false);
});

test('ANY sign the rancher moved clears the stall, however old the acceptance', () => {
  const long = daysAgo(90);
  const movements: Array<Partial<MemberCallbackDeal>> = [
    { handoffDate: '2026-08-14' },
    { processingDate: '2026-08-01' },
    { fulfillmentStatus: 'packed' },
    { fulfillmentConfirmedAt: daysAgo(1) },
    { finalInvoiceSentAt: daysAgo(2) },
    { finalPaidAt: daysAgo(1) },
  ];
  for (const m of movements) {
    assert.equal(
      isStalledOnRancher(deal({ rancherAcceptedAt: long, ...m }), NOW),
      false,
      JSON.stringify(m),
    );
  }
});

test('an unpaid deal is never stalled — no money, no callback', () => {
  const unpaid = deal({ depositPaidAt: '', rancherAcceptedAt: daysAgo(60) });
  assert.equal(isStalledOnRancher(unpaid, NOW), false);
});

test('a buyer with no paid deal gets NO affordance — browsing is not a reason', () => {
  assert.equal(resolveMemberCallbackReason([], NOW), null);
  assert.equal(resolveMemberCallbackReason(null, NOW), null);
  assert.equal(resolveMemberCallbackReason(undefined, NOW), null);
  assert.equal(resolveMemberCallbackReason([deal({ depositPaidAt: '' })], NOW), null);
  assert.equal(resolveMemberCallbackReason([deal({ status: 'Refunded' })], NOW), null);
});

test('a paying customer gets the affordance', () => {
  assert.equal(resolveMemberCallbackReason([deal()], NOW), 'paid-deal');
});

test('one stalled deal upgrades the reason for the whole dashboard', () => {
  const healthy = deal({ rancherAcceptedAt: daysAgo(1) });
  const stalled = deal({ rancherAcceptedAt: daysAgo(30) });
  assert.equal(resolveMemberCallbackReason([healthy, stalled], NOW), 'stalled-on-rancher');
  assert.equal(resolveMemberCallbackReason([healthy], NOW), 'paid-deal');
});

test('a stalled-looking DEAD deal cannot upgrade the reason', () => {
  const deadStalled = deal({ status: 'Refunded', rancherAcceptedAt: daysAgo(30) });
  const healthy = deal({ rancherAcceptedAt: daysAgo(1) });
  assert.equal(resolveMemberCallbackReason([deadStalled, healthy], NOW), 'paid-deal');
});

// ── the guardrail this whole module exists to hold ─────────────────────────

// Anything shaped like a North American number: optional +1, 3 digits,
// separator, 3 digits, separator, 4 digits. Deliberately loose.
const PHONE_SHAPED = /\+?1?[\s.\-–]?\(?\d{3}\)?[\s.\-–]?\d{3}[\s.\-–]?\d{4}/;

test('NO phone number is hardcoded anywhere in the callback rail', () => {
  // The regression this pins: someone "helpfully" restoring a default so the
  // affordance renders in dev, or pasting the real line into copy. There is no
  // number in this repository — if CALLBACK_PHONE is unset, nothing renders.
  const files = [
    '../lib/callbackRail.ts',
    '../lib/callbackQueue.ts',
    '../lib/salesContact.ts',
    '../app/api/callback-request/route.ts',
    '../app/components/CallbackRequest.tsx',
    '../app/checkout/[refId]/deposit/page.tsx',
    '../app/member/page.tsx',
    '../app/api/admin/desk/route.ts',
  ];
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    const hit = src.match(PHONE_SHAPED);
    assert.equal(hit, null, `${f} must not contain a phone number (found ${hit?.[0]})`);
  }
});
