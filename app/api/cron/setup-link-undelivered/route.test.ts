import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectUndeliveredSetupLinks,
  ONBOARDING_SETUP_TEMPLATES,
  type SetupSendRow,
  type RancherLite,
} from './route';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const minsAgo = (m: number) => NOW - m * 60_000;

function send(over: Partial<SetupSendRow>): SetupSendRow {
  return {
    recipientEmail: 'a@ranch.test',
    templateName: 'sendRancherApplyAutoApproved',
    sentAtMs: minsAgo(120),
    hasDeliverySignal: false,
    ...over,
  };
}

test('flags an onboarding send with no delivery signal to a pre-live rancher', () => {
  const sends = [send({})];
  const ranchers: RancherLite[] = [{ email: 'a@ranch.test', pageLive: false }];
  const hits = selectUndeliveredSetupLinks(sends, ranchers, NOW, 60);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].email, 'a@ranch.test');
  assert.equal(hits[0].minutesAgo, 120);
});

test('a delivered/bounced signal clears the hit', () => {
  const sends = [send({ hasDeliverySignal: true })];
  const ranchers: RancherLite[] = [{ email: 'a@ranch.test', pageLive: false }];
  assert.equal(selectUndeliveredSetupLinks(sends, ranchers, NOW, 60).length, 0);
});

test('an already-live rancher is not chased (link clearly landed)', () => {
  const sends = [send({})];
  const ranchers: RancherLite[] = [{ email: 'a@ranch.test', pageLive: true }];
  assert.equal(selectUndeliveredSetupLinks(sends, ranchers, NOW, 60).length, 0);
});

test('a live record for the same email wins over a pre-live duplicate', () => {
  const sends = [send({})];
  const ranchers: RancherLite[] = [
    { email: 'a@ranch.test', pageLive: false },
    { email: 'A@Ranch.Test', pageLive: true }, // case-insensitive, live
  ];
  assert.equal(selectUndeliveredSetupLinks(sends, ranchers, NOW, 60).length, 0);
});

test('a send too fresh (under threshold) is held — webhook may still arrive', () => {
  const sends = [send({ sentAtMs: minsAgo(30) })];
  const ranchers: RancherLite[] = [{ email: 'a@ranch.test', pageLive: false }];
  assert.equal(selectUndeliveredSetupLinks(sends, ranchers, NOW, 60).length, 0);
  // past the threshold it flags
  assert.equal(selectUndeliveredSetupLinks(sends, ranchers, NOW, 20).length, 1);
});

test('a send with no matching rancher is skipped (cannot confirm pre-live)', () => {
  const sends = [send({ recipientEmail: 'ghost@ranch.test' })];
  const ranchers: RancherLite[] = [{ email: 'a@ranch.test', pageLive: false }];
  assert.equal(selectUndeliveredSetupLinks(sends, ranchers, NOW, 60).length, 0);
});

test('non-onboarding templates are ignored', () => {
  const sends = [send({ templateName: 'sendBuyerAbandonedRecovery' })];
  const ranchers: RancherLite[] = [{ email: 'a@ranch.test', pageLive: false }];
  assert.equal(selectUndeliveredSetupLinks(sends, ranchers, NOW, 60).length, 0);
});

test('dedupes per email to the most-recent qualifying send', () => {
  const sends = [
    send({ sentAtMs: minsAgo(300), templateName: 'sendRancherApproval' }),
    send({ sentAtMs: minsAgo(90), templateName: 'sendRancherSetupLink' }),
  ];
  const ranchers: RancherLite[] = [{ email: 'a@ranch.test', pageLive: false }];
  const hits = selectUndeliveredSetupLinks(sends, ranchers, NOW, 60);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].minutesAgo, 90);
  assert.equal(hits[0].templateName, 'sendRancherSetupLink');
});

test('results are sorted most-stale-first', () => {
  const sends = [
    send({ recipientEmail: 'fresh@ranch.test', sentAtMs: minsAgo(70) }),
    send({ recipientEmail: 'stale@ranch.test', sentAtMs: minsAgo(400) }),
  ];
  const ranchers: RancherLite[] = [
    { email: 'fresh@ranch.test', pageLive: false },
    { email: 'stale@ranch.test', pageLive: false },
  ];
  const hits = selectUndeliveredSetupLinks(sends, ranchers, NOW, 60);
  assert.deepEqual(hits.map((h) => h.email), ['stale@ranch.test', 'fresh@ranch.test']);
});

test('template set carries exactly the four onboarding link emails', () => {
  assert.equal(ONBOARDING_SETUP_TEMPLATES.size, 4);
  assert.ok(ONBOARDING_SETUP_TEMPLATES.has('sendRancherApplyAutoApproved'));
  assert.ok(ONBOARDING_SETUP_TEMPLATES.has('sendRancherApproval'));
  assert.ok(ONBOARDING_SETUP_TEMPLATES.has('sendRancherSetupLink'));
  assert.ok(ONBOARDING_SETUP_TEMPLATES.has('sendRancherSelfSubmitWelcome'));
});
