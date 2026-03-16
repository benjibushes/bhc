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
