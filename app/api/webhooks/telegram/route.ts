import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  TELEGRAM_ADMIN_CHAT_ID,
} from '@/lib/telegram';
import { sendEmail } from '@/lib/email';

export async function POST(request: Request) {
  try {
    const update = await request.json();

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
          const maxRefs = rancher['Max Active Referrals'] || 5;

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

          // Send intro email
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
                  <p style="font-size: 12px; color: #A7A29A; margin-top: 30px;">— Benji, BuyHalfCow | 10% commission on BHC referral sales.</p>
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
          await updateRecord(TABLES.REFERRALS, fullReferralId, {
            'Status': 'Closed Lost',
            'Closed At': new Date().toISOString(),
          });

          await answerCallbackQuery(queryId, 'Rejected');

          if (chatId && messageId) {
            const referral: any = await getRecordById(TABLES.REFERRALS, fullReferralId);
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
            const maxRefs = r['Max Active Referrals'] || 5;
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
              text: `${r['Operator Name'] || r['Ranch Name']} (${r['Current Active Referrals'] || 0}/${r['Max Active Referrals'] || 5})`,
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

          // Decrement old rancher's count if there was one
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
                  <p style="font-size: 12px; color: #A7A29A;">— Benji, BuyHalfCow</p>
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

      return NextResponse.json({ ok: true });
    }

    // Handle text commands
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
          msg += '\n\nView all at: ' + (process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com') + '/admin/referrals';
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
          const max = r['Max Active Referrals'] || 5;
          return current >= max * 0.8 && r['Active Status'] === 'Active';
        });

        if (nearCapacity.length === 0) {
          await sendTelegramMessage(chatId, '✅ All ranchers have capacity available.');
        } else {
          let msg = `⚠️ <b>Ranchers Near Capacity</b>\n\n`;
          for (const r of nearCapacity as any[]) {
            msg += `• ${r['Operator Name'] || r['Ranch Name']} — ${r['Current Active Referrals']}/${r['Max Active Referrals']} (${r['State']})\n`;
          }
          await sendTelegramMessage(chatId, msg);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Telegram webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
