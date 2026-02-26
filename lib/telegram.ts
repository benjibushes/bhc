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

export async function sendTelegramConsumerSignup(data: {
  consumerId: string;
  name: string;
  email: string;
  state: string;
  segment: string;
  intentScore: number;
  intentClassification: string;
  status: string;
  orderType?: string;
  budgetRange?: string;
}) {
  const statusEmoji = data.status === 'approved' ? '✅' : '⏳';
  const segmentEmoji = data.segment === 'Beef Buyer' ? '🥩' : '🏷️';

  const message = `👤 <b>NEW SIGNUP</b>

${segmentEmoji} <b>Segment:</b> ${data.segment}
📊 <b>Intent:</b> ${data.intentScore} (${data.intentClassification})
${statusEmoji} <b>Status:</b> ${data.status === 'approved' ? 'Auto-Approved' : 'Pending Review'}

<b>Name:</b> ${data.name}
📧 ${data.email}
📍 ${data.state}${data.orderType ? `\n🥩 Order: ${data.orderType}` : ''}${data.budgetRange ? `\n💵 Budget: ${data.budgetRange}` : ''}`;

  if (data.status !== 'approved') {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `capprove_${data.consumerId}` },
          { text: '❌ Reject', callback_data: `creject_${data.consumerId}` },
        ],
        [
          { text: '🔍 View Details', callback_data: `cdetails_${data.consumerId}` },
        ],
      ],
    };
    return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
  }

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message);
}

export async function sendTelegramPartnerAlert(data: {
  type: 'rancher' | 'brand' | 'land';
  recordId: string;
  name: string;
  email: string;
  state?: string;
  details: string;
}) {
  const typeEmoji = data.type === 'rancher' ? '🤠' : data.type === 'brand' ? '🛠️' : '🏞️';
  const typeLabel = data.type.charAt(0).toUpperCase() + data.type.slice(1);

  const message = `${typeEmoji} <b>NEW ${typeLabel.toUpperCase()} APPLICATION</b>

<b>Name:</b> ${data.name}
📧 ${data.email}${data.state ? `\n📍 ${data.state}` : ''}

${data.details}`;

  if (data.type === 'rancher') {
    const calLink = process.env.NEXT_PUBLIC_CALENDLY_LINK || process.env.CALENDLY_LINK || '';
    const keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } = {
      inline_keyboard: [],
    };
    if (calLink) {
      keyboard.inline_keyboard.push([{ text: '📅 Schedule Call', url: calLink }]);
    }
    keyboard.inline_keyboard.push([
      { text: '📦 Send Onboarding', callback_data: `ronboard_${data.recordId}` },
    ]);
    return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
  }

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message);
}

export async function sendTelegramUpdate(text: string) {
  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, text);
}

export { sendTelegramMessage, editTelegramMessage, answerCallbackQuery, TELEGRAM_ADMIN_CHAT_ID };
