// lib/prospectOutreach.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/prospectOutreach.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickProspectsForDraft,
  violatesVoice,
  parseDraftOutput,
  toProspectRow,
  type ProspectRow,
} from './prospectOutreach';

const mk = (over: Partial<ProspectRow>): ProspectRow => ({
  id: 'rec' + Math.abs(JSON.stringify(over).length).toString().padEnd(14, 'x'),
  ranchName: 'Test Ranch', operatorName: 'Jane Doe', state: 'TX', city: 'Waco',
  email: 'jane@ranch.com', fitScore: 75, fitReasons: '', disqualifiers: '',
  sizeSignal: '', beefType: '', status: 'new', outreachStatus: '',
  ...over,
});

test('selector: requires email, fit >= 60, new/reviewed, no prior outreach', () => {
  const rows = [
    mk({ id: 'recAAAAAAAAAAAAA1' }),
    mk({ id: 'recAAAAAAAAAAAAA2', email: '' }),                    // no email
    mk({ id: 'recAAAAAAAAAAAAA3', fitScore: 45 }),                 // low fit
    mk({ id: 'recAAAAAAAAAAAAA4', status: 'contacted' }),          // wrong lane
    mk({ id: 'recAAAAAAAAAAAAA5', outreachStatus: 'Sent' }),       // already touched
    mk({ id: 'recAAAAAAAAAAAAA6', disqualifiers: 'ANTI-FIT: demand met' }),
  ];
  const picked = pickProspectsForDraft(rows, { TX: 250 }, 10);
  assert.deepEqual(picked.map((p) => p.id), ['recAAAAAAAAAAAAA1']);
});

test('selector: demand-state ranking beats fit score; cap respected', () => {
  const rows = [
    mk({ id: 'recBBBBBBBBBBBBB1', state: 'ME', fitScore: 95 }),
    mk({ id: 'recBBBBBBBBBBBBB2', state: 'TX', fitScore: 61 }),
    mk({ id: 'recBBBBBBBBBBBBB3', state: 'TX', fitScore: 80 }),
  ];
  const picked = pickProspectsForDraft(rows, { TX: 253, ME: 3 }, 2);
  assert.deepEqual(picked.map((p) => p.id), ['recBBBBBBBBBBBBB3', 'recBBBBBBBBBBBBB2']);
});

test('voice guard: bans the old template skeleton + AI-tells', () => {
  const pad = 'real words about beef and buyers and montana ranch life here '.repeat(4);
  assert.match(String(violatesVoice(pad + 'exactly the kind of direct operation we want')), /exactly the kind/);
  assert.match(String(violatesVoice(pad + 'I hope this finds you well')), /hope this finds/);
  assert.match(String(violatesVoice(pad + 'our seamless platform')), /seamless/);
  assert.match(String(violatesVoice('too short')), /too short/);
  assert.equal(violatesVoice(pad + 'there are 253 families in texas on our waitlist. worth a look? — Ben'), null);
});

test('voice guard: rejects automation mentions and exclamation overload', () => {
  const pad = 'plain honest sentence about ranch beef buyers waiting nearby today '.repeat(4);
  assert.match(String(violatesVoice(pad + 'this AI system routes buyers')), /automation/);
  assert.match(String(violatesVoice(pad + 'amazing! incredible! join now!')), /exclamation/);
});

test('parseDraftOutput: extracts subject + body, rejects malformed', () => {
  const good = parseDraftOutput('SUBJECT: 253 texas families want beef\nBODY:\nhey jane — short note.\n\n— Ben');
  assert.equal(good?.subject, '253 texas families want beef');
  assert.match(String(good?.body), /short note/);
  assert.equal(parseDraftOutput('no structure here'), null);
});

test('toProspectRow: normalizes selects + trims + uppercases state', () => {
  const p = toProspectRow({
    id: 'recCCCCCCCCCCCCCC', 'Ranch Name': ' X Ranch ', State: 'tx',
    Email: ' JANE@R.COM ', 'Fit Score': '72',
    Status: { name: 'new' }, 'Outreach Status': { name: 'Draft Ready' },
  });
  assert.equal(p.ranchName, 'X Ranch');
  assert.equal(p.state, 'TX');
  assert.equal(p.email, 'jane@r.com');
  assert.equal(p.fitScore, 72);
  assert.equal(p.outreachStatus, 'Draft Ready');
});
