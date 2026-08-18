// lib/chasupDraft.test.ts
//
// F7 (2026-08-18): the chasup buyer-chase lane ran 100% llm-draft-failed for
// 3 straight days (Groq decommissioned both models in lib/ai.ts's GROQ_MODELS
// map — every callClaude throws model_not_found) while the run reported
// 'success'. The stale-referral rescue rail was DARK and lying about it.
//
// These tests pin the two fixes:
//   1. resolveChaseDraft — a failed/empty LLM draft falls back to a solid
//      static chase template instead of silently skipping the buyer. The
//      LLM-success path is byte-identical to the old inline logic (trim,
//      ≥20 chars, 4000-char cap).
//   2. chasupRunStatus — any llmDraftFailed > 0 makes the run 'partial', so
//      Cron Runs can never again show a green run over a dark AI lane.
//
// Route wiring is pinned by source (route handlers can't be imported under
// tsx --test — they pull the whole Airtable/Resend stack at module load; same
// convention as lib/brokerDownstreamGates.test.ts).
//
// Run: npm test  (or npx tsx --test lib/chasupDraft.test.ts)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveChaseDraft,
  staticChaseBody,
  chasupRunStatus,
  MIN_DRAFT_LENGTH,
  MAX_DRAFT_LENGTH,
  type ChaseDraftFacts,
} from './chasupDraft';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function facts(overrides: Partial<ChaseDraftFacts> = {}): ChaseDraftFacts {
  return {
    buyerFirstName: 'Sam',
    rancherName: 'High Lonesome Ranch',
    chaseCount: 1,
    maxChases: 3,
    daysStale: 6,
    ...overrides,
  };
}

// ── LLM-success path — byte-identical to the old inline logic ───────────────

test('a good LLM draft is used verbatim (trimmed), no fallback', () => {
  const raw = '  Wanted to circle back on the intro I made for you.\nAny word from the ranch?  ';
  const out = resolveChaseDraft(raw, facts());
  assert.equal(out.usedFallback, false);
  assert.equal(out.body, raw.trim());
});

test('a draft over the 4000-char cap is truncated, still no fallback', () => {
  const raw = 'a'.repeat(MAX_DRAFT_LENGTH + 500);
  const out = resolveChaseDraft(raw, facts());
  assert.equal(out.usedFallback, false);
  assert.equal(out.body.length, MAX_DRAFT_LENGTH);
});

test('a draft exactly at the minimum length is accepted', () => {
  const raw = 'x'.repeat(MIN_DRAFT_LENGTH);
  const out = resolveChaseDraft(raw, facts());
  assert.equal(out.usedFallback, false);
  assert.equal(out.body, raw);
});

// ── LLM-failure path — static template instead of a silent skip ─────────────

test('null (thrown call) → static fallback, not a skip', () => {
  const out = resolveChaseDraft(null, facts());
  assert.equal(out.usedFallback, true);
  assert.equal(out.body, staticChaseBody(facts()));
  assert.ok(out.body.length >= MIN_DRAFT_LENGTH);
});

test('empty string → static fallback', () => {
  const out = resolveChaseDraft('', facts());
  assert.equal(out.usedFallback, true);
  assert.equal(out.body, staticChaseBody(facts()));
});

test('too-short draft (< 20 chars) → static fallback', () => {
  const out = resolveChaseDraft('ok thanks', facts());
  assert.equal(out.usedFallback, true);
});

test('whitespace-only draft → static fallback', () => {
  const out = resolveChaseDraft('   \n  \n ', facts());
  assert.equal(out.usedFallback, true);
});

// ── The static template itself ──────────────────────────────────────────────

test('static body names the rancher and reads as multiple paragraphs', () => {
  const body = staticChaseBody(facts());
  assert.ok(body.includes('High Lonesome Ranch'));
  assert.ok(body.split('\n').filter(Boolean).length >= 2, 'renders as 2+ <p> blocks in the route template');
});

test('static body never carries prices, dollar amounts, or invented commitments', () => {
  for (const chaseCount of [1, 2, 3]) {
    const body = staticChaseBody(facts({ chaseCount }));
    // Same contract the LLM prompt enforces (HALLUCINATION GUARD P1
    // 2026-06-23): no prices, no dates promised, no guarantees.
    assert.ok(!body.includes('$'), 'no dollar amounts');
    assert.ok(!/\bprice|discount|guarantee|deliver(y|ed) (on|by)\b/i.test(body), 'no invented commitments');
  }
});

test('final chase (count === max) says it is the last follow up', () => {
  const body = staticChaseBody(facts({ chaseCount: 3 }));
  assert.ok(/last/i.test(body), 'final chase must set the expectation this is the last touch');
  const first = staticChaseBody(facts({ chaseCount: 1 }));
  assert.ok(!/last/i.test(first), 'first chase must NOT claim to be the last');
});

test('static body is Connect-rail copy — asks whether the rancher reached out', () => {
  // Broker rows are filtered out of the stale pool upstream (post-#634
  // broker-rail skip), so this template only ever reaches Connect buyers —
  // where "did the rancher reach out?" is the true question. It must never
  // use broker framing (deposit/pickup/balance).
  const body = staticChaseBody(facts());
  assert.ok(/reach(ed)? out|connect|heard/i.test(body));
  assert.ok(!/deposit|balance|pickup|commission/i.test(body), 'no broker-rail framing');
});

test('static body mentions how long it has been', () => {
  const body = staticChaseBody(facts({ daysStale: 9 }));
  assert.ok(body.includes('9'), 'references daysStale so the note reads as personal, not canned');
});

// ── Run status truth ────────────────────────────────────────────────────────

test('clean run → success', () => {
  assert.equal(chasupRunStatus({ errors: 0, llmDraftFailed: 0 }), 'success');
});

test('any llmDraftFailed → partial (a dark AI lane must never read green)', () => {
  assert.equal(chasupRunStatus({ errors: 0, llmDraftFailed: 1 }), 'partial');
  assert.equal(chasupRunStatus({ errors: 0, llmDraftFailed: 5 }), 'partial');
});

test('any send errors → partial (pre-existing behavior preserved)', () => {
  assert.equal(chasupRunStatus({ errors: 2, llmDraftFailed: 0 }), 'partial');
});

// ── Route wiring pins (source contract) ─────────────────────────────────────

test('PIN referral-chasup: the route resolves drafts through the fallback, not a skip', () => {
  const src = read('../app/api/cron/referral-chasup/route.ts');
  assert.match(src, /import \{ resolveChaseDraft, chasupRunStatus \} from '@\/lib\/chasupDraft'/);
  assert.match(src, /resolveChaseDraft\(/);
  // The old failure mode: catch → console.warn → `continue` (buyer silently
  // dropped). The catch around callClaude must now hand a null to the
  // resolver instead of skipping the buyer.
  assert.ok(!src.includes('skipping (no email)'), 'LLM failure must no longer skip the buyer');
});

test('PIN referral-chasup: run status + notes carry the LLM failure count', () => {
  const src = read('../app/api/cron/referral-chasup/route.ts');
  assert.match(src, /chasupRunStatus\(\{ errors, llmDraftFailed \}\)/);
  assert.match(src, /llmDraftFailed=\$\{llmDraftFailed\}/);
});

test('PIN referral-chasup: the 350ms pacing the loop comment claims actually exists', () => {
  // fea7a13 raised the cap 8→25 and *documented* a 350ms sleep that was never
  // written. The Airtable 5 req/s ceiling relies on it.
  const src = read('../app/api/cron/referral-chasup/route.ts');
  assert.match(src, /setTimeout\(\w+, 350\)/);
});
