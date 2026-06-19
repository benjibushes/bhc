import { summarizeDeliverability } from '../deliverabilityStats.ts';

const now = Date.parse('2026-06-19T18:00:00Z');
const h = (n) => new Date(now - n * 3600_000).toISOString();

const conversations = [
  { fields: { Direction: 'inbound', Timestamp: h(2) } },
  { fields: { Direction: 'inbound', Timestamp: h(30) } }, // >24h, excluded from 24h count
  { fields: { Direction: 'outbound', Timestamp: h(1) } },  // outbound, excluded
];
const suppressed = [
  { fields: { Bounced: true } },
  { fields: { Complained: true } },
  { fields: { Unsubscribed: true, Bounced: false, Complained: false } },
];

const r = summarizeDeliverability({ conversations, suppressed, nowMs: now });

const checks = [
  [r.inboundLast24h, 1, 'one inbound within 24h'],
  [r.inboundTotal, 2, 'two inbound total'],
  [r.bounced, 1, 'one bounced'],
  [r.complained, 1, 'one complained'],
  [r.suppressedTotal, 3, 'three suppressed total'],
  [r.healthy, true, 'healthy when inbound flowing'],
];
let pass = 0;
for (const [got, exp, d] of checks) {
  const ok = got === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${JSON.stringify(got)} (exp ${JSON.stringify(exp)}) ${d}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exit(1);
