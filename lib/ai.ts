// Shared AI helper — priority order:
// 1. Ollama (local dev)  — set OLLAMA_BASE_URL=http://localhost:11434
// 2. Groq (free tier)    — set GROQ_API_KEY at console.groq.com (free, fast)
// 3. Anthropic (paid)    — fallback: on a MISSING Groq key, and also on a
//    FAILED Groq call (HTTP error / model_not_found / timeout). One
//    fallthrough, no retries — see groqWithAnthropicFallback below.

// Env is read at call time (not module load) so key rotations apply without a
// cold start and tests can toggle providers per-case.
const OLLAMA_BASE_URL = () => process.env.OLLAMA_BASE_URL || '';
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || 'llama3.2';
const GROQ_API_KEY = () => process.env.GROQ_API_KEY || '';
const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || '';

// Groq model mapping — free equivalents for each quality tier.
// IDs live-verified 2026-08-18 against GET https://api.groq.com/openai/v1/models
// (200; each ID answered a chat completion). Groq DECOMMISSIONS models without
// warning — the previous llama 70b/8b pair died this way and every AI lane
// went dark. If Groq errors with model_not_found, re-verify against the live
// /models list and update this map + this comment's date (lib/ai.test.ts pins
// both, and pins that no decommissioned ID lingers anywhere in this file).
export const GROQ_MODELS: Record<string, string> = {
  'claude-sonnet-4-6': 'openai/gpt-oss-120b',        // high quality, 131k ctx
  'claude-haiku-4-5-20251001': 'openai/gpt-oss-20b', // fast/cheap, 131k ctx
};
const GROQ_DEFAULT_MODEL = GROQ_MODELS['claude-sonnet-4-6'];

// A hung Groq request must become a catchable failure so the Anthropic
// fallthrough can fire — without this a Groq stall eats the whole cron budget.
const GROQ_TIMEOUT_MS = 60_000;

// One bounded fallthrough: try Groq, and on ANY failure (HTTP error,
// model_not_found, network error, timeout) make exactly one Anthropic attempt.
// No retry of Groq, no retry of Anthropic. The warn makes degradation visible
// in Vercel logs / Cron Runs. If Anthropic is unset or also fails, the thrown
// error names every provider tried (callers keep their own fallbacks, #642).
async function groqWithAnthropicFallback<T>(opts: {
  groqModel: string;
  groqCall: () => Promise<T>;
  anthropicCall: () => Promise<T>;
}): Promise<T> {
  try {
    return await opts.groqCall();
  } catch (groqErr) {
    const groqReason = groqErr instanceof Error ? groqErr.message : String(groqErr);
    console.warn(
      `[ai-failover] groq (${opts.groqModel}) failed: ${groqReason} — falling back to anthropic`
    );
    if (!ANTHROPIC_API_KEY()) {
      throw new Error(
        `All AI providers failed. Tried groq (${opts.groqModel}): ${groqReason}; anthropic: ANTHROPIC_API_KEY unset.`
      );
    }
    try {
      return await opts.anthropicCall();
    } catch (anthErr) {
      const anthReason = anthErr instanceof Error ? anthErr.message : String(anthErr);
      throw new Error(
        `All AI providers failed. Tried groq (${opts.groqModel}): ${groqReason}; anthropic: ${anthReason}`
      );
    }
  }
}

