import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, createRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { getMaxActiveReferrals, getLiveCapacity, incrementCapacity, decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  TELEGRAM_ADMIN_CHAT_ID,
} from '@/lib/telegram';
import { sendEmail, sendConsumerApproval, sendBroadcastEmail, sendBuyerIntroNotification, sendRancherCheckIn, sendPipelineUpdateEmail } from '@/lib/email';
import { callClaude } from '@/lib/ai';
import { bulkRouteStateToRancher } from '@/lib/bulkRoute';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';
import { normalizeState, normalizeStates } from '@/lib/states';
import { buildCronStatusCard, pauseCron, resumeCron } from '@/lib/cronIntrospection';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

// ─── Waitlist-to-matched blast: when a rancher goes live, auto-match waiting buyers ──
async function runWaitlistBlast(rancherId: string): Promise<{ matched: number; ranchName: string; state: string }> {
  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  const ranchName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
  const rancherStateRaw = rancher['State'] || '';

  // Build set of states this rancher serves, all normalized to 2-letter codes.
  // CRITICAL: previously this used raw strings, so a rancher who typed "Montana"
  // never matched buyers stored as "MT". Same root cause as the matching engine bug.
  const allStates = new Set<string>();
  const primary = normalizeState(rancherStateRaw);
  if (primary) allStates.add(primary);
  for (const s of normalizeStates(rancher['States Served'])) {
    allStates.add(s);
  }

  if (allStates.size === 0) {
    return { matched: 0, ranchName, state: rancherStateRaw };
  }

  // Find waiting consumers in those states (also normalize the consumer's state
  // for comparison — a buyer who slipped through with a non-canonical state would
  // otherwise never match either).
  const allConsumers: any[] = await getAllRecords(TABLES.CONSUMERS);
  const waitingBuyers = allConsumers.filter((c: any) => {
    const status = c['Status'] || '';
    const refStatus = c['Referral Status'] || '';
    const consumerState = normalizeState(c['State']);
    if (status !== 'Approved') return false;
    if (refStatus !== 'Unmatched' && refStatus !== 'Waitlisted') return false;
    if (!consumerState) return false;
    return allStates.has(consumerState);
  }).slice(0, 50); // Cap at 50

  let matched = 0;
  for (const buyer of waitingBuyers) {
    try {
      const res = await fetch(`${SITE_URL}/api/matching/suggest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(INTERNAL_API_SECRET ? { 'x-internal-secret': INTERNAL_API_SECRET } : {}),
        },
        body: JSON.stringify({
          buyerId: buyer.id,
          buyerState: buyer['State'] || '',
          buyerName: buyer['Full Name'] || '',
          buyerEmail: buyer['Email'] || '',
          buyerPhone: buyer['Phone'] || '',
          orderType: buyer['Order Type'] || '',
          budgetRange: buyer['Budget'] || buyer['Budget Range'] || '',
          intentScore: buyer['Intent Score'] || 0,
          intentClassification: buyer['Intent Classification'] || '',
          notes: buyer['Notes'] || '',
        }),
      });
      if (res.ok) {
        const result = await res.json();
        if (result.matchFound) matched++;
      }
    } catch (e) {
      console.error(`Waitlist blast: error matching ${buyer['Full Name'] || buyer.id}:`, e);
    }
  }

  return { matched, ranchName, state: primary || rancherStateRaw };
}

function escHtml(str: string): string {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// BHC business context injected into every AI conversation
const BHC_SYSTEM_PROMPT = `You are Ben's AI business assistant for BuyHalfCow (BHC), embedded in his Telegram admin bot.

BuyHalfCow is a private, curated beef brokerage that connects pre-verified consumers (Beef Buyers) with verified American ranchers. Ben earns a 10% commission on every sale he facilitates. This is NOT a public marketplace — it's relationship-based and invitation-only.

Key business context:
- Consumers sign up and are scored by intent (High/Medium/Low). Beef Buyers with High/Medium intent are auto-approved and matched to ranchers in their state.
- Ranchers apply, go through an onboarding process (call → docs/agreement → verification → live), and pay no upfront fees.
- Rancher matching: active ranchers with signed agreements, sorted by lowest load first.
- Revenue model: ranchers pay Ben 10% commission on all sales made to BHC-referred buyers. 24-month commission term.
- Current pipeline: ~245 consumers, ~26 ranchers (most still onboarding), ~80 referrals.

Your role:
- Answer Ben's questions about his business, pipeline, strategy, rancher negotiations, buyer follow-up, etc.
- You can suggest actions he should take, help draft emails/messages, analyze situations, and give business advice.
- Keep responses concise and actionable — Ben is running a business from his phone.
- Available bot commands for quick data: /stats, /today, /pending, /pipeline, /revenue, /capacity, /lookup [name].
- Always be direct, practical, and focused on helping Ben close deals and grow revenue.`;

const AI_CONFIGURED = !!(ANTHROPIC_API_KEY || OLLAMA_BASE_URL || GROQ_API_KEY);

async function handleAIChat(chatId: string, userMessage: string) {
  if (!AI_CONFIGURED) {
    await sendTelegramMessage(
      chatId,
      '⚠️ AI chat not configured. Set OLLAMA_BASE_URL for local dev or ANTHROPIC_API_KEY for production, then redeploy.\n\nFor commands, send /help'
    );
    return;
  }

  try {
    // Show typing indicator
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });

    const reply = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      system: BHC_SYSTEM_PROMPT,
      user: userMessage,
      maxTokens: 1024,
    });

    const cleaned = reply
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<i>$1</i>')
      .replace(/`(.*?)`/g, '<code>$1</code>');

    await sendTelegramMessage(chatId, cleaned);
  } catch (err: any) {
    console.error('AI chat error:', err);
    await sendTelegramMessage(chatId, `⚠️ AI error: ${err.message}. Use /help for commands.`);
  }
}

// ─── AI Skills helpers ─────────────────────────────────────────────────────

async function runQualifyAnalysis(consumer: any): Promise<{ summary: string; recommendation: 'approve' | 'reject' | 'watch' }> {
  const prompt = `Analyze this consumer lead for BuyHalfCow. Write a 2-3 sentence qualification summary, then end with your recommendation in exactly this format:
RECOMMENDATION: approve | reject | watch

Consumer data:
- Name: ${consumer['Full Name'] || 'Unknown'}
- State: ${consumer['State'] || 'Unknown'}
- Segment: ${consumer['Segment'] || 'Unknown'}
- Interests: ${Array.isArray(consumer['Interests']) ? consumer['Interests'].join(', ') : (consumer['Interests'] || 'Not specified')}
- Order Type: ${consumer['Order Type'] || 'Not specified'}
- Budget: ${consumer['Budget'] || consumer['Budget Range'] || 'Not specified'}
- Notes: ${consumer['Notes'] || 'None'}
- Intent Score: ${consumer['Intent Score'] || 0} (${consumer['Intent Classification'] || 'Unknown'})`;

  const response = await callClaude({
    model: 'claude-sonnet-4-6',
    system: BHC_SYSTEM_PROMPT,
    user: prompt,
    maxTokens: 400,
  });

  const recMatch = response.match(/RECOMMENDATION:\s*(approve|reject|watch)/i);
  const recommendation = (recMatch?.[1]?.toLowerCase() || 'watch') as 'approve' | 'reject' | 'watch';
  const summary = response.replace(/RECOMMENDATION:\s*(approve|reject|watch)/i, '').trim();

  return { summary, recommendation };
}

async function runChasupCheck(chatId: string) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const referrals = await getAllRecords(
    TABLES.REFERRALS,
    'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")'
  );

  const stale = (referrals as any[]).filter(r => {
    const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
    if (!lastActivity) return false;
    return (Date.now() - new Date(lastActivity).getTime()) >= 5 * DAY_MS;
  });

  if (stale.length === 0) {
    await sendTelegramMessage(chatId, '✅ No stalled referrals — all active referrals are within 5 days.');
    return;
  }

  await sendTelegramMessage(chatId, `🎯 Found <b>${stale.length} stalled referral${stale.length > 1 ? 's' : ''}</b>. Drafting chase-up messages...`);

  for (const referral of stale.slice(0, 5) as any[]) {
    try {
      const buyerName = referral['Buyer Name'] || 'the buyer';
      const buyerEmail = referral['Buyer Email'] || '';
      const rancherName = referral['Suggested Rancher Name'] || referral['Rancher Name'] || 'your rancher';
      const daysStale = Math.floor((Date.now() - new Date(referral['Last Chased At'] || referral['Intro Sent At'] || referral['Approved At']).getTime()) / DAY_MS);

      const draftPrompt = `Draft a friendly, concise re-engagement email for a beef buyer who was introduced to a rancher ${daysStale} days ago and we haven't heard back. Keep it warm, not pushy — 2-3 short paragraphs. Do NOT include a subject line, just the email body. Sign as Benjamin from BuyHalfCow.

Buyer: ${buyerName}, ${referral['Buyer State'] || ''}
Rancher introduced: ${rancherName}
Order interest: ${referral['Order Type'] || 'bulk beef'}, Budget: ${referral['Budget Range'] || 'not specified'}`;

      const draft = await callClaude({
        model: 'claude-sonnet-4-6',
        system: BHC_SYSTEM_PROMPT,
        user: draftPrompt,
        maxTokens: 500,
      });

      // Store draft in Airtable referral record
      await updateRecord(TABLES.REFERRALS, referral.id, {
        'AI Chase Draft': draft,
      });

      const preview = draft.length > 200 ? draft.substring(0, 200) + '...' : draft;
      const msg = `🎯 <b>REFERRAL CHASE-UP</b>

👤 ${buyerName} → 🤠 ${rancherName}
Status: ${referral['Status']} | ${daysStale} days stale

<b>AI Draft:</b>
<i>"${preview}"</i>`;

      const keyboard = {
        inline_keyboard: [[
          { text: '📧 Send to Consumer', callback_data: `chasend_${referral.id}` },
          { text: '⏭️ Skip', callback_data: `chaskip_${referral.id}` },
        ]],
      };

      await sendTelegramMessage(chatId, msg, keyboard);
    } catch (err: any) {
      console.error(`Chase-up error for referral ${referral.id}:`, err);
    }
  }

  if (stale.length > 5) {
    await sendTelegramMessage(chatId, `<i>...and ${stale.length - 5} more. Run /chasup again after clearing these.</i>`);
  }
}

// ─── /setuppage wizard session store ──────────────────────────────────────
// In-memory per serverless instance — acceptable for a live admin wizard
interface SetupSession {
  rancherId: string;
  rancherName: string;
  awaitingField: string | null; // short field key, e.g. 'slug', 'about'
}
const setupPageSessions = new Map<string, SetupSession>();

const SP_FIELD_LABELS: Record<string, string> = {
  slug:   'Page URL Slug',
  logo:   'Logo URL',
  tag:    'Tagline',
  about:  'About Text',
  video:  'Video URL',
  notes:  'Custom Notes',
  qp:     'Quarter Price ($)',
  ql:     'Quarter lbs (e.g. ~85 lbs)',
  qlink:  'Quarter Payment Link',
  hp:     'Half Price ($)',
  hl:     'Half lbs (e.g. ~170 lbs)',
  hlink:  'Half Payment Link',
  wp:     'Whole Price ($)',
  wl:     'Whole lbs (e.g. ~340 lbs)',
  wlink:  'Whole Payment Link',
  date:   'Next Processing Date (YYYY-MM-DD)',
  rlink:  'Reserve / Deposit Link',
};

const SP_AIRTABLE_KEY: Record<string, string> = {
  slug:   'Slug',
  logo:   'Logo URL',
  tag:    'Tagline',
  about:  'About Text',
  video:  'Video URL',
  notes:  'Custom Notes',
  qp:     'Quarter Price',
  ql:     'Quarter lbs',
  qlink:  'Quarter Payment Link',
  hp:     'Half Price',
  hl:     'Half lbs',
  hlink:  'Half Payment Link',
  wp:     'Whole Price',
  wl:     'Whole lbs',
  wlink:  'Whole Payment Link',
  date:   'Next Processing Date',
  rlink:  'Reserve Link',
};

async function sendPageMenu(chatId: string, rancherId: string) {
  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  const name = rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch';
  const slug = rancher['Slug'] || '—';
  const live = rancher['Page Live'] ? '🟢 LIVE' : '🔴 Draft';
  const url = rancher['Slug'] ? `${SITE_URL}/ranchers/${rancher['Slug']}` : 'No slug yet';

  const priceSummary = [
    rancher['Quarter Price'] ? `Q: $${rancher['Quarter Price']}` : '',
    rancher['Half Price'] ? `H: $${rancher['Half Price']}` : '',
    rancher['Whole Price'] ? `W: $${rancher['Whole Price']}` : '',
  ].filter(Boolean).join(' · ') || 'No pricing set';

  const msg = `🏡 <b>${name}</b> — Page Setup
${live}

📍 Slug: <code>${slug}</code>
🖼 Logo: ${rancher['Logo URL'] ? '✓' : '—'}
💬 Tagline: ${rancher['Tagline'] ? `"${rancher['Tagline']}"` : '—'}
📖 About: ${rancher['About Text'] ? '✓ (filled)' : '—'}
🎬 Video: ${rancher['Video URL'] ? '✓' : '—'}
💰 Pricing: ${priceSummary}
📅 Next date: ${rancher['Next Processing Date'] || '—'}

Tap a button to fill in that field:`;

  const kb = {
    inline_keyboard: [
      [
        { text: '📝 URL Slug', callback_data: 'spf_slug' },
        { text: '🖼 Logo URL', callback_data: 'spf_logo' },
      ],
      [
        { text: '💬 Tagline', callback_data: 'spf_tag' },
        { text: '📖 About', callback_data: 'spf_about' },
      ],
      [
        { text: '🎬 Video URL', callback_data: 'spf_video' },
        { text: '📒 Notes', callback_data: 'spf_notes' },
      ],
      [
        { text: '💲 Q Price', callback_data: 'spf_qp' },
        { text: '⚖️ Q lbs', callback_data: 'spf_ql' },
        { text: '🔗 Q Link', callback_data: 'spf_qlink' },
      ],
      [
        { text: '💲 H Price', callback_data: 'spf_hp' },
        { text: '⚖️ H lbs', callback_data: 'spf_hl' },
        { text: '🔗 H Link', callback_data: 'spf_hlink' },
      ],
      [
        { text: '💲 W Price', callback_data: 'spf_wp' },
        { text: '⚖️ W lbs', callback_data: 'spf_wl' },
        { text: '🔗 W Link', callback_data: 'spf_wlink' },
      ],
      [
        { text: '📅 Processing Date', callback_data: 'spf_date' },
        { text: '🔗 Reserve Link', callback_data: 'spf_rlink' },
      ],
      [
        { text: '🚀 GO LIVE', callback_data: 'spgolive' },
        { text: '👁 Preview Page', callback_data: 'sppreview' },
        { text: '✅ Done', callback_data: 'spdone' },
      ],
    ],
  };

  await sendTelegramMessage(chatId, msg, kb);
}

// ──────────────────────────────────────────────────────────────────────────

export const maxDuration = 60;

// Idempotency Set for Telegram update_ids. Module-level Map survives within
// a single Vercel function instance; cold starts reset. Good enough for the
// common case (Telegram redelivers within seconds, not across instances).
// Audit finding 2026-05-20 #2.
const _seenUpdateIds = new Map<number, number>();
const UPDATE_ID_TTL_MS = 5 * 60_000;
function _markUpdateSeen(id: number): boolean {
  // Prune old entries opportunistically
  const cutoff = Date.now() - UPDATE_ID_TTL_MS;
  for (const [k, ts] of _seenUpdateIds.entries()) {
    if (ts < cutoff) _seenUpdateIds.delete(k);
  }
  if (_seenUpdateIds.has(id)) return false;
  _seenUpdateIds.set(id, Date.now());
  return true;
}

export async function POST(request: Request) {
  // Signature verification. Telegram supports X-Telegram-Bot-Api-Secret-Token.
  // Audit finding 2026-05-20 #1 — without this, anyone can POST forged
  // callback_query and trigger one-tap admin actions. Gracefully degrades
  // when secret is unset (warn in prod) to avoid bricking the bot during
  // rollout.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const provided = request.headers.get('x-telegram-bot-api-secret-token');
    if (provided !== expectedSecret) {
      console.warn('[telegram-webhook] signature mismatch — rejecting');
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.warn('[telegram-webhook] TELEGRAM_WEBHOOK_SECRET unset in prod — webhook is unauthenticated');
  }

  let update: any;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Idempotency — Telegram redelivers on any 5xx or timeout. Drop dupes.
  if (typeof update?.update_id === 'number') {
    if (!_markUpdateSeen(update.update_id)) {
      return NextResponse.json({ ok: true, deduped: true });
    }
  }

  // Process the update and respond — Vercel kills the function after response
  // so we must await the processing, not fire-and-forget
  try {
    await processUpdate(update);
  } catch (err: any) {
    console.error('Telegram processing error:', err);
    const chatId = update?.message?.chat?.id?.toString() || update?.callback_query?.message?.chat?.id?.toString();
    if (chatId) {
      try { await sendTelegramMessage(chatId, `⚠️ Error: ${err?.message || 'Unknown'}`); } catch {}
    }
  }

  return NextResponse.json({ ok: true });
}

async function processUpdate(update: any) {
  try {
    // Handle callback queries (button presses)
    if (update.callback_query) {
      const { id: queryId, data: callbackData, message } = update.callback_query;
      const chatId = message?.chat?.id?.toString();
      const messageId = message?.message_id;

      if (!callbackData) {
        await answerCallbackQuery(queryId, 'Unknown action');
        return NextResponse.json({ ok: true });
      }

      const [action, referralId] = callbackData.split('_', 2);
      const fullReferralId = callbackData.substring(action.length + 1);

      // ─── /match Direct routing actions ──────────────────────────────────
      // Fires when operator taps "✅ Fire intro now" or "❌ Cancel" on a
      // /match confirmation card. matchfire creates a Pending Approval +
      // immediately fires intro emails to buyer + rancher. matchcancel is
      // a no-op so the operator can back out.

      if (action === 'matchfire') {
        await answerCallbackQuery(queryId, 'Firing…');
        try {
          const restAfter = callbackData.substring('matchfire_'.length);
          const sepIdx = restAfter.lastIndexOf('_');
          const buyerRecId = restAfter.slice(0, sepIdx);
          const rancherRecId = restAfter.slice(sepIdx + 1);
          if (!buyerRecId || !rancherRecId) {
            if (chatId) await sendTelegramMessage(chatId, '⚠️ Malformed matchfire callback');
            return NextResponse.json({ ok: true });
          }
          const [buyer, rancher] = await Promise.all([
            getRecordById(TABLES.CONSUMERS, buyerRecId) as Promise<any>,
            getRecordById(TABLES.RANCHERS, rancherRecId) as Promise<any>,
          ]);

          // IDEMPOTENCY GUARD (RW-9 audit): without this, double-click
          // on the manual /match Telegram button created DUPLICATE
          // Referral rows + sent the intro email twice to both buyer
          // and rancher. Check for any active referral for this
          // buyer-rancher pair before creating a new one.
          try {
            const { getAllRecords, escapeAirtableValue } = await import('@/lib/airtable');
            const existing = (await getAllRecords(
              TABLES.REFERRALS,
              `AND(LOWER({Buyer Email}) = "${escapeAirtableValue((buyer['Email'] || '').toString().toLowerCase())}", NOT({Status} = "Closed Won"), NOT({Status} = "Closed Lost"))`,
            )) as any[];
            const sameRancher = existing.find((r) => {
              const refRanchers = (r['Rancher'] || r['Suggested Rancher'] || []) as string[];
              return refRanchers.includes(rancher.id);
            });
            if (sameRancher) {
              await answerCallbackQuery(queryId, '⚠️ Already matched');
              return new Response('OK');
            }
          } catch { /* fall through on Airtable read failure */ }

          const now = new Date().toISOString();
          const refRecord: any = await createRecord(TABLES.REFERRALS, {
            'Buyer': [buyer.id],
            'Rancher': [rancher.id],
            'Suggested Rancher': [rancher.id],
            'Suggested Rancher Name': rancher['Operator Name'] || rancher['Ranch Name'] || '',
            'Suggested Rancher State': rancher['State'] || '',
            'Status': 'Intro Sent',
            'Approval Status': 'approved',
            'Approved At': now,
            'Intro Sent At': now,
            'Buyer Name': buyer['Full Name'] || '',
            'Buyer Email': buyer['Email'] || '',
            'Buyer Phone': buyer['Phone'] || '',
            'Buyer State': buyer['State'] || '',
            'Order Type': buyer['Order Type'] || '',
            'Budget Range': buyer['Budget'] || '',
            'Intent Score': buyer['Intent Score'] || 0,
            'Intent Classification': buyer['Intent Classification'] || '',
            'Notes': buyer['Notes'] || '',
            'Match Type': 'Local',
          });
          await updateRecord(TABLES.CONSUMERS, buyer.id, {
            'Buyer Stage': 'MATCHED',
            'Buyer Stage Updated At': now,
          });
          const rancherEmail = rancher['Email'];
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
          const buyerName = buyer['Full Name'] || 'Buyer';
          if (rancherEmail) {
            await sendBuyerIntroNotification({
              firstName: (buyerName.split(' ')[0]) || 'there',
              email: buyer['Email'] || '',
              rancherName,
              rancherEmail,
              rancherPhone: rancher['Phone'] || '',
              rancherSlug: rancher['Slug'] || '',
              loginUrl: `${SITE_URL}/member`,
              quarterPrice: Number(rancher['Quarter Price']) || undefined,
              quarterLbs: rancher['Quarter lbs'] || '',
              halfPrice: Number(rancher['Half Price']) || undefined,
              halfLbs: rancher['Half lbs'] || '',
              wholePrice: Number(rancher['Whole Price']) || undefined,
              wholeLbs: rancher['Whole lbs'] || '',
              nextProcessingDate: rancher['Next Processing Date'] || '',
            }).catch((e: any) => console.error('[match] buyer intro failed:', e?.message));
            await sendEmail({
              to: rancherEmail,
              subject: `BuyHalfCow Introduction: ${buyerName} in ${buyer['State'] || ''}`,
              html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
<h1 style="font-family:Georgia,serif;">New buyer lead</h1>
<p>Hi ${rancherName},</p>
<p>You've got a new buyer matched to you on BuyHalfCow. Reach out today:</p>
<div style="background:#F4F1EC;padding:20px;margin:20px 0;">
  <p><strong>Buyer:</strong> ${buyerName}</p>
  <p><strong>Email:</strong> ${buyer['Email'] || ''}</p>
  <p><strong>Phone:</strong> ${buyer['Phone'] || ''}</p>
  <p><strong>Location:</strong> ${buyer['State'] || ''}</p>
  <p><strong>Order:</strong> ${buyer['Order Type'] || ''}</p>
  <p><strong>Budget:</strong> ${buyer['Budget'] || ''}</p>
  ${buyer['Notes'] ? `<p><strong>Notes:</strong> ${buyer['Notes']}</p>` : ''}
</div>
<p>— Ben, BuyHalfCow</p>
</body></html>`,
            }).catch((e: any) => console.error('[match] rancher intro failed:', e?.message));
          }
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `✅ <b>INTRO FIRED</b>\n\n` +
              `👤 ${buyerName} → 🤠 ${rancherName}\n\n` +
              `Referral: <code>${refRecord.id}</code>\n` +
              `Status: Intro Sent\n` +
              `Both emails dispatched.`
            );
          }
        } catch (e: any) {
          if (chatId) await sendTelegramMessage(chatId, `⚠️ matchfire failed: ${e?.message || 'unknown'}`);
        }
        return NextResponse.json({ ok: true });
      }

      if (action === 'matchcancel') {
        await answerCallbackQuery(queryId, 'Cancelled');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, '❌ <b>Match cancelled.</b> No referral created. Re-run <code>/match</code> with different search terms.');
        }
        return NextResponse.json({ ok: true });
      }

      // ─── Referral actions ───────────────────────────────────────────────

      if (action === 'approve') {
        await answerCallbackQuery(queryId, 'Approving…');
        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);

          if (referral['Status'] === 'Intro Sent' || referral['Status'] === 'Closed Won') {
            await answerCallbackQuery(queryId, 'Already approved');
            return NextResponse.json({ ok: true });
          }

          const rancherId = referral['Suggested Rancher']?.[0];

          if (!rancherId) {
            await answerCallbackQuery(queryId, 'No rancher assigned');
            return NextResponse.json({ ok: true });
          }

          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          // Live Redis counter — Airtable's Current Active Referrals is the
          // eventually-consistent MIRROR of the Redis counter and can lag under
          // burst. Reading the mirror could let an over-cap referral through if
          // a concurrent matching/suggest INCR hasn't synced yet. getLiveCapacity
          // reads Redis directly (Airtable fallback only if Redis is down).
          const currentRefs = await getLiveCapacity(rancherId);
          const maxRefs = getMaxActiveReferrals(rancher);

          if (currentRefs >= maxRefs) {
            await answerCallbackQuery(queryId, `At capacity (${currentRefs}/${maxRefs}). Reassign instead.`);
            if (chatId) {
              await sendTelegramMessage(chatId, `⚠️ ${rancher['Operator Name'] || 'Rancher'} is at capacity (${currentRefs}/${maxRefs}). Tap "Reassign" to pick a different rancher.`);
            }
            return NextResponse.json({ ok: true });
          }

          const now = new Date().toISOString();

          // Capacity reconciliation: if upstream matching/suggest already
          // incremented when this referral was first created, the live count
          // is already correct. But for Pending Approval referrals that
          // pre-date the Redis counter (or were inserted manually / via
          // /assignto / direct page) the counter may not reflect this
          // referral yet. Detect by comparing previous status — only INCR
          // when the referral wasn't already in an ACTIVE_REF state
          // (Intro Sent et al). This is idempotent: a re-tapped approve
          // button on an already-approved referral was rejected earlier by
          // the "already approved" guard, so we don't double-INCR.
          const prevStatus = String(referral['Status'] || '');
          const ACTIVE_REF_STATES = new Set([
            'Intro Sent',
            'Rancher Contacted',
            'Negotiation',
          ]);
          const shouldIncrement = !ACTIVE_REF_STATES.has(prevStatus);

          await updateRecord(TABLES.REFERRALS, fullReferralId, {
            'Status': 'Intro Sent',
            'Rancher': [rancherId],
            'Approved At': now,
            'Intro Sent At': now,
          });

          if (shouldIncrement) {
            try {
              const newCount = await incrementCapacity(rancherId);
              await syncCapacityToAirtable(rancherId, newCount);
            } catch (capErr: any) {
              console.warn('[telegram approve_] capacity INCR failed:', capErr?.message);
            }
          }
          await updateRecord(TABLES.RANCHERS, rancherId, {
            'Last Assigned At': now,
          });

          const rancherEmail = rancher['Email'];
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
          const rancherPhone = rancher['Phone'] || '';
          if (rancherEmail) {
            await sendEmail({
              to: rancherEmail,
              subject: `BuyHalfCow Introduction: ${referral['Buyer Name']} in ${referral['Buyer State']}`,
              html: `
                <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px; border: 1px solid #A7A29A;">
                  <h1 style="font-family: Georgia, serif;">New Qualified Buyer Lead</h1>
                  <p>Hi ${rancherName},</p>
                  <p>You have a new qualified buyer lead from BuyHalfCow:</p>
                  <hr style="border: none; height: 1px; background: #A7A29A; margin: 20px 0;">
                  <p><strong>Buyer:</strong> ${referral['Buyer Name']}</p>
                  <p><strong>Email:</strong> ${referral['Buyer Email']}</p>
                  <p><strong>Phone:</strong> ${referral['Buyer Phone']}</p>
                  <p><strong>Location:</strong> ${referral['Buyer State']}</p>
                  <p><strong>Order:</strong> ${referral['Order Type']}</p>
                  <p><strong>Budget:</strong> ${referral['Budget Range']}</p>
                  ${referral['Notes'] ? `<p><strong>Notes:</strong> ${referral['Notes']}</p>` : ''}
                  <hr style="border: none; height: 1px; background: #A7A29A; margin: 20px 0;">
                  <p>Please reach out to them directly. Reply-all to keep me in the loop.</p>
                  <p style="font-size: 12px; color: #A7A29A; margin-top: 30px;">— Benjamin, BuyHalfCow | 10% commission on BHC referral sales.</p>
                </div>
              `,
            });
          }

          // Notify the buyer they've been connected to a rancher
          const buyerEmail = referral['Buyer Email'];
          const consumerId = referral['Buyer']?.[0] || '';
          if (buyerEmail && consumerId) {
            try {
              const buyerToken = jwt.sign(
                { type: 'member-login', consumerId, email: buyerEmail.trim().toLowerCase() },
                JWT_SECRET,
                { expiresIn: '7d' }
              );
              const buyerLoginUrl = `${SITE_URL}/member/verify?token=${buyerToken}`;
              const buyerFirstName = (referral['Buyer Name'] || '').split(' ')[0] || 'there';
              await sendBuyerIntroNotification({
                firstName: buyerFirstName,
                email: buyerEmail,
                rancherName,
                rancherEmail: rancherEmail || '',
                rancherPhone,
                rancherSlug: rancher['Slug'] || '',
                loginUrl: buyerLoginUrl,
              });
            } catch (e) {
              console.error('Error sending buyer intro notification:', e);
            }

            // Update consumer's referral status
            try {
              await updateRecord(TABLES.CONSUMERS, consumerId, {
                'Referral Status': 'Intro Sent',
              });
            } catch (e) {
              console.error('Error updating consumer referral status:', e);
            }
          }

          await answerCallbackQuery(queryId, 'Approved! Intro sent to both.');

          if (chatId && messageId) {
            await editTelegramMessage(
              chatId,
              messageId,
              `✅ <b>APPROVED</b>\n\nIntro sent to <b>${rancherName}</b> for <b>${referral['Buyer Name']}</b> in ${referral['Buyer State']}`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'reject') {
        await answerCallbackQuery(queryId, 'Rejecting…');
        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);

          await updateRecord(TABLES.REFERRALS, fullReferralId, {
            'Status': 'Closed Lost',
            'Closed At': new Date().toISOString(),
          });

          // MISMATCH FIX: use atomic Redis DECR (lib/rancherCapacity) so
          // concurrent reject/closelost clicks on the same rancher don't
          // under-decrement via read-then-write race. Prior code read
          // currentRefs from a possibly-stale snapshot + wrote currentRefs-1.
          const assignedRancherIds = referral['Rancher'] || referral['Suggested Rancher'] || [];
          if (Array.isArray(assignedRancherIds) && assignedRancherIds.length > 0) {
            try {
              const { decrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
              const newCount = await decrementCapacity(assignedRancherIds[0]);
              await syncCapacityToAirtable(assignedRancherIds[0], newCount);
            } catch (capErr: any) {
              console.warn('[telegram reject] atomic decrement failed:', capErr?.message);
            }
          }

          await answerCallbackQuery(queryId, 'Rejected');

          if (chatId && messageId) {
            await editTelegramMessage(
              chatId,
              messageId,
              `❌ <b>REJECTED</b>\n\n${referral['Buyer Name']} in ${referral['Buyer State']} — marked as Closed Lost`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'reassign') {
        await answerCallbackQuery(queryId, 'Finding available ranchers…');
        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);
          const buyerState = referral['Buyer State'] || '';

          const allRanchers = await getAllRecords(TABLES.RANCHERS);
          const available = allRanchers.filter((r: any) => {
            const active = r['Active Status'] === 'Active';
            const agreed = r['Agreement Signed'] === true;
            const state = r['State'] || '';
            const served = r['States Served'] || '';
            const maxRefs = getMaxActiveReferrals(r);
            const currentRefs = r['Current Active Referrals'] || 0;
            const servesState = state === buyerState ||
              (typeof served === 'string' && served.includes(buyerState));
            return active && agreed && servesState && currentRefs < maxRefs;
          });

          if (available.length === 0) {
            await answerCallbackQuery(queryId, 'No available ranchers');
            if (chatId) {
              await sendTelegramMessage(chatId, '⚠️ No available ranchers for this state. Use the web dashboard to reassign.');
            }
          } else {
            const keyboard = available.slice(0, 8).map((r: any) => [{
              text: `${r['Operator Name'] || r['Ranch Name']} (${r['Current Active Referrals'] || 0}/${getMaxActiveReferrals(r)})`,
              callback_data: `assignto_${fullReferralId}_${r.id}`,
            }]);

            if (chatId) {
              await sendTelegramMessage(chatId, '🔄 Select a rancher to reassign to:', {
                inline_keyboard: keyboard,
              });
            }
            await answerCallbackQuery(queryId, 'Select rancher below');
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'assignto') {
        await answerCallbackQuery(queryId, 'Reassigning…');
        const parts = callbackData.split('_');
        const refId = parts[1];
        const newRancherId = parts.slice(2).join('_');

        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, refId);

          const oldRancherId = referral['Rancher']?.[0] || referral['Suggested Rancher']?.[0];
          // Atomic decrement on the OLD rancher only if the referral was in
          // an active state (occupying a slot). Read-then-write here was racy
          // with concurrent close-completions; Redis DECR clamps at 0.
          const ACTIVE_REF_STATES_REASSIGN = new Set([
            'Intro Sent',
            'Rancher Contacted',
            'Negotiation',
            'Pending Approval',
          ]);
          const prevStatusForReassign = String(referral['Status'] || '');
          if (
            oldRancherId &&
            oldRancherId !== newRancherId &&
            ACTIVE_REF_STATES_REASSIGN.has(prevStatusForReassign)
          ) {
            try {
              const newOldCount = await decrementCapacity(oldRancherId);
              await syncCapacityToAirtable(oldRancherId, newOldCount);
            } catch (e: any) {
              console.error('[telegram assignto] old rancher decrement failed:', e?.message);
            }
          }

          const rancher: any = await getRecordById(TABLES.RANCHERS, newRancherId);
          const now = new Date().toISOString();

          await updateRecord(TABLES.REFERRALS, refId, {
            'Suggested Rancher': [newRancherId],
            'Suggested Rancher Name': rancher['Operator Name'] || rancher['Ranch Name'] || '',
            'Suggested Rancher State': rancher['State'] || '',
            'Status': 'Intro Sent',
            'Rancher': [newRancherId],
            'Approved At': now,
            'Intro Sent At': now,
          });

          // Atomic INCR on NEW rancher. No previous-state guard needed here —
          // a reassign always moves the slot from old → new, and we already
          // decremented the old side above. Mirror to Airtable for dashboards.
          try {
            const newCount = await incrementCapacity(newRancherId);
            await syncCapacityToAirtable(newRancherId, newCount);
          } catch (e: any) {
            console.error('[telegram assignto] new rancher INCR failed:', e?.message);
          }
          await updateRecord(TABLES.RANCHERS, newRancherId, {
            'Last Assigned At': now,
          });

          const updatedReferral: any = await getRecordById(TABLES.REFERRALS, refId);
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'];
          const rancherEmail = rancher['Email'];

          if (rancherEmail) {
            await sendEmail({
              to: rancherEmail,
              subject: `BuyHalfCow Introduction: ${updatedReferral['Buyer Name']} in ${updatedReferral['Buyer State']}`,
              html: `
                <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px; border: 1px solid #A7A29A;">
                  <h1 style="font-family: Georgia, serif;">New Qualified Buyer Lead</h1>
                  <p>Hi ${rancherName},</p>
                  <p>You have a new buyer lead from BuyHalfCow:</p>
                  <p><strong>Buyer:</strong> ${referral['Buyer Name']}</p>
                  <p><strong>Email:</strong> ${referral['Buyer Email']}</p>
                  <p><strong>Phone:</strong> ${referral['Buyer Phone']}</p>
                  <p><strong>State:</strong> ${referral['Buyer State']}</p>
                  <p><strong>Order:</strong> ${referral['Order Type']}</p>
                  <p><strong>Budget:</strong> ${referral['Budget Range']}</p>
                  <p>Reach out directly. Reply-all to keep me in the loop.</p>
                  <p style="font-size: 12px; color: #A7A29A;">— Benjamin, BuyHalfCow</p>
                </div>
              `,
            });
          }

          // Also notify the buyer about their new rancher connection
          const buyerEmail = referral['Buyer Email'];
          const buyerConsumerId = referral['Buyer']?.[0] || '';
          if (buyerEmail && buyerConsumerId) {
            try {
              const buyerToken = jwt.sign(
                { type: 'member-login', consumerId: buyerConsumerId, email: buyerEmail.trim().toLowerCase() },
                JWT_SECRET,
                { expiresIn: '7d' }
              );
              const buyerLoginUrl = `${SITE_URL}/member/verify?token=${buyerToken}`;
              const buyerFirstName = (referral['Buyer Name'] || '').split(' ')[0] || 'there';
              await sendBuyerIntroNotification({
                firstName: buyerFirstName,
                email: buyerEmail,
                rancherName: rancher['Operator Name'] || rancher['Ranch Name'] || '',
                rancherEmail: rancherEmail || '',
                rancherPhone: rancher['Phone'] || '',
                rancherSlug: rancher['Slug'] || '',
                loginUrl: buyerLoginUrl,
              });
            } catch (e) {
              console.error('Error sending buyer intro on reassignment:', e);
            }

            try {
              await updateRecord(TABLES.CONSUMERS, buyerConsumerId, {
                'Referral Status': 'Intro Sent',
              });
            } catch (e) {
              console.error('Error updating consumer referral status on reassignment:', e);
            }
          }

          await answerCallbackQuery(queryId, `Reassigned to ${rancherName}`);

          if (chatId && messageId) {
            await editTelegramMessage(
              chatId,
              messageId,
              `🔄 <b>REASSIGNED</b>\n\nIntro sent to <b>${rancherName}</b> AND buyer for <b>${referral['Buyer Name']}</b>`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'details') {
        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);
          const detailMsg = `📋 <b>REFERRAL DETAILS</b>

👤 <b>${referral['Buyer Name']}</b>
📧 ${referral['Buyer Email']}
📱 ${referral['Buyer Phone']}
📍 ${referral['Buyer State']}
🥩 ${referral['Order Type']}
💵 ${referral['Budget Range']}
📊 Intent: ${referral['Intent Score']} (${referral['Intent Classification']})
📝 Notes: ${referral['Notes'] || 'None'}

Status: ${referral['Status']}
Suggested: ${referral['Suggested Rancher Name'] || 'None'}`;

          if (chatId) {
            await sendTelegramMessage(chatId, detailMsg);
          }
          await answerCallbackQuery(queryId, 'Details sent');
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Consumer actions ───────────────────────────────────────────────

      else if (action === 'capprove') {
        await answerCallbackQuery(queryId, 'Approving…');
        try {
          const consumer: any = await getRecordById(TABLES.CONSUMERS, fullReferralId);
          const currentStatus = (consumer['Status'] || '').toLowerCase();
          if (currentStatus === 'approved' || currentStatus === 'active') {
            await answerCallbackQuery(queryId, 'Already approved');
            return NextResponse.json({ ok: true });
          }

          const consumerEmail = consumer['Email'];
          const firstName = (consumer['Full Name'] || '').split(' ')[0];
          const segment = consumer['Segment'] || 'Community';
          const now = new Date().toISOString();

          await updateRecord(TABLES.CONSUMERS, fullReferralId, { 'Status': 'Approved', 'Approved At': now });

          const token = jwt.sign(
            { type: 'member-login', consumerId: fullReferralId, email: consumerEmail?.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const loginUrl = `${SITE_URL}/member/verify?token=${token}`;
          await sendConsumerApproval({ firstName, email: consumerEmail, loginUrl, segment });

          if (segment === 'Beef Buyer' && consumer['State']) {
            try {
              await fetch(`${SITE_URL}/api/matching/suggest`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                },
                body: JSON.stringify({
                  buyerState: consumer['State'],
                  buyerId: fullReferralId,
                  buyerName: consumer['Full Name'],
                  buyerEmail: consumerEmail,
                  buyerPhone: consumer['Phone'],
                  orderType: consumer['Order Type'],
                  budgetRange: consumer['Budget'],
                  intentScore: consumer['Intent Score'],
                  intentClassification: consumer['Intent Classification'],
                  notes: consumer['Notes'],
                }),
              });
            } catch (e) {
              console.error('Matching error after Telegram approval:', e);
            }
          }

          await answerCallbackQuery(queryId, 'Approved! Email sent.');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `✅ <b>CONSUMER APPROVED</b>\n\n${consumer['Full Name']} (${segment}) — approval email sent`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'creject') {
        try {
          const consumer: any = await getRecordById(TABLES.CONSUMERS, fullReferralId);
          await updateRecord(TABLES.CONSUMERS, fullReferralId, { 'Status': 'Rejected' });
          await answerCallbackQuery(queryId, 'Rejected');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `❌ <b>CONSUMER REJECTED</b>\n\n${consumer['Full Name']} (${consumer['State']}) — marked as Rejected`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'cdetails') {
        try {
          const c: any = await getRecordById(TABLES.CONSUMERS, fullReferralId);
          const msg = `📋 <b>CONSUMER DETAILS</b>

👤 <b>${c['Full Name']}</b>
📧 ${c['Email']}
📱 ${c['Phone'] || 'No phone'}
📍 ${c['State']}
${c['Segment'] === 'Beef Buyer' ? '🥩' : '🏷️'} Segment: ${c['Segment'] || 'Unknown'}
📊 Intent: ${c['Intent Score'] || 0} (${c['Intent Classification'] || 'N/A'})
🥩 Order: ${c['Order Type'] || 'N/A'}
💵 Budget: ${c['Budget'] || 'N/A'}
📝 Notes: ${c['Notes'] || 'None'}

Status: ${c['Status'] || 'Unknown'}
Source: ${c['Source'] || 'organic'}`;

          if (chatId) await sendTelegramMessage(chatId, msg);
          await answerCallbackQuery(queryId, 'Details sent');
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Sale celebration actions (L2e) ─────────────────────────────────
      // Mark commission as paid (writes Commission Paid = true on referral)
      else if (action === 'markpaid') {
        try {
          const refId = fullReferralId;
          const ref: any = await getRecordById(TABLES.REFERRALS, refId);
          // IDEMPOTENCY GUARD (RW-9 audit): without this, double-click
          // appended a fresh '[Commission marked paid via Telegram X]'
          // note to Referral.Notes every click AND re-sent the paid-
          // receipt email to the rancher every click.
          if (ref['Commission Paid'] === true) {
            await answerCallbackQuery(queryId, '✓ Already marked paid');
            return new Response('OK');
          }
          await updateRecord(TABLES.REFERRALS, refId, {
            'Commission Paid': true,
            'Commission Paid At': new Date().toISOString(),
            'Notes': `${ref['Notes'] || ''}\n[Commission marked paid via Telegram ${new Date().toISOString().slice(0, 10)}]`.trim(),
          });
          await answerCallbackQuery(queryId, '💰 Marked paid');
          if (chatId) {
            await sendTelegramMessage(chatId, `💰 <b>COMMISSION PAID</b>\n\n$${(ref['Commission Due'] || 0).toLocaleString()} for ${ref['Buyer Name']} marked as paid.`);
          }

          // Send a paid-receipt email to the rancher. Closes the loop so the
          // rancher knows their commission cleared without having to ask.
          try {
            const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
            const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
            if (rancherId) {
              const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
              const rancherEmail = rancher['Email'];
              const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Partner';
              const buyerName = ref['Buyer Name'] || 'the buyer';
              const commission = Number(ref['Commission Due']) || 0;
              if (rancherEmail) {
                await sendEmail({
                  to: rancherEmail,
                  subject: `Commission received — BuyHalfCow`,
                  html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                    <p>Hi ${rancherName},</p>
                    <p>Your commission payment of <b>$${commission.toLocaleString()}</b> for the <b>${buyerName}</b> sale has been received. Thank you for closing this one.</p>
                    <p>Reply if anything looks off — otherwise we're square. Keep selling.</p>
                    <p>— Benjamin, BuyHalfCow</p>
                  </div>`,
                });
              }
            }
          } catch (receiptErr: any) {
            // Non-fatal — the Airtable update already succeeded.
            console.error('[markpaid] receipt email failed:', receiptErr?.message);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // Send a quick thank-you email to the rancher
      else if (action === 'thankrancher') {
        try {
          const refId = fullReferralId;
          await answerCallbackQuery(queryId, 'Sending thanks…');
          const ref: any = await getRecordById(TABLES.REFERRALS, refId);
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
          if (!rancherId) {
            await sendTelegramMessage(chatId!, '⚠️ No rancher linked to this referral.');
            return NextResponse.json({ ok: true });
          }
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          const rancherEmail = rancher['Email'];
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Partner';
          const buyerName = ref['Buyer Name'] || 'the buyer';
          if (!rancherEmail) {
            await sendTelegramMessage(chatId!, `⚠️ ${rancherName} has no email on file.`);
            return NextResponse.json({ ok: true });
          }
          await sendEmail({
            to: rancherEmail,
            subject: `Thanks for closing ${buyerName}!`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
              <p>Hey ${rancherName},</p>
              <p>Just saw the deal with <b>${buyerName}</b> closed — congrats. Thanks for taking great care of them.</p>
              <p>This is exactly what BuyHalfCow is built to do: connect serious buyers with operators who deliver. Keep me posted on how it goes from here.</p>
              <p>If you've got more capacity opening up soon, let me know and I'll route more leads your way.</p>
              <p>— Benjamin</p>
            </div>`,
          });
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, `🙏 <b>THANK YOU SENT</b>\n\n${rancherName} just got a personal note from you.`);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Stalled deal nudge actions (L2c) ───────────────────────────────
      // Send a polite "hey, the buyer's waiting" email to the rancher
      else if (action === 'nudgerancher') {
        try {
          const refId = fullReferralId;
          await answerCallbackQuery(queryId, 'Sending nudge…');
          const ref: any = await getRecordById(TABLES.REFERRALS, refId);
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
          if (!rancherId) {
            await sendTelegramMessage(chatId!, '⚠️ No rancher linked to this referral.');
            return NextResponse.json({ ok: true });
          }
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          const rancherEmail = rancher['Email'];
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Partner';
          const buyerName = ref['Buyer Name'] || 'the buyer';
          const buyerState = ref['Buyer State'] || '';
          const buyerEmail = ref['Buyer Email'] || '';
          const buyerPhone = ref['Buyer Phone'] || '';
          const orderType = ref['Order Type'] || 'bulk beef';
          const introAt = ref['Intro Sent At'] || ref['Approved At'];
          const days = introAt ? Math.floor((Date.now() - new Date(introAt).getTime()) / (24 * 60 * 60 * 1000)) : 0;

          if (!rancherEmail) {
            await sendTelegramMessage(chatId!, `⚠️ ${rancherName} has no email on file.`);
            return NextResponse.json({ ok: true });
          }

          await sendEmail({
            to: rancherEmail,
            subject: `Quick nudge — ${buyerName} is still waiting`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
              <p>Hi ${rancherName},</p>
              <p>Just checking in — I introduced you to <b>${buyerName}</b> from ${buyerState} ${days} days ago and haven't seen any movement yet.</p>
              <p><b>Buyer details:</b><br>
              📧 ${buyerEmail}<br>
              ${buyerPhone ? `📱 ${buyerPhone}<br>` : ''}
              🥩 Wants: ${orderType}</p>
              <p>If you can shoot them a quick note today — even a "got your inquiry, here's when I can deliver" — that usually gets the ball rolling. If you're slammed and need me to reroute, just reply and let me know.</p>
              <p>Thanks,<br>— Benjamin</p>
              <p style="font-size:12px;color:#A7A29A;margin-top:30px;">BuyHalfCow | 10% commission on closed referrals</p>
            </div>`,
          });

          await answerCallbackQuery(queryId, '✅ Nudge sent');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, `📞 <b>RANCHER NUDGED</b>\n\n${rancherName} just got a polite ping about ${buyerName}.`);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // Mark a stalled referral as Closed Lost (and free up rancher capacity)
      else if (action === 'closelost') {
        try {
          const { logAuditEntry, buildAirtableUpdateReverse } = await import('@/lib/auditLog');
          const refId = fullReferralId;
          const ref: any = await getRecordById(TABLES.REFERRALS, refId);
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const previousStatus = ref['Status'] || null;
          // IDEMPOTENCY GUARD (RW-9 audit): without this, double-click on
          // the closelost Telegram button decremented Current Active
          // Referrals TWICE per click → rancher capacity underflow.
          // Short-circuit if already terminal.
          if (previousStatus === 'Closed Lost' || previousStatus === 'Closed Won') {
            await answerCallbackQuery(queryId, `Already ${previousStatus}`);
            return new Response('OK');
          }
          const previousClosedAt = ref['Closed At'] || null;
          const previousNotes = ref['Notes'] || null;
          const reverse = buildAirtableUpdateReverse(TABLES.REFERRALS, refId, {
            'Status': previousStatus,
            'Closed At': previousClosedAt,
            'Notes': previousNotes,
          });
          await updateRecord(TABLES.REFERRALS, refId, {
            'Status': 'Closed Lost',
            'Closed At': new Date().toISOString(),
            'Notes': `${ref['Notes'] || ''}\n[Closed Lost via Telegram — stalled, no engagement]`.trim(),
          });
          await logAuditEntry({
            actor: 'manual',
            tool: 'closelost',
            targetType: 'Referral',
            targetId: refId,
            args: { callbackData },
            result: { previousStatus, newStatus: 'Closed Lost' },
            reverseAction: reverse,
          });
          // MISMATCH FIX: atomic Redis DECR same as reject path above —
          // protects against concurrent closelost clicks under-decrementing.
          if (Array.isArray(rancherIds) && rancherIds[0]) {
            try {
              const { decrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
              const newCount = await decrementCapacity(rancherIds[0]);
              await syncCapacityToAirtable(rancherIds[0], newCount);
            } catch (capErr: any) {
              console.warn('[telegram closelost] atomic decrement failed:', capErr?.message);
            }
          }
          await answerCallbackQuery(queryId, '🔒 Closed Lost');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, `🔒 <b>CLOSED LOST</b>\n\n${ref['Buyer Name'] || 'Referral'} marked closed. Rancher capacity freed.`);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Hot lead actions (L2b) ─────────────────────────────────────────
      // Mark a 🔥 hot lead as personally contacted — appends a timestamp to Notes
      else if (action === 'hotcontact') {
        try {
          const consumerId = fullReferralId;
          const c: any = await getRecordById(TABLES.CONSUMERS, consumerId);
          const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'short', timeStyle: 'short' });
          const existingNotes = c['Notes'] || '';
          const newNotes = `${existingNotes}${existingNotes ? '\n' : ''}[Contacted via Telegram ${stamp}]`;
          await updateRecord(TABLES.CONSUMERS, consumerId, { 'Notes': newNotes });
          await answerCallbackQuery(queryId, '✅ Marked contacted');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, `✅ <b>CONTACTED</b> — ${c['Full Name']} marked as reached at ${stamp} MT`);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // Hot lead email — uses the existing AI draft pipeline so the result lands
      // in the same draftfollowup_send/sched/disc flow Ben already knows.
      else if (action === 'hotemail') {
        try {
          const consumerId = fullReferralId;
          await answerCallbackQuery(queryId, 'Drafting…');
          const c: any = await getRecordById(TABLES.CONSUMERS, consumerId);
          const firstName = (c['Full Name'] || '').split(' ')[0] || 'there';
          const aiPrompt = `Draft a short, warm, personal follow-up email from Benjamin (founder of BuyHalfCow) to a brand-new HIGH-INTENT beef buyer lead.

Buyer: ${c['Full Name']}
State: ${c['State']}
Order interest: ${c['Order Type'] || 'unspecified'}
Budget: ${c['Budget'] || 'unspecified'}
Notes: ${c['Notes'] || 'none'}

The email should:
- Open with their first name
- Acknowledge they just signed up and we noticed they're serious
- Ask 1-2 clarifying questions (timing, freezer space, processing preferences)
- Promise to connect them with a vetted rancher fast
- Sign off as "— Benjamin"
- Be 4-6 short sentences, no fluff, no headers, no bullets

Output ONLY the email body. First line should be the subject line prefixed with "SUBJECT: ".`;
          const aiResponse = await callClaude({
            model: 'claude-haiku-4-5-20251001',
            system: `You are Benjamin's AI assistant for BuyHalfCow. Write like Benjamin: direct, warm, conversational. Never use exclamation points or sales-y language.`,
            user: aiPrompt,
            maxTokens: 400,
          });
          const lines = aiResponse.trim().split('\n');
          const subjectLine = lines[0]?.replace(/^SUBJECT:\s*/i, '').trim() || `Quick question about your beef order, ${firstName}`;
          const body = lines.slice(1).join('\n').trim();
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'AI Email Draft': body,
            'AI Email Draft Subject': subjectLine,
          });
          if (chatId) {
            const draftMsg = `✉️ <b>HOT LEAD DRAFT</b>\n\n<b>To:</b> ${c['Full Name']} &lt;${c['Email']}&gt;\n<b>Subject:</b> ${subjectLine}\n\n${body}`;
            const keyboard = {
              inline_keyboard: [[
                { text: '📧 Send Now', callback_data: `draftfollowup_send_${consumerId}` },
                { text: '⏰ Tomorrow', callback_data: `draftfollowup_sched_${consumerId}` },
                { text: '🗑️ Discard', callback_data: `draftfollowup_disc_${consumerId}` },
              ]],
            };
            await sendTelegramMessage(chatId, draftMsg, keyboard);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Rancher actions ────────────────────────────────────────────────

      else if (action === 'ronboard') {
        await answerCallbackQuery(queryId, 'Sending onboarding docs…');
        try {
          // Fetch rancher to include their call notes and capacity
          const rancher: any = await getRecordById(TABLES.RANCHERS, fullReferralId);
          const res = await fetch(`${SITE_URL}/api/ranchers/${fullReferralId}/send-onboarding`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
            },
            body: JSON.stringify({
              callSummary: rancher['Call Notes'] || rancher['Operation Details'] || '',
              confirmedCapacity: rancher['Monthly Capacity'] || 10,
              specialNotes: rancher['Certifications'] || '',
              includeVerification: true,
              password: process.env.ADMIN_PASSWORD || '',
            }),
          });
          if (res.ok) {
            await answerCallbackQuery(queryId, 'Onboarding docs sent!');
            if (chatId && messageId) {
              await editTelegramMessage(chatId, messageId,
                `📦 <b>ONBOARDING SENT</b>\n\n${rancher['Operator Name'] || rancher['Ranch Name']} — docs and agreement link sent`
              );
            }
          } else {
            const err = await res.json();
            await answerCallbackQuery(queryId, `Error: ${err.error || 'Failed'}`);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Chase-up callbacks ─────────────────────────────────────────────
      // chasend_{referralId}, chaskip_{referralId}

      else if (action === 'chasend') {
        await answerCallbackQuery(queryId, 'Sending chase-up…');
        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);
          const draft = referral['AI Chase Draft'];
          if (!draft) {
            await answerCallbackQuery(queryId, 'No draft found. Run /chasup again.');
            return NextResponse.json({ ok: true });
          }

          const buyerEmail = referral['Buyer Email'];
          const buyerName = referral['Buyer Name'] || 'there';
          const firstName = buyerName.split(' ')[0];
          const rancherName = referral['Suggested Rancher Name'] || 'your rancher';
          const consumerId = referral['Buyer']?.[0] || '';

          if (!buyerEmail) {
            await answerCallbackQuery(queryId, 'No buyer email on record.');
            return NextResponse.json({ ok: true });
          }

          // Generate login URL for the consumer
          const token = jwt.sign(
            { type: 'member-login', consumerId, email: buyerEmail.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const loginUrl = `${SITE_URL}/member/verify?token=${token}`;

          // Send chase-up email
          await sendEmail({
            to: buyerEmail,
            subject: 'Quick check-in from BuyHalfCow',
            html: `
              <!DOCTYPE html><html><head>
              <style>body{font-family:-apple-system,sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:16px 0;color:#0E0E0E}.button{display:inline-block;padding:14px 28px;background:#0E0E0E;color:white!important;text-decoration:none;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin:20px 0}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
              </head><body><div class="container">
              <h1>Quick check-in</h1>
              <p>Hi ${firstName},</p>
              ${draft.split('\n').filter(Boolean).map((p: string) => `<p>${p}</p>`).join('')}
              <a href="${loginUrl}" class="button">View Your Dashboard →</a>
              <div class="footer"><p>— Benjamin, BuyHalfCow<br>Questions? Reply to this email.</p></div>
              </div></body></html>
            `,
          });

          // Update referral record
          const now = new Date().toISOString();
          const currentCount = referral['Chase Count'] || 0;
          await updateRecord(TABLES.REFERRALS, fullReferralId, {
            'Last Chased At': now,
            'Chase Count': currentCount + 1,
          });

          await answerCallbackQuery(queryId, '📧 Sent!');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `✅ <b>CHASE-UP SENT</b>\n\nEmail sent to ${buyerName} re: ${rancherName}`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'chaskip') {
        // Update Last Chased At so this referral doesn't reappear in tomorrow's cron
        try {
          await updateRecord(TABLES.REFERRALS, fullReferralId, {
            'Last Chased At': new Date().toISOString(),
          });
        } catch { /* non-critical */ }
        await answerCallbackQuery(queryId, 'Skipped');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, `⏭️ <b>SKIPPED</b> — won't reappear for 5 days`);
        }
      }

      // ─── Draft email callbacks ──────────────────────────────────────────
      // draftfollowup_{send|sched|disc}_{consumerId}

      else if (action === 'draftfollowup') {
        // fullReferralId = "send_recXXX" or "sched_recXXX" or "disc_recXXX"
        const underscoreIdx = fullReferralId.indexOf('_');
        const subAction = underscoreIdx >= 0 ? fullReferralId.substring(0, underscoreIdx) : fullReferralId;
        const consumerId = underscoreIdx >= 0 ? fullReferralId.substring(underscoreIdx + 1) : '';

        if (subAction === 'disc') {
          try {
            if (consumerId) await updateRecord(TABLES.CONSUMERS, consumerId, { 'AI Email Draft': '', 'AI Email Draft Subject': '' });
            await answerCallbackQuery(queryId, 'Draft discarded');
            if (chatId && messageId) await editTelegramMessage(chatId, messageId, '🗑️ <b>DRAFT DISCARDED</b>');
          } catch (e: any) {
            await answerCallbackQuery(queryId, `Error: ${e.message}`);
          }
        } else if (subAction === 'send' || subAction === 'sched') {
          try {
            const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId);
            const subject = consumer['AI Email Draft Subject'] || 'A note from BuyHalfCow';
            const draft = consumer['AI Email Draft'];
            const consumerEmail = consumer['Email'];
            const firstName = (consumer['Full Name'] || '').split(' ')[0];

            if (!draft || !consumerEmail) {
              await answerCallbackQuery(queryId, 'Draft or email not found. Run /draft again.');
              return NextResponse.json({ ok: true });
            }

            const token = jwt.sign(
              { type: 'member-login', consumerId, email: consumerEmail.trim().toLowerCase() },
              JWT_SECRET,
              { expiresIn: '7d' }
            );
            const loginUrl = `${SITE_URL}/member/verify?token=${token}`;

            if (subAction === 'sched') {
              // Schedule for tomorrow via Campaigns table
              const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
              const { createRecord } = await import('@/lib/airtable');
              await createRecord(TABLES.CAMPAIGNS, {
                'Campaign Name': `Followup: ${consumer['Full Name'] || consumerEmail}`,
                'Subject': subject,
                'Message': draft,
                'Audience': `single:${consumerEmail}`,
                'Scheduled For': tomorrow,
                'Status': 'Scheduled',
              });
              await updateRecord(TABLES.CONSUMERS, consumerId, { 'AI Email Draft': '', 'AI Email Draft Subject': '' });
              await answerCallbackQuery(queryId, '⏰ Scheduled for tomorrow!');
              if (chatId && messageId) await editTelegramMessage(chatId, messageId, `⏰ <b>SCHEDULED</b>\n\nEmail to ${consumer['Full Name']} queued for tomorrow`);
            } else {
              // Send now
              await sendEmail({
                to: consumerEmail,
                subject,
                html: `
                  <!DOCTYPE html><html><head>
                  <style>body{font-family:-apple-system,sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:16px 0;color:#0E0E0E}.button{display:inline-block;padding:14px 28px;background:#0E0E0E;color:white!important;text-decoration:none;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin:20px 0}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
                  </head><body><div class="container">
                  <h1>${escHtml(subject)}</h1>
                  <p>Hi ${escHtml(firstName)},</p>
                  ${draft.split('\n').filter(Boolean).map((p: string) => `<p>${escHtml(p)}</p>`).join('')}
                  <a href="${loginUrl}" class="button">View Your Dashboard →</a>
                  <div class="footer"><p>— Benjamin, BuyHalfCow</p></div>
                  </div></body></html>
                `,
              });
              await updateRecord(TABLES.CONSUMERS, consumerId, { 'AI Email Draft': '', 'AI Email Draft Subject': '' });
              await answerCallbackQuery(queryId, '📧 Sent!');
              if (chatId && messageId) await editTelegramMessage(chatId, messageId, `✅ <b>EMAIL SENT</b>\n\nPersonalized follow-up sent to ${consumer['Full Name']}`);
            }
          } catch (e: any) {
            await answerCallbackQuery(queryId, `Error: ${e.message}`);
          }
        }
      }

      // ─── Broadcast callbacks (fixed — moved from dead code block) ───────

      else if (callbackData === 'bccancel') {
        await answerCallbackQuery(queryId, 'Cancelled');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, '❌ Broadcast cancelled.');
        }
      }

      // ─── Rancher check-in callbacks ────────────────────────────────────
      else if (callbackData === 'rcheckin_cancel') {
        await answerCallbackQuery(queryId, 'Cancelled');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, '❌ Check-in cancelled.');
        }
      }

      else if (callbackData === 'rcheckin_send') {
        try {
          await answerCallbackQuery(queryId, 'Sending check-in emails...');

          const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
          const stalled = allRanchers.filter((r: any) => {
            const status = r['Active Status'] || '';
            const email = r['Email'] || '';
            const pageLive = r['Page Live'] || false;
            if (pageLive) return false;
            if (['Suspended', 'Rejected'].includes(status)) return false;
            if (!email) return false;
            if (r['Last Check In']) {
              const lastCheckin = new Date(r['Last Check In']);
              const daysSince = (Date.now() - lastCheckin.getTime()) / (1000 * 60 * 60 * 24);
              if (daysSince < 7) return false;
            }
            return true;
          });

          let sentCount = 0;
          for (const r of stalled) {
            try {
              const token = jwt.sign(
                { type: 'rancher-checkin', rancherId: r.id },
                JWT_SECRET,
                { expiresIn: '30d' }
              );
              await sendRancherCheckIn({
                operatorName: r['Operator Name'] || r['Ranch Name'] || 'Rancher',
                ranchName: r['Ranch Name'] || r['Operator Name'] || 'Your Ranch',
                email: r['Email'],
                rancherId: r.id,
                onboardingStatus: r['Onboarding Status'] || 'Pending',
                token,
              });
              sentCount++;
            } catch (e) {
              console.error(`Check-in email error for ${r['Email']}:`, e);
            }
          }

          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `✅ <b>CHECK-IN EMAILS SENT</b>\n\n📧 ${sentCount}/${stalled.length} ranchers contacted\n\nEach got 3 buttons:\n✅ "I'm still in" → notifies you\n📞 "Questions" → sends to Calendly\n🔴 "Not interested" → marks Inactive\n\nResponses will ping this chat in real time.`
            );
          }
        } catch (e: any) {
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, `❌ Error sending check-ins: ${e.message}`);
          }
        }
      }

      // ── BLITZ: bulk pipeline update emails ──────────────────────────
      else if (callbackData === 'blitz_cancel') {
        await answerCallbackQuery(queryId, 'Cancelled');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, '❌ Pipeline blitz cancelled.');
        }
      }

      else if (callbackData === 'blitz_send') {
        try {
          await answerCallbackQuery(queryId, 'Sending pipeline update emails...');

          const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
          const pipeline = allRanchers.filter((r: any) => {
            const onboarding = r['Onboarding Status'] || '';
            const active = r['Active Status'] || '';
            const email = r['Email'] || '';
            if (!email) return false;
            if (['Suspended', 'Rejected'].includes(active)) return false;
            if (onboarding === 'Live') return false;
            return true;
          });

          let sentCount = 0;
          const byStage: Record<string, number> = {};

          for (const r of pipeline) {
            try {
              const status = r['Onboarding Status'] || '';
              byStage[status || 'New'] = (byStage[status || 'New'] || 0) + 1;

              // Generate signing link for ranchers who need to sign
              let signingLink: string | undefined;
              if (!status || status === 'Call Scheduled' || status === 'Call Complete' || status === 'Docs Sent') {
                const signingToken = jwt.sign(
                  { type: 'agreement-signing', rancherId: r.id },
                  JWT_SECRET,
                  { expiresIn: '30d' }
                );
                signingLink = `${SITE_URL}/rancher/sign-agreement?token=${signingToken}`;
              }

              // Generate dashboard link for signed ranchers
              let dashboardLink: string | undefined;
              if (status === 'Agreement Signed' || status === 'Verification Pending') {
                const loginToken = jwt.sign(
                  { type: 'rancher-login', rancherId: r.id, email: r['Email'] },
                  JWT_SECRET,
                  { expiresIn: '7d' }
                );
                dashboardLink = `${SITE_URL}/rancher/verify?token=${loginToken}`;
              }

              await sendPipelineUpdateEmail({
                operatorName: r['Operator Name'] || r['Ranch Name'] || 'Rancher',
                ranchName: r['Ranch Name'] || r['Operator Name'] || 'Your Ranch',
                email: r['Email'],
                rancherId: r.id,
                onboardingStatus: status,
                signingLink,
                dashboardLink,
              });
              sentCount++;
            } catch (e) {
              console.error(`Blitz email error for ${r['Email']}:`, e);
            }
          }

          const stageBreakdown = Object.entries(byStage)
            .map(([stage, count]) => `  ${stage || 'New'}: ${count}`)
            .join('\n');

          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `🚀 <b>PIPELINE BLITZ SENT</b>\n\n📧 ${sentCount}/${pipeline.length} ranchers emailed\n\n<b>By stage:</b>\n${stageBreakdown}\n\nEach rancher got a personalized email with their specific next step and a direct action link (sign agreement / set up page / dashboard).`
            );
          }
        } catch (e: any) {
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, `❌ Error sending blitz: ${e.message}`);
          }
        }
      }

      // ── BULK ONBOARD: send onboarding docs to all eligible ─────────
      else if (callbackData === 'bulkonboard_cancel') {
        await answerCallbackQuery(queryId, 'Cancelled');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, '❌ Bulk onboard cancelled.');
        }
      }

      else if (callbackData === 'bulkonboard_send') {
        try {
          await answerCallbackQuery(queryId, 'Sending onboarding packages...');

          const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
          const eligible = allRanchers.filter((r: any) => {
            const status = r['Onboarding Status'] || '';
            const active = r['Active Status'] || '';
            const email = r['Email'] || '';
            if (!email) return false;
            if (['Suspended', 'Rejected'].includes(active)) return false;
            // Only send to those who haven't received docs yet
            if (['Docs Sent', 'Agreement Signed', 'Verification Pending', 'Verification Complete', 'Live'].includes(status)) return false;
            return true;
          });

          let sentCount = 0;
          const failures: string[] = [];

          for (const r of eligible) {
            try {
              const internalSecret = process.env.INTERNAL_API_SECRET;
              const adminPassword = process.env.ADMIN_PASSWORD || '';
              const res = await fetch(`${SITE_URL}/api/ranchers/${r.id}/send-onboarding`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(internalSecret ? { 'x-internal-secret': internalSecret } : {}),
                },
                body: JSON.stringify({
                  callSummary: r['Call Notes'] || r['Operation Details'] || '',
                  confirmedCapacity: r['Monthly Capacity'] || 10,
                  specialNotes: r['Certifications'] || '',
                  includeVerification: true,
                  password: adminPassword,
                }),
              });
              if (res.ok) {
                sentCount++;
              } else {
                const errBody = await res.json().catch(() => ({ error: 'Unknown' }));
                failures.push(`${r['Operator Name'] || r['Email']}: ${errBody.error || res.status}`);
              }
            } catch (e: any) {
              failures.push(`${r['Operator Name'] || r['Email']}: ${e.message}`);
            }
          }

          let resultMsg = `📦 <b>BULK ONBOARDING COMPLETE</b>\n\n📧 ${sentCount}/${eligible.length} ranchers received onboarding docs`;
          if (sentCount > 0) {
            resultMsg += `\n\nEach got:\n• Commission Agreement\n• Media Agreement\n• Rancher Info Packet\n• 30-day signing link\n\nThey can sign immediately and start setting up their page.`;
          }
          if (failures.length > 0) {
            resultMsg += `\n\n❌ <b>${failures.length} failed:</b>\n${failures.slice(0, 10).map(f => `• ${f}`).join('\n')}`;
            if (failures.length > 10) resultMsg += `\n...and ${failures.length - 10} more`;
          }

          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, resultMsg);
          }
        } catch (e: any) {
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId, `❌ Error with bulk onboard: ${e.message}`);
          }
        }
      }

      else if (callbackData?.startsWith('bcsend_')) {
        await answerCallbackQuery(queryId, 'Broadcasting…');
        try {
          const originalText = message?.text || '';
          const messageMatch = originalText.match(/Message:\n([\s\S]+)\n\nConfirm/);
          const broadcastMsg = messageMatch?.[1] || 'Update from BuyHalfCow';
          const audienceType = callbackData.split('_')[1];

          let recipients: Array<{ email: string; name: string }> = [];

          if (audienceType === 'ranchers') {
            const ranchers = await getAllRecords(TABLES.RANCHERS);
            recipients = ranchers.map((r: any) => ({
              email: (r['Email'] || '').trim().toLowerCase(),
              name: r['Operator Name'] || 'Rancher',
            })).filter(r => r.email);
          } else {
            const consumers = await getAllRecords(TABLES.CONSUMERS);
            // Filter out unsubscribed consumers from broadcasts
            let filtered = consumers.filter((c: any) => !c['Unsubscribed']);
            if (audienceType === 'consumers-beef') {
              filtered = filtered.filter((c: any) => c['Segment'] === 'Beef Buyer');
            } else if (audienceType === 'consumers-community') {
              filtered = filtered.filter((c: any) => !c['Segment'] || c['Segment'] === 'Community');
            }
            recipients = filtered.map((c: any) => ({
              email: (c['Email'] || '').trim().toLowerCase(),
              name: c['Full Name'] || 'Member',
            })).filter(r => r.email);
          }

          const seen = new Set<string>();
          recipients = recipients.filter(r => {
            if (seen.has(r.email)) return false;
            seen.add(r.email);
            return true;
          });

          let sentCount = 0;
          for (const recipient of recipients) {
            try {
              await sendBroadcastEmail({
                to: recipient.email,
                name: recipient.name,
                subject: 'Update from BuyHalfCow',
                message: broadcastMsg,
                campaignName: 'telegram-broadcast',
                includeCTA: false,
                ctaText: '',
                ctaLink: '',
              });
              sentCount++;
            } catch (e) {
              console.error(`Broadcast send error for ${recipient.email}:`, e);
            }
          }

          await answerCallbackQuery(queryId, `Sent to ${sentCount} recipients`);
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `✅ <b>BROADCAST SENT</b>\n\n📧 ${sentCount}/${recipients.length} emails delivered`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── /setuppage wizard callbacks ──────────────────────────────────────

      else if (callbackData?.startsWith('spf_')) {
        const fieldKey = callbackData.replace('spf_', '');
        const session = chatId ? setupPageSessions.get(chatId) : null;
        if (!session) {
          await answerCallbackQuery(queryId, 'Session expired. Run /setuppage again.');
          return NextResponse.json({ ok: true });
        }
        const label = SP_FIELD_LABELS[fieldKey] || fieldKey;
        session.awaitingField = fieldKey;
        await answerCallbackQuery(queryId, `Enter ${label}`);
        if (chatId) {
          await sendTelegramMessage(chatId, `✏️ <b>${label}</b>\n\nType the value and send it:`);
        }
      }

      else if (callbackData === 'spgolive') {
        const session = chatId ? setupPageSessions.get(chatId) : null;
        if (!session) {
          await answerCallbackQuery(queryId, 'Session expired. Run /setuppage again.');
          return NextResponse.json({ ok: true });
        }
        try {
          const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
          const slug = rancher['Slug'] || '';

          // Validate minimum content
          if (!slug) {
            await answerCallbackQuery(queryId, 'Set a URL slug first!');
            if (chatId) await sendTelegramMessage(chatId, '⚠️ Set a <b>URL Slug</b> before going live.');
            return NextResponse.json({ ok: true });
          }
          const hasAbout = !!(rancher['About Text'] || '').trim();
          const hasAnyPricing = !!(rancher['Quarter Price'] || rancher['Half Price'] || rancher['Whole Price']);
          const hasAnyPaymentLink = !!(rancher['Quarter Payment Link'] || rancher['Half Payment Link'] || rancher['Whole Payment Link']);
          const missing: string[] = [];
          if (!hasAbout) missing.push('About Text');
          if (!hasAnyPricing) missing.push('at least 1 price');
          if (!hasAnyPaymentLink) missing.push('at least 1 payment link');
          if (missing.length > 0) {
            await answerCallbackQuery(queryId, 'Missing required content');
            if (chatId) {
              await sendTelegramMessage(chatId, `⚠️ Can't go live yet. Missing:\n${missing.map(m => `• ${m}`).join('\n')}`);
            }
            return NextResponse.json({ ok: true });
          }

          const { logAuditEntry: logSpGolive, buildAirtableUpdateReverse: buildSpGoliveReverse } = await import('@/lib/auditLog');
          const previousPageLive = rancher['Page Live'] ?? null;
          const previousOnboardingStatus = rancher['Onboarding Status'] ?? null;
          const spGoliveReverse = buildSpGoliveReverse(TABLES.RANCHERS, session.rancherId, {
            'Page Live': previousPageLive,
            'Onboarding Status': previousOnboardingStatus,
          });
          await updateRecord(TABLES.RANCHERS, session.rancherId, {
            'Page Live': true,
            'Onboarding Status': 'Live',
          });
          triggerLaunchWarmup(`telegram-spgolive:${session.rancherId}`);
          await logSpGolive({
            actor: 'manual',
            tool: 'spgolive',
            targetType: 'Rancher',
            targetId: session.rancherId,
            args: { callbackData },
            result: { previousPageLive, previousOnboardingStatus, newPageLive: true, newOnboardingStatus: 'Live' },
            reverseAction: spGoliveReverse,
          });
          await answerCallbackQuery(queryId, '🚀 Page is live!');
          const liveUrl = `${SITE_URL}/ranchers/${slug}`;

          // Notify the rancher they're live
          const rancherEmail = rancher['Email'];
          if (rancherEmail) {
            const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
            await sendEmail({
              to: rancherEmail,
              subject: 'You\'re Live on BuyHalfCow!',
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                <h1 style="font-family:Georgia,serif;font-size:22px;">You're Live!</h1>
                <p>Hi ${escHtml(name)},</p>
                <p>Your ranch page is now live on BuyHalfCow. Buyers can find you, learn about your operation, and purchase directly.</p>
                <div style="margin:30px 0;text-align:center;">
                  <a href="${liveUrl}" style="background:#2D5016;color:#fff;padding:14px 28px;text-decoration:none;font-weight:600;display:inline-block;">View Your Page</a>
                </div>
                <p><strong>What happens now:</strong></p>
                <ul style="line-height:1.8;">
                  <li>Buyers in your area will see your page in our directory</li>
                  <li>When a buyer clicks to purchase, you'll get an email</li>
                  <li>We'll send you qualified leads directly via email</li>
                  <li>BuyHalfCow earns 10% commission on referred sales</li>
                </ul>
                <p>Share your page: <a href="${liveUrl}">${liveUrl}</a></p>
                <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow</p>
              </div>`,
            });
          }

          if (chatId) {
            await sendTelegramMessage(chatId,
              `🚀 <b>${session.rancherName} is LIVE!</b>\n\n🔗 ${liveUrl}\n📧 Rancher notified\n✅ Status → Live\n\nShare this link and run ads to it.`
            );
          }

          // Waitlist blast: auto-match waiting buyers in this rancher's state(s)
          try {
            const blast = await runWaitlistBlast(session.rancherId);
            if (blast.matched > 0 && chatId) {
              await sendTelegramMessage(chatId, `🚀 <b>${escHtml(blast.ranchName)}</b> is LIVE in <b>${escHtml(blast.state)}</b> — auto-matched <b>${blast.matched}</b> waiting buyer${blast.matched === 1 ? '' : 's'}`);
            }
          } catch (e) {
            console.error('Waitlist blast error (spgolive):', e);
          }

          setupPageSessions.delete(chatId!);
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (callbackData === 'sppreview') {
        const session = chatId ? setupPageSessions.get(chatId) : null;
        if (!session) {
          await answerCallbackQuery(queryId, 'Session expired. Run /setuppage again.');
          return NextResponse.json({ ok: true });
        }
        try {
          const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
          const slug = rancher['Slug'];
          if (!slug) {
            await answerCallbackQuery(queryId, 'Set a slug first');
            return NextResponse.json({ ok: true });
          }
          await answerCallbackQuery(queryId, 'Here\'s the preview link');
          if (chatId) {
            await sendTelegramMessage(chatId, `👁 <b>Preview:</b>\n${SITE_URL}/ranchers/${slug}\n\n<i>Note: page only shows publicly once Page Live is set to ✅</i>`);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (callbackData.startsWith('rcallcompl_')) {
        const rancherId = callbackData.substring('rcallcompl_'.length);
        try {
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          if (!rancher) {
            await answerCallbackQuery(queryId, 'Rancher not found');
            return NextResponse.json({ ok: true });
          }
          const currentStatus = (rancher['Onboarding Status'] || '').toString();
          // Only advance from Call Scheduled. Don't overwrite signed / verified.
          if (currentStatus === 'Call Scheduled' || currentStatus === '' || currentStatus === 'New') {
            await updateRecord(TABLES.RANCHERS, rancherId, {
              'Onboarding Status': 'Call Complete',
              'Call Completed At': new Date().toISOString().slice(0, 10),
            });
            await answerCallbackQuery(queryId, '✅ Call marked complete');
          } else {
            await answerCallbackQuery(queryId, `No-op — status is ${currentStatus}`);
          }
        } catch (e: any) {
          console.error('rcallcompl_ handler error:', e);
          await answerCallbackQuery(queryId, 'Error — check logs');
        }
        return NextResponse.json({ ok: true });
      }

      else if (callbackData.startsWith('rverify_')) {
        const rancherId = callbackData.substring('rverify_'.length);
        try {
          const { logAuditEntry, buildAirtableUpdateReverse } = await import('@/lib/auditLog');
          const before = await getRecordById(TABLES.RANCHERS, rancherId) as any;
          const previousOnboarding = before?.['Onboarding Status'] ?? null;
          const previousVerification = before?.['Verification Status'] ?? null;
          const reverse = buildAirtableUpdateReverse(TABLES.RANCHERS, rancherId, {
            'Onboarding Status': previousOnboarding,
            'Verification Status': previousVerification,
          });
          // Set BOTH fields. Prior version only flipped Onboarding Status,
          // leaving Verification Status='Prospect' which contradicts
          // downstream filters and the sign-agreement copy claiming both
          // flip together. batch-approve gates on Onboarding Status so
          // routing worked, but other reads (admin dashboards, public
          // page, audit log) saw inconsistent state.
          await updateRecord(TABLES.RANCHERS, rancherId, {
            'Onboarding Status': 'Verification Complete',
            'Verification Status': 'Verified',
          });
          await logAuditEntry({
            actor: 'manual',
            tool: 'rverify',
            targetType: 'Rancher',
            targetId: rancherId,
            args: { callbackData },
            result: { previousOnboarding, previousVerification, newOnboarding: 'Verification Complete', newVerification: 'Verified' },
            reverseAction: reverse,
          });
          await answerCallbackQuery(queryId, '✅ Verification approved!');
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
          const rancherEmail = rancher['Email'];

          // Notify the rancher their verification passed
          if (rancherEmail) {
            const slug = rancher['Slug'] || '';
            const dashToken = jwt.sign(
              { type: 'rancher-login', rancherId, email: rancherEmail.trim().toLowerCase() },
              JWT_SECRET,
              { expiresIn: '7d' }
            );
            const dashUrl = `${SITE_URL}/rancher/verify?token=${dashToken}`;
            await sendEmail({
              to: rancherEmail,
              subject: 'Verification Complete — Ready to Go Live on BuyHalfCow',
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                <h1 style="font-family:Georgia,serif;font-size:22px;">Verification Complete</h1>
                <p>Hi ${escHtml(name)},</p>
                <p>Your product verification has been approved. You're almost live on BuyHalfCow.</p>
                <p><strong>Next step:</strong> Make sure your landing page has your pricing, payment links, and about text filled in. Then hit "Request Go Live" on your dashboard.</p>
                <div style="margin:30px 0;text-align:center;">
                  <a href="${dashUrl}" style="background:#2D5016;color:#fff;padding:14px 28px;text-decoration:none;font-weight:600;display:inline-block;">Open Dashboard</a>
                </div>
                <p>Once your page is live, buyers in your area will start seeing your ranch and can purchase directly.</p>
                <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow</p>
              </div>`,
            });
          }

          if (chatId) {
            await editTelegramMessage(chatId, messageId!, `✅ <b>VERIFICATION APPROVED</b>\n\n🤠 ${escHtml(name)} — Onboarding Status set to "Verification Complete".\n📧 Rancher notified via email.`);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (callbackData.startsWith('rgolive_')) {
        const rancherId = callbackData.substring('rgolive_'.length);
        try {
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
          const slug = rancher['Slug'] || '';
          const rancherEmail = rancher['Email'];

          // Validate minimum content before going live
          if (!slug) {
            await answerCallbackQuery(queryId, 'Set a URL slug first!');
            return NextResponse.json({ ok: true });
          }
          const hasAbout = !!(rancher['About Text'] || '').trim();
          const hasAnyPricing = !!(rancher['Quarter Price'] || rancher['Half Price'] || rancher['Whole Price']);
          const hasAnyPaymentLink = !!(rancher['Quarter Payment Link'] || rancher['Half Payment Link'] || rancher['Whole Payment Link']);
          const missing: string[] = [];
          if (!hasAbout) missing.push('About Text');
          if (!hasAnyPricing) missing.push('at least 1 price (quarter/half/whole)');
          if (!hasAnyPaymentLink) missing.push('at least 1 payment link');
          if (missing.length > 0) {
            await answerCallbackQuery(queryId, 'Missing required content');
            if (chatId) {
              await sendTelegramMessage(chatId, `⚠️ Can't go live yet. Missing:\n${missing.map(m => `• ${m}`).join('\n')}\n\nUse /setuppage ${name} or have the rancher fill these in on their dashboard.`);
            }
            return NextResponse.json({ ok: true });
          }

          const { logAuditEntry: logGolive, buildAirtableUpdateReverse: buildGoliveReverse } = await import('@/lib/auditLog');
          const previousPageLive = rancher['Page Live'] ?? null;
          const previousOnboardingStatus = rancher['Onboarding Status'] ?? null;
          const goliveReverse = buildGoliveReverse(TABLES.RANCHERS, rancherId, {
            'Page Live': previousPageLive,
            'Onboarding Status': previousOnboardingStatus,
          });
          await updateRecord(TABLES.RANCHERS, rancherId, {
            'Page Live': true,
            'Onboarding Status': 'Live',
          });
          triggerLaunchWarmup(`telegram-rgolive:${rancherId}`);
          await logGolive({
            actor: 'manual',
            tool: 'rgolive',
            targetType: 'Rancher',
            targetId: rancherId,
            args: { callbackData },
            result: { previousPageLive, previousOnboardingStatus, newPageLive: true, newOnboardingStatus: 'Live' },
            reverseAction: goliveReverse,
          });
          await answerCallbackQuery(queryId, '🟢 Page is live!');

          // Notify the rancher they're live
          if (rancherEmail) {
            const liveUrl = `${SITE_URL}/ranchers/${slug}`;
            await sendEmail({
              to: rancherEmail,
              subject: 'You\'re Live on BuyHalfCow!',
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                <h1 style="font-family:Georgia,serif;font-size:22px;">You're Live!</h1>
                <p>Hi ${escHtml(name)},</p>
                <p>Your ranch page is now live on BuyHalfCow. Buyers can find you, learn about your operation, and purchase directly.</p>
                <div style="margin:30px 0;text-align:center;">
                  <a href="${liveUrl}" style="background:#2D5016;color:#fff;padding:14px 28px;text-decoration:none;font-weight:600;display:inline-block;">View Your Page</a>
                </div>
                <p><strong>What happens now:</strong></p>
                <ul style="line-height:1.8;">
                  <li>Buyers in your area will see your page in our rancher directory</li>
                  <li>When a buyer clicks to purchase, you'll get an email notification</li>
                  <li>We'll also send you qualified buyer leads directly via email</li>
                  <li>BuyHalfCow earns 10% commission on referred sales — that's it</li>
                </ul>
                <p>Share your page link with your own customers too: <a href="${liveUrl}">${liveUrl}</a></p>
                <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow</p>
              </div>`,
            });
          }

          if (chatId) {
            const liveUrl = `${SITE_URL}/ranchers/${slug}`;
            await editTelegramMessage(chatId, messageId!, `🟢 <b>PAGE IS LIVE</b>\n\n🤠 ${escHtml(name)}\n🔗 ${liveUrl}\n📧 Rancher notified via email\n✅ Onboarding Status → Live`);
          }

          // Waitlist blast: auto-match waiting buyers in this rancher's state(s)
          try {
            const blast = await runWaitlistBlast(rancherId);
            if (blast.matched > 0 && chatId) {
              await sendTelegramMessage(chatId, `🚀 <b>${escHtml(blast.ranchName)}</b> is LIVE in <b>${escHtml(blast.state)}</b> — auto-matched <b>${blast.matched}</b> waiting buyer${blast.matched === 1 ? '' : 's'}`);
            }
          } catch (e) {
            console.error('Waitlist blast error (rgolive):', e);
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (callbackData === 'spdone') {
        await answerCallbackQuery(queryId, 'Done!');
        if (chatId) {
          setupPageSessions.delete(chatId);
          await sendTelegramMessage(chatId, '✅ Page setup saved. Run /setuppage [name] anytime to edit.');
        }
      }

      // ─── Morning brief drill-down buttons ───────────────────────────────────
      // Tapping a button on the daily AI brief fires a fresh fetch and replies inline.
      else if (callbackData === 'brief_leads') {
        if (!chatId) {
          await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(queryId, 'Loading…');
        try {
          const refs = await getAllRecords(TABLES.REFERRALS, '{Status} = "Pending Approval"');
          if (refs.length === 0) {
            await sendTelegramMessage(chatId, '✅ No pending referrals — all caught up.');
          } else {
            let msg = `📋 <b>${refs.length} Pending Referral${refs.length > 1 ? 's' : ''}</b>\n\n`;
            for (const ref of (refs as any[]).slice(0, 10)) {
              msg += `• ${ref['Buyer Name']} (${ref['Buyer State']}) — ${ref['Intent Classification'] || 'unknown'} intent\n`;
            }
            if (refs.length > 10) msg += `\n…and ${refs.length - 10} more`;
            msg += `\n\nFull list: ${SITE_URL}/admin/referrals`;
            await sendTelegramMessage(chatId, msg);
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ Couldn't load leads: ${e.message}`);
        }
      }

      else if (callbackData === 'brief_stalled') {
        if (!chatId) {
          await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(queryId, 'Loading…');
        try {
          const refs = await getAllRecords(TABLES.REFERRALS);
          const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
          const stalled = (refs as any[]).filter((r) => {
            if (!['Intro Sent', 'Rancher Contacted'].includes(r['Status'])) return false;
            const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
            if (!lastActivity) return false;
            return (Date.now() - new Date(lastActivity).getTime()) >= fiveDaysMs;
          });
          if (stalled.length === 0) {
            await sendTelegramMessage(chatId, '✅ No stalled referrals — every active deal is fresh.');
          } else {
            let msg = `🔥 <b>${stalled.length} Stalled Referral${stalled.length > 1 ? 's' : ''}</b> (5+ days no movement)\n\n`;
            for (const r of stalled.slice(0, 10)) {
              const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
              const days = Math.floor((Date.now() - new Date(lastActivity).getTime()) / (24 * 60 * 60 * 1000));
              msg += `• ${r['Buyer Name']} (${r['Buyer State']}) — ${days}d, ${r['Status']}\n`;
            }
            if (stalled.length > 10) msg += `\n…and ${stalled.length - 10} more`;
            msg += `\n\nRun /chasup to draft re-engagement emails.`;
            await sendTelegramMessage(chatId, msg);
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ Couldn't load stalled refs: ${e.message}`);
        }
      }

      else if (callbackData === 'brief_money') {
        if (!chatId) {
          await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(queryId, 'Loading…');
        try {
          const refs = await getAllRecords(TABLES.REFERRALS);
          const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
          const monthWins = (refs as any[]).filter((r) => {
            const closed = new Date(r['Closed At'] || 0);
            return closed >= monthStart && r['Status'] === 'Closed Won';
          });
          const monthCommission = monthWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
          const allWins = (refs as any[]).filter((r) => r['Status'] === 'Closed Won');
          const lifetimeCommission = allWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
          const unpaid = allWins.filter((r) => !r['Commission Paid']).reduce((s, r) => s + (r['Commission Due'] || 0), 0);
          const msg = `💰 <b>Revenue</b>\n\n` +
            `<b>This Month</b>\n` +
            `• Deals closed: ${monthWins.length}\n` +
            `• Commission earned: $${monthCommission.toLocaleString()}\n\n` +
            `<b>Lifetime</b>\n` +
            `• Total wins: ${allWins.length}\n` +
            `• Total commission: $${lifetimeCommission.toLocaleString()}\n` +
            `• Unpaid: $${unpaid.toLocaleString()}`;
          await sendTelegramMessage(chatId, msg);
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ Couldn't load revenue: ${e.message}`);
        }
      }

      else if (callbackData === 'brief_pipeline') {
        if (!chatId) {
          await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(queryId, 'Loading…');
        try {
          const refs = await getAllRecords(TABLES.REFERRALS);
          const stages: Record<string, number> = {};
          for (const r of refs as any[]) {
            const status = r['Status'] || 'Unknown';
            stages[status] = (stages[status] || 0) + 1;
          }
          const order = ['Pending Approval', 'Intro Sent', 'Rancher Contacted', 'Negotiation', 'Closed Won', 'Closed Lost', 'Dormant', 'Reassigned'];
          let msg = `📊 <b>Referral Pipeline</b>\n\nTotal: ${refs.length}\n`;
          for (const stage of order) {
            if (stages[stage]) {
              const bar = '█'.repeat(Math.min(stages[stage], 20));
              msg += `\n${stage}: <b>${stages[stage]}</b> ${bar}`;
              delete stages[stage];
            }
          }
          for (const [stage, count] of Object.entries(stages)) {
            if (stage !== 'Unknown') {
              const bar = '█'.repeat(Math.min(count, 20));
              msg += `\n${stage}: <b>${count}</b> ${bar}`;
            }
          }
          await sendTelegramMessage(chatId, msg);
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ Couldn't load pipeline: ${e.message}`);
        }
      }

      // ─── Close-detector check-in callbacks ─────────────────────────────
      // Wired by app/api/cron/close-detector/route.ts which posts daily cards.
      // Format: clcheck_<action>_<referralId>  where action ∈ {won,lost,working,mute}
      // - won: status → Closed Won. Prompts a follow-up text message asking
      //   for sale $ amount which a later turn captures (Phase 0 simplified:
      //   we mark the status and a placeholder amount; sale $ stays human-confirm).
      // - lost: status → Closed Lost
      // - working: leaves status, just resets the "Close Check Sent At" cooldown
      // - mute: marks "Stop Asking" so close-detector skips this referral going forward
      else if (callbackData?.startsWith('clcheck_')) {
        if (!chatId || !messageId) {
          await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
          return NextResponse.json({ ok: true });
        }
        const parts = callbackData.split('_');
        const action = parts[1];
        const refId = parts.slice(2).join('_');
        if (!refId) {
          await answerCallbackQuery(queryId, 'Missing referral ID');
        } else {
          try {
            // Audit log import
            const { logAuditEntry, buildAirtableUpdateReverse } = await import('@/lib/auditLog');
            // Capture previous values for the reverse action
            const before = await getRecordById(TABLES.REFERRALS, refId) as any;
            const previousStatus = before?.['Status'] || null;
            const previousClosedAt = before?.['Closed At'] || null;
            const buyerName = (before?.['Buyer Name'] as string) || '?';
            const reverse = buildAirtableUpdateReverse(TABLES.REFERRALS, refId, {
              'Status': previousStatus,
              'Closed At': previousClosedAt,
            });

            if (action === 'won') {
              // FIX 2026-05-20: previously this immediately flipped Status to
              // Closed Won with no sale amount captured. Ben routinely never
              // followed through on the "reply with $ amount" prompt; deals
              // sat as Closed Won with no Sale Amount + later got patched
              // manually with placeholder values (Ashcraft/Eric Turner: $1
              // placeholder, $95 manually-edited commission → $95 invoice
              // fired on $1 sale = 9500% ratio).
              //
              // New flow: tap Won → DOES NOT change Status. Edits the card
              // with a [BHC:close:refId] marker + asks operator to reply
              // with sale $ amount OR "awaiting" (off-platform close, buyer
              // hasn't paid yet). The reply-to-message intercept above
              // catches replies + processes the actual close.
              await answerCallbackQuery(queryId, '💰 Reply with sale $');
              await editTelegramMessage(
                chatId,
                messageId,
                `💰 <b>Confirming Closed Won</b> — ${buyerName}\n\n` +
                `Reply to <i>this message</i> with the sale dollar amount ` +
                `(e.g. <code>$2400</code>) — I'll fire the invoice automatically.\n\n` +
                `OR reply <code>awaiting</code> if buyer hasn't paid yet ` +
                `(off-platform deal, pay on delivery). Status will move to ` +
                `Awaiting Payment and I'll nudge you in 14 days.\n\n` +
                `[BHC:close:${refId}]`
              );
            } else if (action === 'lost') {
              await answerCallbackQuery(queryId, '❌ Marked Closed Lost');
              await updateRecord(TABLES.REFERRALS, refId, {
                'Status': 'Closed Lost',
                'Closed At': new Date().toISOString(),
              });
              await logAuditEntry({
                actor: 'manual',
                tool: 'clcheck_lost',
                targetType: 'Referral',
                targetId: refId,
                args: { callbackData },
                result: { previousStatus, newStatus: 'Closed Lost' },
                reverseAction: reverse,
              });
              await editTelegramMessage(chatId, messageId, `❌ <b>Closed Lost</b> — ${buyerName}\n\nReferral closed out. Buyer stays in network.`);
            } else if (action === 'working') {
              await answerCallbackQuery(queryId, '⏳ Will check again in 7 days');
              // Just reset the cooldown timestamp — no status change.
              try {
                await updateRecord(TABLES.REFERRALS, refId, {
                  'Close Check Sent At': new Date().toISOString(),
                });
              } catch {}
              await editTelegramMessage(chatId, messageId, `⏳ <b>Still working</b> — ${buyerName}\n\nLeft as ${previousStatus}. I'll check in again in 7 days.`);
            } else if (action === 'mute') {
              await answerCallbackQuery(queryId, '🔇 Muted — won\'t ask again');
              // Mark with a far-future check date so the cron skips forever.
              try {
                await updateRecord(TABLES.REFERRALS, refId, {
                  'Close Check Sent At': '2099-12-31T00:00:00Z',
                });
              } catch {}
              await editTelegramMessage(chatId, messageId, `🔇 <b>Muted</b> — ${buyerName}\n\nClose detector will skip this referral. Mark Won/Lost manually in Airtable when it resolves.`);
            } else {
              await answerCallbackQuery(queryId, `Unknown action: ${action}`);
            }
          } catch (e: any) {
            await answerCallbackQuery(queryId, `⚠️ ${e?.message || 'Failed'}`);
            console.error('[clcheck callback]', e);
          }
        }
      }

      // ─── selfblock_<recordId> ─ block a self-submitted prospect ───────────
      // Fires from the self-submit Telegram alert. Hides the rancher from the
      // public map (Public Map Hidden=true) AND stops the drip cron
      // (Self-Submit Drip Stage=stopped). Used when a fan-flagged rancher
      // turns out to be junk or a real rancher asks to be removed pre-onboarding.
      else if (callbackData?.startsWith('selfblock_')) {
        if (!chatId || !messageId) {
          await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
          return NextResponse.json({ ok: true });
        }
        const recordId = callbackData.slice('selfblock_'.length);
        if (!recordId) {
          await answerCallbackQuery(queryId, 'Missing record ID');
        } else {
          try {
            const { logAuditEntry, buildAirtableUpdateReverse } = await import('@/lib/auditLog');
            const before = await getRecordById(TABLES.RANCHERS, recordId) as any;
            const previousHidden = before?.['Public Map Hidden'] ?? null;
            const previousDripStage = before?.['Self-Submit Drip Stage'] ?? null;
            const reverse = buildAirtableUpdateReverse(TABLES.RANCHERS, recordId, {
              'Public Map Hidden': previousHidden,
              'Self-Submit Drip Stage': previousDripStage,
            });
            await updateRecord(TABLES.RANCHERS, recordId, {
              'Public Map Hidden': true,
              'Self-Submit Drip Stage': 'stopped',
            });
            await logAuditEntry({
              actor: 'manual',
              tool: 'selfblock',
              targetType: 'Rancher',
              targetId: recordId,
              args: { callbackData },
              result: { previousHidden, previousDripStage, newHidden: true, newDripStage: 'stopped' },
              reverseAction: reverse,
            });
            await answerCallbackQuery(queryId, '🚫 Blocked — hidden from map, drip stopped');
            await editTelegramMessage(
              chatId,
              messageId,
              `🚫 <b>Blocked</b>\n\nRecord <code>${recordId}</code> hidden from public map. Drip cron will skip them.`
            );
          } catch (e: any) {
            await answerCallbackQuery(queryId, `⚠️ ${e?.message || 'Block failed'}`);
            console.error('[selfblock callback]', e);
          }
        }
      }

      // ─── First-week founder approval gate (Project 2 — Onboarding Throttle) ──
      // Wired by app/api/warmup/engage/route.ts. When a buyer clicks YES on
      // a warmup email and the in-state rancher is still in their onboarding
      // window (Trust Mode=false AND <5 onboarding intros), engage stages a
      // pending-approval referral and posts a card with these buttons.
      // Format: firstweek_<action>_<referralId>  where action ∈ {approve, hold, skip}
      // - approve: Approval Status → approved, Status → Intro Sent, fire
      //   matching/suggest so the rancher gets the standard intro email,
      //   flip buyer to MATCHED.
      // - hold:    Approval Status → held, stamp "Approval Hold Until" 7d
      //   future (lightweight: we just edit the message + leave the row;
      //   a future cron can re-surface). Buyer stays at READY/WAITING.
      // - skip:    Approval Status → skipped, Status → Closed Lost. Buyer
      //   reverts to WAITING. Future iteration: try next-best rancher.
      else if (callbackData?.startsWith('firstweek_')) {
        if (!chatId || !messageId) {
          await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
          return NextResponse.json({ ok: true });
        }
        const parts = callbackData.split('_');
        const action = parts[1];
        const refId = parts.slice(2).join('_');
        if (!refId) {
          await answerCallbackQuery(queryId, 'Missing referral ID');
        } else {
          try {
            const referral: any = await getRecordById(TABLES.REFERRALS, refId);
            const buyerId = referral?.['Buyer']?.[0] || '';
            const buyerName = referral?.['Buyer Name'] || '?';
            const ranchName = referral?.['Suggested Rancher Name'] || 'rancher';

            if (action === 'approve') {
              await answerCallbackQuery(queryId, '✅ Approved — firing intro');
              const suggestedRancherId = referral?.['Suggested Rancher']?.[0] || '';

              // Flip buyer first so the immediate-route below sees MATCHED.
              if (buyerId) {
                try {
                  await updateRecord(TABLES.CONSUMERS, buyerId, {
                    'Buyer Stage': 'MATCHED',
                    'Buyer Stage Updated At': new Date().toISOString(),
                  });
                } catch {}
              }

              // Flip the staged referral to Approval Status=approved. We
              // leave Status as Pending Approval — matching/suggest is
              // idempotent and will either reuse this row or create the
              // canonical Intro Sent referral.
              try {
                await updateRecord(TABLES.REFERRALS, refId, {
                  'Approval Status': 'approved',
                });
              } catch {}

              // Fire matching/suggest — same path as warmup/engage's
              // immediate-route block. This sends the rancher the intro
              // email and the buyer the buyer-side intro notification.
              if (buyerId) {
                try {
                  const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
                  if (buyer?.['Email'] && buyer?.['State']) {
                    await fetch(`${SITE_URL}/api/matching/suggest`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        ...(INTERNAL_API_SECRET ? { 'x-internal-secret': INTERNAL_API_SECRET } : {}),
                      },
                      body: JSON.stringify({
                        buyerId,
                        buyerState: buyer['State'],
                        buyerName: buyer['Full Name'] || '',
                        buyerEmail: buyer['Email'],
                        buyerPhone: buyer['Phone'] || '',
                        orderType: buyer['Order Type'] || '',
                        budgetRange: buyer['Budget'] || buyer['Budget Range'] || '',
                        intentScore: buyer['Intent Score'] || 0,
                        intentClassification: buyer['Intent Classification'] || '',
                        notes: buyer['Notes'] || '',
                        warmupEngaged: true,
                        // Hint: prefer the rancher we already staged
                        preferredRancherId: suggestedRancherId,
                      }),
                    });
                  }
                } catch (e: any) {
                  console.error('[firstweek approve] matching/suggest failed:', e?.message);
                }
              }

              await editTelegramMessage(
                chatId,
                messageId,
                `✅ <b>Approved</b> — ${buyerName} → ${ranchName}\n\nIntro fired. Rancher will reach out within 24-48h.`
              );
            } else if (action === 'hold') {
              await answerCallbackQuery(queryId, '⏸️ Held — re-queue 7d');
              try {
                const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
                await updateRecord(TABLES.REFERRALS, refId, {
                  'Approval Status': 'held',
                  // Stamp Approved At as the hold-until pointer. Cheap
                  // re-surface signal without adding a new field.
                  'Approved At': future,
                });
              } catch {}
              await editTelegramMessage(
                chatId,
                messageId,
                `⏸️ <b>Held 7 days</b> — ${buyerName} → ${ranchName}\n\nReferral parked. I'll keep the buyer warm and you can revisit next week.`
              );
            } else if (action === 'skip') {
              await answerCallbackQuery(queryId, '⏭️ Skipped');
              try {
                await updateRecord(TABLES.REFERRALS, refId, {
                  'Approval Status': 'skipped',
                  'Status': 'Closed Lost',
                  'Closed At': new Date().toISOString(),
                });
              } catch {}
              if (buyerId) {
                try {
                  await updateRecord(TABLES.CONSUMERS, buyerId, {
                    'Buyer Stage': 'WAITING',
                    'Buyer Stage Updated At': new Date().toISOString(),
                  });
                } catch {}
              }
              await editTelegramMessage(
                chatId,
                messageId,
                `⏭️ <b>Skipped</b> — ${buyerName}\n\nReverted to WAITING. Future iteration can try next-best rancher; for now, manual route via /route.`
              );
            } else {
              await answerCallbackQuery(queryId, `Unknown action: ${action}`);
            }
          } catch (e: any) {
            await answerCallbackQuery(queryId, `⚠️ ${e?.message || 'Failed'}`);
            console.error('[firstweek callback]', e);
          }
        }
      }

      else {
        // Unknown callback — likely from a deploy that removed the handler or a
        // bug in callback_data construction. Log + ack so the button doesn't spin.
        console.warn('[telegram] Unknown callback:', callbackData);
        await answerCallbackQuery(queryId, 'Unknown action');
      }

      return NextResponse.json({ ok: true });
    }

    // ─── Text commands ──────────────────────────────────────────────────────

    if (update.message?.text) {
      const rawText = update.message.text.trim();
      // Normalize new categorized command names → existing handlers (zero-risk aliasing).
      // This lets us reorganize commands without rewriting any handler logic.
      const text = (() => {
        const t = rawText;
        // Multi-word /email subcommands → existing handlers
        if (t === '/email blitz') return '/blitz';
        if (t === '/email checkin') return '/checkin';
        if (t === '/email onboard') return '/bulkonboard';
        if (t === '/email broadcast' || t.startsWith('/email broadcast ')) return '/broadcast' + t.slice('/email broadcast'.length);
        if (t === '/email draft' || t.startsWith('/email draft ')) return '/draft' + t.slice('/email draft'.length);
        // Single-word renames → legacy command name
        if (t === '/leads') return '/pending';
        if (t === '/money') return '/revenue';
        if (t === '/refs') return '/pipeline';
        if (t === '/ranchers') return '/rancherpipeline';
        // Prefix renames (commands with args)
        if (t === '/find' || t.startsWith('/find ')) return '/lookup' + t.slice('/find'.length);
        if (t === '/route' || t.startsWith('/route ')) return '/routestate' + t.slice('/route'.length);
        if (t === '/affiliate' || t.startsWith('/affiliate ')) return '/makeaffiliate' + t.slice('/affiliate'.length);
        return t;
      })();
      const chatId = update.message.chat.id.toString();

      // ─── Close-amount reply intercept (added 2026-05-20) ───────────────────
      // When operator replies to a "💰 Confirming Closed Won" prompt with a
      // dollar amount OR "awaiting", finalize the close. Marker
      // [BHC:close:recXXX] is embedded in the prompt message so we can route
      // the reply back to the right referral without server-side state.
      const repliedTo: any = (update.message as any)?.reply_to_message;
      const repliedText: string = repliedTo?.text || repliedTo?.caption || '';
      const closeMarker = repliedText.match(/\[BHC:close:(rec[A-Za-z0-9]{14})\]/);
      if (closeMarker && !text.startsWith('/')) {
        const refId = closeMarker[1];
        const userReply = text.trim();
        try {
          const ref: any = await getRecordById(TABLES.REFERRALS, refId);
          if (!ref) {
            await sendTelegramMessage(chatId, `⚠️ Referral ${refId} not found.`);
            return NextResponse.json({ ok: true });
          }
          const buyerName = ref['Buyer Name'] || '(unknown)';
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
          if (!rancherId) {
            await sendTelegramMessage(chatId, `⚠️ ${buyerName} has no rancher linked. Fix the referral first.`);
            return NextResponse.json({ ok: true });
          }
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          if (!rancher) {
            await sendTelegramMessage(chatId, `⚠️ Rancher ${rancherId} not found.`);
            return NextResponse.json({ ok: true });
          }
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || '(rancher)';

          // Capacity-freeing transitions need previous-status tracking so we
          // don't double-decrement when operator re-replies to the same prompt.
          // Mirrors logic in app/api/rancher/referrals/[id]/route.ts:312-320.
          const previousStatus = String(ref['Status'] || '');
          const ACTIVE_REF_STATES_FOR_DECREMENT = new Set([
            'Intro Sent',
            'Rancher Contacted',
            'Negotiation',
            'Pending Approval',
          ]);

          // Branch 1: "awaiting" reply → flip to Awaiting Payment + skip invoice
          if (/^(awaiting|pending|later|not paid|not yet|on delivery)\b/i.test(userReply)) {
            await updateRecord(TABLES.REFERRALS, refId, {
              'Status': 'Awaiting Payment',
              'Closed At': new Date().toISOString(),
              // Stamp rancher activity — operator just confirmed close on behalf
              // of rancher; freshness window extends so chasup doesn't kill it.
              'Last Rancher Activity At': new Date().toISOString(),
              'Rancher Engaged Flag': true,
            });

            // Capacity decrement — Awaiting Payment frees the slot per the
            // 2026-05-20 audit. Atomic Redis DECR + Airtable mirror so dashboards
            // and routing both see the new count. Gate prevents double-decrement.
            if (ACTIVE_REF_STATES_FOR_DECREMENT.has(previousStatus)) {
              try {
                const { decrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
                const newCount = await decrementCapacity(rancherId);
                await syncCapacityToAirtable(rancherId, newCount);
              } catch (capErr: any) {
                console.warn('[telegram close-reply awaiting] capacity decrement failed:', capErr?.message);
              }
            }

            await sendTelegramMessage(
              chatId,
              `🕓 <b>Awaiting Payment</b> — ${buyerName} → ${rancherName}\n\n` +
              `Status: Awaiting Payment. Capacity slot freed.\n` +
              `Use the rancher dashboard "Confirm Payment Received" button (or reply /confirmpaid ${refId} $X here) when buyer pays. Invoice fires automatically at that point.\n\n` +
              `I'll nudge you at 14 days if it's still unresolved.`,
            );
            return NextResponse.json({ ok: true });
          }

          // Branch 2: parse a dollar amount → run the full close + invoice flow.
          // Accept $1234 / 1,234 / 1234.56 — strip $ and commas.
          const amountMatch = userReply.replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d{1,2})?)$/);
          if (!amountMatch) {
            await sendTelegramMessage(
              chatId,
              `⚠️ Couldn't parse "${userReply}". Reply with a dollar amount (e.g. <code>$2400</code>) or <code>awaiting</code>. Reply to the original prompt message so I know which referral.`,
            );
            return NextResponse.json({ ok: true });
          }
          const saleAmount = Number(amountMatch[1]);

          // Gate: rancher must have a locked commission rate. Refuse the close
          // until the rate is set on the rancher's record.
          const { hasLockedCommissionRate, calcCommissionForRancher, getRancherCommissionRate } = await import('@/lib/commission');
          if (!hasLockedCommissionRate(rancher)) {
            await sendTelegramMessage(
              chatId,
              `🚫 <b>Refused close</b> — ${rancherName} has no Commission Rate locked.\n\n` +
              `Set <code>Commission Rate</code> on their Rancher row first (e.g. 0.10 for 10%). Then reply again with the sale amount.`,
            );
            return NextResponse.json({ ok: true });
          }

          const commission = calcCommissionForRancher(rancher, saleAmount);
          const rate = getRancherCommissionRate(rancher);

          const closedAtIso = new Date().toISOString();
          await updateRecord(TABLES.REFERRALS, refId, {
            'Status': 'Closed Won',
            'Closed At': closedAtIso,
            'Sale Amount': saleAmount,
            'Commission Due': commission,
            // Stamp rancher activity — extends chasup freshness window so the
            // rancher's other open referrals don't get nuked while they're
            // closing this one.
            'Last Rancher Activity At': closedAtIso,
            'Rancher Engaged Flag': true,
          });

          // ── Capacity decrement (atomic Redis DECR + Airtable mirror) ───────
          // Gate on previous status so a re-reply to the same prompt doesn't
          // double-decrement. Mirrors rancher dashboard PATCH logic.
          let capacityDecremented = false;
          if (ACTIVE_REF_STATES_FOR_DECREMENT.has(previousStatus)) {
            try {
              const { decrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
              const newCount = await decrementCapacity(rancherId);
              await syncCapacityToAirtable(rancherId, newCount);
              capacityDecremented = true;
            } catch (capErr: any) {
              console.warn('[telegram close-reply won] capacity decrement failed:', capErr?.message);
            }
          }

          // ── Flip Consumer Buyer Stage + post-purchase track ────────────────
          // Without this, the buyer stays MATCHED forever and the post-purchase
          // email sequence never starts. Mirrors dashboard PATCH (lines 330-372).
          const buyerIds: string[] = (ref['Buyer'] || []) as string[];
          const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
          let buyerRecord: any = null;
          if (buyerId) {
            try {
              await updateRecord(TABLES.CONSUMERS, buyerId, {
                'Referral Status': 'Closed Won',
                'Sequence Stage': '',
                'Buyer Health': 'Closed Won',
                'Missed Responses': 0,
                'Buyer Stage': 'CLOSED',
                'Buyer Stage Updated At': closedAtIso,
              });
            } catch (e: any) {
              console.error('[telegram close-reply won] Consumer stage flip failed:', e?.message);
            }

            // Fire Day-0 post-purchase welcome email to buyer.
            try {
              buyerRecord = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
              const buyerEmail = buyerRecord?.['Email'] || '';
              const buyerFullName = buyerRecord?.['Full Name'] || '';
              const orderType = buyerRecord?.['Order Type'] || ref['Order Type'] || 'Not Sure';
              if (buyerEmail) {
                const { sendPostPurchaseWelcome } = await import('@/lib/email');
                await sendPostPurchaseWelcome({
                  firstName: (buyerFullName || '').split(' ')[0] || 'there',
                  email: buyerEmail,
                  rancherName,
                  orderType,
                });
              }
            } catch (e: any) {
              console.error('[telegram close-reply won] post-purchase email failed:', e?.message);
            }
          }

          // Fire Stripe invoice. createCommissionInvoice has its own floor +
          // ratio guards (lib/stripe-commission.ts) — they'll throw before we
          // generate a bogus invoice.
          const { createCommissionInvoice } = await import('@/lib/stripe-commission');
          let stripeInvoiceUrl = '';
          let invoiceFailed = false;
          let invoiceErrMsg = '';
          try {
            const result = await createCommissionInvoice({
              rancher: {
                id: rancher.id,
                operatorName: rancherName,
                ranchName: rancher['Ranch Name'] || rancherName,
                email: rancher['Email'] || '',
                stripeCustomerId: rancher['Stripe Customer ID'] || undefined,
              },
              referral: {
                id: refId,
                buyerName,
                orderType: ref['Order Type'] || '',
                saleAmount,
                commissionDue: commission,
              },
            });
            stripeInvoiceUrl = result.invoiceUrl;
            await updateRecord(TABLES.REFERRALS, refId, {
              'Stripe Invoice ID': result.invoiceId,
              'Stripe Invoice URL': result.invoiceUrl,
            });
          } catch (invoiceErr: any) {
            invoiceFailed = true;
            invoiceErrMsg = invoiceErr?.message || 'unknown';
          }

          // ── Instant commission invoice email to rancher (branded) ──────────
          // Mirrors quick-action(won) behavior. Even if Stripe invoice failed,
          // the branded email keeps the rancher informed of the close.
          if (rancher['Email']) {
            try {
              const { sendInstantCommissionInvoice } = await import('@/lib/email');
              await sendInstantCommissionInvoice({
                operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || rancherName,
                ranchName: rancher['Ranch Name'] || '',
                email: rancher['Email'],
                buyerName,
                orderType: ref['Order Type'] || 'Beef order',
                saleAmount,
                commissionDue: commission,
                closedAt: closedAtIso,
                stripeInvoiceUrl: stripeInvoiceUrl || undefined,
              });
            } catch (e: any) {
              console.error('[telegram close-reply won] commission email failed:', e?.message);
            }
          }

          // ── Telegram sale celebration with hydrated stats ──────────────────
          // Replaces the bespoke "🎉 invoice sent" one-liner. Operator sees
          // first-sale milestone, monthly cadence, lifetime totals — same UX
          // as dashboard close and quick-action close.
          try {
            const { sendTelegramSaleCelebration } = await import('@/lib/telegram');
            let isFirstSaleForRancher = false;
            let monthlyWins = 0;
            let monthlyCommission = 0;
            let lifetimeWins = 0;
            let lifetimeCommission = 0;
            try {
              const allRefs = (await getAllRecords(TABLES.REFERRALS)) as any[];
              const wins = allRefs.filter((r: any) => {
                if (r['Status'] !== 'Closed Won') return false;
                const ids = r['Rancher'] || r['Suggested Rancher'] || [];
                return Array.isArray(ids) && ids.includes(rancherId);
              });
              isFirstSaleForRancher = wins.length === 1; // includes the one we just closed
              const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
              const monthWins = wins.filter((r: any) => new Date(r['Closed At'] || 0).getTime() >= monthStart);
              monthlyWins = monthWins.length;
              monthlyCommission = monthWins.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
              lifetimeWins = wins.length;
              lifetimeCommission = wins.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
            } catch (statsErr: any) {
              console.warn('[telegram close-reply won] stats hydration failed:', statsErr?.message);
            }

            await sendTelegramSaleCelebration({
              referralId: refId,
              buyerName,
              rancherName,
              saleAmount,
              commission,
              isFirstSaleForRancher,
              monthlyWins,
              monthlyCommission,
              lifetimeWins,
              lifetimeCommission,
            });
          } catch (celebrErr: any) {
            console.warn('[telegram close-reply won] sale celebration failed:', celebrErr?.message);
          }

          // Operator-facing status line — capacity/invoice/email truthful so
          // we never claim success on a write that didn't land.
          const statusLines: string[] = [];
          statusLines.push(`Sale: <b>$${saleAmount.toLocaleString()}</b>`);
          statusLines.push(`Commission (${(rate * 100).toFixed(1)}%): <b>$${commission.toLocaleString()}</b>`);
          statusLines.push(`Capacity slot: ${capacityDecremented ? '✅ freed' : (ACTIVE_REF_STATES_FOR_DECREMENT.has(previousStatus) ? '⚠️ decrement failed' : 'already free')}`);
          if (invoiceFailed) {
            statusLines.push(`Invoice: ⚠️ failed (${invoiceErrMsg})`);
          } else if (stripeInvoiceUrl) {
            statusLines.push(`Invoice: ${stripeInvoiceUrl}`);
          }
          await sendTelegramMessage(
            chatId,
            `🎉 <b>Closed Won — finalized</b>\n\n` +
            `${buyerName} → ${rancherName}\n` +
            statusLines.join('\n') +
            (invoiceFailed
              ? `\n\nFix the underlying issue and use the dashboard close flow to re-fire the invoice.`
              : `\n\nStripe will email ${rancher['Email'] || 'the rancher'} the hosted invoice. Webhook flips Commission Paid on payment.`),
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ Close-reply handler failed: ${e?.message || 'unknown'}`);
        }
        return NextResponse.json({ ok: true });
      }

      // ─── /setuppage wizard: intercept replies for active sessions ──────────
      const spSession = setupPageSessions.get(chatId);
      if (spSession?.awaitingField && !text.startsWith('/')) {
        const fieldKey = spSession.awaitingField;
        const airtableKey = SP_AIRTABLE_KEY[fieldKey];
        spSession.awaitingField = null;

        try {
          // Convert price fields to numbers
          const priceFields = ['qp', 'hp', 'wp'];
          const value = priceFields.includes(fieldKey) ? (parseFloat(text) || null) : text;
          await updateRecord(TABLES.RANCHERS, spSession.rancherId, { [airtableKey]: value });
          await sendTelegramMessage(chatId, `✅ <b>${SP_FIELD_LABELS[fieldKey]}</b> saved.\n\nWhat's next?`);
          await sendPageMenu(chatId, spSession.rancherId);
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Save failed: ${e.message}. Try again.`);
          await sendPageMenu(chatId, spSession.rancherId);
        }
        return NextResponse.json({ ok: true });
      }

      // ─── /start — proper welcome (no longer aliases /pending) ─────────────
      if (text === '/start') {
        const welcome = `👋 <b>Welcome to BuyHalfCow Bot</b>

I'm your operations assistant — I run the daily ops so you can focus on closing deals and growing the business.

<b>📊 SEE</b> what's happening
/today — Daily brief (numbers + AI priorities)
/leads — Pending consumers awaiting review
/ranchers — Rancher onboarding pipeline
/money — Revenue + commission summary
/find [name or phone] — Search consumers, tap 💬 SMS · 📱 Call · 📧 Email

<b>🎯 DO</b> single actions
/route CO the-high-lonesome-ranch [dry|morning] — Bulk-route stuck buyers
/setuppage [name] — Build a rancher landing page
/affiliate [email] — Make an affiliate
/comp [email] [tier] [#n] [reason] — Comp someone onto Founders Wall (fee waived)

<b>📨 EMAIL</b> bulk sends
/email checkin — Nudge stalled ranchers
/email onboard — Send onboarding docs
/email blitz — Personalized updates to all pipeline ranchers
/email broadcast [seg] [msg] — Quick broadcast
/email draft followup [name] — AI-drafted follow-up
/email draft campaign [seg] [topic] — AI-drafted broadcast

<b>🧠 AI</b> autonomous tasks
/qualify — AI scores pending leads (with approve buttons)
/chasup — AI drafts re-engagement for stalled deals

<b>❓ HELP</b>
/help — This menu

You can also just ask me anything in plain English — I'll figure it out.`;
        await sendTelegramMessage(chatId, welcome);
      }

      else if (text === '/pending') {
        const referrals = await getAllRecords(TABLES.REFERRALS, '{Status} = "Pending Approval"');
        const count = referrals.length;

        if (count === 0) {
          await sendTelegramMessage(chatId, '✅ No pending referrals! All caught up.');
        } else {
          let msg = `📋 <b>${count} Pending Referral${count > 1 ? 's' : ''}</b>\n\n`;
          for (const ref of referrals.slice(0, 10) as any[]) {
            msg += `• ${ref['Buyer Name']} (${ref['Buyer State']}) — ${ref['Intent Classification']} intent\n`;
          }
          if (count > 10) msg += `\n...and ${count - 10} more`;
          msg += '\n\nView all at: ' + SITE_URL + '/admin/referrals';
          await sendTelegramMessage(chatId, msg);
        }
      }

      else if (text === '/stats') {
        const [consumers, ranchers, referrals] = await Promise.all([
          getAllRecords(TABLES.CONSUMERS),
          getAllRecords(TABLES.RANCHERS),
          getAllRecords(TABLES.REFERRALS),
        ]);

        const pending = referrals.filter((r: any) => r['Status'] === 'Pending Approval').length;
        const active = referrals.filter((r: any) =>
          !['Closed Won', 'Closed Lost', 'Dormant', 'Pending Approval'].includes(r['Status'])
        ).length;
        const closedWon = referrals.filter((r: any) => r['Status'] === 'Closed Won');
        const totalCommission = closedWon.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);

        const msg = `📊 <b>BuyHalfCow Stats</b>

👥 Buyers: ${consumers.length}
🤠 Ranchers: ${ranchers.length}
🤝 Total Referrals: ${referrals.length}

⏳ Pending: ${pending}
🔄 Active: ${active}
✅ Closed Won: ${closedWon.length}
💰 Total Commission: $${totalCommission.toLocaleString()}`;

        await sendTelegramMessage(chatId, msg);
      }

      else if (text.startsWith('/capacity')) {
        const ranchers = await getAllRecords(TABLES.RANCHERS);
        const nearCapacity = ranchers.filter((r: any) => {
          const current = r['Current Active Referrals'] || 0;
          const max = getMaxActiveReferrals(r);
          return current >= max * 0.8 && r['Active Status'] === 'Active';
        });

        if (nearCapacity.length === 0) {
          await sendTelegramMessage(chatId, '✅ All ranchers have capacity available.');
        } else {
          let msg = `⚠️ <b>Ranchers Near Capacity</b>\n\n`;
          for (const r of nearCapacity as any[]) {
            msg += `• ${r['Operator Name'] || r['Ranch Name']} — ${r['Current Active Referrals']}/${getMaxActiveReferrals(r)} (${r['State']})\n`;
          }
          await sendTelegramMessage(chatId, msg);
        }
      }

      // /casestudy [rancher-slug-or-name] — generates a copy-paste social
      // blurb for any rancher with closed deals. Pulls live data; safe to
      // run any time. Output is plain-text + emoji so it pastes clean into
      // X / IG captions / LinkedIn / email. No formatting markup.
      else if (text.startsWith('/casestudy')) {
        const query = text.replace('/casestudy', '').trim().toLowerCase();
        if (!query) {
          await sendTelegramMessage(
            chatId,
            'Usage: <code>/casestudy [rancher slug or name]</code>\n\nExample: <code>/casestudy sackett</code> or <code>/casestudy high lonesome</code>'
          );
        } else {
          const [allRanchers, allRefs] = (await Promise.all([
            getAllRecords(TABLES.RANCHERS),
            getAllRecords(TABLES.REFERRALS, '{Status} = "Closed Won"'),
          ])) as [any[], any[]];

          const matched = (allRanchers as any[]).find((r: any) => {
            const slug = (r['Slug'] || '').toString().toLowerCase();
            const name = (r['Ranch Name'] || '').toString().toLowerCase();
            const op = (r['Operator Name'] || '').toString().toLowerCase();
            return slug.includes(query) || name.includes(query) || op.includes(query);
          });

          if (!matched) {
            await sendTelegramMessage(
              chatId,
              `No rancher matched "${text.replace('/casestudy', '').trim()}". Try a slug or part of their name.`
            );
          } else {
            const wins = (allRefs as any[]).filter((ref: any) => {
              const ids = ref['Rancher'] || ref['Suggested Rancher'] || [];
              return Array.isArray(ids) && ids.includes(matched.id);
            });
            const totalGmv = wins.reduce(
              (s: number, r: any) => s + (Number(r['Sale Amount']) || 0),
              0
            );
            const ranchName = matched['Ranch Name'] || matched['Operator Name'] || 'this ranch';
            const state = matched['State'] || '';
            const slug = matched['Slug'] || '';
            const url = `https://www.buyhalfcow.com/ranchers/${slug}`;

            // Find earliest close to compute time-on-platform / time-to-close.
            const earliestClose = wins
              .map((r: any) => r['Closed At'])
              .filter(Boolean)
              .sort()[0];
            const months = earliestClose
              ? Math.max(
                  1,
                  Math.ceil(
                    (Date.now() - new Date(earliestClose).getTime()) /
                      (30 * 24 * 60 * 60 * 1000)
                  )
                )
              : null;

            const blurb =
              `🎯 <b>${ranchName}${state ? ` (${state})` : ''}</b>\n` +
              `${wins.length} closed deal${wins.length !== 1 ? 's' : ''}` +
              (totalGmv ? ` · $${totalGmv.toLocaleString('en-US', { maximumFractionDigits: 0 })} GMV` : '') +
              (months ? ` in ${months} month${months !== 1 ? 's' : ''}` : '') +
              `\n\n${url}\n\n` +
              `<i>Copy-paste anywhere. Pin in marketing.</i>`;

            await sendTelegramMessage(chatId, blurb);
          }
        }
      }

      else if (text === '/today') {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [consumers, ranchers, referrals] = await Promise.all([
          getAllRecords(TABLES.CONSUMERS),
          getAllRecords(TABLES.RANCHERS),
          getAllRecords(TABLES.REFERRALS),
        ]);

        const recentSignups = consumers.filter((c: any) => {
          const created = new Date(c['Created'] || c.createdTime || 0);
          return created >= yesterday;
        });
        const beefSignups = recentSignups.filter((c: any) => c['Segment'] === 'Beef Buyer').length;
        const communitySignups = recentSignups.length - beefSignups;
        const pendingConsumers = consumers.filter((c: any) => (c['Status'] || '').toLowerCase() === 'pending').length;

        const pendingReferrals = referrals.filter((r: any) => r['Status'] === 'Pending Approval').length;
        const recentIntros = referrals.filter((r: any) => {
          const sent = new Date(r['Intro Sent At'] || 0);
          return sent >= yesterday && r['Status'] === 'Intro Sent';
        }).length;

        const monthWins = referrals.filter((r: any) => {
          const closed = new Date(r['Closed At'] || 0);
          return closed >= monthStart && r['Status'] === 'Closed Won';
        });
        const monthCommission = monthWins.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);

        const capacityWarnings = ranchers.filter((r: any) => {
          const cur = r['Current Active Referrals'] || 0;
          const max = getMaxActiveReferrals(r);
          return cur >= max * 0.8 && r['Active Status'] === 'Active';
        }).length;

        const msg = `☀️ <b>Daily Digest</b>
${now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}

<b>Last 24 Hours</b>
👤 New signups: ${recentSignups.length} (🥩 ${beefSignups} beef, 🏷️ ${communitySignups} community)
⏳ Consumers pending review: ${pendingConsumers}
🤝 Intros sent: ${recentIntros}

<b>Pipeline</b>
⏳ Referrals pending approval: ${pendingReferrals}

<b>This Month</b>
✅ Deals closed: ${monthWins.length}
💰 Commission: $${monthCommission.toLocaleString()}

<b>Supply</b>
🤠 Total ranchers: ${ranchers.length}${capacityWarnings > 0 ? `\n⚠️ ${capacityWarnings} rancher(s) near capacity` : '\n✅ All ranchers have capacity'}

👥 Total members: ${consumers.length}`;

        await sendTelegramMessage(chatId, msg);
      }

      // /morning — campaign-aware digest. Bigger surface than /today. Surfaces
      // self-submits, founder backers, throttle approvals, hot leads, deals at risk.
      // Keeps Ben from running 5 commands in the morning.
      else if (text === '/morning') {
        const now = new Date();
        const day = 24 * 60 * 60 * 1000;
        const yesterday = new Date(now.getTime() - day);

        const [consumers, ranchers, referrals] = await Promise.all([
          getAllRecords(TABLES.CONSUMERS),
          getAllRecords(TABLES.RANCHERS),
          getAllRecords(TABLES.REFERRALS),
        ]);

        const recentSelfSubmits = ranchers.filter((r: any) => {
          const at = r['Self-Submitted At'];
          return at && new Date(at) >= yesterday;
        });

        const recentFounders = consumers.filter((c: any) => {
          const subAt = c['Subscribed At'];
          return subAt && new Date(subAt) >= yesterday && c['Founder Tier'];
        });
        const founderRevenue24h = recentFounders.reduce(
          (s: number, c: any) => s + (Number(c['Tier Amount Paid']) || 0),
          0
        );

        const founding100Count = consumers.filter(
          (c: any) => c['Founder Tier'] === 'Founding 100'
        ).length;
        const titleFounderCount = consumers.filter(
          (c: any) => c['Founder Tier'] === 'Title Founder'
        ).length;

        // BUG-FIX (2026-05-13): was filtering r['Approval Status'] but
        // matching/suggest only sets r['Status']='Pending Approval'. The
        // 'Approval Status' field is set by warmup/engage only — so the
        // /morning command reported 0 pending all the time even when the
        // queue was full. daily-digest + /pending already use Status.
        const pendingApprovals = referrals.filter(
          (r: any) => r['Status'] === 'Pending Approval'
        );

        const hotLeads = consumers.filter((c: any) => {
          const intent = Number(c['Intent Score']) || 0;
          const status = (c['Status'] || '').toLowerCase();
          return intent >= 80 && (status === 'pending' || status === 'new' || !status);
        });

        const sevenDays = 7 * day;
        const dealsAtRisk = referrals.filter((r: any) => {
          const status = r['Status'];
          if (!['Intro Sent', 'Rancher Contacted', 'Negotiation'].includes(status)) return false;
          const last = new Date(
            r['Last Updated'] || r['Intro Sent At'] || r['Created'] || 0
          ).getTime();
          return now.getTime() - last >= sevenDays;
        });

        const lines = [
          `🌅 <b>Morning brief</b> — ${now.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          })}`,
          '',
          '<b>Movement (last 24h)</b>',
          `🟡 Self-submits: ${recentSelfSubmits.length}${
            recentSelfSubmits.length
              ? ' — ' +
                recentSelfSubmits
                  .slice(0, 5)
                  .map((r: any) => r['Ranch Name'] || '?')
                  .join(', ')
              : ''
          }`,
          `🪙 New founders: ${recentFounders.length} ($${founderRevenue24h.toLocaleString()})`,
          '',
          '<b>Funnel</b>',
          `🔥 Hot leads waiting: ${hotLeads.length}`,
          `🛂 Throttle approvals pending: ${pendingApprovals.length}`,
          `⏳ Deals at risk (7d+ stale): ${dealsAtRisk.length}`,
          '',
          '<b>Founding Herd live counts</b>',
          `Founding 100: ${founding100Count}/100`,
          `Title Founder: ${titleFounderCount}/10`,
          '',
          '<i>Tap commands: /pending · /capacity · /pipeline · /revenue</i>',
        ];

        await sendTelegramMessage(chatId, lines.join('\n'));
      }

      else if (text.startsWith('/lookup') || text.startsWith('/find') || text.startsWith('/buyer')) {
        const query = text.replace(/^\/(lookup|find|buyer)/, '').trim();
        if (!query) {
          await sendTelegramMessage(chatId, 'Usage: <code>/find name or email</code>\n\nReturns contact info with tap-to-SMS warmup links for each match.');
        } else {
          const consumers = await getAllRecords(TABLES.CONSUMERS);
          const q = query.toLowerCase();
          const matches = consumers.filter((c: any) => {
            const name = (c['Full Name'] || '').toLowerCase();
            const email = (c['Email'] || '').toLowerCase();
            const phone = (c['Phone'] || '').toLowerCase();
            return name.includes(q) || email.includes(q) || phone.includes(q);
          });

          if (matches.length === 0) {
            await sendTelegramMessage(chatId, `🔍 No consumers found for "<b>${query}</b>"`);
          } else {
            let msg = `🔍 <b>${matches.length} result${matches.length > 1 ? 's' : ''}</b> for "${query}"\n`;
            for (const c of matches.slice(0, 5) as any[]) {
              const segEmoji = c['Segment']?.name === 'Beef Buyer' || c['Segment'] === 'Beef Buyer' ? '🥩' : '🏷️';
              const statusEmoji = (c['Status']?.name || c['Status'] || '').toLowerCase() === 'approved' ? '✅' : '⏳';
              const fullName = c['Full Name'] || 'Unknown';
              const firstName = fullName.split(' ')[0] || 'there';
              const state = c['State'] || '';
              const phone = (c['Phone'] || '').replace(/[^\d+]/g, '');
              const email = c['Email'] || '';
              const refStatus = c['Referral Status']?.name || c['Referral Status'] || 'N/A';
              const warmup = c['Warmup Stage']?.name || c['Warmup Stage'] || '';

              msg += `\n${statusEmoji} <b>${fullName}</b> ${segEmoji}`;
              if (state) msg += ` · ${state}`;
              msg += `\n   Intent: ${c['Intent Score'] || 0} | Referral: ${refStatus}`;
              if (warmup) msg += ` | Warmup: ${warmup}`;
              msg += `\n`;

              // Build tap-through links for mobile: sms: / tel: / mailto:
              const contactLinks: string[] = [];
              if (phone) {
                const smsBody = `Hi ${firstName}, Ben from BuyHalfCow. Circling back — we're getting ranchers live in ${state || 'your state'}. Still want to get matched? Reply YES if yes.`;
                contactLinks.push(`<a href="sms:${phone}?&body=${encodeURIComponent(smsBody)}">💬 SMS</a>`);
                contactLinks.push(`<a href="tel:${phone}">📱 Call</a>`);
              }
              if (email) {
                contactLinks.push(`<a href="mailto:${email}?subject=${encodeURIComponent('Following up — BuyHalfCow')}">📧 Email</a>`);
              }
              if (contactLinks.length > 0) msg += `   ${contactLinks.join(' · ')}\n`;
              if (email) msg += `   <code>${email}</code>\n`;
              if (phone) msg += `   <code>${phone}</code>\n`;
            }
            if (matches.length > 5) msg += `\n...and ${matches.length - 5} more`;
            msg += `\n<i>Tap any link above to open your phone's native app.</i>`;
            await sendTelegramMessage(chatId, msg);
          }
        }
      }

      else if (text === '/revenue') {
        const referrals = await getAllRecords(TABLES.REFERRALS);
        const closedWon = referrals.filter((r: any) => r['Status'] === 'Closed Won');

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

        const thisMonthDeals = closedWon.filter((r: any) => new Date(r['Closed At'] || 0) >= monthStart);
        const lastMonthDeals = closedWon.filter((r: any) => {
          const d = new Date(r['Closed At'] || 0);
          return d >= lastMonthStart && d < monthStart;
        });

        const totalSales = closedWon.reduce((s: number, r: any) => s + (r['Sale Amount'] || 0), 0);
        const totalCommission = closedWon.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
        const paidCommission = closedWon.filter((r: any) => r['Commission Paid']).reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
        const outstanding = totalCommission - paidCommission;

        const thisMonthCommission = thisMonthDeals.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
        const lastMonthCommission = lastMonthDeals.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);

        const msg = `💰 <b>Revenue Summary</b>

<b>All Time</b>
✅ Deals closed: ${closedWon.length}
💵 Total sales: $${totalSales.toLocaleString()}
📊 Total commission: $${totalCommission.toLocaleString()}
✅ Collected: $${paidCommission.toLocaleString()}
⏳ Outstanding: $${outstanding.toLocaleString()}

<b>This Month</b>
✅ Deals: ${thisMonthDeals.length}
💰 Commission: $${thisMonthCommission.toLocaleString()}

<b>Last Month</b>
✅ Deals: ${lastMonthDeals.length}
💰 Commission: $${lastMonthCommission.toLocaleString()}`;

        await sendTelegramMessage(chatId, msg);
      }

      else if (text === '/pipeline') {
        const referrals = await getAllRecords(TABLES.REFERRALS);

        const stages: Record<string, number> = {};
        for (const r of referrals as any[]) {
          const status = r['Status'] || 'Unknown';
          stages[status] = (stages[status] || 0) + 1;
        }

        const order = ['Pending Approval', 'Intro Sent', 'Rancher Contacted', 'Negotiation', 'Closed Won', 'Closed Lost', 'Dormant', 'Reassigned'];
        let msg = `📊 <b>Referral Pipeline</b>\n\nTotal: ${referrals.length}\n`;

        for (const stage of order) {
          if (stages[stage]) {
            const bar = '█'.repeat(Math.min(stages[stage], 20));
            msg += `\n${stage}: <b>${stages[stage]}</b> ${bar}`;
            delete stages[stage];
          }
        }
        for (const [stage, count] of Object.entries(stages)) {
          if (stage !== 'Unknown') {
            const bar = '█'.repeat(Math.min(count, 20));
            msg += `\n${stage}: <b>${count}</b> ${bar}`;
          }
        }

        await sendTelegramMessage(chatId, msg);
      }

      else if (text.startsWith('/broadcast')) {
        const parts = text.replace('/broadcast', '').trim();
        const firstSpace = parts.indexOf(' ');
        if (firstSpace === -1 || !parts) {
          await sendTelegramMessage(chatId, `Usage: <code>/broadcast [segment] [message]</code>\n\nSegments: <b>beef</b>, <b>community</b>, <b>all</b>, <b>ranchers</b>\n\nExample:\n<code>/broadcast beef New ranchers in Texas!</code>`);
        } else {
          const segment = parts.substring(0, firstSpace).toLowerCase();
          const messageBody = parts.substring(firstSpace + 1).trim();

          const segmentMap: Record<string, string> = {
            beef: 'consumers-beef',
            community: 'consumers-community',
            all: 'consumers',
            ranchers: 'ranchers',
          };

          const audienceType = segmentMap[segment];
          if (!audienceType) {
            await sendTelegramMessage(chatId, `❌ Unknown segment "<b>${segment}</b>". Use: beef, community, all, or ranchers`);
          } else {
            const segLabel = segment === 'beef' ? 'Beef Buyers' : segment === 'community' ? 'Community' : segment === 'ranchers' ? 'Ranchers' : 'All Consumers';

            const keyboard = {
              inline_keyboard: [
                [
                  { text: `✅ Send to ${segLabel}`, callback_data: `bcsend_${audienceType}_${Buffer.from(messageBody).toString('base64').substring(0, 40)}` },
                  { text: '❌ Cancel', callback_data: 'bccancel' },
                ],
              ],
            };

            await sendTelegramMessage(chatId, `📧 <b>Broadcast Preview</b>\n\n<b>To:</b> ${segLabel}\n<b>Message:</b>\n${messageBody}\n\nConfirm send?`, keyboard);
          }
        }
      }

      // ─── NEW: /qualify — AI Lead Analyst ─────────────────────────────────

      // ─── /ask — AI with tool use (L3a) ───────────────────────────────────
      // Lets Ben ask anything in plain English. AI uses read-only tools to
      // investigate the business state and answer with current data.
      else if (text === '/ask' || text.startsWith('/ask ')) {
        const question = text.replace(/^\/ask\s*/, '').trim();
        if (!question) {
          await sendTelegramMessage(chatId, `🤔 <b>Usage:</b> <code>/ask [question]</code>\n\nExamples:\n• /ask which buyers in CO are still unmatched?\n• /ask how much commission is unpaid?\n• /ask is anyone near capacity right now?\n• /ask find Mandi`);
          return NextResponse.json({ ok: true });
        }

        if (!process.env.GROQ_API_KEY && !process.env.ANTHROPIC_API_KEY) {
          await sendTelegramMessage(chatId, '⚠️ /ask requires GROQ_API_KEY or ANTHROPIC_API_KEY.');
          return NextResponse.json({ ok: true });
        }

        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        }).catch(() => {});

        try {
          const { callClaudeWithTools } = await import('@/lib/ai');
          const { text: answer, toolCalls } = await callClaudeWithTools({
            model: 'claude-sonnet-4-6',
            system: `You are Ben's AI assistant for BuyHalfCow. You have access to read-only tools to query the business state. Answer the user's question by calling tools to get fresh data, then summarize concisely. Always cite specific names, numbers, and IDs from the data. If the question is vague, make a reasonable assumption and proceed — don't ask for clarification.`,
            user: question,
            maxTokens: 2048,
            maxIterations: 6,
          });

          const cleaned = (answer || '(no answer)')
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.*?)\*/g, '<i>$1</i>')
            .replace(/`(.*?)`/g, '<code>$1</code>');

          const toolSummary = toolCalls.length > 0
            ? `\n\n<i>🔧 used ${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''}: ${toolCalls.map(t => t.name).join(', ')}</i>`
            : '';

          await sendTelegramMessage(chatId, `🧠 <b>Answer</b>\n\n${cleaned}${toolSummary}`);

          // If the AI staged any email drafts, surface each one with confirm buttons
          for (const tc of toolCalls) {
            if (tc.name === 'draft_email_for_consumer' && tc.output?.requiresConfirmation) {
              const draftMsg = `✉️ <b>AI DRAFTED EMAIL</b>\n\n<b>To:</b> ${tc.output.consumerName} &lt;${tc.output.consumerEmail}&gt;\n<b>Subject:</b> ${tc.output.subject}\n\n${tc.output.body}`;
              const keyboard = {
                inline_keyboard: [[
                  { text: '📧 Send Now', callback_data: `draftfollowup_send_${tc.output.consumerId}` },
                  { text: '⏰ Tomorrow', callback_data: `draftfollowup_sched_${tc.output.consumerId}` },
                  { text: '🗑️ Discard', callback_data: `draftfollowup_disc_${tc.output.consumerId}` },
                ]],
              };
              await sendTelegramMessage(chatId, draftMsg, keyboard);
            }
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /ask failed: ${e.message}`);
        }
      }

      // ─── /scout — autonomous business sweep (L3b) ────────────────────────
      // AI investigates the entire business state via tool calls and produces
      // a prioritized action list. Designed to be run on demand or by cron.
      else if (text === '/scout') {
        if (!AI_CONFIGURED) {
          await sendTelegramMessage(chatId, '⚠️ AI not configured. Set OLLAMA_BASE_URL, GROQ_API_KEY, or ANTHROPIC_API_KEY.');
          return NextResponse.json({ ok: true });
        }

        await sendTelegramMessage(chatId, '🔍 <b>Scouting…</b> AI is sweeping the business now. Hang on ~30s.');

        try {
          // Pre-fetch all data in parallel (no tool-use loop needed = works with free AI)
          const { runTool } = await import('@/lib/aiTools');
          const [pending, stalledRefs, revenue, capacity, unmatched] = await Promise.all([
            runTool('get_pending_consumers', { limit: 20 }),
            runTool('get_stalled_referrals', { minDays: 5, limit: 20 }),
            runTool('get_revenue_summary', {}),
            runTool('get_rancher_capacity', { onlyNearCapacity: false }),
            runTool('get_unmatched_buyers', { limit: 30 }),
          ]);

          const dataBlock = `
PENDING CONSUMERS (Status=Pending, awaiting approval):
${JSON.stringify(pending, null, 2)}

STALLED REFERRALS (5+ days no movement):
${JSON.stringify(stalledRefs, null, 2)}

REVENUE SUMMARY:
${JSON.stringify(revenue, null, 2)}

RANCHER CAPACITY:
${JSON.stringify(capacity, null, 2)}

UNMATCHED BEEF BUYERS (approved but no referral):
${JSON.stringify(unmatched, null, 2)}`;

          const report = await callClaude({
            system: `You are Ben's AI business operator for BuyHalfCow. You have been given a fresh data dump of the entire business state. Analyze it and produce a prioritized action list. Be specific — cite real names, numbers, and IDs from the data. Do NOT ask for more data.`,
            user: `Here is the current BuyHalfCow business state:\n${dataBlock}\n\nProduce your report in this exact format:

🎯 TOP PRIORITY (do today)
1. [specific action with name/ID]
2. [specific action]
3. [specific action]

⚠️ AT RISK
• [specific concerns with names/numbers]

✅ ALL GOOD
• [things that are healthy, brief]

📊 BY THE NUMBERS
• Pending: X | Stalled: X | Unmatched buyers: X
• This month: $X commission, X deals
• Capacity: X/Y ranchers near full

Be specific and concise. No fluff.`,
            maxTokens: 2048,
          });

          const cleaned = (report || '(no report)')
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.*?)\*/g, '<i>$1</i>')
            .replace(/`(.*?)`/g, '<code>$1</code>');

          await sendTelegramMessage(
            chatId,
            `🔍 <b>SCOUT REPORT</b>\n\n${cleaned}`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /scout failed: ${e.message}`);
        }
      }

      // /qualify was a manual AI-assisted approval flow for Pending consumers.
      // Auto-killed: consumer signup is now instant-approve at the form (see
      // /api/consumers) with a qualification gate that controls who gets
      // matched to a rancher. No human review needed. Dead command returns
      // a helpful redirect for any muscle-memory typers.
      else if (text === '/qualify') {
        await sendTelegramMessage(chatId, '✅ /qualify is retired. All signups now auto-approve at submit, with qualification gating which buyers reach ranchers. Use /leads to see recent signups or /scout for the full business sweep.');
      }

      // ─── NEW: /brief — AI Business Brief ─────────────────────────────────

      else if (text === '/brief') {
        if (!AI_CONFIGURED) {
          await sendTelegramMessage(chatId, '⚠️ AI not configured. Set OLLAMA_BASE_URL or ANTHROPIC_API_KEY.');
          return NextResponse.json({ ok: true });
        }

        await sendTelegramMessage(chatId, '🤖 Generating your business brief...');

        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const DAY_MS = 24 * 60 * 60 * 1000;

        const [consumers, ranchers, referrals] = await Promise.all([
          getAllRecords(TABLES.CONSUMERS),
          getAllRecords(TABLES.RANCHERS),
          getAllRecords(TABLES.REFERRALS),
        ]);

        const recentSignups = consumers.filter((c: any) => new Date(c['Created'] || c.createdTime || 0) >= yesterday).length;
        const pendingConsumers = consumers.filter((c: any) => (c['Status'] || '').toLowerCase() === 'pending').length;
        const pendingReferrals = referrals.filter((r: any) => r['Status'] === 'Pending Approval').length;
        const stalledReferrals = (referrals as any[]).filter(r => {
          if (!['Intro Sent', 'Rancher Contacted'].includes(r['Status'])) return false;
          const last = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
          return last && (Date.now() - new Date(last).getTime()) >= 5 * DAY_MS;
        }).length;
        const monthWins = referrals.filter((r: any) => new Date(r['Closed At'] || 0) >= monthStart && r['Status'] === 'Closed Won');
        const monthCommission = monthWins.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
        const capacityWarnings = ranchers.filter((r: any) => {
          const cur = r['Current Active Referrals'] || 0;
          const max = getMaxActiveReferrals(r);
          return cur >= max * 0.8 && r['Active Status'] === 'Active';
        }).length;

        const aiPrompt = `Today's BuyHalfCow business data:
- New signups (24h): ${recentSignups}
- Consumers pending review: ${pendingConsumers}
- Referrals pending approval: ${pendingReferrals}
- Stalled referrals (5+ days no update): ${stalledReferrals}
- Near-capacity ranchers: ${capacityWarnings}
- Deals closed this month: ${monthWins.length}, commission: $${monthCommission.toLocaleString()}
- Total members: ${consumers.length}, total ranchers: ${ranchers.length}

Output exactly this format:
TOP 3 PRIORITIES:
1. [specific action]
2. [specific action]
3. [specific action]

AT RISK:
• [1-2 bullets]

SUGGESTED ACTIONS:
• [3 bullets in priority order]`;

        try {
          const aiResponse = await callClaude({
            model: 'claude-haiku-4-5-20251001',
            system: `You are Ben's AI business assistant for BuyHalfCow. Be concise and actionable.`,
            user: aiPrompt,
            maxTokens: 600,
          });

          const briefMsg = `🤖 <b>AI Business Brief</b>
${now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}

${aiResponse
  .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
  .replace(/^(TOP 3 PRIORITIES:|AT RISK:|SUGGESTED ACTIONS:)/gm, '<b>$1</b>')}`;

          await sendTelegramMessage(chatId, briefMsg);
        } catch (err: any) {
          await sendTelegramMessage(chatId, `⚠️ AI brief failed: ${err.message}`);
        }
      }

      // ─── NEW: /chasup — Referral Chase-Up ────────────────────────────────

      else if (text === '/chasup') {
        if (!AI_CONFIGURED) {
          await sendTelegramMessage(chatId, '⚠️ AI not configured. Set OLLAMA_BASE_URL or ANTHROPIC_API_KEY.');
          return NextResponse.json({ ok: true });
        }
        await runChasupCheck(chatId);
      }

      // ─── NEW: /draft — AI Email Drafter ──────────────────────────────────

      else if (text.startsWith('/draft')) {
        if (!AI_CONFIGURED) {
          await sendTelegramMessage(chatId, '⚠️ AI not configured. Set OLLAMA_BASE_URL or ANTHROPIC_API_KEY.');
          return NextResponse.json({ ok: true });
        }

        const args = text.replace('/draft', '').trim();
        const [subCmd, ...rest] = args.split(' ');

        if (!subCmd) {
          await sendTelegramMessage(chatId, `Usage:
<code>/draft followup [name or email]</code> — Draft personalized follow-up for a consumer
<code>/draft campaign [segment] [topic]</code> — Draft broadcast email for a segment

Segments: beef, community, all, ranchers`);
          return NextResponse.json({ ok: true });
        }

        if (subCmd === 'followup') {
          const query = rest.join(' ').trim();
          if (!query) {
            await sendTelegramMessage(chatId, 'Usage: <code>/draft followup [name or email]</code>');
            return NextResponse.json({ ok: true });
          }

          // Look up consumer
          const consumers = await getAllRecords(TABLES.CONSUMERS);
          const q = query.toLowerCase();
          const match = (consumers as any[]).find(c =>
            (c['Full Name'] || '').toLowerCase().includes(q) ||
            (c['Email'] || '').toLowerCase().includes(q)
          );

          if (!match) {
            await sendTelegramMessage(chatId, `🔍 No consumer found for "<b>${query}</b>". Try /lookup first.`);
            return NextResponse.json({ ok: true });
          }

          await sendTelegramMessage(chatId, `✍️ Drafting personalized follow-up for <b>${match['Full Name']}</b>...`);

          const draftPrompt = `Draft a personalized follow-up email to this BuyHalfCow member. Warm, direct, on-brand. Do NOT include a greeting line with their name — start from the second paragraph. End with a clear next step.

Consumer: ${match['Full Name']}, ${match['State']}
Segment: ${match['Segment'] || 'Unknown'}
Status: ${match['Status'] || 'Unknown'}
Referral Status: ${match['Referral Status'] || 'None'}
Order Type: ${match['Order Type'] || 'Not specified'}, Budget: ${match['Budget'] || match['Budget Range'] || 'Not specified'}
Intent Score: ${match['Intent Score'] || 0} (${match['Intent Classification'] || 'Unknown'})
Notes: ${match['Notes'] || 'None'}

Output in exactly this format:
SUBJECT: [subject line]
BODY:
[email body — 3 short paragraphs, no greeting, signed by Benjamin]`;

          try {
            const response = await callClaude({
              model: 'claude-sonnet-4-6',
              system: BHC_SYSTEM_PROMPT,
              user: draftPrompt,
              maxTokens: 800,
            });

            const subjectMatch = response.match(/SUBJECT:\s*(.+)/i);
            const bodyMatch = response.match(/BODY:\s*([\s\S]+)/i);
            const subject = subjectMatch?.[1]?.trim() || 'A note from BuyHalfCow';
            const body = bodyMatch?.[1]?.trim() || response;

            // Store draft in Airtable
            await updateRecord(TABLES.CONSUMERS, match.id, {
              'AI Email Draft': body,
              'AI Email Draft Subject': subject,
            });

            const preview = body.length > 300 ? body.substring(0, 300) + '...' : body;

            const previewMsg = `✍️ <b>EMAIL DRAFT</b>

👤 To: ${escHtml(match['Full Name'])} (${escHtml(match['Email'])})
📌 Subject: <b>${escHtml(subject)}</b>

<i>${escHtml(preview)}</i>`;

            const keyboard = {
              inline_keyboard: [[
                { text: '📧 Send Now', callback_data: `draftfollowup_send_${match.id}` },
                { text: '⏰ Tomorrow', callback_data: `draftfollowup_sched_${match.id}` },
                { text: '🗑️ Discard', callback_data: `draftfollowup_disc_${match.id}` },
              ]],
            };

            await sendTelegramMessage(chatId, previewMsg, keyboard);
          } catch (err: any) {
            await sendTelegramMessage(chatId, `⚠️ Draft failed: ${err.message}`);
          }
        }

        else if (subCmd === 'campaign') {
          const segment = rest[0]?.toLowerCase() || '';
          const topic = rest.slice(1).join(' ').trim();

          const segmentMap: Record<string, string> = {
            beef: 'consumers-beef',
            community: 'consumers-community',
            all: 'consumers',
            ranchers: 'ranchers',
          };
          const audienceType = segmentMap[segment];

          if (!audienceType || !topic) {
            await sendTelegramMessage(chatId, `Usage: <code>/draft campaign [segment] [topic]</code>\n\nExample: <code>/draft campaign beef Summer rancher availability</code>`);
            return NextResponse.json({ ok: true });
          }

          const segLabel = segment === 'beef' ? 'Beef Buyers' : segment === 'community' ? 'Community members' : segment === 'ranchers' ? 'Ranchers' : 'All members';
          await sendTelegramMessage(chatId, `✍️ Drafting campaign email for <b>${segLabel}</b> about: ${topic}...`);

          const draftPrompt = `Draft a broadcast email for BuyHalfCow's ${segLabel}. Topic: ${topic}. Keep it under 200 words, on-brand, action-oriented. Signed by Benjamin.

Output in exactly this format:
SUBJECT: [subject line]
BODY:
[email body — plain paragraphs, no HTML tags]`;

          try {
            const response = await callClaude({
              model: 'claude-sonnet-4-6',
              system: BHC_SYSTEM_PROMPT,
              user: draftPrompt,
              maxTokens: 600,
            });

            const subjectMatch = response.match(/SUBJECT:\s*(.+)/i);
            const bodyMatch = response.match(/BODY:\s*([\s\S]+)/i);
            const subject = subjectMatch?.[1]?.trim() || topic;
            const body = bodyMatch?.[1]?.trim() || response;

            const preview = body.length > 300 ? body.substring(0, 300) + '...' : body;

            const previewMsg = `📧 <b>CAMPAIGN DRAFT</b>

<b>To:</b> ${segLabel}
📌 <b>Subject:</b> ${subject}

<i>${preview}</i>

Confirm send?`;

            const keyboard = {
              inline_keyboard: [[
                { text: `✅ Send to ${segLabel}`, callback_data: `bcsend_${audienceType}_${Buffer.from(body).toString('base64').substring(0, 40)}` },
                { text: '❌ Cancel', callback_data: 'bccancel' },
              ]],
            };

            await sendTelegramMessage(chatId, previewMsg, keyboard);
          } catch (err: any) {
            await sendTelegramMessage(chatId, `⚠️ Draft failed: ${err.message}`);
          }
        }

        else {
          await sendTelegramMessage(chatId, `Unknown draft type "<b>${subCmd}</b>". Use: followup or campaign`);
        }
      }

      // ─── /makeaffiliate ───────────────────────────────────────────────────

      else if (text.startsWith('/makeaffiliate')) {
        const emailArg = text.replace('/makeaffiliate', '').trim();
        if (!emailArg) {
          await sendTelegramMessage(chatId, `Usage: <code>/makeaffiliate email@example.com</code>\n\nLooks up the consumer and makes them an affiliate with a unique referral link.`);
          return NextResponse.json({ ok: true });
        }

        await sendTelegramMessage(chatId, `🔍 Looking up <code>${emailArg}</code>...`);

        try {
          // Look up consumer to get their name
          const consumers = await getAllRecords(TABLES.CONSUMERS,
            `LOWER({Email}) = "${emailArg.toLowerCase()}"`
          );
          const consumer = consumers[0] as any;
          const name = consumer ? (consumer['Full Name'] || emailArg) : emailArg;

          const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
          const res = await fetch(`${siteUrl}/api/admin/affiliates`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cookie': `bhc-admin-auth=authenticated`,
            },
            body: JSON.stringify({ name, email: emailArg }),
          });
          const data = await res.json();

          if (data.success || data.exists) {
            const status = data.exists ? '⚠️ Already an affiliate' : '✅ Affiliate created';
            await sendTelegramMessage(chatId,
              `${status}\n\n👤 <b>${name}</b>\n📧 ${emailArg}\n\n🔑 Code: <code>${data.code}</code>\n\n🛒 Buyer link:\n<code>${data.buyerLink || `${siteUrl}/access?ref=${data.code}`}</code>\n\n${data.exists ? '' : '📧 Welcome email sent!'}`
            );
          } else {
            await sendTelegramMessage(chatId, `❌ Failed: ${data.error}`);
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
        }
      }

      // ─── /setuppage — Rancher Landing Page Wizard ─────────────────────────

      else if (text.startsWith('/setuppage')) {
        const query = text.replace('/setuppage', '').trim();
        if (!query) {
          await sendTelegramMessage(chatId, `Usage: <code>/setuppage [ranch name or email]</code>\n\nExample: <code>/setuppage Rocking R Ranch</code>`);
          return NextResponse.json({ ok: true });
        }

        await sendTelegramMessage(chatId, `🔍 Looking up <b>${query}</b>...`);

        try {
          const ranchers = await getAllRecords(TABLES.RANCHERS);
          const q = query.toLowerCase();
          const match = (ranchers as any[]).find(r =>
            (r['Ranch Name'] || '').toLowerCase().includes(q) ||
            (r['Operator Name'] || '').toLowerCase().includes(q) ||
            (r['Email'] || '').toLowerCase().includes(q)
          );

          if (!match) {
            await sendTelegramMessage(chatId, `❌ No rancher found for "<b>${query}</b>". Check spelling or use their email.`);
            return NextResponse.json({ ok: true });
          }

          const name = match['Ranch Name'] || match['Operator Name'] || 'Unknown Ranch';
          // Store session
          setupPageSessions.set(chatId, {
            rancherId: match.id,
            rancherName: name,
            awaitingField: null,
          });

          await sendPageMenu(chatId, match.id);
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
        }
      }

      // ─── /routestate — Bulk-route stuck buyers in a state to a specific rancher ──
      // Usage: /routestate CO the-high-lonesome-ranch              (real run, sends emails now)
      //        /routestate CO the-high-lonesome-ranch dry          (dry run, no writes/emails)
      //        /routestate CO the-high-lonesome-ranch morning      (real run, emails scheduled for 9am MT tomorrow)
      else if (text.startsWith('/routestate')) {
        const args = text.replace('/routestate', '').trim().split(/\s+/).filter(Boolean);
        if (args.length < 2) {
          await sendTelegramMessage(
            chatId,
            `Usage: <code>/routestate STATE rancher-slug [dry|morning]</code>\n\n` +
            `Examples:\n` +
            `<code>/routestate CO the-high-lonesome-ranch dry</code> — preview\n` +
            `<code>/routestate CO the-high-lonesome-ranch morning</code> — fire, emails arrive 9am MT tomorrow\n` +
            `<code>/routestate UT the-high-lonesome-ranch</code> — fire, emails go now`
          );
          return NextResponse.json({ ok: true });
        }
        const stateArg = args[0].toUpperCase();
        const slugArg = args[1];
        const mode = (args[2] || '').toLowerCase();
        const dryRun = mode === 'dry';
        const morning = mode === 'morning';

        let scheduledAt: string | undefined;
        if (morning) {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() + 1);
          d.setUTCHours(15, 0, 0, 0); // 9am MT (MDT) = 15:00 UTC
          scheduledAt = d.toISOString();
        }

        await sendTelegramMessage(
          chatId,
          `🔄 ${dryRun ? 'Dry-running' : 'Routing'} <b>${stateArg}</b> → <b>${slugArg}</b>${morning ? ' (emails scheduled for 9am MT tomorrow)' : ''}...`
        );

        try {
          const result = await bulkRouteStateToRancher({
            state: stateArg,
            rancherSlug: slugArg,
            dryRun,
            scheduledAt,
          });

          if (!result.ok) {
            await sendTelegramMessage(chatId, `❌ ${result.error}`);
            return NextResponse.json({ ok: true });
          }

          const s = result.summary;
          const headline = dryRun ? '🔍 <b>DRY RUN</b>' : '🚀 <b>ROUTED</b>';
          await sendTelegramMessage(
            chatId,
            `${headline}\n\n` +
            `${s.state} → ${s.targetRancher}\n` +
            (scheduledAt ? `📅 Emails scheduled: ${new Date(scheduledAt).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' })} MT\n\n` : `\n`) +
            `📊 Total approved buyers: ${s.totalConsumers}\n` +
            `✅ Processed: ${s.processed}\n` +
            `⏭ Skipped (already intro'd): ${s.skipped_already_intro_sent}\n` +
            `🔄 Updated stuck refs: ${s.updated_stuck_referral}\n` +
            `🆕 New refs: ${s.created_new_referral}\n` +
            `🗑 Canceled dupes: ${s.canceled_duplicates}\n` +
            (dryRun
              ? `\n<i>Dry run — no Airtable writes, no emails sent. Run again without "dry" to fire.</i>`
              : `\n📧 Rancher emails: ${s.emails_sent_rancher}\n📧 Buyer emails: ${s.emails_sent_buyer}`) +
            `\n${s.errors.length > 0 ? `\n⚠️ Errors: ${s.errors.length}\n${s.errors.slice(0, 3).join('\n')}` : ''}`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
        }
      }

      // ─── /rancherpipeline — Show all ranchers by onboarding stage ──────
      else if (text === '/rancherpipeline' || text === '/rp') {
        try {
          const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];

          // Group by onboarding status
          const stages: Record<string, any[]> = {};
          for (const r of allRanchers) {
            const status = r['Onboarding Status'] || r['Active Status'] || 'No Status';
            if (!stages[status]) stages[status] = [];
            stages[status].push(r);
          }

          const stageOrder = ['Live', 'Agreement Signed', 'Verification Complete', 'Verification Pending', 'Docs Sent', 'Approved', 'Pending', 'Inactive', 'No Status'];
          const stageEmoji: Record<string, string> = {
            'Live': '🟢', 'Agreement Signed': '📝', 'Verification Complete': '✅',
            'Verification Pending': '🔍', 'Docs Sent': '📦', 'Approved': '👍',
            'Pending': '⏳', 'Inactive': '🔴', 'No Status': '❓',
          };

          let msg = `🤠 <b>Rancher Pipeline</b> — ${allRanchers.length} total\n`;

          for (const stage of stageOrder) {
            if (!stages[stage]) continue;
            const emoji = stageEmoji[stage] || '📋';
            msg += `\n${emoji} <b>${stage}</b> (${stages[stage].length})\n`;
            for (const r of stages[stage]) {
              const name = r['Operator Name'] || r['Ranch Name'] || 'Unknown';
              const state = r['State'] || '';
              const email = r['Email'] || '';
              const lastCheckin = r['Last Check In'] ? ` | Last check-in: ${new Date(r['Last Check In']).toLocaleDateString()}` : '';
              msg += `  • ${name}${state ? ` (${state})` : ''}${lastCheckin}\n`;
            }
            delete stages[stage];
          }

          // Any stages not in our order
          for (const [stage, ranchers] of Object.entries(stages)) {
            msg += `\n📋 <b>${stage}</b> (${ranchers.length})\n`;
            for (const r of ranchers) {
              const name = r['Operator Name'] || r['Ranch Name'] || 'Unknown';
              msg += `  • ${name} (${r['State'] || ''})\n`;
            }
          }

          // Truncate if needed for Telegram 4096 char limit
          if (msg.length > 4000) {
            msg = msg.substring(0, 3950) + '\n\n<i>...truncated. Use /checkin to take action.</i>';
          }

          await sendTelegramMessage(chatId, msg);
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
        }
      }

      // ─── /checkin — Bulk send check-in emails to stalled ranchers ──────
      else if (text === '/checkin') {
        try {
          const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];

          // Find ranchers who are in the pipeline but stalled
          // (not Live, not Inactive, not Rejected, have an email)
          const stalled = allRanchers.filter((r: any) => {
            const status = r['Active Status'] || '';
            const onboarding = r['Onboarding Status'] || '';
            const email = r['Email'] || '';
            const pageLive = r['Page Live'] || false;

            // Skip if already live, inactive, rejected, or no email
            if (pageLive) return false;
            if (['Suspended', 'Rejected'].includes(status)) return false;
            if (!email) return false;
            // Skip if they already responded recently (within 7 days)
            if (r['Last Check In']) {
              const lastCheckin = new Date(r['Last Check In']);
              const daysSince = (Date.now() - lastCheckin.getTime()) / (1000 * 60 * 60 * 24);
              if (daysSince < 7) return false;
            }
            return true;
          });

          if (stalled.length === 0) {
            await sendTelegramMessage(chatId, '✅ No stalled ranchers to check in with — everyone is either live or responded recently.');
            return NextResponse.json({ ok: true });
          }

          // Show preview with confirm button
          let preview = `📧 <b>Rancher Check-In</b>\n\nReady to send check-in emails to <b>${stalled.length} ranchers</b>:\n\n`;
          for (const r of stalled.slice(0, 15)) {
            const name = r['Operator Name'] || r['Ranch Name'] || 'Unknown';
            const status = r['Onboarding Status'] || r['Active Status'] || 'Unknown';
            preview += `• ${name} — ${status}\n`;
          }
          if (stalled.length > 15) {
            preview += `\n<i>...and ${stalled.length - 15} more</i>`;
          }
          preview += `\n\nEach rancher gets 3 buttons:\n✅ "I'm still in"\n📞 "I have questions"\n🔴 "Not interested"`;

          const keyboard = {
            inline_keyboard: [
              [
                { text: `✅ Send to ${stalled.length} ranchers`, callback_data: 'rcheckin_send' },
                { text: '❌ Cancel', callback_data: 'rcheckin_cancel' },
              ],
            ],
          };

          await sendTelegramMessage(chatId, preview, keyboard);
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
        }
      }

      // ── /blitz — bulk pipeline update emails to all non-live ranchers ──
      else if (text === '/blitz') {
        try {
          const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
          const pipeline = allRanchers.filter((r: any) => {
            const onboarding = r['Onboarding Status'] || '';
            const active = r['Active Status'] || '';
            const email = r['Email'] || '';
            if (!email) return false;
            if (['Suspended', 'Rejected'].includes(active)) return false;
            if (onboarding === 'Live') return false;
            return true;
          });

          if (pipeline.length === 0) {
            await sendTelegramMessage(chatId, '✅ No pipeline ranchers to blitz — everyone is either live or has no email.');
          } else {
            // Group by stage for preview
            const byStage: Record<string, string[]> = {};
            for (const r of pipeline) {
              const stage = r['Onboarding Status'] || 'New Applicant';
              if (!byStage[stage]) byStage[stage] = [];
              byStage[stage].push(r['Operator Name'] || r['Ranch Name'] || 'Unknown');
            }

            const stageEmoji: Record<string, string> = {
              'New Applicant': '📬', 'Call Scheduled': '📅', 'Call Complete': '📞',
              'Docs Sent': '📄', 'Agreement Signed': '✍️', 'Verification Pending': '🔬',
              'Verification Complete': '✅',
            };

            let preview = `🚀 <b>PIPELINE BLITZ</b>\n\n${pipeline.length} ranchers will receive personalized update emails:\n\n`;
            for (const [stage, names] of Object.entries(byStage)) {
              const emoji = stageEmoji[stage] || '⏳';
              preview += `${emoji} <b>${stage}</b> (${names.length})\n`;
              for (const n of names.slice(0, 5)) {
                preview += `  • ${escHtml(n)}\n`;
              }
              if (names.length > 5) preview += `  ... and ${names.length - 5} more\n`;
              preview += '\n';
            }

            preview += `Each rancher gets a <b>stage-specific email</b> with their exact next step and a direct action link.\n\nSend now?`;

            const keyboard = {
              inline_keyboard: [
                [
                  { text: `🚀 Send to ${pipeline.length} ranchers`, callback_data: 'blitz_send' },
                  { text: '❌ Cancel', callback_data: 'blitz_cancel' },
                ],
              ],
            };

            await sendTelegramMessage(chatId, preview, keyboard);
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
        }
      }

      // ── /bulkonboard — bulk send onboarding docs to all who haven't received them ──
      else if (text === '/bulkonboard') {
        try {
          const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
          const eligible = allRanchers.filter((r: any) => {
            const status = r['Onboarding Status'] || '';
            const active = r['Active Status'] || '';
            const email = r['Email'] || '';
            if (!email) return false;
            if (['Suspended', 'Rejected'].includes(active)) return false;
            if (['Docs Sent', 'Agreement Signed', 'Verification Pending', 'Verification Complete', 'Live'].includes(status)) return false;
            return true;
          });

          if (eligible.length === 0) {
            await sendTelegramMessage(chatId, '✅ All ranchers have already received onboarding docs.');
          } else {
            let preview = `📦 <b>BULK ONBOARD</b>\n\n${eligible.length} ranchers have NOT received onboarding docs yet:\n\n`;
            for (const r of eligible.slice(0, 15)) {
              const name = r['Operator Name'] || r['Ranch Name'] || 'Unknown';
              const state = r['State'] || '?';
              const status = r['Onboarding Status'] || 'New';
              preview += `• ${escHtml(name)} (${state}) — ${status}\n`;
            }
            if (eligible.length > 15) preview += `... and ${eligible.length - 15} more\n`;

            preview += `\nEach will receive:\n• Commission Agreement\n• Media Agreement\n• Rancher Info Packet\n• 30-day signing link\n\nSend now?`;

            const keyboard = {
              inline_keyboard: [
                [
                  { text: `📦 Send to ${eligible.length} ranchers`, callback_data: 'bulkonboard_send' },
                  { text: '❌ Cancel', callback_data: 'bulkonboard_cancel' },
                ],
              ],
            };

            await sendTelegramMessage(chatId, preview, keyboard);
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
        }
      }

      else if (text === '/status') {
        try {
          await sendTelegramMessage(chatId, '🔍 Running health checks...');
          const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
          const cronSecret = process.env.CRON_SECRET || '';
          const res = await fetch(`${SITE_URL}/api/health?secret=${encodeURIComponent(cronSecret)}`);
          const data = await res.json();
          const checks = data.checks || {};
          const icon = (ok: boolean) => ok ? '✅' : '❌';
          const ms = (c: any) => c?.ok ? `${c.ms}ms` : (c?.error || 'failed');
          const statusIcon = data.status === 'healthy' ? '🟢' : data.status === 'degraded' ? '🟡' : '🔴';
          await sendTelegramMessage(chatId,
            `${statusIcon} <b>System Status: ${(data.status || 'unknown').toUpperCase()}</b>\n\n` +
            `${icon(checks.airtable?.ok)} Airtable — ${ms(checks.airtable)}\n` +
            `${icon(checks.resend?.ok)} Resend — ${ms(checks.resend)}\n` +
            `${icon(checks.telegram?.ok)} Telegram — ${ms(checks.telegram)}\n` +
            `${icon(checks.ai?.ok)} AI — ${ms(checks.ai)}`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `❌ Health check failed: ${e.message}`);
        }
      }

      // ─── /pause [slug] — stop sending leads to a rancher ────────────────
      // Use cases: rancher is on vacation, processing month, sick, or just
      // backed up. Flips Active Status from 'Active' to 'Paused'. The matching
      // engine already filters on Active Status === 'Active', so paused ranchers
      // immediately stop receiving new leads but their existing pipeline stays.
      else if (text.startsWith('/pause ')) {
        const arg = text.replace(/^\/pause\s+/, '').trim();
        if (!arg) {
          await sendTelegramMessage(chatId, '⚠️ Usage: <code>/pause [rancher-slug]</code>');
          return NextResponse.json({ ok: true });
        }
        try {
          const all = await getAllRecords(TABLES.RANCHERS) as any[];
          const target = all.find((r) => (r['Slug'] || '').toLowerCase() === arg.toLowerCase()
            || (r['Operator Name'] || '').toLowerCase().includes(arg.toLowerCase())
            || (r['Ranch Name'] || '').toLowerCase().includes(arg.toLowerCase()));
          if (!target) {
            await sendTelegramMessage(chatId, `⚠️ No rancher matching "${arg}"`);
            return NextResponse.json({ ok: true });
          }
          await updateRecord(TABLES.RANCHERS, target.id, { 'Active Status': 'Paused' });
          await sendTelegramMessage(
            chatId,
            `⏸ <b>PAUSED</b> ${target['Operator Name'] || target['Ranch Name']}\n\nThey'll stop receiving new leads. Existing pipeline unchanged.\nResume with: <code>/resume ${target['Slug'] || arg}</code>`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /pause failed: ${e.message}`);
        }
      }

      // ─── /resume [slug] — re-activate a paused rancher ──────────────────
      else if (text.startsWith('/resume ')) {
        const arg = text.replace(/^\/resume\s+/, '').trim();
        if (!arg) {
          await sendTelegramMessage(chatId, '⚠️ Usage: <code>/resume [rancher-slug]</code>');
          return NextResponse.json({ ok: true });
        }
        try {
          const all = await getAllRecords(TABLES.RANCHERS) as any[];
          const target = all.find((r) => (r['Slug'] || '').toLowerCase() === arg.toLowerCase()
            || (r['Operator Name'] || '').toLowerCase().includes(arg.toLowerCase())
            || (r['Ranch Name'] || '').toLowerCase().includes(arg.toLowerCase()));
          if (!target) {
            await sendTelegramMessage(chatId, `⚠️ No rancher matching "${arg}"`);
            return NextResponse.json({ ok: true });
          }
          await updateRecord(TABLES.RANCHERS, target.id, { 'Active Status': 'Active' });
          triggerLaunchWarmup(`telegram-resume:${target.id}`);
          await sendTelegramMessage(
            chatId,
            `▶️ <b>RESUMED</b> ${target['Operator Name'] || target['Ranch Name']}\n\nNew leads will start flowing. Waitlisted buyers in their state are being warmed up now.`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /resume failed: ${e.message}`);
        }
      }

      // ─── /blast [STATE] [message] — quick broadcast to a state segment ──
      // Sends an immediate email blast to all approved Beef Buyers in the given
      // state. Hits the same suppression check + footer as every other email.
      // Cap at 100 recipients per blast to protect deliverability.
      else if (text.startsWith('/blast ')) {
        const rest = text.replace(/^\/blast\s+/, '').trim();
        const match = rest.match(/^([A-Za-z]{2})\s+(.+)$/);
        if (!match) {
          await sendTelegramMessage(chatId, '⚠️ Usage: <code>/blast [STATE] [message]</code>\nExample: <code>/blast TX New rancher live in Texas — reply if you want a Half this month.</code>');
          return NextResponse.json({ ok: true });
        }
        const [, stateRaw, messageBody] = match;
        const { normalizeState } = await import('@/lib/states');
        const stateCode = normalizeState(stateRaw);
        if (!stateCode) {
          await sendTelegramMessage(chatId, `⚠️ "${stateRaw}" isn't a recognized US state code.`);
          return NextResponse.json({ ok: true });
        }
        try {
          const consumers = await getAllRecords(
            TABLES.CONSUMERS,
            `AND({Status} = "Approved", {State} = "${stateCode}")`
          ) as any[];
          const recipients = consumers
            .filter((c: any) => !c['Unsubscribed'] && !c['Bounced'] && !c['Complained'])
            .filter((c: any) => (c['Email'] || '').includes('@'))
            .slice(0, 100);
          if (recipients.length === 0) {
            await sendTelegramMessage(chatId, `📭 No mailable approved buyers in ${stateCode}.`);
            return NextResponse.json({ ok: true });
          }
          await sendTelegramMessage(chatId, `📨 Sending to ${recipients.length} buyers in ${stateCode}…`);
          let sent = 0; let failed = 0;
          for (const c of recipients) {
            try {
              const firstName = (c['Full Name'] || '').split(' ')[0] || 'there';
              await sendEmail({
                to: c['Email'].trim().toLowerCase(),
                subject: `Quick update from BuyHalfCow`,
                html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:30px;background:white;border:1px solid #A7A29A;">
                  <p style="color:#0E0E0E;">Hi ${firstName},</p>
                  ${messageBody.split('\n').filter(Boolean).map((p: string) => `<p style="color:#6B4F3F;">${escHtml(p)}</p>`).join('')}
                  <p style="color:#6B4F3F;margin-top:24px;">— Benjamin, BuyHalfCow</p>
                </div>`,
              });
              sent++;
            } catch {
              failed++;
            }
          }
          await sendTelegramMessage(
            chatId,
            `✅ <b>BLAST DONE</b> (${stateCode})\n\n📨 Sent: ${sent}\n❌ Failed: ${failed}`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /blast failed: ${e.message}`);
        }
      }

      // ─── Cron + Operator surface (added 2026-05-19) ─────────────────────
      // Six commands that surface what the crons actually did + let Ben
      // intervene without opening Airtable or the codebase.

      // /cronstatus, /runs — last 24h cron run status (with missing-run alerts)
      else if (text === '/cronstatus' || text === '/runs') {
        try {
          const card = await buildCronStatusCard();
          await sendTelegramMessage(chatId, `<b>Cron Runs · Last 24h</b>\n\n${card}`);
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /cronstatus failed: ${e?.message || 'unknown'}`);
        }
      }

      // /bulkfire — promote every Pending Approval referral to Intro Sent
      // + fire intro emails to buyer + rancher. Clears the gate-staged
      // backlog in one tap. Caps at 50 per run for safety.
      else if (text === '/bulkfire') {
        try {
          const all = (await getAllRecords(TABLES.REFERRALS)) as any[];
          const stuck = all.filter((r: any) => r['Status'] === 'Pending Approval').slice(0, 50);
          if (stuck.length === 0) {
            await sendTelegramMessage(chatId, '✅ No Pending Approval referrals to fire.');
          } else {
            let fired = 0;
            let errored = 0;
            for (const ref of stuck) {
              try {
                const rancherId = ref['Rancher']?.[0] || ref['Suggested Rancher']?.[0];
                if (!rancherId) { errored++; continue; }
                const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
                if (!rancher) { errored++; continue; }
                const rancherEmail = rancher['Email'];
                const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
                const buyerName = ref['Buyer Name'] || 'Buyer';
                const buyerEmail = ref['Buyer Email'] || '';
                const buyerPhone = ref['Buyer Phone'] || '';
                const buyerState = ref['Buyer State'] || '';
                const orderType = ref['Order Type'] || '';
                const budgetRange = ref['Budget Range'] || '';
                const notes = ref['Notes'] || '';

                if (rancherEmail) {
                  await sendBuyerIntroNotification({
                    firstName: buyerName.split(' ')[0] || 'there',
                    email: buyerEmail,
                    rancherName,
                    rancherEmail,
                    rancherPhone: rancher['Phone'] || '',
                    rancherSlug: rancher['Slug'] || '',
                    loginUrl: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com'}/member`,
                    quarterPrice: Number(rancher['Quarter Price']) || undefined,
                    quarterLbs: rancher['Quarter lbs'] || '',
                    halfPrice: Number(rancher['Half Price']) || undefined,
                    halfLbs: rancher['Half lbs'] || '',
                    wholePrice: Number(rancher['Whole Price']) || undefined,
                    wholeLbs: rancher['Whole lbs'] || '',
                    nextProcessingDate: rancher['Next Processing Date'] || '',
                  }).catch((e: any) => console.error('[bulkfire] buyer intro failed:', e?.message));

                  await sendEmail({
                    to: rancherEmail,
                    subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
                    html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
<h1 style="font-family:Georgia,serif;">New buyer lead</h1>
<p>Hi ${rancherName},</p>
<p>New buyer matched to you on BuyHalfCow. Reach out today:</p>
<div style="background:#F4F1EC;padding:20px;margin:20px 0;">
  <p><strong>Buyer:</strong> ${buyerName}</p>
  <p><strong>Email:</strong> ${buyerEmail}</p>
  <p><strong>Phone:</strong> ${buyerPhone}</p>
  <p><strong>Location:</strong> ${buyerState}</p>
  <p><strong>Order:</strong> ${orderType}</p>
  <p><strong>Budget:</strong> ${budgetRange}</p>
  ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
</div>
<p>— Ben, BuyHalfCow</p>
</body></html>`,
                  }).catch((e: any) => console.error('[bulkfire] rancher intro failed:', e?.message));
                }

                await updateRecord(TABLES.REFERRALS, ref.id, {
                  'Status': 'Intro Sent',
                  'Approval Status': 'approved',
                  'Intro Sent At': new Date().toISOString(),
                });
                fired++;
              } catch (e: any) {
                console.error('[bulkfire] referral failed:', e?.message);
                errored++;
              }
            }
            await sendTelegramMessage(
              chatId,
              `🔥 <b>BULK FIRE COMPLETE</b>\n\nPromoted <b>${fired}</b> Pending Approval → Intro Sent\nErrors: ${errored}\n\nBuyers + ranchers both got intro emails.`,
            );
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /bulkfire failed: ${e?.message || 'unknown'}`);
        }
      }

      // /routingstatus, /segments — buyer routing-segment breakdown.
      // Lets the operator see how the 1500+ Consumers funnel splits: how
      // many are MATCH_NOW (ready, in-state rancher) vs OUT_OF_STATE_FOUNDER_PITCH
      // (high-intent but no rancher) vs UNQUALIFIED_NURTURE. Drives the
      // decision about where to push manual energy + which states to recruit.
      else if (text === '/routingstatus' || text === '/segments') {
        try {
          const consumers = (await getAllRecords(TABLES.CONSUMERS)) as any[];
          const counts: Record<string, number> = {};
          for (const c of consumers) {
            const seg = c['Routing Segment'];
            const name =
              typeof seg === 'object' && seg !== null && 'name' in seg
                ? String((seg as any).name || '')
                : String(seg || '');
            const key = name || 'UNCLASSIFIED';
            counts[key] = (counts[key] || 0) + 1;
          }
          const total = consumers.length;
          const lines = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}: <b>${v}</b> (${Math.round((v / total) * 100)}%)`);
          await sendTelegramMessage(
            chatId,
            `<b>📊 Routing Status · ${total} buyers</b>\n\n${lines.join('\n')}\n\nReclassifies nightly at 04:00 UTC via <code>reclassify-buyers</code> cron.`,
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /routingstatus failed: ${e?.message || 'unknown'}`);
        }
      }

      // /pausecron <name> — pause a cron from firing until /resumecron
      else if (text.startsWith('/pausecron ')) {
        const name = text.slice('/pausecron '.length).trim();
        if (!name) {
          await sendTelegramMessage(chatId, 'Usage: <code>/pausecron &lt;cron-name&gt;</code>');
        } else {
          try {
            await pauseCron(name, 'telegram', 'paused via Telegram');
            await sendTelegramMessage(chatId, `⏸️ Paused <code>${name}</code>. Use <code>/resumecron ${name}</code> to resume.`);
          } catch (e: any) {
            await sendTelegramMessage(chatId, `⚠️ Pause failed: ${e?.message || 'unknown'}`);
          }
        }
      }

      // /resumecron <name> — clear a paused state
      else if (text.startsWith('/resumecron ')) {
        const name = text.slice('/resumecron '.length).trim();
        if (!name) {
          await sendTelegramMessage(chatId, 'Usage: <code>/resumecron &lt;cron-name&gt;</code>');
        } else {
          try {
            await resumeCron(name);
            await sendTelegramMessage(chatId, `▶️ Resumed <code>${name}</code>.`);
          } catch (e: any) {
            await sendTelegramMessage(chatId, `⚠️ Resume failed: ${e?.message || 'unknown'}`);
          }
        }
      }

      // /emaillog <email-or-name> — show last 30d of emails sent to a Consumer.
      else if (text.startsWith('/emaillog ')) {
        const arg = text.slice('/emaillog '.length).trim().toLowerCase();
        if (!arg) {
          await sendTelegramMessage(chatId, 'Usage: <code>/emaillog &lt;email&gt;</code>');
        } else {
          try {
            const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
            const sinceISO = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
            const safeArg = arg.replace(/"/g, '');
            const sends = (await getAllRecords(
              TABLES.EMAIL_SENDS,
              `AND(LOWER({Recipient Email})="${safeArg}", {Sent At} > "${sinceISO}")`,
            )) as any[];
            if (sends.length === 0) {
              await sendTelegramMessage(chatId, `📭 No emails sent to <code>${arg}</code> in last 30d.`);
            } else {
              const sorted = sends.sort((a, b) =>
                new Date(b['Sent At']).getTime() - new Date(a['Sent At']).getTime()
              ).slice(0, 30);
              const lines = sorted.map((s: any) => {
                const ts = new Date(s['Sent At']).toISOString().slice(0, 16).replace('T', ' ');
                const status = (s['Status'] || '').toString();
                const tag = status === 'sent' ? '✅' : status === 'suppressed' ? '⏸️' : '⚠️';
                return `${tag} ${ts} · <b>${s['Template Name'] || '?'}</b>${s['Suppression Reason'] ? ` (${s['Suppression Reason']})` : ''}`;
              });
              const sentCount = sends.filter((s: any) => s['Status'] === 'sent').length;
              const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
              const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;
              const last7d = sends.filter((s: any) =>
                new Date(s['Sent At']).getTime() > sevenDaysAgo && s['Status'] === 'sent'
              ).length;
              await sendTelegramMessage(
                chatId,
                `📧 <b>EMAIL LOG</b> · ${arg}\n\n` +
                `Past 30d: ${sentCount} sent, ${sends.length - sentCount} suppressed\n` +
                `Past 7d: ${last7d} sent\n\n` +
                lines.join('\n')
              );
            }
          } catch (e: any) {
            await sendTelegramMessage(chatId, `⚠️ /emaillog failed: ${e?.message || 'unknown'}`);
          }
        }
      }

      // /pausemail <template-name> — kill a specific email template
      else if (text.startsWith('/pausemail ')) {
        const name = text.slice('/pausemail '.length).trim();
        if (!name) {
          await sendTelegramMessage(chatId, 'Usage: <code>/pausemail &lt;template-name&gt;</code>\n\nExample: <code>/pausemail sendRancherCheckIn</code>');
        } else {
          try {
            await pauseCron(name, 'telegram', 'paused via /pausemail');
            await sendTelegramMessage(chatId, `⏸️ Paused email template <code>${name}</code>. Use <code>/resumemail ${name}</code> to resume.`);
          } catch (e: any) {
            await sendTelegramMessage(chatId, `⚠️ /pausemail failed: ${e?.message || 'unknown'}`);
          }
        }
      }

      // /resumemail <template-name> — re-enable a template
      else if (text.startsWith('/resumemail ')) {
        const name = text.slice('/resumemail '.length).trim();
        if (!name) {
          await sendTelegramMessage(chatId, 'Usage: <code>/resumemail &lt;template-name&gt;</code>');
        } else {
          try {
            await resumeCron(name);
            await sendTelegramMessage(chatId, `▶️ Resumed email template <code>${name}</code>.`);
          } catch (e: any) {
            await sendTelegramMessage(chatId, `⚠️ /resumemail failed: ${e?.message || 'unknown'}`);
          }
        }
      }

      // /freqcap <number> | show — global rolling 7d cap per Consumer
      else if (text === '/freqcap show' || text === '/freqcap') {
        const cap = process.env.EMAIL_FREQUENCY_CAP_PER_WEEK || '10 (default)';
        await sendTelegramMessage(
          chatId,
          `<b>Frequency cap</b>: ${cap} emails/Consumer/7d\n\n` +
          `Change via Vercel env var <code>EMAIL_FREQUENCY_CAP_PER_WEEK</code> + redeploy.\n` +
          `Transactional templates (invoices, intros, approvals) bypass the cap.`
        );
      }

      // /templatestats — per-template send count last 30 days
      else if (text === '/templatestats') {
        try {
          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          const sinceISO = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
          const sends = (await getAllRecords(
            TABLES.EMAIL_SENDS,
            `{Sent At} > "${sinceISO}"`,
          )) as any[];
          const byTemplate: Record<string, { sent: number; suppressed: number }> = {};
          for (const s of sends) {
            const t = String(s['Template Name'] || '?');
            byTemplate[t] = byTemplate[t] || { sent: 0, suppressed: 0 };
            if (s['Status'] === 'sent') byTemplate[t].sent++;
            else if (s['Status'] === 'suppressed') byTemplate[t].suppressed++;
          }
          const ranked = Object.entries(byTemplate)
            .sort((a, b) => b[1].sent - a[1].sent)
            .slice(0, 25);
          const lines = ranked.map(([t, v]) =>
            `${v.sent.toString().padStart(4)} sent${v.suppressed > 0 ? ` · ${v.suppressed} supp` : ''}  ${t}`
          );
          await sendTelegramMessage(
            chatId,
            `📈 <b>TEMPLATE STATS</b> · Last 30 days\n\n` +
            `<pre>${lines.join('\n')}</pre>\n\n` +
            `Open/click data not yet wired (Phase 2 via Resend webhooks).`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /templatestats failed: ${e?.message || 'unknown'}`);
        }
      }

      // /whatfired today | yesterday | YYYY-MM-DD — daily activity summary
      else if (text.startsWith('/whatfired')) {
        const arg = text.slice('/whatfired'.length).trim() || 'today';
        try {
          let targetDate: Date;
          if (arg === 'today') targetDate = new Date();
          else if (arg === 'yesterday') targetDate = new Date(Date.now() - 86400000);
          else targetDate = new Date(arg);
          if (isNaN(targetDate.getTime())) {
            await sendTelegramMessage(chatId, 'Usage: <code>/whatfired today</code> or <code>/whatfired yesterday</code> or <code>/whatfired YYYY-MM-DD</code>');
            return NextResponse.json({ ok: true });
          }
          const dayStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
          const dayEnd = new Date(dayStart.getTime() + 86400000);
          const [cronRuns, sends] = await Promise.all([
            getAllRecords(
              TABLES.CRON_RUNS,
              `AND({Started At} >= "${dayStart.toISOString()}", {Started At} < "${dayEnd.toISOString()}")`,
            ) as Promise<any[]>,
            getAllRecords(
              TABLES.EMAIL_SENDS,
              `AND({Sent At} >= "${dayStart.toISOString()}", {Sent At} < "${dayEnd.toISOString()}")`,
            ) as Promise<any[]>,
          ]);
          const cronByName: Record<string, { count: number; lastStatus: string }> = {};
          for (const c of cronRuns) {
            const n = String(c['Name'] || '?');
            cronByName[n] = cronByName[n] || { count: 0, lastStatus: '' };
            cronByName[n].count++;
            cronByName[n].lastStatus = String(c['Status'] || '');
          }
          const sendsByTemplate: Record<string, number> = {};
          for (const s of sends) {
            if (s['Status'] !== 'sent') continue;
            const t = String(s['Template Name'] || '?');
            sendsByTemplate[t] = (sendsByTemplate[t] || 0) + 1;
          }
          const cronLines = Object.entries(cronByName).map(([n, v]) =>
            `${v.lastStatus === 'success' ? '✅' : v.lastStatus === 'partial' ? '🟡' : v.lastStatus === 'paused' ? '⏸️' : '❌'} ${n} (×${v.count})`
          );
          const sendLines = Object.entries(sendsByTemplate)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([t, n]) => `${n}× ${t}`);
          await sendTelegramMessage(
            chatId,
            `🤖 <b>WHAT FIRED</b> · ${dayStart.toISOString().slice(0, 10)}\n\n` +
            `<b>Crons (${cronRuns.length} runs)</b>:\n${cronLines.join('\n') || 'none'}\n\n` +
            `<b>Emails sent (${sends.filter(s => s['Status'] === 'sent').length} total)</b>:\n${sendLines.join('\n') || 'none'}`
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /whatfired failed: ${e?.message || 'unknown'}`);
        }
      }

      // /match <buyer-search> <rancher-search> — interactive buyer-to-rancher
      // direct routing w/ fuzzy name search + inline confirm button.
      //
      // Example: "/match katie renick" → finds Katie Hunter (or whoever
      // matches "katie") + Renick Valley Meats (matches "renick") → shows
      // a confirmation card w/ ✅ Fire intro / ❌ Cancel buttons. Tap to
      // create Pending Approval + fire intro emails to both sides.
      //
      // Single command, two fuzzy args. If ambiguous, returns top 3 of
      // each w/ instructions. Always shows the chosen match before firing.
      else if (text.startsWith('/match ')) {
        const rest = text.slice('/match '.length).trim();
        const parts = rest.split(/\s+/);
        if (parts.length < 2) {
          await sendTelegramMessage(chatId, 'Usage: <code>/match &lt;buyer-search&gt; &lt;rancher-search&gt;</code>\n\nExample: <code>/match katie renick</code>\n\nFuzzy matches buyer name/email + rancher name/operator. Returns confirm card.');
        } else {
          // Take everything as 2 args — last word = rancher, rest = buyer.
          // Allows multi-word buyer names like "katie hunter".
          const rancherSearch = parts[parts.length - 1].toLowerCase();
          const buyerSearch = parts.slice(0, -1).join(' ').toLowerCase();
          try {
            const [allBuyers, allRanchers] = await Promise.all([
              getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
              getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
            ]);
            const buyerMatches = allBuyers.filter((b: any) => {
              const name = String(b['Full Name'] || '').toLowerCase();
              const email = String(b['Email'] || '').toLowerCase();
              return name.includes(buyerSearch) || email.includes(buyerSearch);
            });
            const rancherMatches = allRanchers.filter((r: any) => {
              const name = String(r['Ranch Name'] || '').toLowerCase();
              const op = String(r['Operator Name'] || '').toLowerCase();
              const slug = String(r['Slug'] || '').toLowerCase();
              return (name.includes(rancherSearch) || op.includes(rancherSearch) || slug.includes(rancherSearch))
                && r['Active Status'] === 'Active'
                && r['Agreement Signed'] === true;
            });

            if (buyerMatches.length === 0) {
              await sendTelegramMessage(chatId, `❌ No buyer matching "<b>${buyerSearch}</b>"`);
              return NextResponse.json({ ok: true });
            }
            if (rancherMatches.length === 0) {
              await sendTelegramMessage(chatId, `❌ No active+signed rancher matching "<b>${rancherSearch}</b>"`);
              return NextResponse.json({ ok: true });
            }
            if (buyerMatches.length > 1) {
              const list = buyerMatches.slice(0, 5).map((b: any, i: number) => `${i + 1}. <b>${b['Full Name']}</b> · ${b['Email']} · ${b['State'] || '?'}`).join('\n');
              await sendTelegramMessage(chatId, `🔍 Multiple buyers matching "<b>${buyerSearch}</b>":\n\n${list}\n\nRefine search w/ more of their name OR full email.`);
              return NextResponse.json({ ok: true });
            }
            if (rancherMatches.length > 1) {
              const list = rancherMatches.slice(0, 5).map((r: any, i: number) => `${i + 1}. <b>${r['Ranch Name']}</b> (${r['Operator Name']}, ${r['State']})`).join('\n');
              await sendTelegramMessage(chatId, `🔍 Multiple ranchers matching "<b>${rancherSearch}</b>":\n\n${list}\n\nRefine search w/ more of their name OR slug.`);
              return NextResponse.json({ ok: true });
            }

            const buyer = buyerMatches[0];
            const rancher = rancherMatches[0];
            const buyerName = buyer['Full Name'] || 'Buyer';
            const rancherName = rancher['Ranch Name'] || rancher['Operator Name'] || 'Rancher';
            const operatorName = rancher['Operator Name'] || '';
            const buyerState = buyer['State'] || '?';
            const rancherState = rancher['State'] || '?';
            const orderType = buyer['Order Type'] || '?';
            const budget = buyer['Budget'] || '?';
            const stateWarn = buyerState !== rancherState && !(rancher['Admin Approved Multi-State']) ? '\n⚠️ Buyer state ≠ rancher state + multi-state NOT admin-approved. Match may fail downstream gates.' : '';

            await sendTelegramMessage(
              chatId,
              `🎯 <b>CONFIRM MATCH</b>\n\n` +
              `👤 <b>${buyerName}</b> · ${buyer['Email']} · ${buyerState}\n` +
              `🥩 ${orderType} · 💰 ${budget}\n\n` +
              `🤠 <b>${rancherName}</b> (${operatorName}, ${rancherState})\n${stateWarn}\n\n` +
              `Tap to fire intro emails to both. Creates Pending Approval row → flips to Intro Sent → buyer + rancher get contact info within seconds.`,
              {
                inline_keyboard: [[
                  { text: '✅ Fire intro now', callback_data: `matchfire_${buyer.id}_${rancher.id}` },
                  { text: '❌ Cancel', callback_data: `matchcancel_${buyer.id}` },
                ]],
              }
            );
          } catch (e: any) {
            await sendTelegramMessage(chatId, `⚠️ /match failed: ${e?.message || 'unknown'}`);
          }
        }
      }

      // /forcematch <email-or-recId> — bypass batch-approve cooldowns and
      // call matching/suggest directly. Stops the "why isn't this buyer
      // matching" investigation loop.
      else if (text.startsWith('/forcematch ')) {
        const arg = text.slice('/forcematch '.length).trim();
        if (!arg) {
          await sendTelegramMessage(chatId, 'Usage: <code>/forcematch &lt;email-or-recId&gt;</code>');
        } else {
          try {
            const safeArg = escapeAirtableValue(arg);
            const buyers = (await getAllRecords(
              TABLES.CONSUMERS,
              `OR({Email}="${safeArg}", RECORD_ID()="${safeArg}")`,
            )) as any[];
            if (!buyers.length) {
              await sendTelegramMessage(chatId, `❌ No buyer matching <code>${arg}</code>`);
            } else {
              const buyer = buyers[0];
              const res = await fetch(`${SITE_URL}/api/matching/suggest`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(INTERNAL_API_SECRET ? { 'x-internal-secret': INTERNAL_API_SECRET } : {}),
                },
                body: JSON.stringify({
                  buyerState: buyer['State'],
                  buyerId: buyer.id,
                  buyerName: buyer['Full Name'],
                  buyerEmail: buyer['Email'],
                  buyerPhone: buyer['Phone'],
                  orderType: buyer['Order Type'],
                  budgetRange: buyer['Budget'],
                  intentScore: buyer['Intent Score'],
                  intentClassification: buyer['Intent Classification'] || '',
                  notes: buyer['Notes'] || '',
                  // hot-lead bypass — caller is operator
                  warmupEngaged: true,
                }),
              });
              const data: any = await res.json().catch(() => ({}));
              if (data.matchFound) {
                const ranch = data.suggestedRancher?.['Ranch Name'] || data.suggestedRancher?.['Operator Name'] || 'rancher';
                await sendTelegramMessage(
                  chatId,
                  `✅ Matched <b>${buyer['Full Name']}</b> → <b>${ranch}</b>`,
                );
              } else {
                await sendTelegramMessage(
                  chatId,
                  `⏳ No match for <b>${buyer['Full Name']}</b> (${buyer['State']})\nReason: ${data.reason || data.error || 'unknown'}`,
                );
              }
            }
          } catch (e: any) {
            await sendTelegramMessage(chatId, `⚠️ /forcematch failed: ${e?.message || 'unknown'}`);
          }
        }
      }

      // /stuckbuyers — buyers waitlisted >14 days grouped by state
      else if (text === '/stuckbuyers') {
        try {
          const cutoff = Date.now() - 14 * 86_400_000;
          const buyers = (await getAllRecords(
            TABLES.CONSUMERS,
            `AND({Status}="Approved", {Referral Status}="Waitlisted", NOT({Unsubscribed}))`,
          )) as any[];
          const stuck = buyers.filter((b: any) => {
            const created = new Date(b['Created'] || b['Approved At'] || 0).getTime();
            return created > 0 && created < cutoff;
          });
          const byState = new Map<string, number>();
          for (const b of stuck) {
            const s = normalizeState(b['State']) || '?';
            byState.set(s, (byState.get(s) || 0) + 1);
          }
          const lines = Array.from(byState.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([s, n]) => `<code>${s}</code>: ${n}`)
            .join('\n');
          await sendTelegramMessage(
            chatId,
            `<b>Stuck Buyers</b> (waitlisted &gt;14d, total ${stuck.length})\n\n${lines || 'None'}`,
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /stuckbuyers failed: ${e?.message || 'unknown'}`);
        }
      }

      // /stuckranchers — Signed-but-not-Live + Live-but-quiet
      else if (text === '/stuckranchers') {
        try {
          const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
          const signedNotLive = ranchers.filter(
            (r: any) => r['Agreement Signed'] && !r['Page Live'],
          );
          const cutoff = Date.now() - 30 * 86_400_000;
          const liveButQuiet = ranchers.filter((r: any) => {
            if (!r['Page Live']) return false;
            const last =
              r['Warmup Last Batch At'] ||
              r['Last Assigned At'] ||
              r['Onboarding Phase Until'];
            if (!last) return true;
            return new Date(last).getTime() < cutoff;
          });
          const fmt = (r: any) => `· ${r['Ranch Name'] || r['Operator Name'] || r.id} (${r['State'] || '?'})`;
          const lines = [
            `<b>Stuck Ranchers</b>`,
            '',
            `🚧 Signed, not Live: <b>${signedNotLive.length}</b>`,
            ...signedNotLive.slice(0, 10).map(fmt),
            '',
            `💤 Live, no activity 30d: <b>${liveButQuiet.length}</b>`,
            ...liveButQuiet.slice(0, 10).map(fmt),
          ];
          await sendTelegramMessage(chatId, lines.join('\n'));
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /stuckranchers failed: ${e?.message || 'unknown'}`);
        }
      }

      // /ghostranchers — ranchers with 2+ buyer-pulse ghost reports
      else if (text === '/ghostranchers') {
        try {
          const pulses = (await getAllRecords(
            TABLES.REFERRALS,
            `{Buyer Pulse Response}="ghosted"`,
          )) as any[];
          const counts = new Map<string, number>();
          for (const p of pulses) {
            const ids: string[] = p['Rancher'] || p['Suggested Rancher'] || [];
            const rid = Array.isArray(ids) ? ids[0] : null;
            if (!rid) continue;
            counts.set(rid, (counts.get(rid) || 0) + 1);
          }
          const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
          const nameById = new Map<string, string>();
          for (const r of ranchers) {
            nameById.set(r.id, r['Ranch Name'] || r['Operator Name'] || r.id);
          }
          const sorted = Array.from(counts.entries())
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1]);
          const lines = sorted.map(
            ([rid, n]) => `${nameById.get(rid) || rid}: <b>${n}</b> ghost reports`,
          );
          await sendTelegramMessage(
            chatId,
            `<b>Ghost Ranchers</b> (2+ buyer ghost reports)\n\n${lines.join('\n') || 'None — clean week.'}`,
          );
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /ghostranchers failed: ${e?.message || 'unknown'}`);
        }
      }

      // /comp <email> <tier> [#number] [reason]
      // Adds someone to the Founders Wall with full tier benefits + waived
      // fee. Tier must be one of: Herd, Outlaw, Steward, "Founding 100",
      // "Title Founder". For multi-word tiers, wrap in quotes:
      //   /comp matt@brimstone.beef "Founding 100" co-build pilot partner
      else if (text.startsWith('/comp ')) {
        try {
          const argString = text.slice('/comp '.length).trim();
          // Lightweight quoted-arg parser. Handles `/comp email tier rest`
          // and `/comp email "Founding 100" rest`.
          const tokens: string[] = [];
          const re = /"([^"]+)"|(\S+)/g;
          let match: RegExpExecArray | null;
          while ((match = re.exec(argString)) !== null) {
            tokens.push(match[1] !== undefined ? match[1] : match[2]);
          }
          const email = tokens[0] || '';
          const tier = tokens[1] || '';

          // Optional #N — pulls explicit Founder Number out of remaining tokens.
          let founderNumber: number | undefined;
          const rest: string[] = [];
          for (const t of tokens.slice(2)) {
            const m = t.match(/^#(\d+)$/);
            if (m && founderNumber === undefined) {
              founderNumber = Number(m[1]);
            } else {
              rest.push(t);
            }
          }
          const reason = rest.join(' ');

          if (!email || !tier) {
            await sendTelegramMessage(
              chatId,
              `Usage: <code>/comp &lt;email&gt; &lt;tier&gt; [#number] [reason]</code>\n\n` +
                `Tiers: Herd, Outlaw, Steward, "Founding 100", "Title Founder"\n\n` +
                `Examples:\n` +
                `<code>/comp matt@brimstone.beef "Founding 100" co-build partner</code>\n` +
                `<code>/comp jane@x.com Outlaw</code>\n` +
                `<code>/comp ben@y.com "Title Founder" #3 founding investor</code>`,
            );
          } else {
            const adminPw = process.env.ADMIN_PASSWORD || '';
            const res = await fetch(`${SITE_URL}/api/admin/founders/comp`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(adminPw ? { 'x-admin-password': adminPw } : {}),
              },
              body: JSON.stringify({ email, tier, founderNumber, reason }),
            });
            const data: any = await res.json().catch(() => ({}));
            if (data?.exists) {
              await sendTelegramMessage(chatId, `ℹ️ ${data.message}`);
            } else if (data?.ok) {
              await sendTelegramMessage(
                chatId,
                `🎁 <b>Comp added</b>\n\n` +
                  `${email}\n` +
                  `Tier: <b>${data.tier}</b>${data.founderNumber ? ` #${data.founderNumber}` : ''}\n` +
                  `Wall opt-in: ${data.wallOptIn ? '✅' : '❌'}\n` +
                  `Welcome email: ${data.welcomeSent ? '✅ sent' : '⏸ skipped'}\n\n` +
                  `<i>Audit note appended to their Consumer Notes.</i>`,
              );
            } else {
              await sendTelegramMessage(
                chatId,
                `⚠️ Comp failed: ${data?.error || `HTTP ${res.status}`}`,
              );
            }
          }
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /comp failed: ${e?.message || 'unknown'}`);
        }
      }

      else if (text === '/help') {
        const msg = `📖 <b>BuyHalfCow Bot — Command Reference</b>

