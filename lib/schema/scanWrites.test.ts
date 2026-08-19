import test from 'node:test';
import assert from 'node:assert';
import { scanSource, type ScanContext } from './scanWrites';

const CTX: ScanContext = {
  tables: { CONSUMERS: 'Consumers', REFERRALS: 'Referrals', RANCHERS: 'Ranchers' },
  writeHelpers: { createReferral: { table: 'Referrals', payloadArg: 0 } },
};

const scan = (src: string) => scanSource('x.ts', src, CTX);
const one = (src: string) => {
  const sites = scan(src);
  assert.equal(sites.length, 1, `expected exactly one write site, got ${sites.length}`);
  return sites[0];
};
const fieldNames = (src: string) => one(src).fields.map((f) => f.name).sort();
const valuesFor = (src: string, name: string) =>
  (one(src).fields.find((f) => f.name === name)?.values ?? []).slice().sort();

// ── table resolution ─────────────────────────────────────────────────────

test('resolves TABLES.X through the real TABLES map', () => {
  const s = one(`createRecord(TABLES.CONSUMERS, { 'Status': 'Approved' });`);
  assert.equal(s.table, 'Consumers');
  assert.equal(s.resolved, true);
});

test('resolves a module-level string alias', () => {
  const s = one(`const PAYMENTS_TABLE = 'Payments';\nupdateRecord(PAYMENTS_TABLE, id, { 'Status': 'pending' });`);
  assert.equal(s.table, 'Payments');
});

test('resolves an alias that points at TABLES.X', () => {
  const s = one(`const T = TABLES.REFERRALS;\nupdateRecord(T, id, { 'Status': 'Intro Sent' });`);
  assert.equal(s.table, 'Referrals');
});

test('a bare string literal table works', () => {
  assert.equal(one(`createRecord('Deal Events', { 'Type': 'x' });`).table, 'Deal Events');
});

test('an unresolvable table is reported, not guessed', () => {
  const s = one(`updateRecord(tableName, id, { 'Status': 'Lost' });`);
  assert.equal(s.table, null);
  assert.equal(s.resolved, false);
});

// ── payload extraction ───────────────────────────────────────────────────

test('inline object literal: field names and string values', () => {
  const src = `updateRecord(TABLES.REFERRALS, id, { 'Status': 'Closed Lost', 'Notes': 'x' });`;
  assert.deepEqual(fieldNames(src), ['Notes', 'Status']);
  assert.deepEqual(valuesFor(src, 'Status'), ['Closed Lost']);
});

test('payload held in a local const is followed', () => {
  const src = `const fields: Record<string, any> = { 'Status': 'Lost' };\nupdateRecord(TABLES.REFERRALS, id, fields);`;
  assert.deepEqual(valuesFor(src, 'Status'), ['Lost']);
});

test('both branches of a ternary value are candidates', () => {
  const src = `updateRecord(TABLES.REFERRALS, id, { 'Status': won ? 'Closed Won' : 'Lost' });`;
  assert.deepEqual(valuesFor(src, 'Status'), ['Closed Won', 'Lost']);
});

test('both sides of || and ?? are candidates', () => {
  const src = `updateRecord(TABLES.REFERRALS, id, { 'Status': maybe || 'Pending' });`;
  assert.deepEqual(valuesFor(src, 'Status'), ['Pending']);
});

test('a conditional spread contributes its fields', () => {
  const src = `updateRecord(TABLES.REFERRALS, id, { 'Notes': n, ...(flag ? { 'Status': 'Dormant' } : {}) });`;
  assert.deepEqual(fieldNames(src), ['Notes', 'Status']);
  assert.deepEqual(valuesFor(src, 'Status'), ['Dormant']);
});

test('a && spread contributes its fields', () => {
  const src = `createRecord(TABLES.CONSUMERS, { 'Email': e, ...(flag && { 'Status': 'Approved' }) });`;
  assert.deepEqual(fieldNames(src), ['Email', 'Status']);
});

test('a spread of a resolvable const object contributes its fields', () => {
  const src = `const base = { 'Status': 'Pending' };\ncreateRecord(TABLES.REFERRALS, { ...base, 'Notes': 'x' });`;
  assert.deepEqual(fieldNames(src), ['Notes', 'Status']);
});

test('a spread of something unresolvable marks the site partial but keeps what it saw', () => {
  const src = `updateRecord(TABLES.REFERRALS, id, { ...mystery(), 'Status': 'Closed Won' });`;
  const s = one(src);
  assert.equal(s.partial, true);
  assert.deepEqual(s.fields.map((f) => f.name), ['Status']);
});