export async function callClaude(params: {
  model?: 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const withModel = { ...params, model: params.model || 'claude-sonnet-4-6' as const };
  if (OLLAMA_BASE_URL()) return callOllama(withModel);
  if (GROQ_API_KEY()) {
    return groqWithAnthropicFallback({
      groqModel: GROQ_MODELS[withModel.model] || GROQ_DEFAULT_MODEL,
      groqCall: () => callGroq(withModel),
      anthropicCall: () => callAnthropic(withModel),
    });
  }
  return callAnthropic(withModel);
}

async function callOllama(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL(),
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      stream: false,
      options: { num_predict: params.maxTokens || 1024 },
    }),
  });

  if (!response.ok) throw new Error(`Ollama API error: ${await response.text()}`);
  const data: any = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function callGroq(params: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const model = GROQ_MODELS[params.model] || GROQ_DEFAULT_MODEL;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY()}`,
    },
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      max_tokens: params.maxTokens || 1024,
    }),
  });

  if (!response.ok) throw new Error(`Groq API error: ${await response.text()}`);
  const data: any = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function callAnthropic(params: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  if (!ANTHROPIC_API_KEY()) {
    throw new Error('No AI configured. Set GROQ_API_KEY (free) or ANTHROPIC_API_KEY in env vars.');
  }

  // Prompt caching: mark the system prompt as cacheable. Anthropic returns
  // ~90% input-token discount on cache hits within a 5-min TTL. Worth it for
  // any system prompt > ~1k tokens that repeats across calls (audit cron,
  // coaching cron, classification crons all hit this frequently). System
  // prompts under 1024 tokens are below cache threshold and pass through
  // unchanged at full cost — no harm in always marking them cacheable.
  const systemBlocks =
    params.system.length > 0
      ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
      : undefined;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens || 1024,
      system: systemBlocks,
      messages: [{ role: 'user', content: params.user }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic API error: ${await response.text()}`);
  const data: any = await response.json();
  return data?.content?.[0]?.text || '';
}

// ─── Tool-use loop ────────────────────────────────────────────────────────
// callClaudeWithTools runs a tool-use conversation loop. Priority:
// 1. Groq (free — OpenAI-compatible tool calling)
// 2. Anthropic (paid fallback)
// The model can call any tool from the registry, we execute via runTool,
// feed results back, and loop until a final text response.
import { TOOLS as REGISTERED_TOOLS, runTool } from './aiTools';
import { buildMemoryContextBlock } from './aiMemory';

// Convert Anthropic tool schema to OpenAI/Groq format
function toOpenAITools(tools: typeof REGISTERED_TOOLS) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export async function callClaudeWithTools(params: {
  model?: 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
  system: string;
  user: string;
  maxTokens?: number;
  maxIterations?: number;
  /**
   * Pin to a specific provider. Default behavior (omitted) routes through
   * Groq if available then Anthropic. Use 'anthropic' for cron paths that
   * need reliable tool-schema validation — Groq's strict JSON-schema
   * validator has rejected valid integer literals as strings in the past
   * (2026-05-19 daily-audit failure on get_stalled_referrals minDays).
   */
  forceProvider?: 'anthropic' | 'groq';
}): Promise<{ text: string; toolCalls: { name: string; input: any; output: any }[] }> {
  // Inject persistent memory facts into the system prompt
  let memoryBlock = '';
  try {
    memoryBlock = await buildMemoryContextBlock();
  } catch (e) {
    console.error('Failed to load memory block:', e);
  }
  const systemWithMemory = params.system + memoryBlock;

  // Explicit pin wins — a pinned provider never silently switches, even on
  // failure (forceProvider=anthropic exists precisely to dodge Groq quirks).
  if (params.forceProvider === 'anthropic') {
    if (!ANTHROPIC_API_KEY()) throw new Error('forceProvider=anthropic but ANTHROPIC_API_KEY unset');
    return callAnthropicWithTools({ ...params, system: systemWithMemory });
  }
  if (params.forceProvider === 'groq') {
    if (!GROQ_API_KEY()) throw new Error('forceProvider=groq but GROQ_API_KEY unset');
    return callGroqWithTools({ ...params, system: systemWithMemory });
  }

  // Default: Groq (free) first, then Anthropic — on a missing Groq key AND on
  // a failed Groq call (one bounded fallthrough). Note: if Groq dies mid-loop
  // after executing some tools, the Anthropic pass restarts the conversation
  // from scratch (tools re-run; they are reads/idempotent writes).
  if (GROQ_API_KEY()) {
    return groqWithAnthropicFallback({
      groqModel: GROQ_MODELS[params.model || 'claude-sonnet-4-6'] || GROQ_DEFAULT_MODEL,
      groqCall: () => callGroqWithTools({ ...params, system: systemWithMemory }),
      anthropicCall: () => callAnthropicWithTools({ ...params, system: systemWithMemory }),
    });
  }
  if (ANTHROPIC_API_KEY()) {
    return callAnthropicWithTools({ ...params, system: systemWithMemory });
  }
  throw new Error('No AI provider configured for tool use. Set GROQ_API_KEY (free) or ANTHROPIC_API_KEY.');
}

