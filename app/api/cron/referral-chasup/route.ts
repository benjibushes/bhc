import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendTelegramMessage, sendTelegramUpdate, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';
import { sendEmail, sendRepeatPurchaseEmail, sendRancherLeadReminder } from '@/lib/email';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHASE_UPS = 3;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_CONFIGURED = !!(OLLAMA_URL || ANTHROPIC_KEY);

// Runs daily at 11am MT (17:00 UTC)
// Auto-sends AI re-engagement emails (max 3 per referral), auto-closes stale referrals
async function handler(request: Request) {
  try {
    if (isMaintenanceMode()) return maintenanceResponse('referral-chasup');

    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = request.headers.get('authorization');
      if (authHeader !== `Bearer ${cronSecret}`) {
        const { searchParams } = new URL(request.url);
        const secret = searchParams.get('secret');
        if (secret !== cronSecret) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
      }
    }

    if (!AI_CONFIGURED) {
      return NextResponse.json({ success: false, error: 'AI not configured (set OLLAMA_BASE_URL or ANTHROPIC_API_KEY)' });
    }

    const referrals = await getAllRecords(
      TABLES.REFERRALS,
      'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")'
    ) as any[];

    // Fetch unsubscribed emails to skip them
    const consumers = await getAllRecords(TABLES.CONSUMERS) as any[];
    const unsubscribedEmails = new Set(
      consumers
        .filter((c: any) => c['Unsubscribed'])
        .map((c: any) => (c['Email'] || '').trim().toLowerCase())
    );

    const stale = referrals.filter(r => {
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      if (!lastActivity) return false;
      const buyerEmail = (r['Buyer Email'] || '').trim().toLowerCase();
      if (unsubscribedEmails.has(buyerEmail)) return false;
      const chaseCount = r['Chase Count'] || 0;
      if (chaseCount >= MAX_CHASE_UPS) return false; // Already maxed out
      return (Date.now() - new Date(lastActivity).getTime()) >= 5 * DAY_MS;
    });

    // ── Auto-close referrals that hit max chase-ups ──────────────────────────
    let autoClosed = 0;
    const maxedOut = referrals.filter(r => {
      const chaseCount = r['Chase Count'] || 0;
      if (chaseCount < MAX_CHASE_UPS) return false;
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      if (!lastActivity) return false;
      return (Date.now() - new Date(lastActivity).getTime()) >= 5 * DAY_MS;
    });

    for (const referral of maxedOut) {
      try {
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'Status': 'Closed Lost',
          'Closed At': new Date().toISOString(),
          'Notes': (referral['Notes'] || '') + '\n[Auto-closed: no response after 3 follow-ups]',
        });
        // Decrement rancher's active referral count
        const rancherIds = referral['Suggested Rancher'] || referral['Rancher'] || [];
        if (rancherIds.length > 0) {
          try {
            const rancher: any = await getRecordById(TABLES.RANCHERS, rancherIds[0]);
            const count = rancher['Current Active Referrals'] || 0;
            if (count > 0) {
              await updateRecord(TABLES.RANCHERS, rancherIds[0], {
                'Current Active Referrals': count - 1,
              });
            }
          } catch (e) { console.error('Error decrementing rancher count:', e); }
        }

        // Re-route the buyer to another rancher
        const buyerIds = referral['Buyer'] || [];
        const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
        if (buyerId) {
          try {
            const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
            if (buyer && buyer['Email']) {
              await updateRecord(TABLES.CONSUMERS, buyerId, {
                'Referral Status': 'Unmatched',
                'Sequence Stage': 'rerouted',
              });
              await fetch(`${SITE_URL}/api/matching/suggest`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                },
                body: JSON.stringify({
                  buyerState: buyer['State'] || '',
                  buyerId,
                  buyerName: buyer['Full Name'] || '',
                  buyerEmail: buyer['Email'],
                  buyerPhone: buyer['Phone'] || '',
                  orderType: buyer['Order Type'] || '',
                  budgetRange: buyer['Budget'] || '',
                  intentScore: buyer['Intent Score'] || 50,
                  intentClassification: buyer['Intent Classification'] || 'Medium',
                  notes: buyer['Notes'] || '',
                }),
              });
            }
          } catch (rerouteErr) {
            console.error('Re-route error on auto-close:', rerouteErr);
          }
        }

        autoClosed++;
      } catch (e: any) {
        console.error('Auto-close error:', e.message);
      }
    }

    if (autoClosed > 0) {
      await sendTelegramUpdate(`🔒 <b>Auto-Closed ${autoClosed} Stale Referrals</b>\nNo response after ${MAX_CHASE_UPS} follow-ups. Rancher capacity freed.`);
    }

    // ── L2a: DAY 2 RANCHER REMINDER ────────────────────────────────────────
    // Ranchers don't have Telegram — they only have email + dashboard. If a
    // rancher hasn't moved a lead off "Intro Sent" within 2 days, email them
    // directly with the buyer's contact info + a CTA. Throttled to one
    // reminder per 4-day window via Rancher Reminded At field.
    let rancherReminders = 0;
    try {
      const introSentRefs = referrals.filter(r => r['Status'] === 'Intro Sent');
      const now = Date.now();
      const needsReminder = introSentRefs.filter(r => {
        const introAt = r['Intro Sent At'] || r['Approved At'];
        if (!introAt) return false;
        const days = (now - new Date(introAt).getTime()) / DAY_MS;
        if (days < 2) return false;
        // Throttle: skip if reminded within last 4 days
        const lastReminder = r['Rancher Reminded At'];
        if (lastReminder) {
          const daysSinceReminder = (now - new Date(lastReminder).getTime()) / DAY_MS;
          if (daysSinceReminder < 4) return false;
        }
        return true;
      });

      for (const ref of needsReminder.slice(0, 10)) {
        try {
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
          if (!rancherId) continue;
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          if (!rancher) continue;
          const rancherEmail = rancher['Email'] || '';
          if (!rancherEmail) continue;
          if (rancher['Unsubscribed'] || rancher['Bounced']) continue;

          const introAt = ref['Intro Sent At'] || ref['Approved At'];
          const days = Math.floor((now - new Date(introAt).getTime()) / DAY_MS);

          await sendRancherLeadReminder({
            rancherEmail,
            operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher',
            buyerName: ref['Buyer Name'] || 'a buyer',
            buyerState: ref['Buyer State'] || '',
            buyerPhone: ref['Buyer Phone'] || '',
            buyerEmail: ref['Buyer Email'] || '',
            orderType: ref['Order Type'] || '',
            budgetRange: ref['Budget Range'] || '',
            daysSinceIntro: days,
            dashboardUrl: `${SITE_URL}/rancher`,
          });

          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Rancher Reminded At': new Date().toISOString(),
          });

          rancherReminders++;
        } catch (e: any) {
          console.error(`Rancher reminder error for referral ${ref.id}:`, e.message);
        }
      }

      if (rancherReminders > 0) {
        await sendTelegramUpdate(`📧 <b>${rancherReminders} rancher reminder${rancherReminders > 1 ? 's' : ''} sent</b>\nNudged ranchers sitting on Intro Sent leads for 2+ days.`);
      }
    } catch (e: any) {
      console.error('Rancher reminder query error:', e.message);
    }

    // ── L2c: STALLED RANCHER NUDGE ─────────────────────────────────────────
    // Detect referrals where the rancher hasn't moved in 3+ days (Intro Sent stage).
    // Fires a Telegram alert (max once per 3-day window) so Ben can nudge or reassign.
    let stalledNudges = 0;
    try {
      const introSentRefs = referrals.filter(r => r['Status'] === 'Intro Sent');
      const now = Date.now();
      const stalledForNudge = introSentRefs.filter(r => {
        const introAt = r['Intro Sent At'] || r['Approved At'];
        if (!introAt) return false;
        const daysSinceIntro = (now - new Date(introAt).getTime()) / DAY_MS;
        if (daysSinceIntro < 3) return false;
        // Throttle: don't re-alert if we already alerted within the last 3 days
        const lastAlert = r['Stalled Alert Sent At'];
        if (lastAlert) {
          const daysSinceAlert = (now - new Date(lastAlert).getTime()) / DAY_MS;
          if (daysSinceAlert < 3) return false;
        }
        return true;
      });

      for (const ref of stalledForNudge.slice(0, 6)) {
        try {
          const buyerName = ref['Buyer Name'] || 'Unknown buyer';
          const buyerState = ref['Buyer State'] || '?';
          const rancherName = ref['Suggested Rancher Name'] || 'Unknown rancher';
          const introAt = ref['Intro Sent At'] || ref['Approved At'];
          const days = Math.floor((now - new Date(introAt).getTime()) / DAY_MS);

          const alertMsg = `🔕 <b>STALLED RANCHER</b> — ${days}d no activity\n\n` +
            `👤 Buyer: <b>${buyerName}</b> (${buyerState})\n` +
            `🤠 Rancher: <b>${rancherName}</b>\n` +
            `📊 Status: Intro Sent (rancher hasn't engaged)\n\n` +
            `<i>Tap a button to act:</i>`;

          const keyboard = {
            inline_keyboard: [
              [
                { text: '📞 Nudge Rancher', callback_data: `nudgerancher_${ref.id}` },
                { text: '🔄 Reassign', callback_data: `reassign_${ref.id}` },
              ],
              [
                { text: '🔒 Close Lost', callback_data: `closelost_${ref.id}` },
                { text: '👁 Details', callback_data: `details_${ref.id}` },
              ],
            ],
          };

          await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, alertMsg, keyboard);
          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Stalled Alert Sent At': new Date().toISOString(),
          });
          stalledNudges++;
        } catch (e: any) {
          console.error(`Stalled nudge error for referral ${ref.id}:`, e.message);
        }
      }

      if (stalledNudges > 0) {
        await sendTelegramUpdate(`🔕 <b>${stalledNudges} stalled deal alert${stalledNudges > 1 ? 's' : ''} sent</b>\nNudge or reassign before they go cold.`);
      }
    } catch (e: any) {
      console.error('Stalled nudge query error:', e.message);
    }

    // ── HARD AUTO-REASSIGN AT 14+ DAYS ────────────────────────────────────
    // No lead should ever die silently. If a rancher has had a lead for 14+
    // days without moving past "Intro Sent", we auto-pass it on their behalf
    // and re-run matching with that rancher excluded. The buyer gets a
    // re-engagement notification regardless of outcome.
    let autoReassigned = 0;
    try {
      const introSentRefs = referrals.filter(r => r['Status'] === 'Intro Sent');
      const now = Date.now();
      const stuckTooLong = introSentRefs.filter(r => {
        const introAt = r['Intro Sent At'] || r['Approved At'];
        if (!introAt) return false;
        const days = (now - new Date(introAt).getTime()) / DAY_MS;
        return days >= 14;
      });

      for (const ref of stuckTooLong.slice(0, 10)) {
        try {
          const buyerName = ref['Buyer Name'] || 'Unknown';
          const buyerState = ref['Buyer State'] || '';
          const rancherName = ref['Suggested Rancher Name'] || 'Unknown rancher';
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const previousRancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;

          // Close current referral as Closed Lost with auto-pass note
          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Status': 'Closed Lost',
            'Closed At': new Date().toISOString(),
            'Notes': `[AUTO-REASSIGNED ${new Date().toISOString().slice(0, 10)} — 14+ days no movement]\n${ref['Notes'] || ''}`.trim(),
          });

          // Decrement previous rancher's capacity
          if (previousRancherId) {
            try {
              const prevRancher: any = await getRecordById(TABLES.RANCHERS, previousRancherId);
              const count = prevRancher['Current Active Referrals'] || 0;
              if (count > 0) {
                await updateRecord(TABLES.RANCHERS, previousRancherId, {
                  'Current Active Referrals': count - 1,
                });
              }
            } catch (e) {
              console.error('Auto-reassign: capacity decrement error:', e);
            }
          }

          // Re-run matching for the buyer with previous rancher excluded
          const buyerIds = ref['Buyer'] || [];
          const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
          let outcome: 'rematched' | 'waitlisted' = 'waitlisted';
          let newRancher = '';
          if (buyerId) {
            try {
              const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
              if (buyer && buyer['Email']) {
                await updateRecord(TABLES.CONSUMERS, buyerId, {
                  'Referral Status': 'Unmatched',
                  'Sequence Stage': 'rerouted_after_stall',
                });
                const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                  },
                  body: JSON.stringify({
                    buyerState: buyer['State'] || buyerState,
                    buyerId,
                    buyerName: buyer['Full Name'] || buyerName,
                    buyerEmail: buyer['Email'],
                    buyerPhone: buyer['Phone'] || '',
                    orderType: buyer['Order Type'] || '',
                    budgetRange: buyer['Budget'] || '',
                    intentScore: buyer['Intent Score'] || 50,
                    intentClassification: buyer['Intent Classification'] || 'Medium',
                    notes: buyer['Notes'] || '',
                    excludeRancherIds: previousRancherId ? [previousRancherId] : [],
                  }),
                });
                if (matchRes.ok) {
                  const data = await matchRes.json();
                  if (data.matchFound) {
                    outcome = 'rematched';
                    newRancher = data.suggestedRancher?.name || '';
                  }
                }
              }
            } catch (rerouteErr) {
              console.error('Auto-reassign: rematch error:', rerouteErr);
            }
          }

          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `⏰ <b>AUTO-REASSIGNED</b> (14+ days stalled)\n\n` +
            `🤠 Was: ${rancherName}\n` +
            `👤 Buyer: ${buyerName} (${buyerState})\n` +
            (outcome === 'rematched'
              ? `🔄 Reassigned to: <b>${newRancher}</b>`
              : `⏳ No other rancher in ${buyerState} — buyer waitlisted, nurture restarted`)
          );
          autoReassigned++;
        } catch (e: any) {
          console.error('Auto-reassign error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Auto-reassign query error:', e.message);
    }

    if (stale.length === 0) {
      return NextResponse.json({ success: true, stale: 0, sent: 0, autoClosed, rancherReminders, stalledNudges, autoReassigned });
    }

    let sent = 0;
    let errors = 0;

    for (const referral of stale.slice(0, 8)) {
      try {
        const buyerName = referral['Buyer Name'] || 'the buyer';
        const buyerEmail = referral['Buyer Email'] || '';
        const rancherName = referral['Suggested Rancher Name'] || 'the rancher';
        const chaseCount = (referral['Chase Count'] || 0) + 1;
        const daysStale = Math.floor((Date.now() - new Date(referral['Last Chased At'] || referral['Intro Sent At'] || referral['Approved At']).getTime()) / DAY_MS);

        if (!buyerEmail) continue;

        const draftPrompt = `Draft a friendly, concise re-engagement email for a beef buyer who was introduced to a rancher ${daysStale} days ago and we haven't heard back. This is follow-up #${chaseCount} of ${MAX_CHASE_UPS}. 2-3 short paragraphs. Warm, not pushy. ${chaseCount === MAX_CHASE_UPS ? 'Mention this is your last follow-up.' : ''} Do NOT include a subject line — just the body paragraphs. Sign as Benjamin from BuyHalfCow.

Buyer: ${buyerName}, ${referral['Buyer State'] || ''}
Rancher introduced: ${rancherName}
Order interest: ${referral['Order Type'] || 'bulk beef'}, Budget: ${referral['Budget Range'] || 'not specified'}`;

        const draft = await callClaude({
          system: `You are Ben's AI business assistant for BuyHalfCow, a private beef brokerage. Write warm, direct emails that feel personal.`,
          user: draftPrompt,
          maxTokens: 500,
        });

        // Send immediately (no Telegram approval needed)
        const firstName = buyerName.split(' ')[0] || 'there';
        const subject = chaseCount === 1
          ? `Quick check-in — ${rancherName} on BuyHalfCow`
          : chaseCount === MAX_CHASE_UPS
          ? `Last follow-up — ${rancherName} on BuyHalfCow`
          : `Following up — ${rancherName} on BuyHalfCow`;

        await sendEmail({
          to: buyerEmail,
          subject,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
            <p>Hi ${firstName},</p>
            ${draft.split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('')}
            <div style="background:#F4F1EC;border-left:3px solid #0E0E0E;padding:14px 18px;margin:20px 0;">
              <p style="margin:0;font-size:14px;color:#0E0E0E;"><strong>Already bought from ${rancherName}?</strong> Just reply <strong>"YES"</strong> to this email and I'll close the loop on our end. Takes 5 seconds.</p>
            </div>
            <p style="font-size:12px;color:#A7A29A;margin-top:30px;">You're receiving this because you signed up on BuyHalfCow. <a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(buyerEmail)}" style="color:#A7A29A;">Unsubscribe</a></p>
          </div>`,
        });

        // Update referral
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'AI Chase Draft': draft,
          'Chase Count': chaseCount,
          'Last Chased At': new Date().toISOString(),
        });

        // Info-only Telegram notification
        await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID,
          `🎯 <b>AUTO CHASE-UP #${chaseCount}/${MAX_CHASE_UPS}</b>\n👤 ${buyerName} → 🤠 ${rancherName}\n📧 Sent to ${buyerEmail}\n${chaseCount >= MAX_CHASE_UPS ? '⚠️ Final follow-up — will auto-close if no response' : ''}`
        );

        sent++;
      } catch (err: any) {
        console.error(`Chase-up error for referral ${referral.id}:`, err.message);
        errors++;
      }
    }

    if (sent > 0) {
      await sendTelegramUpdate(`🎯 <b>Chase-Up Complete</b>\n${sent} emails auto-sent\n${autoClosed} referrals auto-closed${errors > 0 ? `\n⚠️ ${errors} errors` : ''}`);
    }

    // ── Repeat purchase emails — 30 days post-close ────────────────────────
    let repeatSent = 0;
    try {
      const closedReferrals = await getAllRecords(
        TABLES.REFERRALS,
        '{Status} = "Closed Won"'
      ) as any[];

      const reorderWindow = Date.now() - 250 * DAY_MS;
      const repeatCandidates = closedReferrals.filter(r => {
        if (r['Repeat Outreach Sent']) return false;
        const closedAt = r['Closed At'];
        if (!closedAt) return false;
        return new Date(closedAt).getTime() < reorderWindow;
      });

      for (const referral of repeatCandidates) {
        try {
          const buyerEmail = referral['Buyer Email'] || '';
          const buyerName = referral['Buyer Name'] || '';
          if (!buyerEmail) continue;

          const firstName = buyerName.split(' ')[0] || 'there';
          const rancherName = referral['Suggested Rancher Name'] || 'your rancher';

          // Build a magic login link for the consumer
          const consumerIds: string[] = referral['Buyer'] || [];
          const consumerId = consumerIds[0] || '';
          const token = consumerId
            ? jwt.sign(
                { type: 'member-login', consumerId, email: buyerEmail.trim().toLowerCase() },
                JWT_SECRET,
                { expiresIn: '7d' }
              )
            : '';
          const loginUrl = token ? `${SITE_URL}/member/verify?token=${token}` : `${SITE_URL}/member`;

          await sendRepeatPurchaseEmail({ firstName, email: buyerEmail, rancherName, loginUrl });
          await updateRecord(TABLES.REFERRALS, referral.id, { 'Repeat Outreach Sent': true });
          repeatSent++;
        } catch (e: any) {
          console.error('Repeat purchase email error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Repeat purchase query error:', e.message);
    }

    if (repeatSent > 0) {
      await sendTelegramUpdate(`🔄 <b>Repeat Purchase Emails</b>: ${repeatSent} sent to past buyers`);
    }

    return NextResponse.json({ success: true, stale: stale.length, sent, autoClosed, rancherReminders, stalledNudges, autoReassigned, errors, repeatSent });
  } catch (error: any) {
    console.error('Referral chase-up cron error:', error);
    await sendTelegramUpdate(`⚠️ Referral chase-up cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