<b>📊 SEE</b> — what's happening
/morning — Campaign-aware brief: self-submits, founders, throttle approvals, hot leads
/today — Daily brief (numbers + AI top 3 priorities)
/casestudy [name or slug] — Generate copy-paste social blurb for any rancher
/leads — Pending consumers awaiting review
/ranchers — Rancher onboarding pipeline
/money — Revenue + commission summary
/find [name or phone] — Search consumers, tap 💬 SMS · 📱 Call · 📧 Email
/capacity — Ranchers near capacity
/refs — Referral stage breakdown

<b>🎯 DO</b> — single actions
/route CO the-high-lonesome-ranch [dry|morning] — Bulk-route stuck buyers
/pause [slug] — Stop sending leads to a rancher (vacation, processing month, sick)
/resume [slug] — Reactivate a paused rancher
/blast [STATE] [message] — Quick email to all approved buyers in a state
/setuppage [name] — Build a rancher landing page (interactive wizard)
/affiliate [email] — Make someone an affiliate

<b>📨 EMAIL</b> — bulk sends, all in one namespace
/email checkin — Nudge stalled ranchers
/email onboard — Send onboarding docs to ranchers missing them
/email blitz — Personalized update emails to all pipeline ranchers
/email broadcast [seg] [msg] — Quick broadcast (segments: beef, community, all, ranchers)
/email draft followup [name] — AI drafts a personalized follow-up
/email draft campaign [seg] [topic] — AI drafts a broadcast campaign

