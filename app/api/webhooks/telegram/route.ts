import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  TELEGRAM_ADMIN_CHAT_ID,
} from '@/lib/telegram';
import { sendEmail, sendConsumerApproval, sendBroadcastEmail, sendBuyerIntroNotification, sendRancherCheckIn, sendPipelineUpdateEmail } from '@/lib/email';
import { callClaude } from '@/lib/ai';
import { bulkRouteStateToRancher } from '@/lib/bulkRoute';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

// ─── Waitlist-to-matched blast: when a rancher goes live, auto-match waiting buyers ──
async function runWaitlistBlast(rancherId: string): Promise<{ matched: number; ranchName: string; state: string }> {
  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  const ranchName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
  const rancherState = rancher['State'] || '';
  const statesServedRaw = rancher['States Served'] || '';
  const statesServed: string[] = Array.isArray(statesServedRaw)
    ? statesServedRaw
    : typeof statesServedRaw === 'string'
      ? statesServedRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

  // Combine primary state + states served for matching
  const allStates = new Set<string>();
  if (rancherState) allStates.add(rancherState);
  statesServed.forEach((s: string) => allStates.add(s));

  if (allStates.size === 0) {
    return { matched: 0, ranchName, state: rancherState };
  }

  // Find waiting consumers in those states
  const allConsumers: any[] = await getAllRecords(TABLES.CONSUMERS);
  const waitingBuyers = allConsumers.filter((c: any) => {
    const status = c['Status'] || '';
    const refStatus = c['Referral Status'] || '';
    const consumerState = c['State'] || '';
    if (status !== 'Approved') return false;
    if (refStatus !== 'Unmatched' && refStatus !== 'Waitlisted') return false;
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

  return { matched, ranchName, state: rancherState };
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

export async function POST(request: Request) {
  let update: any;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
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

      // ─── Referral actions ───────────────────────────────────────────────

      if (action === 'approve') {
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
          const currentRefs = rancher['Current Active Referrals'] || 0;
          const maxRefs = rancher['Max Active Referalls'] || 5;

          if (currentRefs >= maxRefs) {
            await answerCallbackQuery(queryId, `At capacity (${currentRefs}/${maxRefs}). Reassign instead.`);
            if (chatId) {
              await sendTelegramMessage(chatId, `⚠️ ${rancher['Operator Name'] || 'Rancher'} is at capacity (${currentRefs}/${maxRefs}). Tap "Reassign" to pick a different rancher.`);
            }
            return NextResponse.json({ ok: true });
          }

          const now = new Date().toISOString();

          await updateRecord(TABLES.REFERRALS, fullReferralId, {
            'Status': 'Intro Sent',
            'Rancher': [rancherId],
            'Approved At': now,
            'Intro Sent At': now,
          });

          // Note: Current Active Referrals is incremented at match creation time
          // in /api/matching/suggest — only update Last Assigned At here to avoid double-counting
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
        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);

          await updateRecord(TABLES.REFERRALS, fullReferralId, {
            'Status': 'Closed Lost',
            'Closed At': new Date().toISOString(),
          });

          const assignedRancherIds = referral['Rancher'] || referral['Suggested Rancher'] || [];
          if (Array.isArray(assignedRancherIds) && assignedRancherIds.length > 0) {
            try {
              const rancher: any = await getRecordById(TABLES.RANCHERS, assignedRancherIds[0]);
              const currentRefs = rancher['Current Active Referrals'] || 0;
              if (currentRefs > 0) {
                await updateRecord(TABLES.RANCHERS, assignedRancherIds[0], {
                  'Current Active Referrals': currentRefs - 1,
                });
              }
            } catch { /* rancher lookup failed, skip decrement */ }
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
        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);
          const buyerState = referral['Buyer State'] || '';

          const allRanchers = await getAllRecords(TABLES.RANCHERS);
          const available = allRanchers.filter((r: any) => {
            const active = r['Active Status'] === 'Active';
            const agreed = r['Agreement Signed'] === true;
            const state = r['State'] || '';
            const served = r['States Served'] || '';
            const maxRefs = r['Max Active Referalls'] || 5;
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
              text: `${r['Operator Name'] || r['Ranch Name']} (${r['Current Active Referrals'] || 0}/${r['Max Active Referalls'] || 5})`,
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
        const parts = callbackData.split('_');
        const refId = parts[1];
        const newRancherId = parts.slice(2).join('_');

        try {
          const referral: any = await getRecordById(TABLES.REFERRALS, refId);

          const oldRancherId = referral['Rancher']?.[0] || referral['Suggested Rancher']?.[0];
          if (oldRancherId && oldRancherId !== newRancherId) {
            try {
              const oldRancher: any = await getRecordById(TABLES.RANCHERS, oldRancherId);
              const oldCount = oldRancher['Current Active Referrals'] || 0;
              if (oldCount > 0) {
                await updateRecord(TABLES.RANCHERS, oldRancherId, {
                  'Current Active Referrals': oldCount - 1,
                });
              }
            } catch (e) {
              console.error('Error decrementing old rancher count:', e);
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

          const currentRefs = rancher['Current Active Referrals'] || 0;
          await updateRecord(TABLES.RANCHERS, newRancherId, {
            'Last Assigned At': now,
            'Current Active Referrals': currentRefs + 1,
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
          await updateRecord(TABLES.REFERRALS, refId, {
            'Commission Paid': true,
            'Notes': `${ref['Notes'] || ''}\n[Commission marked paid via Telegram ${new Date().toISOString().slice(0, 10)}]`.trim(),
          });
          await answerCallbackQuery(queryId, '💰 Marked paid');
          if (chatId) {
            await sendTelegramMessage(chatId, `💰 <b>COMMISSION PAID</b>\n\n$${(ref['Commission Due'] || 0).toLocaleString()} for ${ref['Buyer Name']} marked as paid.`);
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
          const refId = fullReferralId;
          const ref: any = await getRecordById(TABLES.REFERRALS, refId);
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          await updateRecord(TABLES.REFERRALS, refId, {
            'Status': 'Closed Lost',
            'Closed At': new Date().toISOString(),
            'Notes': `${ref['Notes'] || ''}\n[Closed Lost via Telegram — stalled, no engagement]`.trim(),
          });
          // Free up rancher capacity
          if (Array.isArray(rancherIds) && rancherIds[0]) {
            try {
              const rancher: any = await getRecordById(TABLES.RANCHERS, rancherIds[0]);
              const count = rancher['Current Active Referrals'] || 0;
              if (count > 0) {
                await updateRecord(TABLES.RANCHERS, rancherIds[0], { 'Current Active Referrals': count - 1 });
              }
            } catch { /* non-critical */ }
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

      // ─── AI Qualify callbacks ───────────────────────────────────────────
      // qapprove_{consumerId}, qreject_{consumerId}, qwatch_{consumerId}

      else if (action === 'qapprove') {
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
              console.error('Matching error after AI qualify approval:', e);
            }
          }

          await answerCallbackQuery(queryId, '✅ Approved! Email sent.');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `✅ <b>AI QUALIFIED → APPROVED</b>\n\n${consumer['Full Name']} (${segment}) — approval email sent`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'qreject') {
        try {
          const consumer: any = await getRecordById(TABLES.CONSUMERS, fullReferralId);
          await updateRecord(TABLES.CONSUMERS, fullReferralId, { 'Status': 'Rejected' });
          await answerCallbackQuery(queryId, 'Rejected');
          if (chatId && messageId) {
            await editTelegramMessage(chatId, messageId,
              `❌ <b>AI QUALIFIED → REJECTED</b>\n\n${consumer['Full Name']} (${consumer['State']}) — marked as Rejected`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      else if (action === 'qwatch') {
        try {
          await updateRecord(TABLES.CONSUMERS, fullReferralId, { 'AI Recommended Action': 'watch' });
          await answerCallbackQuery(queryId, 'Marked as Watch — no action taken.');
          if (chatId && messageId) {
            const c: any = await getRecordById(TABLES.CONSUMERS, fullReferralId);
            await editTelegramMessage(chatId, messageId,
              `👁️ <b>WATCHING</b>\n\n${c['Full Name']} — flagged for later review`
            );
          }
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Chase-up callbacks ─────────────────────────────────────────────
      // chasend_{referralId}, chaskip_{referralId}

      else if (action === 'chasend') {
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

          await updateRecord(TABLES.RANCHERS, session.rancherId, {
            'Page Live': true,
            'Onboarding Status': 'Live',
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

      else if (callbackData.startsWith('rverify_')) {
        const rancherId = callbackData.substring('rverify_'.length);
        try {
          await updateRecord(TABLES.RANCHERS, rancherId, { 'Onboarding Status': 'Verification Complete' });
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

          await updateRecord(TABLES.RANCHERS, rancherId, {
            'Page Live': true,
            'Onboarding Status': 'Live',
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
        if (chatId) {
          setupPageSessions.delete(chatId);
          await answerCallbackQuery(queryId, 'Done!');
          await sendTelegramMessage(chatId, '✅ Page setup saved. Run /setuppage [name] anytime to edit.');
        }
      }

      // ─── Morning brief drill-down buttons ───────────────────────────────────
      // Tapping a button on the daily AI brief fires a fresh fetch and replies inline.
      else if (callbackData === 'brief_leads' && chatId) {
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

      else if (callbackData === 'brief_stalled' && chatId) {
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

      else if (callbackData === 'brief_money' && chatId) {
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

      else if (callbackData === 'brief_pipeline' && chatId) {
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
/find [name] — Search consumers/ranchers

<b>🎯 DO</b> single actions
/route CO the-high-lonesome-ranch [dry|morning] — Bulk-route stuck buyers
/setuppage [name] — Build a rancher landing page
/affiliate [email] — Make an affiliate

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
          const max = r['Max Active Referalls'] || 5;
          return current >= max * 0.8 && r['Active Status'] === 'Active';
        });

        if (nearCapacity.length === 0) {
          await sendTelegramMessage(chatId, '✅ All ranchers have capacity available.');
        } else {
          let msg = `⚠️ <b>Ranchers Near Capacity</b>\n\n`;
          for (const r of nearCapacity as any[]) {
            msg += `• ${r['Operator Name'] || r['Ranch Name']} — ${r['Current Active Referrals']}/${r['Max Active Referalls']} (${r['State']})\n`;
          }
          await sendTelegramMessage(chatId, msg);
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
          const max = r['Max Active Referalls'] || 5;
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

      else if (text.startsWith('/lookup')) {
        const query = text.replace('/lookup', '').trim();
        if (!query) {
          await sendTelegramMessage(chatId, 'Usage: <code>/lookup name or email</code>');
        } else {
          const consumers = await getAllRecords(TABLES.CONSUMERS);
          const q = query.toLowerCase();
          const matches = consumers.filter((c: any) => {
            const name = (c['Full Name'] || '').toLowerCase();
            const email = (c['Email'] || '').toLowerCase();
            return name.includes(q) || email.includes(q);
          });

          if (matches.length === 0) {
            await sendTelegramMessage(chatId, `🔍 No consumers found for "<b>${query}</b>"`);
          } else {
            let msg = `🔍 <b>${matches.length} result${matches.length > 1 ? 's' : ''}</b> for "${query}"\n`;
            for (const c of matches.slice(0, 5) as any[]) {
              const segEmoji = c['Segment'] === 'Beef Buyer' ? '🥩' : '🏷️';
              const statusEmoji = (c['Status'] || '').toLowerCase() === 'approved' || (c['Status'] || '').toLowerCase() === 'active' ? '✅' : '⏳';
              msg += `\n${statusEmoji} <b>${c['Full Name']}</b> ${segEmoji}`;
              msg += `\n   📧 ${c['Email']}`;
              msg += `\n   📍 ${c['State']} | Intent: ${c['Intent Score'] || 0} (${c['Intent Classification'] || 'N/A'})`;
              msg += `\n   Status: ${c['Status'] || 'Unknown'} | Referral: ${c['Referral Status'] || 'N/A'}`;
              msg += `\n`;
            }
            if (matches.length > 5) msg += `\n...and ${matches.length - 5} more`;
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

        if (!process.env.ANTHROPIC_API_KEY) {
          await sendTelegramMessage(chatId, '⚠️ /ask requires ANTHROPIC_API_KEY. Tool use isn\'t available with Ollama or Groq yet.');
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
        } catch (e: any) {
          await sendTelegramMessage(chatId, `⚠️ /ask failed: ${e.message}`);
        }
      }

      else if (text === '/qualify') {
        if (!AI_CONFIGURED) {
          await sendTelegramMessage(chatId, '⚠️ AI not configured. Set OLLAMA_BASE_URL or ANTHROPIC_API_KEY.');
          return NextResponse.json({ ok: true });
        }

        const pending = await getAllRecords(TABLES.CONSUMERS, '{Status} = "Pending"');

        if (pending.length === 0) {
          await sendTelegramMessage(chatId, '✅ No pending consumers to qualify. All caught up.');
          return NextResponse.json({ ok: true });
        }

        const total = pending.length;
        const batch = (pending as any[]).slice(0, 3); // Cap at 3 per invocation for timeout safety
        await sendTelegramMessage(chatId, `🧠 Analyzing <b>${batch.length}</b> of <b>${total}</b> pending lead${total > 1 ? 's' : ''} with AI...`);

        for (const consumer of batch) {
          try {
            const { summary, recommendation } = await runQualifyAnalysis(consumer);

            // Store in Airtable
            await updateRecord(TABLES.CONSUMERS, consumer.id, {
              'AI Qualification Summary': summary,
              'AI Recommended Action': recommendation,
            });

            const recEmoji = recommendation === 'approve' ? '✅' : recommendation === 'reject' ? '❌' : '👁️';
            const segEmoji = consumer['Segment'] === 'Beef Buyer' ? '🥩' : '🏷️';

            const msg = `🧠 <b>AI LEAD ANALYSIS</b>

${segEmoji} <b>${consumer['Full Name']}</b> — ${consumer['State']}
Intent: ${consumer['Intent Score'] || 0} (${consumer['Intent Classification'] || 'N/A'}) | ${consumer['Segment'] || 'Unknown'}

${summary}

${recEmoji} <b>Recommendation: ${recommendation.toUpperCase()}</b>`;

            const keyboard = {
              inline_keyboard: [[
                { text: '✅ Approve', callback_data: `qapprove_${consumer.id}` },
                { text: '❌ Reject', callback_data: `qreject_${consumer.id}` },
                { text: '👁️ Watch', callback_data: `qwatch_${consumer.id}` },
              ]],
            };

            await sendTelegramMessage(chatId, msg, keyboard);
          } catch (err: any) {
            await sendTelegramMessage(chatId, `⚠️ Could not analyze ${consumer['Full Name'] || consumer.id}: ${err.message}`);
          }
        }

        if (total > 3) {
          await sendTelegramMessage(chatId, `<i>...${total - 3} more pending. Run /qualify again after clearing these.</i>`);
        }
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
          const max = r['Max Active Referalls'] || 5;
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

      else if (text === '/help') {
        const msg = `📖 <b>BuyHalfCow Bot — Command Reference</b>

<b>📊 SEE</b> — what's happening
/today — Daily brief (numbers + AI top 3 priorities)
/leads — Pending consumers awaiting review
/ranchers — Rancher onboarding pipeline
/money — Revenue + commission summary
/find [name] — Search consumers/ranchers
/capacity — Ranchers near capacity
/refs — Referral stage breakdown

<b>🎯 DO</b> — single actions
/route CO the-high-lonesome-ranch [dry|morning] — Bulk-route stuck buyers
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
/ask [question] — AI investigates the business and answers (uses tools)
/qualify — AI scores pending leads (3 at a time, with approve/reject/watch buttons)
/chasup — Find stalled referrals + AI-draft re-engagement emails

<b>❓ HELP</b>
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
