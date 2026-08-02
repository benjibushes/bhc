import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_MIN_LEAD_AGE_DAYS,
  DIGEST_THROTTLE_HOURS,
  buildDigestLeads,
  digestSubject,
  shouldSendLeadDigest,
  hasLeadsNewToDigest,
} from './rancherLeadDigest';

const NOW = new Date('2026-07-28T12:00:00Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

const ref = (over: Record<string, unknown> = {}) => ({
  id: 'recTESTREFERRAL01',
  Status: 'Intro Sent',
  'Intro Sent At': daysAgo(5),
  'Buyer Name': 'Richard Field',
  'Buyer State': 'NE',
  'Buyer Phone': '555-0100',
  'Buyer Email': 'richard@example.com',
  'Order Type': 'Half',
  'Budget Range': '$2,000-$3,000',
  ...over,
});

describe('shouldSendLeadDigest', () => {
  it('sends when never sent', () => {
    assert.equal(shouldSendLeadDigest(undefined, NOW), true);
    assert.equal(shouldSendLeadDigest(null, NOW), true);
    assert.equal(shouldSendLeadDigest('', NOW), true);
  });

  it('suppresses inside the 24h window', () => {
    assert.equal(shouldSendLeadDigest(hoursAgo(1), NOW), false);
    assert.equal(shouldSendLeadDigest(hoursAgo(23), NOW), false);
  });

  it('sends at/after the window boundary', () => {
    assert.equal(shouldSendLeadDigest(hoursAgo(DIGEST_THROTTLE_HOURS), NOW), true);
    assert.equal(shouldSendLeadDigest(hoursAgo(48), NOW), true);
  });

  it('fails open on a garbage stamp (DB-state throttle, not a lockout)', () => {
    assert.equal(shouldSendLeadDigest('not-a-date', NOW), true);
  });
});

describe('buildDigestLeads', () => {
  it('includes only Intro Sent leads at least the minimum age', () => {
    const leads = buildDigestLeads(
      [
        ref({ id: 'recAAAAAAAAAAAAA1', 'Intro Sent At': daysAgo(3) }),
        ref({ id: 'recAAAAAAAAAAAAA2', 'Intro Sent At': daysAgo(1) }),           // too fresh
        ref({ id: 'recAAAAAAAAAAAAA3', Status: 'Rancher Contacted' }),           // theirs now
        ref({ id: 'recAAAAAAAAAAAAA4', Status: 'Closed Lost' }),
        ref({ id: 'recAAAAAAAAAAAAA5', 'Intro Sent At': undefined, 'Approved At': daysAgo(4) }), // fallback field
        ref({ id: 'recAAAAAAAAAAAAA6', 'Intro Sent At': undefined, 'Approved At': undefined }),  // no timestamp
      ],
      NOW,
    );
    assert.deepEqual(leads.map((l) => l.referralId).sort(), ['recAAAAAAAAAAAAA1', 'recAAAAAAAAAAAAA5']);
    assert.ok(leads.every((l) => l.daysSinceIntro >= DIGEST_MIN_LEAD_AGE_DAYS));
  });

  it('sorts oldest-waiting first', () => {
    const leads = buildDigestLeads(
      [
        ref({ id: 'recBBBBBBBBBBBBB1', 'Intro Sent At': daysAgo(2) }),
        ref({ id: 'recBBBBBBBBBBBBB2', 'Intro Sent At': daysAgo(16) }),
        ref({ id: 'recBBBBBBBBBBBBB3', 'Intro Sent At': daysAgo(7) }),
      ],
      NOW,
    );
    assert.deepEqual(leads.map((l) => l.daysSinceIntro), [16, 7, 2]);
  });

  it('shapes buyer contact fields with safe fallbacks', () => {
    const [lead] = buildDigestLeads(
      [ref({ 'Buyer Name': undefined, 'Buyer Phone': undefined, 'Order Type': undefined })],
      NOW,
    );
    assert.equal(lead.buyerName, 'a buyer');
    assert.equal(lead.buyerPhone, '');
    assert.equal(lead.orderType, '');
    assert.equal(lead.buyerEmail, 'richard@example.com');
  });
});

describe('digestSubject', () => {
  it('single lead reads personally', () => {
    const [lead] = buildDigestLeads([ref({ 'Intro Sent At': daysAgo(12) })], NOW);
    assert.equal(digestSubject([lead]), 'Richard has been waiting 12 days to hear from you');
  });

  it('multiple leads lead with the count and oldest first', () => {
    const leads = buildDigestLeads(
      [
        ref({ id: 'recCCCCCCCCCCCCC1', 'Buyer Name': 'Ana Cole', 'Intro Sent At': daysAgo(2) }),
        ref({ id: 'recCCCCCCCCCCCCC2', 'Buyer Name': 'Richard Field', 'Intro Sent At': daysAgo(12) }),
        ref({ id: 'recCCCCCCCCCCCCC3', 'Buyer Name': 'Christine Ray', 'Intro Sent At': daysAgo(5) }),
      ],
      NOW,
    );
    assert.equal(digestSubject(leads), '3 buyers waiting on you: Richard 12d, Christine 5d, Ana 2d');
  });

  it('truncation marker past three names', () => {
    const leads = buildDigestLeads(
      [1, 2, 3, 4].map((i) =>
        ref({ id: `recDDDDDDDDDDDDD${i}`, 'Buyer Name': `Buyer${i} X`, 'Intro Sent At': daysAgo(2 + i) }),
      ),
      NOW,
    );
    assert.ok(digestSubject(leads).startsWith('4 buyers waiting on you:'));
    assert.ok(digestSubject(leads).endsWith('…'));
  });
});

// ── new-leads gate (email-hygiene 2026-08-02) ───────────────────────────────
// The 24h throttle alone let the SAME stale-lead list email the rancher every
// day forever. The gate: send only when a lead became digest-visible (crossed
// the 2-day age threshold) after the last digest went out.

describe('hasLeadsNewToDigest', () => {
  it('first digest ever always sends', () => {
    const leads = buildDigestLeads([ref({ 'Intro Sent At': daysAgo(3) })], NOW);
    assert.equal(hasLeadsNewToDigest(leads, undefined), true);
    assert.equal(hasLeadsNewToDigest(leads, null), true);
    assert.equal(hasLeadsNewToDigest(leads, ''), true);
  });

  it('FOREVER BUG: same stale leads, digest sent yesterday → NO email today', () => {
    // Lead intro'd 10d ago became visible 8d ago — the digest sent 24h ago
    // already listed it. Nothing new = nothing sent, today or any later day.
    const leads = buildDigestLeads([ref({ 'Intro Sent At': daysAgo(10) })], NOW);
    assert.equal(hasLeadsNewToDigest(leads, hoursAgo(24)), false);
    assert.equal(hasLeadsNewToDigest(leads, daysAgo(5)), false);
  });

  it('a lead that crossed the 2-day threshold since the last digest re-arms it', () => {
    const leads = buildDigestLeads(
      [
        ref({ id: 'recEEEEEEEEEEEEE1', 'Intro Sent At': daysAgo(10) }), // old news
        ref({ id: 'recEEEEEEEEEEEEE2', 'Intro Sent At': daysAgo(2) }),  // became visible today
      ],
      NOW,
    );
    assert.equal(hasLeadsNewToDigest(leads, hoursAgo(24)), true);
  });

  it('no visible leads → nothing to send regardless of stamp', () => {
    assert.equal(hasLeadsNewToDigest([], undefined), false);
    assert.equal(hasLeadsNewToDigest([], hoursAgo(48)), false);
  });

  it('garbage stamp fails open (send rather than silently strand a digest)', () => {
    const leads = buildDigestLeads([ref({ 'Intro Sent At': daysAgo(10) })], NOW);
    assert.equal(hasLeadsNewToDigest(leads, 'not-a-date'), true);
  });
});
