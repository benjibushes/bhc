// Tests for lib/ai.ts — Groq model pins + Groq→Anthropic failover.
//
// Context (2026-08-18): Groq decommissioned llama-3.3-70b-versatile and
// llama-3.1-8b-instant. Every Groq chat call returned model_not_found, and
// callClaude/callClaudeWithTools never fell through to Anthropic on a FAILED
// call (only on a missing key) — so every AI lane was deterministically dark.
// These tests pin (a) the model map against the live-verified replacement IDs
// and (b) the failover contract: Groq failure → one Anthropic attempt,
// Groq success → Anthropic never called, both dead → error naming both.
//
// All provider calls are mocked — no live APIs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callClaude, callClaudeWithTools, GROQ_MODELS } from './ai';

const AI_SOURCE = readFileSync(new URL('./ai.ts', import.meta.url), 'utf8');

// Live-verified against GET https://api.groq.com/openai/v1/models on
// 2026-08-18 (HTTP 200; both IDs answered a chat completion). If Groq
// decommissions these too, re-verify live and update BOTH this constant and
// GROQ_MODELS in lib/ai.ts, including its live-verified date comment.
const VERIFIED_GROQ_MODELS = {
  'claude-sonnet-4-6': 'openai/gpt-oss-120b',
  'claude-haiku-4-5-20251001': 'openai/gpt-oss-20b',
};
const DECOMMISSIONED = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

// ─── fetch mock harness ──────────────────────────────────────────────────

type RecordedCall = { url: string; body: any };
let fetchCalls: RecordedCall[] = [];
let fetchHandler: (url: string) => Response | Promise<Response>;
let warnings: string[] = [];

const realFetch = globalThis.fetch;
const realWarn = console.warn;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GROQ_OK = () =>
  json(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'groq says hi' } }] });
const GROQ_MODEL_NOT_FOUND = () =>
  json(404, { error: { message: 'The model does not exist', code: 'model_not_found' } });
const ANTHROPIC_OK = () =>
  json(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'anthropic says hi' }] });

function groqCalls() {
  return fetchCalls.filter((c) => c.url.includes('api.groq.com'));
}
function anthropicCalls() {
  return fetchCalls.filter((c) => c.url.includes('api.anthropic.com'));
}

