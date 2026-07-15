import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  qualifiedAgoLabel,
  commitmentLineHtml,
  leadFactsHtml,
  closeCtaHtml,
  readyBannerHtml,
} from './rancherLeadEmail';

const NOW = new Date('2026-07-15T12:00:00.000Z').getTime();

// ── commitment line gating (B1a) ────────────────────────────────────────────
test('commitment line renders ONLY when Response Ack At is present', () => {
  assert.equal(commitmentLineHtml(undefined), '');
  assert.equal(commitmentLineHtml(''), '');
  assert.equal(commitmentLineHtml(null), '');
  const html = commitmentLineHtml('2026-07-15T10:00:00.000Z');
  assert.match(html, /acknowledged the commitment to respond within 24 hours/);
});

// ── facts block (B1b) ───────────────────────────────────────────────────────
test('facts block shows cut / timing / storage / budget and freshness — never a score', () => {
  const html = leadFactsHtml(
    {
      cut: 'Half',
      timing: 'Within 1 month',
      storage: 'have_freezer',
      budget: '$2,000–$4,000',
      qualifiedAtIso: '2026-07-15T09:00:00.000Z',
    },
    NOW,
  );
  assert.match(html, /Cut wanted:<\/strong> Half/);
  assert.match(html, /Timing:<\/strong> Within 1 month/);
  assert.match(html, /Storage:<\/strong> Has freezer space/);
  assert.match(html, /Budget:<\/strong> \$2,000–\$4,000/);
  assert.match(html, /qualified 3h ago/);
  assert.doesNotMatch(html, /\/100/);
  assert.doesNotMatch(html, /⭐/);
});

test('facts block omits missing rows instead of printing unspecified', () => {
  const html = leadFactsHtml({ cut: 'Quarter' }, NOW);
  assert.match(html, /Cut wanted/);
  assert.doesNotMatch(html, /Timing/);
  assert.doesNotMatch(html, /Budget/);
  assert.doesNotMatch(html, /unspecified/);
});

test('facts block with zero facts renders nothing', () => {
  assert.equal(leadFactsHtml({}, NOW), '');
});

test('facts block includes commitment line only with ack', () => {
  const withAck = leadFactsHtml({ cut: 'Half', responseAckAt: '2026-07-15T09:00:00.000Z' }, NOW);
  const without = leadFactsHtml({ cut: 'Half' }, NOW);
  assert.match(withAck, /respond within 24 hours/);
  assert.doesNotMatch(without, /respond within 24 hours/);
});

// ── freshness label ─────────────────────────────────────────────────────────
test('qualifiedAgoLabel: hours under 48h, days after, empty when unknown', () => {
  assert.equal(qualifiedAgoLabel('2026-07-15T09:00:00.000Z', NOW), 'qualified 3h ago');
  assert.equal(qualifiedAgoLabel('2026-07-13T13:00:00.000Z', NOW), 'qualified 47h ago');
  assert.equal(qualifiedAgoLabel('2026-07-11T12:00:00.000Z', NOW), 'qualified 4d ago');
  assert.equal(qualifiedAgoLabel(undefined, NOW), '');
  assert.equal(qualifiedAgoLabel('garbage', NOW), '');
});

// ── operator symmetry (B2) ──────────────────────────────────────────────────
test('close CTA: Operator tier is told the team runs the close', () => {
  const html = closeCtaHtml('operator');
  assert.match(html, /Our team is running this close/);
  assert.match(html, /confirmed order to fulfill/);
  assert.doesNotMatch(html, /Reach out within 24 hours/);
});

test('close CTA: every other tier keeps the 24-hour call urging', () => {
  for (const tier of ['pasture', 'ranch', 'legacy_connect', null] as const) {
    const html = closeCtaHtml(tier);
    assert.match(html, /Reach out within 24 hours to close the sale/, String(tier));
  }
});

test('ready banner: Operator variant never promises the rancher will call', () => {
  assert.match(readyBannerHtml('operator'), /Our team is reaching out/);
  assert.doesNotMatch(readyBannerHtml('operator'), /your call/);
  assert.match(readyBannerHtml(null), /expecting your call within 24–48 hours/);
  assert.match(readyBannerHtml('pasture'), /expecting your call/);
});
