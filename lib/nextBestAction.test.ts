// lib/nextBestAction.test.ts
//
// Wave 1B — supply-aware NBA gating. The engine previously ranked purely on
// lead score, so it told the operator to call buyers in states with no
// operational rancher, and its action copy still referenced the dead
// invoice-on-close money model. These tests pin the gate + the copy fix.
//
// NOTE (public repo): all names below are synthetic fixtures, not real people.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNBA } from './nextBestAction';

const emptyInput = () => ({
  calls: [] as any[],
  quizComplete: [] as any[],
  depositPending: [] as any[],
  slotsLocked: [] as any[],
  wholesale: [] as any[],
});

const hotBuyer = (id: string, state: string, leadScore = 90) => ({
  id,
  name: `Test Buyer ${id}`,
  email: `${id}@example.com`,
  state,
  qualifiedAt: new Date(Date.now() - 3600_000).toISOString(),
  leadScore,
});

test('no coveredStates option → legacy behavior, no gating, no recruit items', () => {
  const input = emptyInput();
  input.quizComplete = [hotBuyer('b1', 'ZZ' as any), hotBuyer('b2', 'TX')];
  const items = computeNBA(input);
  assert.equal(items.filter((i) => i.type === 'recruit').length, 0);
  assert.equal(items.filter((i) => i.type === 'call').length, 2);
});

test('uncovered-state hot buyer becomes a recruit item, demoted below covered ones', () => {
  const input = emptyInput();
  input.quizComplete = [
    hotBuyer('b-fl', 'FL', 95), // uncovered — higher score, must still sink
    hotBuyer('b-tx', 'TX', 80), // covered
  ];
  const items = computeNBA(input, { coveredStates: ['TX'] });

  const call = items.find((i) => i.type === 'call');
  const recruit = items.find((i) => i.type === 'recruit');
  assert.ok(call, 'covered buyer keeps a call item');
  assert.ok(recruit, 'uncovered buyer converted to recruit signal');

  assert.equal(call!.priority, 1);
  assert.equal(recruit!.priority, 3);
  assert.ok(
    items.indexOf(call!) < items.indexOf(recruit!),
    'covered-state call ranks above the recruit signal',
  );
  assert.match(recruit!.subject, /FL/);
  assert.match(recruit!.action, /FL/);
  assert.equal(recruit!.entityType, 'rancher');
});

test('one recruit item per state, however many buyers are stranded there', () => {
  const input = emptyInput();
  input.quizComplete = [
    hotBuyer('b1', 'FL'),
    hotBuyer('b2', 'FL'),
    hotBuyer('b3', 'Florida'), // full name normalizes to FL too
  ];
  const items = computeNBA(input, { coveredStates: ['TX'] });
  assert.equal(items.filter((i) => i.type === 'recruit').length, 1);
});

test('blank or unparseable state is never demoted (cannot gate honestly)', () => {
  const input = emptyInput();
  input.quizComplete = [hotBuyer('b1', ''), hotBuyer('b2', 'not-a-state')];
  const items = computeNBA(input, { coveredStates: ['TX'] });
  assert.equal(items.filter((i) => i.type === 'recruit').length, 0);
  assert.equal(items.filter((i) => i.type === 'call').length, 2);
});

test('coveredStates accepts full state names and mixed casing', () => {
  const input = emptyInput();
  input.quizComplete = [hotBuyer('b1', 'TX')];
  const items = computeNBA(input, { coveredStates: ['texas'] });
  assert.equal(items.filter((i) => i.type === 'call').length, 1);
  assert.equal(items.filter((i) => i.type === 'recruit').length, 0);
});

test('warm buyers in uncovered states are skipped, not invited to a dead-end call', () => {
  const input = emptyInput();
  input.quizComplete = [hotBuyer('warm-fl', 'FL', 50), hotBuyer('warm-tx', 'TX', 50)];
  const items = computeNBA(input, { coveredStates: ['TX'] });
  const sends = items.filter((i) => i.type === 'send');
  assert.equal(sends.length, 1);
  assert.match(sends[0].subject, /TX/);
});

test('dead invoice-on-close copy is gone; live deposit-link copy is present', () => {
  const input = emptyInput();
  input.quizComplete = [hotBuyer('b1', 'TX')];
  const items = computeNBA(input, { coveredStates: ['TX'] });
  const all = JSON.stringify(items);
  assert.ok(!all.includes('send invoice on close'), 'dead money-model copy removed');
  assert.match(items[0].action, /deposit link/);
});
