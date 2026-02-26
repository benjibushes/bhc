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
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

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

      // Consumer approve from Telegram
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

          await updateRecord(TABLES.CONSUMERS, fullReferralId, { 'Status': 'approved' });

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

      // Consumer reject from Telegram
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

      // Consumer details from Telegram
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

      // Rancher send onboarding from Telegram
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
          const max = r['Max Active Referrals'] || 5;
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

        const order = ['Pending Approval', 'Intro Sent', 'In Conversation', 'Tour Scheduled', 'Negotiating', 'Closed Won', 'Closed Lost', 'Dormant', 'Waitlisted'];
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

Segments: beef, community, all, ranchers`;

        await sendTelegramMessage(chatId, msg);
      }
    }

    // Handle broadcast confirmation callbacks
    if (update.callback_query) {
      const { id: queryId, data: callbackData, message } = update.callback_query;
      const chatId = message?.chat?.id?.toString();
      const messageId = message?.message_id;

      if (callbackData === 'bccancel') {
        await answerCallbackQuery(queryId, 'Cancelled');
        if (chatId && messageId) {
          await editTelegramMessage(chatId, messageId, '❌ Broadcast cancelled.');
        }
        return NextResponse.json({ ok: true });
      }

      if (callbackData?.startsWith('bcsend_')) {
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
        return NextResponse.json({ ok: true });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Telegram webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
