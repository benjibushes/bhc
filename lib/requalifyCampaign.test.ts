import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRequalifyEmail, validateRequalifyBatch, requalifyCta, MAX_BATCH, DAILY_CAMPAIGN_BUDGET } from './requalifyCampaign';

const CV = { name: 'Champion Valley Farm', slug: 'champion-valley-farm' };

test('render: subject + body carry first name, state, CV pin; no banned money framing', () => {
  const r = renderRequalifyEmail('Jane Doe', 'CO', CV);
  assert.match(r.subject, /^Jane, /);
  assert.match(r.html, /serving CO/);
  assert.match(r.html, /rancher=champion-valley-farm/);
  assert.match(r.html, /utm_campaign=waiting-wake-co/);
  for (const banned of ['deduct', 'keep 90', 'we take']) assert.ok(!r.html.toLowerCase().includes(banned), banned);
});

test('render: blank name → "there"; junk state degrades gracefully', () => {
  const r = renderRequalifyEmail('', 'Colorado', CV);
  assert.match(r.subject, /^there, /);
  assert.match(r.html, /your state/);
  assert.match(requalifyCta('Colorado', CV.slug), /waiting-wake-xx/);
});

test('validate: strict shape — batch cap, email format, campaign slug', () => {
  const good = { campaign: 'cv-requalify', rancher: CV, recipients: [{ email: 'A@B.co', name: 'A', state: 'NE' }] };
  const ok = validateRequalifyBatch(good);
  assert.ok(!('error' in ok) && ok.recipients[0].email === 'a@b.co');
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', rancher: CV, recipients: [] }));
  // rancher is REQUIRED and slug-validated — the endpoint is per-rancher now
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', recipients: good.recipients }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', rancher: { name: 'X Ranch', slug: 'Bad Slug!' }, recipients: good.recipients }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'BAD SLUG', rancher: CV, recipients: good.recipients }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', rancher: CV, recipients: [{ email: 'nope' }] }));
  const over = { campaign: 'cv-requalify', rancher: CV, recipients: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ email: `a${i}@b.co`, name: 'x', state: 'CO' })) };
  assert.ok('error' in validateRequalifyBatch(over));
});

test('daily budget constant is a sane domain-wide ceiling', () => {
  assert.ok(DAILY_CAMPAIGN_BUDGET >= 100 && DAILY_CAMPAIGN_BUDGET <= 150);
});
