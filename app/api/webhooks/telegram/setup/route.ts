import { NextResponse } from 'next/server';
import { requireCron } from '@/lib/cronAuth';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// One-time setup endpoint to register the Telegram webhook URL with the Telegram Bot API.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (requireCron). The old
// `?secret=ADMIN_PASSWORD` query auth leaked the admin password into Vercel
// access logs on every hit — removed in the cron-auth sweep.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" $SITE/api/webhooks/telegram/setup                 # register
//   curl -H "Authorization: Bearer $CRON_SECRET" "$SITE/api/webhooks/telegram/setup?action=info"   # current status
//   curl -H "Authorization: Bearer $CRON_SECRET" "$SITE/api/webhooks/telegram/setup?action=delete" # remove webhook
export async function GET(request: Request) {
  const denied = requireCron(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'register';

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
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const res = await fetch(`${telegramApi}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      ...(webhookSecret ? { secret_token: webhookSecret } : {}),
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
