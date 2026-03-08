import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  TELEGRAM_ADMIN_CHAT_ID,
} from '@/lib/telegram';
import { sendEmail, sendConsumerApproval, sendBroadcastEmail } from '@/lib/email';
import { callClaude } from '@/lib/ai';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || '';

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

const AI_CONFIGURED = !!(ANTHROPIC_API_KEY || OLLAMA_BASE_URL);

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

// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let update: any;
  try {
    update = await request.json();

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

          await updateRecord(TABLES.RANCHERS, rancherId, {
            'Last Assigned At': now,
            'Current Active Referrals': currentRefs + 1,
          });

          const rancherEmail = rancher['Email'];
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
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

          await answerCallbackQuery(queryId, 'Approved! Intro sent.');

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

          await answerCallbackQuery(queryId, `Reassigned to ${rancherName}`);

          if (chatId && messageId) {
            await editTelegramMessage(
              chatId,
              messageId,
              `🔄 <b>REASSIGNED</b>\n\nIntro sent to <b>${rancherName}</b> for <b>${referral['Buyer Name']}</b>`
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

          await updateRecord(TABLES.CONSUMERS, fullReferralId, { 'Status': 'approved', 'Approved At': now });

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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  buyerState: consumer['State'],
                  buyerId: fullReferralId,
                  buyerName: consumer['Full Name'],
                  buyerEmail: consumerEmail,
                  buyerPhone: consumer['Phone'],
                  orderType: consumer['Order Type'],
                  budgetRange: consumer['Budget Range'],
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
💵 Budget: ${c['Budget Range'] || 'N/A'}
📝 Notes: ${c['Notes'] || 'None'}

Status: ${c['Status'] || 'Unknown'}
Source: ${c['Source'] || 'organic'}`;

          if (chatId) await sendTelegramMessage(chatId, msg);
          await answerCallbackQuery(queryId, 'Details sent');
        } catch (e: any) {
          await answerCallbackQuery(queryId, `Error: ${e.message}`);
        }
      }

      // ─── Rancher actions ────────────────────────────────────────────────

      else if (action === 'ronboard') {
        try {
          const res = await fetch(`${SITE_URL}/api/ranchers/${fullReferralId}/send-onboarding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          if (res.ok) {
            await answerCallbackQuery(queryId, 'Onboarding docs sent!');
            if (chatId && messageId) {
              const rancher: any = await getRecordById(TABLES.RANCHERS, fullReferralId);
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

          await updateRecord(TABLES.CONSUMERS, fullReferralId, { 'Status': 'approved', 'Approved At': now });

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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  buyerState: consumer['State'],
                  buyerId: fullReferralId,
                  buyerName: consumer['Full Name'],
                  buyerEmail: consumerEmail,
                  buyerPhone: consumer['Phone'],
                  orderType: consumer['Order Type'],
                  budgetRange: consumer['Budget Range'],
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
        await answerCallbackQuery(queryId, 'Skipped');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, `⏭️ <b>SKIPPED</b>`);
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
                'Subject': subject,
                'Body': draft,
                'Segment': `single:${consumerEmail}`,
                'Scheduled At': tomorrow,
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
                  <h1>${subject}</h1>
                  <p>Hi ${firstName},</p>
                  ${draft.split('\n').filter(Boolean).map((p: string) => `<p>${p}</p>`).join('')}
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
            let filtered = consumers;
            if (audienceType === 'consumers-beef') {
              filtered = consumers.filter((c: any) => c['Segment'] === 'Beef Buyer');
            } else if (audienceType === 'consumers-community') {
              filtered = consumers.filter((c: any) => !c['Segment'] || c['Segment'] === 'Community');
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

      return NextResponse.json({ ok: true });
    }

    // ─── Text commands ──────────────────────────────────────────────────────

    if (update.message?.text) {
      const text = update.message.text.trim();
      const chatId = update.message.chat.id.toString();

      if (text === '/pending' || text === '/start') {
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

👤 To: ${match['Full Name']} (${match['Email']})
📌 Subject: <b>${subject}</b>

<i>${preview}</i>`;

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

      else if (text === '/help') {
        const msg = `📖 <b>BuyHalfCow Bot Commands</b>

<b>Dashboard</b>
/today — Morning digest (signups, pipeline, revenue)
/stats — Overall platform stats
/pending — List pending referrals

<b>Lookup</b>
/lookup [name or email] — Search consumers

<b>Pipeline</b>
/pipeline — Referral stage breakdown
/capacity — Ranchers near capacity
/revenue — Commission & revenue summary

<b>Actions</b>
/broadcast [segment] [msg] — Quick broadcast

<b>🤖 AI Skills</b>
/qualify — AI reviews & scores pending leads
/brief — AI-generated priority action list for today
/chasup — Find stalled referrals, draft re-engagement emails
/draft followup [name] — AI drafts personalized follow-up email
/draft campaign [segment] [topic] — AI drafts broadcast campaign

Segments: beef, community, all, ranchers`;

        await sendTelegramMessage(chatId, msg);
      }

      else {
        // Route to Claude AI for natural language questions
        await handleAIChat(chatId, text);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Telegram webhook error:', error);
    try {
      const chatId = update?.message?.chat?.id?.toString();
      if (chatId) {
        await sendTelegramMessage(chatId, `⚠️ Something went wrong: ${error?.message || 'Unknown error'}. Check server logs.`);
      }
    } catch (_) { /* ignore */ }
    return NextResponse.json({ ok: true });
  }
}
