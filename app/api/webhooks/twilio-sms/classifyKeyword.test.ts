import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKeyword } from './route';

// ─── STOP family ───────────────────────────────────────────────────────────
test('STOP keywords classify as stop', () => {
  for (const w of ['STOP', 'stop', 'Stop', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']) {
    assert.equal(classifyKeyword(w), 'stop', `${w} → stop`);
  }
});

test('STOP tolerates punctuation and trailing words', () => {
  assert.equal(classifyKeyword('STOP.'), 'stop');
  assert.equal(classifyKeyword('Stop!'), 'stop');
  assert.equal(classifyKeyword('  stop  '), 'stop');
  assert.equal(classifyKeyword('STOP please'), 'stop');
});

// ─── START family ──────────────────────────────────────────────────────────
test('START keywords classify as start', () => {
  for (const w of ['START', 'start', 'UNSTOP', 'YES', 'resume']) {
    assert.equal(classifyKeyword(w), 'start', `${w} → start`);
  }
});

// ─── HELP family ───────────────────────────────────────────────────────────
test('HELP keywords classify as help', () => {
  for (const w of ['HELP', 'help', 'Help?', 'INFO']) {
    assert.equal(classifyKeyword(w), 'help', `${w} → help`);
  }
});

// ─── Everything else ───────────────────────────────────────────────────────
test('non-keyword messages classify as other', () => {
  for (const w of ['hey is my order ready', 'thanks!', 'when will the rancher call', 'STOPPING by later']) {
    assert.equal(classifyKeyword(w), 'other', `${w} → other`);
  }
});

test('empty / nullish bodies classify as other (never crash)', () => {
  assert.equal(classifyKeyword(''), 'other');
  assert.equal(classifyKeyword('   '), 'other');
  assert.equal(classifyKeyword(null), 'other');
  assert.equal(classifyKeyword(undefined), 'other');
});

// Guard: a word that merely CONTAINS a keyword must not trip it (only the first
// token, fully matched after stripping non-letters, counts).
test('substring of a keyword does not trigger', () => {
  assert.equal(classifyKeyword('stopwatch'), 'other');
  assert.equal(classifyKeyword('helpful tips'), 'other');
  assert.equal(classifyKeyword('restart'), 'other');
});
