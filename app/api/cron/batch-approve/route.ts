import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendConsumerApproval, sendWaitlistEmail } from '@/lib/email';
import { sendTelegramUpdate, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Runs daily at 9am MT — processes pending consumers who qualify for auto-approval
// and kicks off rancher matching for approved Beef Buyers
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== process.env.CRON_SECRET || !process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // Get all pending consumers
    const pending = await getAllRecords(
      TABLES.CONSUMERS,
      `{Status} = "Pending"`
    );

    if (pending.length === 0) {
      await sendTelegramUpdate('⏳ Batch approve ran — no pending consumers.');
      return NextResponse.json({ success: true, approved: 0, skipped: 0 });
    }

    let approved = 0;
    let skipped = 0;
    let matched = 0;
    const errors: string[] = [];

    for (const consumer of pending as any[]) {
      try {
        const intentClassification = consumer['Intent Classification'] || '';
        // Derive segment: use stored Segment field if present, otherwise infer from Order Type/Budget
        // (existing records pre-date the Segment field being added to Airtable)
        const rawSegment = consumer['Segment'] || '';
        const hasBeefBuyerSignals = !!(consumer['Order Type'] || consumer['Budget']);
        const segment = rawSegment || (hasBeefBuyerSignals ? 'Beef Buyer' : 'Community');
        const email = consumer['Email'];
        const firstName = (consumer['Full Name'] || '').split(' ')[0];
        const consumerId = consumer['id'];

        // Determine if this consumer qualifies for auto-approval
        const qualifies =
          segment === 'Community' ||
          (segment === 'Beef Buyer' &&
            (intentClassification === 'High' || intentClassification === 'Medium'));

        if (!qualifies) {
          skipped++;
          // Queue AI analysis for low-intent consumers so Ben can review them in Telegram
          try {
            const OLLAMA_URL = process.env.OLLAMA_BASE_URL || '';
            const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
            if (OLLAMA_URL || ANTHROPIC_KEY) {
              const prompt = `Analyze this consumer lead for BuyHalfCow. Write a 2-3 sentence qualification summary, then end with your recommendation in exactly this format:\nRECOMMENDATION: approve | reject | watch\n\nConsumer data:\n- Name: ${consumer['Full Name'] || 'Unknown'}\n- State: ${consumer['State'] || 'Unknown'}\n- Segment: ${segment}\n- Order Type: ${consumer['Order Type'] || 'Not specified'}\n- Budget: ${consumer['Budget'] || consumer['Budget Range'] || 'Not specified'}\n- Notes: ${consumer['Notes'] || 'None'}\n- Intent Score: ${consumer['Intent Score'] || 0} (${intentClassification || 'Unknown'})`;

              const response = await callClaude({
                model: 'claude-sonnet-4-6',
                system: `You are Ben's AI business assistant for BuyHalfCow, a private beef brokerage. Be concise.`,
                user: prompt,
                maxTokens: 400,
              });

              const recMatch = response.match(/RECOMMENDATION:\s*(approve|reject|watch)/i);
              const recommendation = recMatch?.[1]?.toLowerCase() || 'watch';
              const summary = response.replace(/RECOMMENDATION:\s*(approve|reject|watch)/i, '').trim();

              await updateRecord(TABLES.CONSUMERS, consumerId, {
                'AI Qualification Summary': summary,
                'AI Recommended Action': recommendation,
              });

              const recEmoji = recommendation === 'approve' ? '✅' : recommendation === 'reject' ? '❌' : '👁️';
              const msg = `🧠 <b>LOW-INTENT LEAD — AI REVIEW</b>\n\n${segment === 'Beef Buyer' ? '🥩' : '🏷️'} <b>${consumer['Full Name']}</b> — ${consumer['State']}\nIntent: ${consumer['Intent Score'] || 0} (${intentClassification}) — skipped by batch-approve\n\n${summary}\n\n${recEmoji} <b>AI Recommends: ${recommendation.toUpperCase()}</b>`;

              await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, msg, {
                inline_keyboard: [[
                  { text: '✅ Approve', callback_data: `qapprove_${consumerId}` },
                  { text: '❌ Reject', callback_data: `qreject_${consumerId}` },
                  { text: '👁️ Watch', callback_data: `qwatch_${consumerId}` },
                ]],
              });
            }
          } catch (aiErr: any) {
            console.warn(`AI analysis skipped for ${consumerId}:`, aiErr.message);
          }
          continue;
        }

        // Approve the consumer
        const now = new Date().toISOString();
        await updateRecord(TABLES.CONSUMERS, consumerId, { 'Status': 'Approved', 'Approved At': now });

        // Send magic link email
        if (email) {
          const token = jwt.sign(
            { type: 'member-login', consumerId, email: email.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const loginUrl = `${SITE_URL}/member/verify?token=${token}`;
          await sendConsumerApproval({ firstName, email, loginUrl, segment });
        }

        approved++;

        // Trigger matching for Beef Buyers
        if (segment === 'Beef Buyer' && consumer['State']) {
          try {
            const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                buyerState: consumer['State'],
                buyerId: consumerId,
                buyerName: consumer['Full Name'],
                buyerEmail: email,
                buyerPhone: consumer['Phone'],
                orderType: consumer['Order Type'],
                budgetRange: consumer['Budget'],
                intentScore: consumer['Intent Score'],
                intentClassification,
                notes: consumer['Notes'],
              }),
            });
            if (matchRes.ok) {
              const matchData = await matchRes.json().catch(() => ({}));
              const didMatch = !!(matchData.rancherId || matchData.referralId || matchData.rancher || matchData.matched);
              if (didMatch) {
                matched++;
              } else {
                // No rancher available in their state — waitlist them
                const currentStage = consumer['Sequence Stage'] || 'none';
                if (currentStage !== 'waitlisted' && email) {
                  await sendWaitlistEmail({ firstName, email, state: consumer['State'] });
                  await updateRecord(TABLES.CONSUMERS, consumerId, { 'Sequence Stage': 'waitlisted' });
                }
              }
            } else {
              // Match API error — still no rancher, notify via waitlist
              const currentStage = consumer['Sequence Stage'] || 'none';
              if (currentStage !== 'waitlisted' && email) {
                await sendWaitlistEmail({ firstName, email, state: consumer['State'] });
                await updateRecord(TABLES.CONSUMERS, consumerId, { 'Sequence Stage': 'waitlisted' });
              }
            }
          } catch (matchErr) {
            console.error(`Matching error for consumer ${consumerId}:`, matchErr);
          }
        }
      } catch (err: any) {
        console.error(`Error processing consumer ${consumer['id']}:`, err);
        errors.push(consumer['Full Name'] || consumer['id']);
      }
    }

    const summary = `✅ <b>Batch Approval Complete</b>

📥 Pending reviewed: ${pending.length}
✅ Approved: ${approved}
⏭️ Skipped (low intent): ${skipped}
🤝 Matched to ranchers: ${matched}${errors.length > 0 ? `\n⚠️ Errors: ${errors.length} (${errors.slice(0, 3).join(', ')})` : ''}`;

    await sendTelegramUpdate(summary);

    return NextResponse.json({ success: true, approved, skipped, matched, errors: errors.length });
  } catch (error: any) {
    console.error('Batch approve error:', error);
    await sendTelegramUpdate(`⚠️ Batch approval cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
