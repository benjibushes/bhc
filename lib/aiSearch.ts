// AI web-search abstraction for the discover-ranchers scraper.
//
// Two providers, single contract:
//   - Tavily (fast, structured, paid, ~$0.005/search) — preferred when
//     `TAVILY_API_KEY` is set in env.
//   - Anthropic native web_search tool — fallback when Tavily is unset
//     (returns less structured results, but no extra paid dependency).
//
// Used by `scripts/discover-ranchers.mjs` (gitignored operational script).
// The script is .mjs, so this .ts file is consumed only when discovery is
// invoked from a Next.js context (e.g., a future admin endpoint that triggers
// a one-off state seed). The script itself reimplements the same shape in
// plain JS to avoid a TypeScript build dependency.

import { TAVILY_API_KEY } from './secrets';

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  rawScore?: number; // provider-specific relevance signal, optional
};

export type SearchOptions = {
  maxResults?: number;
  // Optional bias for "include domains" / "exclude domains". Tavily honors
  // these natively; the Anthropic fallback applies them client-side.
  includeDomains?: string[];
  excludeDomains?: string[];
};

const DEFAULT_MAX_RESULTS = 10;

// ── Tavily ──────────────────────────────────────────────────────────────────

async function tavilySearch(
  query: string,
  opts: SearchOptions
): Promise<SearchResult[]> {
  if (!TAVILY_API_KEY) {
    throw new Error('Tavily not configured — TAVILY_API_KEY is missing');
  }
  const body: Record<string, unknown> = {
    api_key: TAVILY_API_KEY,
    query,
    max_results: opts.maxResults ?? DEFAULT_MAX_RESULTS,
    search_depth: 'basic',
    include_answer: false,
  };
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Tavily search failed: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const results = data.results || [];
  return results.map((r) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: String(r.content || r.snippet || ''),
    rawScore: typeof r.score === 'number' ? r.score : undefined,
  }));
}

// ── Anthropic web_search fallback ───────────────────────────────────────────
//
// Uses Claude Sonnet's native `web_search` tool to gather URLs + snippets
// for the same query. Slower than Tavily and the result schema is opaque, so
// we use a small system prompt that forces the model to emit JSON we can
// parse. Acceptable fallback when Tavily isn't configured (e.g. local dev).

async function anthropicWebSearch(
  query: string,
  opts: SearchOptions
): Promise<SearchResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('No search provider available — set TAVILY_API_KEY or ANTHROPIC_API_KEY');
  }
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;

  const sys =
    'You are a search runner. Given a query, call the web_search tool, then ' +
    'return ONLY a strict JSON array of {title, url, snippet} objects. No prose.';

  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: sys,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    messages: [
      {
        role: 'user',
        content: `Search for: ${query}\nReturn the top ${maxResults} results as JSON [{title,url,snippet}].`,
      },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic search failed: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = (data.content || []).find((c) => c.type === 'text');
  const text = textBlock?.text || '';
  // Try to extract a JSON array from the response.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as Array<Record<string, unknown>>;
    let results: SearchResult[] = parsed.map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.snippet || r.content || ''),
    }));
    // Apply client-side include/exclude (Tavily does this server-side).
    if (opts.excludeDomains?.length) {
      results = results.filter(
        (r) => !opts.excludeDomains!.some((d) => r.url.includes(d))
      );
    }
    if (opts.includeDomains?.length) {
      results = results.filter((r) =>
        opts.includeDomains!.some((d) => r.url.includes(d))
      );
    }
    return results.slice(0, maxResults);
  } catch {
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a web search using the best-available provider.
 *
 * Provider precedence:
 *   1. Tavily (if `TAVILY_API_KEY` is set in env)
 *   2. Anthropic native `web_search` tool (if `ANTHROPIC_API_KEY` is set)
 *
 * Throws if neither provider is configured.
 */
export async function aiSearch(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  if (TAVILY_API_KEY) {
    try {
      return await tavilySearch(query, opts);
    } catch (err) {
      console.warn('[aiSearch] Tavily failed, falling back to Anthropic:', err);
      // fall through to Anthropic
    }
  }
  return anthropicWebSearch(query, opts);
}

/** Returns a label describing which provider would be used right now. */
export function describeAiSearchProvider(): 'tavily' | 'anthropic' | 'none' {
  if (TAVILY_API_KEY) return 'tavily';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'none';
}