// ─── Groq tool-use loop (OpenAI-compatible, FREE) ────────────────────────
async function callGroqWithTools(params: {
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
  maxIterations?: number;
}): Promise<{ text: string; toolCalls: { name: string; input: any; output: any }[] }> {
  const model = GROQ_MODELS[params.model || 'claude-sonnet-4-6'] || GROQ_DEFAULT_MODEL;
  const maxIterations = params.maxIterations || 6;
  const toolCalls: { name: string; input: any; output: any }[] = [];
  const openAITools = toOpenAITools(REGISTERED_TOOLS);

  const messages: any[] = [
    { role: 'system', content: params.system },
    { role: 'user', content: params.user },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY()}`,
      },
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        max_tokens: params.maxTokens || 2048,
        messages,
        tools: openAITools,
        tool_choice: 'auto',
      }),
    });
    if (!response.ok) throw new Error(`Groq tool API error: ${await response.text()}`);
    const data: any = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('Groq returned empty response');

    const msg = choice.message;
    messages.push(msg);

    // If no tool calls, we're done
    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
      return { text: msg.content || '', toolCalls };
    }

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      const fnName = tc.function.name;
      let fnArgs: any = {};
      try {
        fnArgs = JSON.parse(tc.function.arguments || '{}');
      } catch (e) {
        fnArgs = {};
      }
      const output = await runTool(fnName, fnArgs);
      toolCalls.push({ name: fnName, input: fnArgs, output });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      });
    }
  }

  return {
    text: '⚠️ Tool loop hit max iterations without resolving — partial answer only.',
    toolCalls,
  };
}

// ─── Anthropic tool-use loop (paid fallback) ─────────────────────────────
async function callAnthropicWithTools(params: {
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
  maxIterations?: number;
}): Promise<{ text: string; toolCalls: { name: string; input: any; output: any }[] }> {
  const model = params.model || 'claude-sonnet-4-6';
  const maxIterations = params.maxIterations || 6;
  const toolCalls: { name: string; input: any; output: any }[] = [];

  const messages: any[] = [{ role: 'user', content: params.user }];

  // Prompt caching for tool-use loop: system prompt + tool schemas are stable
  // across iterations within the same conversation, so cache them. This is
  // the biggest cost lever in BHC's AI usage — daily-digest, referral-chasup,
  // and the upcoming close-detector all run multi-turn tool-use against the
  // same large system+tools blob. Cache hits drop cost ~90% on the input
  // tokens (system + tools).
  const systemBlocks =
    params.system.length > 0
      ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
      : undefined;
  const toolsWithCache = REGISTERED_TOOLS.length
    ? [
        ...REGISTERED_TOOLS.slice(0, -1),
        // Cache breakpoint on the LAST tool — this caches all tool definitions
        // up to and including this one (Anthropic caches everything before
        // the marker).
        { ...REGISTERED_TOOLS[REGISTERED_TOOLS.length - 1], cache_control: { type: 'ephemeral' } },
      ]
    : REGISTERED_TOOLS;

  for (let i = 0; i < maxIterations; i++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: params.maxTokens || 2048,
        system: systemBlocks,
        tools: toolsWithCache,
        messages,
      }),
    });
    if (!response.ok) throw new Error(`Anthropic tool API error: ${await response.text()}`);
    const data: any = await response.json();

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason !== 'tool_use') {
      const textBlocks = (data.content || []).filter((b: any) => b.type === 'text');
      const text = textBlocks.map((b: any) => b.text).join('\n');
      return { text, toolCalls };
    }

    const toolUses = (data.content || []).filter((b: any) => b.type === 'tool_use');
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const output = await runTool(tu.name, tu.input);
      toolCalls.push({ name: tu.name, input: tu.input, output });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(output),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: '⚠️ Tool loop hit max iterations without resolving — partial answer only.',
    toolCalls,
  };
}