beforeEach(() => {
  process.env.GROQ_API_KEY = 'gsk_test_not_a_real_key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
  delete process.env.OLLAMA_BASE_URL;
  fetchCalls = [];
  warnings = [];
  fetchHandler = () => {
    throw new Error('fetchHandler not set for this test');
  };
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    // Non-provider traffic (e.g. the aiMemory Airtable read, which lib/ai
    // wraps in its own try/catch) fails fast without touching the network.
    if (!u.includes('api.groq.com') && !u.includes('api.anthropic.com')) {
      throw new Error(`test fetch mock: unexpected URL ${u}`);
    }
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    fetchCalls.push({ url: u, body });
    return fetchHandler(u);
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

// ─── model map pins ──────────────────────────────────────────────────────

test('GROQ_MODELS matches the live-verified replacement IDs', () => {
  assert.deepEqual({ ...GROQ_MODELS }, VERIFIED_GROQ_MODELS);
});

test('GROQ_MODELS carries a live-verified date comment in the source', () => {
  assert.match(
    AI_SOURCE,
    /live-verified[^\n]*2026-08-18/i,
    'lib/ai.ts must document the date the Groq model IDs were verified against the live /models endpoint'
  );
});

test('decommissioned Groq model IDs are fully gone from lib/ai.ts', () => {
  for (const dead of DECOMMISSIONED) {
    assert.ok(
      !AI_SOURCE.includes(dead),
      `decommissioned model "${dead}" still referenced in lib/ai.ts (check default fallbacks, not just GROQ_MODELS)`
    );
  }
});

// ─── callClaude failover ─────────────────────────────────────────────────

test('callClaude: Groq success → Anthropic never called', async () => {
  fetchHandler = () => GROQ_OK();
  const out = await callClaude({ system: 'sys', user: 'hi' });
  assert.equal(out, 'groq says hi');
  assert.equal(groqCalls().length, 1);
  assert.equal(anthropicCalls().length, 0);
  // The request must use a live-verified model, not a decommissioned one.
  assert.equal(groqCalls()[0].body.model, VERIFIED_GROQ_MODELS['claude-sonnet-4-6']);
});

test('callClaude: haiku tier maps to the small live-verified model', async () => {
  fetchHandler = () => GROQ_OK();
  await callClaude({ model: 'claude-haiku-4-5-20251001', system: 'sys', user: 'hi' });
  assert.equal(groqCalls()[0].body.model, VERIFIED_GROQ_MODELS['claude-haiku-4-5-20251001']);
});

test('callClaude: Groq failure (model_not_found) → falls through to Anthropic once', async () => {
  fetchHandler = (url) => (url.includes('api.groq.com') ? GROQ_MODEL_NOT_FOUND() : ANTHROPIC_OK());
  const out = await callClaude({ system: 'sys', user: 'hi' });
  assert.equal(out, 'anthropic says hi');
  assert.equal(groqCalls().length, 1, 'exactly one Groq attempt — no retry storm');
  assert.equal(anthropicCalls().length, 1, 'exactly one Anthropic fallthrough');
  // Degradation must be visible in logs: provider + model named.
  const warn = warnings.join('\n').toLowerCase();
  assert.ok(warn.includes('groq'), 'console.warn must name the failed provider');
  assert.ok(
    warn.includes(VERIFIED_GROQ_MODELS['claude-sonnet-4-6'].toLowerCase()),
    'console.warn must name the failed Groq model'
  );
  assert.ok(warn.includes('anthropic'), 'console.warn must name the fallback provider');
});

test('callClaude: both providers fail → single bounded error naming both', async () => {
  fetchHandler = (url) =>
    url.includes('api.groq.com')
      ? json(500, { error: { message: 'groq boom' } })
      : json(529, { type: 'error', error: { type: 'overloaded_error', message: 'anthropic boom' } });
  await assert.rejects(
    () => callClaude({ system: 'sys', user: 'hi' }),
    (err: Error) => /groq/i.test(err.message) && /anthropic/i.test(err.message)
  );
  assert.equal(fetchCalls.length, 2, 'one Groq attempt + one Anthropic attempt, nothing more');
});

test('callClaude: Groq fails and ANTHROPIC_API_KEY unset → error names both providers tried', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  fetchHandler = () => GROQ_MODEL_NOT_FOUND();
  await assert.rejects(
    () => callClaude({ system: 'sys', user: 'hi' }),
    (err: Error) => /groq/i.test(err.message) && /anthropic/i.test(err.message)
  );
  assert.equal(anthropicCalls().length, 0, 'no Anthropic HTTP attempt without a key');
});

// ─── callClaudeWithTools failover ────────────────────────────────────────

test('callClaudeWithTools: Groq success → Anthropic never called', async () => {
  fetchHandler = () => GROQ_OK();
  const out = await callClaudeWithTools({ system: 'sys', user: 'hi' });
  assert.equal(out.text, 'groq says hi');
  assert.deepEqual(out.toolCalls, []);
  assert.equal(anthropicCalls().length, 0);
  assert.equal(groqCalls()[0].body.model, VERIFIED_GROQ_MODELS['claude-sonnet-4-6']);
});

test('callClaudeWithTools: Groq failure → Anthropic tool path invoked once', async () => {
  fetchHandler = (url) => (url.includes('api.groq.com') ? GROQ_MODEL_NOT_FOUND() : ANTHROPIC_OK());
  const out = await callClaudeWithTools({ system: 'sys', user: 'hi' });
  assert.equal(out.text, 'anthropic says hi');
  assert.equal(groqCalls().length, 1);
  assert.equal(anthropicCalls().length, 1);
  assert.ok(warnings.join('\n').toLowerCase().includes('groq'), 'degradation warn emitted');
});

test('callClaudeWithTools: forceProvider=groq is a hard pin — no Anthropic fallthrough', async () => {
  fetchHandler = () => json(500, { error: { message: 'groq boom' } });
  await assert.rejects(() => callClaudeWithTools({ system: 'sys', user: 'hi', forceProvider: 'groq' }));
  assert.equal(anthropicCalls().length, 0, 'an explicit pin must not silently switch providers');
});

test('callClaudeWithTools: forceProvider=anthropic never touches Groq', async () => {
  fetchHandler = () => ANTHROPIC_OK();
  const out = await callClaudeWithTools({ system: 'sys', user: 'hi', forceProvider: 'anthropic' });
  assert.equal(out.text, 'anthropic says hi');
  assert.equal(groqCalls().length, 0);
});
