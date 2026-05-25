const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ── Per-chat throttle (1 msg/sec/chat is Telegram's hard limit) ─────────
// Without this, burst events (cron loops, signup spikes) blast multiple
// messages in the same second → 429 with retry_after → currently dropped
// silently because the old code only logged the error. This preserves the
// happy-path behavior and adds: (a) sequencing per chat, (b) sliding-window
// throttle, (c) automatic retry_after honor on 429.
const _chatGate: Record<string, Promise<unknown>> = {};
const _lastSendAt: Record<string, number> = {};
const TG_MIN_GAP_MS = 1100; // 1 msg/sec/chat with a hair of slack
async function _gateForChat(chatId: string, fn: () => Promise<any>): Promise<any> {
  const prev = _chatGate[chatId] || Promise.resolve();
  const next = prev.then(async () => {
    const since = Date.now() - (_lastSendAt[chatId] || 0);
    if (since < TG_MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, TG_MIN_GAP_MS - since));
    }
    try {
      return await fn();
    } finally {
      _lastSendAt[chatId] = Date.now();
    }
  });
  // Don't keep failed sends in the chain — swap to resolved so future calls don't reject.
  _chatGate[chatId] = next.catch(() => undefined);
  return next;
}

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

  // If HTML parsing fails, retry without parse_mode (plain text fallback)
  // This prevents user-submitted data with <, >, & from breaking notifications

  if (replyMarkup) {
    body.reply_markup = JSON.stringify(replyMarkup);
  }

  return _gateForChat(chatId, async () => {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Honor Telegram's documented retry_after on 429.
    if (res.status === 429) {
      let retryMs = 1000;
      try {
        const j = await res.clone().json();
        if (j?.parameters?.retry_after) retryMs = Math.min(30_000, Number(j.parameters.retry_after) * 1000);
      } catch {}
      console.warn(`Telegram 429 — backing off ${retryMs}ms then retrying once`);
      await new Promise(r => setTimeout(r, retryMs));
      const retry = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (retry.ok) return retry.json();
      console.error('Telegram 429 retry failed:', await retry.text());
      return null;
    }

    if (!res.ok) {
      const err = await res.text();
      console.error('Telegram send error:', err);
      // Retry without HTML parsing — handles user data with <, >, & characters
      try {
        const fallbackBody: any = {
          chat_id: chatId,
          text: text.replace(/<[^>]*>/g, ''), // strip HTML tags for plain text
        };
        if (replyMarkup) fallbackBody.reply_markup = JSON.stringify(replyMarkup);
        const retryRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fallbackBody),
        });
        if (retryRes.ok) return retryRes.json();
        console.error('Telegram fallback also failed:', await retryRes.text());
      } catch (retryErr) {
        console.error('Telegram fallback error:', retryErr);
      }
      return null;
    }

    return res.json();
  });
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
  matchType?: string;
  suggestedRancher: {
    name: string;
    activeReferrals: number;
    maxReferrals: number;
  } | null;
}) {
  const matchLabel = data.matchType === 'nationwide' ? ' 🌎 NATIONWIDE' : data.matchType === 'direct' ? ' 🎯 DIRECT (RANCHER PAGE)' : data.matchType === 'local' ? ' 📍 LOCAL' : '';
  const rancherLine = data.suggestedRancher
    ? `\n🤠 <b>Suggested:</b> ${data.suggestedRancher.name}${matchLabel}\n   Load: ${data.suggestedRancher.activeReferrals}/${data.suggestedRancher.maxReferrals}`
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

// Fired in addition to the standard signup notification when a buyer scores 80+.
// Loud, distinctive, action-oriented — designed to make Ben (or his hires)
// drop everything and reach out within minutes.
export async function sendTelegramHotLeadAlert(data: {
  consumerId: string;
  name: string;
  email: string;
  phone?: string;
  state: string;
  intentScore: number;
  orderType?: string;
  budgetRange?: string;
  notes?: string;
}) {
  const phoneLine = data.phone ? `📱 <b>${data.phone}</b>` : '📱 <i>No phone provided</i>';
  const message = `🔥🔥🔥 <b>HOT LEAD — ACT NOW</b> 🔥🔥🔥

📊 Intent: <b>${data.intentScore}/100</b> (high)
⏱ Reach out within 5 min for best close rate

👤 <b>${data.name}</b>
📧 ${data.email}
${phoneLine}
📍 ${data.state}${data.orderType ? `\n🥩 Order: <b>${data.orderType}</b>` : ''}${data.budgetRange ? `\n💵 Budget: <b>${data.budgetRange}</b>` : ''}${data.notes ? `\n\n📝 <i>${data.notes}</i>` : ''}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📞 Mark Contacted', callback_data: `hotcontact_${data.consumerId}` },
        { text: '✉️ Draft Email', callback_data: `hotemail_${data.consumerId}` },
      ],
      [
        { text: '👁 Full Details', callback_data: `cdetails_${data.consumerId}` },
      ],
    ],
  };

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
}

// Big celebration when a referral closes won. If isFirstSaleForRancher is true,
// the message goes extra loud — that's a milestone we want Ben to feel.
export async function sendTelegramSaleCelebration(data: {
  referralId: string;
  buyerName: string;
  rancherName: string;
  saleAmount: number;
  commission: number;
  isFirstSaleForRancher: boolean;
  monthlyWins: number;
  monthlyCommission: number;
  lifetimeWins: number;
  lifetimeCommission: number;
}) {
  const banner = data.isFirstSaleForRancher
    ? `🎉🎉🎉 <b>FIRST SALE — ${data.rancherName.toUpperCase()}</b> 🎉🎉🎉\n\nThis is their first closed deal on BuyHalfCow. Big moment.`
    : `💰 <b>DEAL CLOSED</b> 💰`;

  const message = `${banner}

🤠 Rancher: <b>${data.rancherName}</b>
👤 Buyer: <b>${data.buyerName}</b>
💵 Sale: <b>$${data.saleAmount.toLocaleString()}</b>
💰 Commission: <b>$${data.commission.toLocaleString()}</b>

<b>This Month</b>
✅ ${data.monthlyWins} deal${data.monthlyWins === 1 ? '' : 's'} closed
💰 $${data.monthlyCommission.toLocaleString()} earned

<b>Lifetime</b>
✅ ${data.lifetimeWins} deals
💰 $${data.lifetimeCommission.toLocaleString()} total commission`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '💰 Mark Paid', callback_data: `markpaid_${data.referralId}` },
        { text: '🙏 Thank Rancher', callback_data: `thankrancher_${data.referralId}` },
      ],
    ],
  };

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
}

export async function sendTelegramUpdate(text: string) {
  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Founder backer alerts (Project 3 — Founding Herd)
//
// All three fire from /api/webhooks/stripe with one-tap action buttons so Ben
// can send group invites, DM backers, or refund without leaving Telegram.
// ─────────────────────────────────────────────────────────────────────────────

export async function sendTelegramFounderBacker(data: {
  email: string;
  name?: string;
  tier: string;
  founderNumber?: number | null;
  amountCents: number;
  isLifetime: boolean;
  consumerId: string;
  /**
   * True when this row was comped via /api/admin/founders/comp (not a Stripe
   * payment). Renders distinctly so operator never confuses a comp with a
   * failed payment ($0 lifetime would otherwise look like a webhook bug).
   */
  isComped?: boolean;
}) {
  const amountStr = `$${(data.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const numberStr = data.founderNumber ? ` (#${data.founderNumber})` : '';
  const lifetimeStr = data.isLifetime ? ' lifetime' : '/recurring';
  const header = data.isComped
    ? `🎁 <b>Founding Herd — COMPED</b>\n\n`
    : `🪙 <b>Founding Herd Backer</b>\n\n`;
  const amountLine = data.isComped
    ? `Tier: ${escapeHtml(data.tier)} · <i>comped (no charge)</i>`
    : `Tier: ${escapeHtml(data.tier)} · ${amountStr}${lifetimeStr}`;
  const message =
    header +
    `<b>${escapeHtml(data.name || data.email)}</b>${numberStr}\n` +
    amountLine + `\n` +
    `Email: <code>${escapeHtml(data.email)}</code>`;

  // Action buttons. No group-invite — backers wanted email, not Telegram.
  // Personal email (within 48h) is the high-touch motion for Title Founders;
  // for everyone else the welcome email already covers the ground.
  const keyboard = {
    inline_keyboard: [[
      { text: '📧 Email backer', url: `mailto:${data.email}` },
      { text: '📅 Calendar invite', url: `mailto:${data.email}?subject=${encodeURIComponent('Welcome to the Founding Herd — let\'s find a time')}&body=${encodeURIComponent('Hey — Ben here. Wanted to say thanks personally. My calendar\'s at ' + (process.env.CALENDLY_LINK || 'https://buyhalfcow.com/call') + ' if you ever want to hop on. — Ben')}` },
    ]],
  };

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
}

export async function sendTelegramSubscriptionCancelled(data: {
  email: string;
  name?: string;
  tier: string;
  consumerId: string;
}) {
  const message =
    `⚠️ <b>Founder subscription cancelled</b>\n\n` +
    `<b>${escapeHtml(data.name || data.email)}</b>\n` +
    `Tier: ${escapeHtml(data.tier)}\n` +
    `Email: <code>${escapeHtml(data.email)}</code>\n\n` +
    `Personal save attempt recommended within 48h.`;

  const keyboard = {
    inline_keyboard: [[
      { text: '📧 Email to save', url: `mailto:${data.email}?subject=${encodeURIComponent('Hey — saw your Founding Herd cancel')}` },
    ]],
  };

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
}

export async function sendTelegramInvoiceFailed(data: {
  email: string;
  name?: string;
  tier: string;
  amountCents: number;
}) {
  const amountStr = `$${(data.amountCents / 100).toFixed(2)}`;
  const message =
    `🚨 <b>Founder invoice payment failed</b>\n\n` +
    `<b>${escapeHtml(data.name || data.email)}</b>\n` +
    `Tier: ${escapeHtml(data.tier)} · ${amountStr}\n` +
    `Email: <code>${escapeHtml(data.email)}</code>\n\n` +
    `Stripe will auto-retry. Reach out personally if it fails again.`;

  const keyboard = {
    inline_keyboard: [[
      { text: '📧 Email backer', url: `mailto:${data.email}` },
    ]],
  };

  return sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message, keyboard);
}

// Telegram HTML mode escapes — only `<`, `>`, `&` need escaping.
function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export { sendTelegramMessage, editTelegramMessage, answerCallbackQuery, TELEGRAM_ADMIN_CHAT_ID };
