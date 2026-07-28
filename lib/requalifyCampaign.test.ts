import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRequalifyEmail, validateRequalifyBatch, requalifyCta, MAX_BATCH } from './requalifyCampaign';

test('render: subject + body carry first name, state, CV pin; no banned money framing', () => {
  const r = renderRequalifyEmail('Jane Doe', 'CO');
  assert.match(r.subject, /^Jane, /);
  assert.match(r.html, /serving CO/);
  assert.match(r.html, /rancher=champion-valley-farm/);
  assert.match(r.html, /utm_campaign=waiting-wake-co/);
  for (const banned of ['deduct', 'keep 90', 'we take']) assert.ok(!r.html.toLowerCase().includes(banned), banned);
});

test('render: blank name → "there"; junk state degrades gracefully', () => {
  const r = renderRequalifyEmail('', 'Colorado');
  assert.match(r.subject, /^there, /);
  assert.match(r.html, /your state/);
  assert.match(requalifyCta('Colorado'), /waiting-wake-xx/);
});

test('validate: strict shape — batch cap, email format, campaign slug', () => {
  const good = { campaign: 'cv-requalify', recipients: [{ email: 'A@B.co', name: 'A', state: 'NE' }] };
  const ok = validateRequalifyBatch(good);
  assert.ok(!('error' in ok) && ok.recipients[0].email === 'a@b.co');
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', recipients: [] }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'BAD SLUG', recipients: good.recipients }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', recipients: [{ email: 'nope' }] }));
  const over = { campaign: 'cv-requalify', recipients: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ email: `a${i}@b.co`, name: 'x', state: 'CO' })) };
  assert.ok('error' in validateRequalifyBatch(over));
});
