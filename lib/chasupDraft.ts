// lib/chasupDraft.ts
//
// F7 (2026-08-18) — draft resolution for the referral-chasup buyer AI chase.
//
// WHY THIS EXISTS. The chase lane ran 100% llm-draft-failed for 3 straight
// days (Cron Runs 08-16/17/18: sent=0, llm-draft-failed 5/5, 5/5, 6/6) while
// every run reported 'success'. Root cause: Groq DECOMMISSIONED both models
// in lib/ai.ts's GROQ_MODELS map (llama-3.3-70b-versatile +
// llama-3.1-8b-instant are gone from GET /v1/models; a chat call returns
// `model_not_found`), and callClaude routes Groq-first whenever GROQ_API_KEY
// is set with NO fallthrough to Anthropic on failure — so every draft call
// throws, deterministically. The route's catch was console.warn + continue:
// the buyer was silently dropped and the run stayed green.
//
// The fix has two halves, both pure and pinned by lib/chasupDraft.test.ts:
//   • resolveChaseDraft — a failed/empty LLM draft falls back to a solid
//     static chase template instead of skipping the buyer. The LLM-success
//     path is byte-identical to the old inline logic (trim, ≥20 chars,
//     4000-char cap).
//   • chasupRunStatus — llmDraftFailed > 0 forces 'partial', so a dark AI
//     lane can never again read as a green run in Cron Runs.
//
// COPY CONTRACT for the static template (same as the LLM prompt's
// HALLUCINATION GUARD, P1 2026-06-23): no prices, no dollar amounts, no
// delivery/pickup dates, no promises. Connect-rail framing ONLY — broker rows
// never reach this template (the route's stale pool skips them via
// isBrokerRailReferral, post-#634), so "did the rancher reach out?" is always
// the true question. Rendered by the route as one <p> per newline, each line
// esc()'d, after a "Hi <first>," greeting the route adds itself.

export const MIN_DRAFT_LENGTH = 20;
export const MAX_DRAFT_LENGTH = 4000;

export interface ChaseDraftFacts {
  buyerFirstName: string;
  rancherName: string;
  /** This send, 1-based (Chase Count after increment). */
  chaseCount: number;
  /** Lifetime cap (MAX_CHASE_UPS in the route — 3). */
  maxChases: number;
  /** Whole days since the last activity signal. */
  daysStale: number;
}

/**
 * The static chase body used when the LLM draft fails or comes back empty.
 * Deliberately plain: warm, short, no invented facts, signs like the LLM
 * drafts do. One string per paragraph, joined with '\n' (the route splits on
 * newlines and wraps each in an escaped <p>).
 */
export function staticChaseBody(f: ChaseDraftFacts): string {
  const rancher = String(f.rancherName || 'the rancher');
  const days = Math.max(1, Math.floor(f.daysStale) || 1);
  const isFinal = f.chaseCount >= f.maxChases;
  const isFirst = f.chaseCount <= 1;

  const signoff = 'Talk soon,\nBenjamin from BuyHalfCow';

  if (isFinal) {
    return [
      `It has been ${days} days since my note about ${rancher}, so this is my last follow up. I do not want to clutter your inbox.`,
      `If you two already connected, even better. And if you are still interested, reply any time and I will pick the thread right back up.`,
      signoff,
    ].join('\n');
  }

  if (isFirst) {
    return [
      `It has been ${days} days since I introduced you to ${rancher}, and I wanted to make sure you two connected.`,
      `If you have already talked, wonderful. Nothing needed on your end. If you have not heard from them yet, just reply to this email and I will personally make sure ${rancher} reaches out.`,
      signoff,
    ].join('\n');
  }

  return [
    `Following up on my introduction to ${rancher} from ${days} days back. I know these decisions take time, so no rush on my end.`,
    `A quick reply helps me help you: have you two connected yet? If not, I will give ${rancher} a nudge so you are not left waiting.`,
    signoff,
  ].join('\n');
}

/**
 * Resolve the body the chase email will actually send.
 *
 * `raw` is the LLM draft, or null when the call threw. The success path
 * reproduces the pre-F7 inline logic exactly (trim, minimum length, cap);
 * anything else lands on the static template instead of a silent skip.
 */
export function resolveChaseDraft(
  raw: string | null | undefined,
  facts: ChaseDraftFacts,
): { body: string; usedFallback: boolean } {
  const trimmed = (raw ?? '').toString().trim();
  if (trimmed.length >= MIN_DRAFT_LENGTH) {
    return { body: trimmed.slice(0, MAX_DRAFT_LENGTH), usedFallback: false };
  }
  return { body: staticChaseBody(facts), usedFallback: true };
}

/**
 * Run-status truth: send errors OR LLM draft failures make the run 'partial'.
 * Before F7, only `errors` counted — three days of 100% draft failure
 * reported 'success' with sent=0.
 */
export function chasupRunStatus(i: { errors: number; llmDraftFailed: number }): 'success' | 'partial' {
  return i.errors > 0 || i.llmDraftFailed > 0 ? 'partial' : 'success';
}
