// lib/zipGatherCampaign.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectZipGatherAudience, buildZipConfirmMessage } from './zipGatherCampaign';

// A TX / WAITING / no-ZIP / Houston-phone / emailable buyer — the ideal target.
const base = () => ({
  id: 'rec1',
  Email: 'sam@example.com',
  'Full Name': 'Sam Rivera',
  Phone: '(713) 555-1234',
  State: 'TX',
  'Buyer Stage': 'WAITING',
  Zip: '',
});

const config = { supplierName: 'Thomas Cattle & Catering' };

// ── selectZipGatherAudience ─────────────────────────────────────────────────

test('selects the ideal Houston WAITING no-ZIP buyer', () => {
  const out = selectZipGatherAudience([base()], config);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'rec1');
  assert.equal(out[0].firstName, 'Sam');
  assert.equal(out[0].metro, 'houston');
});

test('excludes a buyer who already has a ZIP (nothing to gather)', () => {
  const out = selectZipGatherAudience([{ ...base(), Zip: '77002' }], config);
  assert.equal(out.length, 0);
});

test('excludes a buyer who is not WAITING', () => {
  assert.equal(selectZipGatherAudience([{ ...base(), 'Buyer Stage': 'MATCHED' }], config).length, 0);
  assert.equal(selectZipGatherAudience([{ ...base(), 'Buyer Stage': 'CLOSED' }], config).length, 0);
});

test('excludes a non-TX buyer even with a Houston-looking phone', () => {
  assert.equal(selectZipGatherAudience([{ ...base(), State: 'OK' }], config).length, 0);
});

test('excludes a buyer whose phone is not a TX metro', () => {
  assert.equal(selectZipGatherAudience([{ ...base(), Phone: '(212) 555-1234' }], config).length, 0);
});

test('excludes suppressed contacts — never message unsub/bounce/complaint', () => {
  assert.equal(selectZipGatherAudience([{ ...base(), Unsubscribed: true }], config).length, 0);
  assert.equal(selectZipGatherAudience([{ ...base(), Bounced: true }], config).length, 0);
  assert.equal(selectZipGatherAudience([{ ...base(), Complained: true }], config).length, 0);
});

test('excludes a buyer with no email address', () => {
  assert.equal(selectZipGatherAudience([{ ...base(), Email: '' }], config).length, 0);
});

test('metros config narrows the audience (houston-only drops austin phones)', () => {
  const austin = { ...base(), id: 'rec2', Phone: '512-555-9999' };
  const both = selectZipGatherAudience([base(), austin], config);
  assert.equal(both.length, 2);
  const houstonOnly = selectZipGatherAudience([base(), austin], { ...config, metros: ['houston'] });
  assert.deepEqual(houstonOnly.map((c) => c.id), ['rec1']);
});

test('firstName falls back to "there" when Full Name is blank', () => {
  const out = selectZipGatherAudience([{ ...base(), 'Full Name': '' }], config);
  assert.equal(out[0].firstName, 'there');
});

// ── buildZipConfirmMessage ──────────────────────────────────────────────────

test('SMS copy: identifies sender, names supplier, has one-tap link + STOP opt-out', () => {
  const msg = buildZipConfirmMessage({
    firstName: 'Sam',
    supplierName: 'Thomas Cattle & Catering',
    metro: 'houston',
    confirmUrl: 'https://www.buyhalfcow.com/zip-confirm?t=abc',
    channel: 'sms',
  });
  assert.match(msg.text, /Thomas Cattle & Catering/);
  assert.match(msg.text, /https:\/\/www\.buyhalfcow\.com\/zip-confirm\?t=abc/);
  assert.match(msg.text, /STOP/); // TCPA opt-out
  assert.match(msg.text, /BuyHalfCow/); // sender identity
  assert.equal(msg.html, undefined); // SMS is plain text
});

test('email copy: has a subject, the supplier name, the confirm link, and first name', () => {
  const msg = buildZipConfirmMessage({
    firstName: 'Sam',
    supplierName: 'Thomas Cattle & Catering',
    metro: 'houston',
    confirmUrl: 'https://www.buyhalfcow.com/zip-confirm?t=abc',
    channel: 'email',
  });
  assert.ok(msg.subject && msg.subject.length > 0);
  assert.match(msg.text, /Sam/);
  assert.match(msg.text, /Thomas Cattle & Catering/);
  assert.ok(msg.html && /zip-confirm\?t=abc/.test(msg.html));
});
