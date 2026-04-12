import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';

export const maxDuration = 30;

// Health check endpoint — pings every external dependency in parallel.
// GET /api/health?secret=CRON_SECRET
// Returns { status: "healthy" | "degraded" | "down", checks: { ... } }
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && secret !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
  const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || '';

  type CheckResult = { ok: boolean; ms: number; error?: string };

  async function timedCheck(name: string, fn: () => Promise<void>): Promise<CheckResult> {
    const start = Date.now();
    try {
      await fn();
      return { ok: true, ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, ms: Date.now() - start, error: e.message || String(e) };
    }
  }

  const [airtable, resend, telegram, ai] = await Promise.all([
    // Airtable: lightweight query guaranteed to return 0 rows
    timedCheck('airtable', async () => {
      await getAllRecords(TABLES.CONSUMERS, '{Email} = "healthcheck@test.invalid"');
    }),
    // Resend: check domains endpoint to verify API key works
    timedCheck('resend', async () => {
      if (!RESEND_API_KEY || RESEND_API_KEY === 're_placeholder_for_build') {
        throw new Error('RESEND_API_KEY not configured');
      }
      const res = await fetch('https://api.resend.com/domains', {
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
      });
      if (!res.ok) throw new Error(`Resend API returned ${res.status}`);
    }),
    // Telegram: getMe to verify bot token
    timedCheck('telegram', async () => {
      if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not configured');
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
      if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
    }),
    // AI: check whichever provider is configured
    timedCheck('ai', async () => {
      if (OLLAMA_BASE_URL) {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
      } else if (GROQ_API_KEY) {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
        });
        if (!res.ok) throw new Error(`Groq returned ${res.status}`);
      } else if (ANTHROPIC_API_KEY) {
        // Just verify the key format is valid (don't burn tokens)
        if (!ANTHROPIC_API_KEY.startsWith('sk-ant-')) throw new Error('Invalid ANTHROPIC_API_KEY format');
      } else {
        throw new Error('No AI provider configured');
      }
    }),
  ]);

  const checks = { airtable, resend, telegram, ai };
  const criticalDown = !airtable.ok || !resend.ok || !telegram.ok;
  const status = criticalDown ? 'down' : !ai.ok ? 'degraded' : 'healthy';

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    checks,
  });
}
