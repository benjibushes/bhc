const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: any) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.warn('Telegram not configured, skipping notification');
    return null;
  }

  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };

  if (replyMarkup) {
    body.reply_markup = JSON.stringify(replyMarkup);
  }

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Telegram send error:', err);
    return null;
  }

  return res.json();
}

async function editTelegramMessage(chatId: string, messageId: number, text: string) {
  if (!TELEGRAM_BOT_TOKEN) return null;

  const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    }),
  });

  return res.ok ? res.json() : null;
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  if (!TELEGRAM_BOT_TOKEN) return null;

  const res = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || 'Done',
    }),
  });

  return res.ok ? res.json() : null;
}

export async function sendTelegramReferralNotification(data: {
  referralId: string;
  buyerName: string;
  buyerState: string;
  orderType: string;
  budgetRange: string;
  intentScore: number;
  intentClassification: string;
  notes: string;
  suggestedRancher: {
    name: string;
    activeReferrals: number;
    maxReferrals: number;
  } | null;
}) {
  const rancherLine = data.suggestedRancher
    ? `\n🤠 <b>Suggested:</b> ${data.suggestedRancher.name}\n   Load: ${data.suggestedRancher.activeReferrals}/${data.suggestedRancher.maxReferrals}`
    : '\n⚠️ <b>No rancher match found</b>';

  const message = `🔔 <b>NEW BUYER LEAD</b>

📊 Intent: ${data.intentScore} (${data.intentClassification})

👤 <b>Buyer:</b> ${data.buyerName}
📍 <b>State:</b> ${data.buyerState}
🥩 <b>Order:</b> ${data.orderType}
💵 <b>Budget:</b> ${data.budgetRange}
${rancherLine}

📝 <b>Notes:</b> ${data.notes || 'None'}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `approve_${data.referralId}` },
        { text: 'Reassign', callback_data: `reassign_${data.referralId}` },
      ],
      [
        { text: 'View Details', callback_data: `details_${data.referralId}` },
        { text: 'Reject', callback_data: `reject_${data.referralId}` },
      ],
    ],
  };

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
}

export async function sendTelegramUpdate(text: string) {
  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, text);
}

export { sendTelegramMessage, editTelegramMessage, answerCallbackQuery, TELEGRAM_ADMIN_CHAT_ID };
