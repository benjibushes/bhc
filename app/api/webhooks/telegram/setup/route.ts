import { NextResponse } from 'next/server';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// One-time setup endpoint to register the Telegram webhook URL with the Telegram Bot API.
// Hit GET /api/webhooks/telegram/setup?secret=YOUR_ADMIN_PASSWORD to register.
// Hit GET /api/webhooks/telegram/setup?secret=YOUR_ADMIN_PASSWORD&action=info to check current status.
// Hit GET /api/webhooks/telegram/setup?secret=YOUR_ADMIN_PASSWORD&action=delete to remove webhook.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  const action = searchParams.get('action') || 'register';

  // Simple auth — use ADMIN_PASSWORD
  if (secret !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!TELEGRAM_BOT_TOKEN) {
    return NextResponse.json(
      { error: 'TELEGRAM_BOT_TOKEN not set in environment variables' },
      { status: 500 }
    );
  }

  const telegramApi = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

  if (action === 'info') {
    const res = await fetch(`${telegramApi}/getWebhookInfo`);
    const data = await res.json();
    return NextResponse.json(data);
  }

  if (action === 'delete') {
    const res = await fetch(`${telegramApi}/deleteWebhook`, { method: 'POST' });
    const data = await res.json();
    return NextResponse.json({ message: 'Webhook deleted', result: data });
  }

  // Register the webhook
  const webhookUrl = `${SITE_URL}/api/webhooks/telegram`;
  const res = await fetch(`${telegramApi}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }),
  });

  const data = await res.json();

  if (data.ok) {
    return NextResponse.json({
      success: true,
      message: `✅ Telegram webhook registered at: ${webhookUrl}`,
      result: data,
    });
  } else {
    return NextResponse.json({
      success: false,
      message: `❌ Failed to register webhook`,
      result: data,
    }, { status: 500 });
  }
}