test('array values are captured member by member (multipleSelects)', () => {
  const src = `createRecord(TABLES.CONSUMERS, { 'Interests': ['Beef', 'Pork'] });`;
  assert.deepEqual(valuesFor(src, 'Interests'), ['Beef', 'Pork']);
});

test('a computed key from a const is resolved', () => {
  const src = `const F = 'Rewarm Sent At';\nupdateRecord(TABLES.REFERRALS, id, { [F]: now });`;
  assert.deepEqual(fieldNames(src), ['Rewarm Sent At']);
});

test('a dynamic value yields no literal candidates but the field is still checked', () => {
  const src = `updateRecord(TABLES.REFERRALS, id, { 'Status': computeStatus() });`;
  assert.deepEqual(fieldNames(src), ['Status']);
  assert.deepEqual(valuesFor(src, 'Status'), []);
});

test('a template literal with substitutions is not treated as a literal', () => {
  const src = 'updateRecord(TABLES.REFERRALS, id, { \'Notes\': `hi ${name}` });';
  assert.deepEqual(valuesFor(src, 'Notes'), []);
});

// ── helper wrappers ──────────────────────────────────────────────────────

test('a registered wrapper carries its fixed table', () => {
  const s = one(`createReferral({ 'Status': 'Pending Approval' });`);
  assert.equal(s.table, 'Referrals');
  assert.deepEqual(s.fields.map((f) => f.name), ['Status']);
});

// ── noise control ────────────────────────────────────────────────────────

test('unrelated calls are ignored', () => {
  assert.equal(scan(`doSomething(TABLES.REFERRALS, { 'Status': 'Lost' });`).length, 0);
});

test('method-call form is picked up (airtable.updateRecord(...))', () => {
  const s = one(`await mod.updateRecord(TABLES.RANCHERS, id, { 'Active Status': 'Paused' });`);
  assert.equal(s.table, 'Ranchers');
});

test('line numbers point at the offending property, not the call', () => {
  const src = [
    `updateRecord(TABLES.REFERRALS, id, {`,
    `  'Notes': 'x',`,
    `  'Status': 'Lost',`,
    `});`,
  ].join('\n');
  const s = one(src);
  assert.equal(s.line, 1);
  assert.equal(s.fields.find((f) => f.name === 'Status')!.line, 3);
});

// ── lexical scoping ──────────────────────────────────────────────────────
// The first cut of this scanner indexed every `const fields = {...}` in a
// file into one map, last-wins. That attributed a Consumers payload to a
// Ranchers call three functions away and invented five findings. A guard that
// invents findings gets muted, so scoping is load-bearing.

test('two same-named payload consts in different functions do not cross-contaminate', () => {
  const src = [
    `function a() {`,
    `  const fields = { 'Order Type': 'Half' };`,
    `  updateRecord(TABLES.CONSUMERS, id, fields);`,
    `}`,
    `function b() {`,
    `  const fields = { 'Active Status': 'Paused' };`,
    `  updateRecord(TABLES.RANCHERS, id, fields);`,
    `}`,
  ].join('\n');
  const sites = scan(src);
  assert.equal(sites.length, 2);
  const consumers = sites.find((s) => s.table === 'Consumers')!;
  const ranchers = sites.find((s) => s.table === 'Ranchers')!;
  assert.deepEqual(consumers.fields.map((f) => f.name), ['Order Type']);
  assert.deepEqual(ranchers.fields.map((f) => f.name), ['Active Status']);
});

test('an outer-scope payload is still visible from an inner block', () => {
  const src = [
    `function a() {`,
    `  const fields = { 'Status': 'Closed Won' };`,
    `  if (x) { updateRecord(TABLES.REFERRALS, id, fields); }`,
    `}`,
  ].join('\n');
  assert.deepEqual(one(src).fields.map((f) => f.name), ['Status']);
});

test('the nearest declaration wins over an outer one of the same name', () => {
  const src = [
    `const fields = { 'Notes': 'outer' };`,
    `function a() {`,
    `  const fields = { 'Status': 'Dormant' };`,
    `  updateRecord(TABLES.REFERRALS, id, fields);`,
    `}`,
  ].join('\n');
  assert.deepEqual(one(src).fields.map((f) => f.name), ['Status']);
});