<b>🧠 AI</b> — autonomous tasks
/scout — AI sweeps the business and produces an action list (~30s)
/ask [question] — AI investigates and answers in plain English
/qualify — AI scores pending leads (3 at a time, with approve/reject/watch buttons)
/chasup — Find stalled referrals + AI-draft re-engagement emails

<b>⚙️ SYSTEM</b>
/status — Health check all dependencies (Airtable, Resend, Telegram, AI)
/cronstatus — Last-24h run status for every cron (catches missing runs)
/routingstatus — Buyer routing-segment breakdown (MATCH_NOW · WARM_LEAD · etc)
/emaillog [email] — Last 30d email log for a Consumer
/pausemail [template] — Kill a specific email template
/resumemail [template] — Re-enable a paused template
/freqcap — Show current frequency cap
/templatestats — Per-template send count last 30d
/whatfired [today|yesterday|YYYY-MM-DD] — Daily activity summary
/bulkfire — Promote all Pending Approval → Intro Sent + fire emails (max 50)
/pausecron [name] — Pause a cron from firing
/resumecron [name] — Resume a paused cron
/forcematch [email-or-recId] — Bypass cooldowns, match a stuck buyer now
/match [buyer-name] [rancher-name] — Fuzzy match buyer→rancher w/ inline confirm. e.g. <code>/match katie renick</code>
/stuckbuyers — Waitlisted &gt;14d, grouped by state
/stuckranchers — Signed-not-Live + Live-but-quiet
/ghostranchers — Ranchers with 2+ buyer ghost reports
/start — Welcome + quick tour
/help — This menu

<i>Tip: just type anything in plain English. I'll figure out what you mean.</i>

<i>Legacy command names still work — /pending, /stats, /lookup, /pipeline, /rancherpipeline, /revenue, /broadcast, /blitz, /checkin, /bulkonboard, /makeaffiliate, /draft, /routestate.</i>`;

        await sendTelegramMessage(chatId, msg);
      }

      else {
        // Route to Claude AI for natural language questions
        await handleAIChat(chatId, text);
      }
    }

  } catch (error: any) {
    console.error('Telegram webhook error:', error);
    const chatId = update?.message?.chat?.id?.toString();
    if (chatId) {
      await sendTelegramMessage(chatId, `⚠️ Something went wrong: ${error?.message || 'Unknown error'}`).catch(() => {});
    }
  }
}
