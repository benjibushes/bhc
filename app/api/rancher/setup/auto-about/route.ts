import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import Anthropic from '@anthropic-ai/sdk';
import { JWT_SECRET } from '@/lib/secrets';

// Auto-fill About from website. Rancher pastes their site URL → we hit
// Tavily's content extraction → optionally pass through Claude for a
// brand-voice 150-word summary → return a draft About the rancher
// edits and saves. Cuts the blank-page paralysis.
//
// When ANTHROPIC_API_KEY is set, the cleaned Tavily output is fed to Claude
// with the BuyHalfCow voice prompt for a ~150-word paragraph. If the Claude
// call fails for any reason we fall back to the cleaned Tavily content
// (fail-open — never block the wizard on a model hiccup).

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function verifyToken(token: string): { rancherId: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'rancher-setup' || !decoded.rancherId) return null;
    return { rancherId: decoded.rancherId };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  const decoded = verifyToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid or expired setup link' }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const websiteUrl = String(body.url || '').trim();
  if (!websiteUrl) {
    return NextResponse.json({ error: 'Website URL required' }, { status: 400 });
  }

  // Normalize URL
  let normalized = websiteUrl;
  if (!normalized.startsWith('http')) normalized = `https://${normalized}`;
  try {
    new URL(normalized);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
  if (!TAVILY_API_KEY) {
    return NextResponse.json(
      { error: 'AI fetch not configured — paste your About manually' },
      { status: 503 }
    );
  }

  try {
    // Tavily extract — pulls clean text from the URL. Faster than search.
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        urls: [normalized],
        extract_depth: 'basic',
      }),
    });
    if (!res.ok) {
      // Fall back to Tavily search if extract isn't available on the plan.
      const searchRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query: `${normalized} about ranch family beef`,
          max_results: 3,
          include_raw_content: true,
        }),
      });
      const sJson: any = await searchRes.json();
      const text = (sJson?.results || [])
        .map((r: any) => r.raw_content || r.content || '')
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 2000);
      const summarized = await summarizeWithClaude(text);
      return NextResponse.json({ success: true, suggested: summarized });
    }

    const data: any = await res.json();
    // Tavily extract returns { results: [{ url, raw_content }] }. Don't
    // pre-slice — that truncates mid-tag and breaks the markdown-image
    // regex stripping in cleanScrape. Clean first, slice in cleanScrape.
    const text = (data?.results || [])
      .map((r: any) => r.raw_content || '')
      .filter(Boolean)
      .join('\n\n');

    if (!text) {
      return NextResponse.json(
        { error: 'No content found at that URL — paste your About manually' },
        { status: 404 }
      );
    }

    // Light cleanup — strip menus, footers, common boilerplate noise.
    const cleaned = cleanScrape(text);
    const summarized = await summarizeWithClaude(cleaned);

    return NextResponse.json({ success: true, suggested: summarized });
  } catch (e: any) {
    console.error('[auto-about] tavily failed:', e?.message);
    return NextResponse.json(
      { error: 'Could not fetch site — paste manually' },
      { status: 500 }
    );
  }
}

// Claude brand-voice summarization pass. Takes the Tavily-cleaned content
// and asks Claude for a ~150-word About paragraph in BuyHalfCow's voice
// (lowercase, direct, no corporate). Fail-open: any error returns the
// original Tavily content unchanged so the wizard never blocks.
async function summarizeWithClaude(content: string): Promise<string> {
  if (!content || content.trim().length < 80) return content;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return content;

  try {
    const client = new Anthropic({ apiKey });
    const prompt = `Write a 150-word About paragraph for this rancher in BuyHalfCow's voice: lowercase, direct, no corporate. Based on the following research: ${content}. Output JUST the paragraph text, no markdown headers.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content.find((b) => b.type === 'text');
    const summary = block && block.type === 'text' ? block.text.trim() : '';
    return summary || content;
  } catch (e: any) {
    console.error('[auto-about] claude summarize failed:', e?.message);
    return content;
  }
}

// Strip obvious nav/footer noise. Keep paragraph structure.
function cleanScrape(s: string): string {
  return s
    // Strip markdown images first — Tavily often returns markdown with the
    // image tags inline. They're noise for an "About" textarea. Match both
    // complete tags and incomplete (truncated) ones.
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/!\[[^\]]*\]\(\/\/[^\s\n]*/g, '') // incomplete tag (no closing paren)
    .replace(/!\[\]/g, '')
    // Strip markdown links but keep the text inside the brackets.
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip raw image-CDN URLs that escape the markdown
    .replace(/https?:\/\/[^\s]+\.(png|jpg|jpeg|svg|gif|webp)(\?[^\s]*)?/gi, '')
    // Collapse repeated whitespace + multi-newlines.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 30) // drop one-word menu items + nav noise
    .filter((l) => !/^(home|about|contact|shop|menu|cart|login|sign in|sign up)$/i.test(l))
    .filter((l) => !/©|all rights reserved|privacy policy|terms of service/i.test(l))
    .filter((l) => !/^[\s\d.,/-]+$/.test(l)) // drop lines that are only numbers/punctuation
    .filter((l) => !/^(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY)\b/i.test(l)) // currency switchers
    .filter((l) => !/^(United States|Japan|Canada|United Kingdom|Australia)\b$/i.test(l)) // country switchers
    .slice(0, 10) // cap paragraphs
    .join('\n\n')
    .slice(0, 2000); // final length cap on cleaned content
}
