// Shared AI helper — priority order:
// 1. Ollama (local dev)  — set OLLAMA_BASE_URL=http://localhost:11434
// 2. Groq (free tier)    — set GROQ_API_KEY at console.groq.com (free, fast)
// 3. Anthropic (paid)    — set ANTHROPIC_API_KEY (fallback)

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Groq model mapping — free equivalents for each quality tier
const GROQ_MODELS: Record<string, string> = {
  'claude-sonnet-4-6': 'llama-3.3-70b-versatile',    // high quality
  'claude-haiku-4-5-20251001': 'llama-3.1-8b-instant', // fast/cheap
};

export async function callClaude(params: {
  model?: 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const withModel = { ...params, model: params.model || 'claude-sonnet-4-6' as const };
  if (OLLAMA_BASE_URL) return callOllama(withModel);
  if (GROQ_API_KEY) return callGroq(withModel);
  return callAnthropic(withModel);
}

async function callOllama(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
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
  const model = GROQ_MODELS[params.model] || 'llama-3.3-70b-versatile';

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
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
  if (!ANTHROPIC_API_KEY) {
    throw new Error('No AI configured. Set GROQ_API_KEY (free) or ANTHROPIC_API_KEY in env vars.');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens || 1024,
      system: params.system,
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
}): Promise<{ text: string; toolCalls: { name: string; input: any; output: any }[] }> {
  // Inject persistent memory facts into the system prompt
  let memoryBlock = '';
  try {
    memoryBlock = await buildMemoryContextBlock();
  } catch (e) {
    console.error('Failed to load memory block:', e);
  }
  const systemWithMemory = params.system + memoryBlock;

  // Route to Groq (free) if available, otherwise Anthropic
  if (GROQ_API_KEY) {
    return callGroqWithTools({ ...params, system: systemWithMemory });
  }
  if (ANTHROPIC_API_KEY) {
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
  const model = GROQ_MODELS[params.model || 'claude-sonnet-4-6'] || 'llama-3.3-70b-versatile';
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
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
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

  for (let i = 0; i < maxIterations; i++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: params.maxTokens || 2048,
        system: params.system,
        tools: REGISTERED_TOOLS,
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