test('a const bound to a ternary of literals contributes both values', () => {
  const src = [
    `const label = kind === 'refund' ? 'REFUNDED' : 'DISPUTED';`,
    `updateRecord(TABLES.CONSUMERS, id, { 'Founder Tier': label });`,
  ].join('\n');
  assert.deepEqual(valuesFor(src, 'Founder Tier'), ['DISPUTED', 'REFUNDED']);
});

test('a table constant imported from another module resolves', () => {
  const ctx: ScanContext = {
    ...CTX,
    externalConstants: { 'lib/contracts/payments#PAYMENTS_TABLE': ['Payments'] },
  };
  const src = [
    `import { PAYMENTS_TABLE } from '@/lib/contracts/payments';`,
    `updateRecord(PAYMENTS_TABLE, id, { 'Status': 'awaiting_auth' });`,
  ].join('\n');
  const sites = scanSource('app/api/webhooks/stripe/route.ts', src, ctx);
  assert.equal(sites[0].table, 'Payments');
});

test('a relative import resolves against the importing file', () => {
  const ctx: ScanContext = { ...CTX, externalConstants: { 'lib/foo#T': ['Threads'] } };
  const src = [`import { T } from './foo';`, `updateRecord(T, id, { 'Status': 'x' });`].join('\n');
  assert.equal(scanSource('lib/bar.ts', src, ctx)[0].table, 'Threads');
});

test('an imported constant with two different values across modules stays unresolved', () => {
  const ctx: ScanContext = { ...CTX, externalConstants: { 'lib/foo#T': ['A', 'B'] } };
  const src = [`import { T } from './foo';`, `updateRecord(T, id, { 'Status': 'x' });`].join('\n');
  assert.equal(scanSource('lib/bar.ts', src, ctx)[0].table, null);
});

// ── label maps ───────────────────────────────────────────────────────────
// `'Order Type': CUT_LABELS[cut]` is how 'Half Cow' and 'Quarter Cow' got
// minted into Consumers.Order Type. Indexing a const map is the single most
// common way a select value reaches Airtable without appearing as a literal
// at the write site, so the scanner over-approximates: every value the map
// can yield is a value that can be written.

test('indexing a const map with a dynamic key yields every value in the map', () => {
  const src = [
    `const CUT_LABELS = { quarter: 'Quarter Cow', half: 'Half Cow', whole: 'Whole Cow' };`,
    `createRecord(TABLES.CONSUMERS, { 'Order Type': CUT_LABELS[cut] });`,
  ].join('\n');
  assert.deepEqual(valuesFor(src, 'Order Type'), ['Half Cow', 'Quarter Cow', 'Whole Cow']);
});

test('a literal key picks exactly one value', () => {
  const src = [
    `const M = { a: 'Alpha', b: 'Beta' };`,
    `createRecord(TABLES.CONSUMERS, { 'Order Type': M['a'] });`,
  ].join('\n');
  assert.deepEqual(valuesFor(src, 'Order Type'), ['Alpha']);
});

test('dotted access into a const map picks one value', () => {
  const src = [
    `const M = { a: 'Alpha', b: 'Beta' };`,
    `createRecord(TABLES.CONSUMERS, { 'Order Type': M.b });`,
  ].join('\n');
  assert.deepEqual(valuesFor(src, 'Order Type'), ['Beta']);
});

test("`x || null` cannot yield '' — the falsy left side is filtered out", () => {
  const src = [
    `const tier = ok ? body.tier : '';`,
    `createRecord(TABLES.CONSUMERS, { 'Order Type': tier || null });`,
  ].join('\n');
  assert.deepEqual(valuesFor(src, 'Order Type'), []);
});

test("`x ?? 'Half'` keeps '' — ?? only skips null/undefined", () => {
  const src = [
    `const tier = ok ? body.tier : '';`,
    `createRecord(TABLES.CONSUMERS, { 'Order Type': tier ?? 'Half' });`,
  ].join('\n');
  assert.deepEqual(valuesFor(src, 'Order Type'), ['', 'Half']);
});

test('a `let` is not treated as authoritative — it can be reassigned', () => {
  // `let nextStage = ''; ... nextStage = 'abandoned_email1_sent';` — reading
  // the initializer as the value reported a phantom empty-select write.
  const src = [
    `let stage = '';`,
    `if (x) stage = 'day3_sent';`,
    `updateRecord(TABLES.CONSUMERS, id, { 'Sequence Stage': stage });`,
  ].join('\n');
  assert.deepEqual(valuesFor(src, 'Sequence Stage'), []);
});
