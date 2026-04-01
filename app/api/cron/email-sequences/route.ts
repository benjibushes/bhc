import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import {
  sendSequenceEmail_BeefDay3,
  sendSequenceEmail_BeefDay7,
  sendSequenceEmail_CommunityDay7,
  sendSequenceEmail_CommunityDay14,
  sendIntroCheckInEmail,
  sendNurtureDay3,
  sendNurtureDay10,
  sendMerchEmail,
  sendNurtureAffiliate,
  sendEmail,
} from '@/lib/email';

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const DAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeLoginUrl(consumerId: string, email: string) {
  const token = jwt.sign(
    { type: 'member-login', consumerId, email: email.trim().toLowerCase() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  return `${SITE_URL}/member/verify?token=${token}`;
}

// Runs daily at 10am MT (16:00 UTC) — after batch-approve at 9am MT
// Sends drip emails to consumers based on how long they've been approved
async function handler(request: Request) {
  try {
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

    const now = Date.now();

    // Fetch all approved consumers + active ranchers once
    const approvedRaw = await getAllRecords(TABLES.CONSUMERS, '{Status} = "Approved"') as any[];
    // Skip unsubscribed consumers
    const approved = approvedRaw.filter((c: any) => !c['Unsubscribed']);
    const activeRanchers = await getAllRecords(TABLES.RANCHERS, '{Active Status} = "Active"') as any[];

    // Helper: does this consumer have a rancher available?
    function hasRancherAvailable(consumerState: string): boolean {
      return activeRanchers.some((r: any) =>
        r['Ships Nationwide'] === true ||
        r['Match Type'] === 'Nationwide' ||
        (r['State'] || '').toLowerCase() === (consumerState || '').toLowerCase()
      );
    }

    let beefDay3 = 0, beefDay7 = 0, community7 = 0, community14 = 0, introCheckin = 0,
        nurture3 = 0, nurture10 = 0, nurtureMerch = 0, nurtureAffiliate = 0, errors = 0;
    // Cap at 50 emails per run to avoid Resend rate limits and spam flags
    const MAX_EMAILS_PER_RUN = 50;
    let totalSent = 0;

    for (const consumer of approved) {
      if (totalSent >= MAX_EMAILS_PER_RUN) break;
      try {
        const email = consumer['Email'];
        const firstName = (consumer['Full Name'] || '').split(' ')[0] || 'there';
        const consumerId = consumer.id;
        const segment = consumer['Segment'] || '';
        const sequenceStage = consumer['Sequence Stage'] || 'none';

        if (!email) continue;

        // 24-hour email frequency gate — skip if we sent an automated email in the last 24 hours
        const lastSentAt = consumer['Sequence Sent At'];
        if (lastSentAt && (now - new Date(lastSentAt).getTime()) < DAY_MS) continue;

        const approvedAt = consumer['Approved At']
          ? new Date(consumer['Approved At']).getTime()
          : new Date(consumer.createdTime || 0).getTime(); // fallback to created time

        const daysSinceApproval = (now - approvedAt) / DAY_MS;
        const loginUrl = makeLoginUrl(consumerId, email);

        // ── Phase 1 vs Phase 2 determined per consumer by rancher availability ──
        const consumerState = consumer['State'] || '';
        const rancherAvailable = hasRancherAvailable(consumerState);

        if (!rancherAvailable) {
          // Day 3+: "What's actually happening right now" — mission update + Instagram
          if (daysSinceApproval >= 3 && sequenceStage === 'none') {
            await sendNurtureDay3({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_3d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurture3++; totalSent++;
          }

          // Day 10+: "I drove to Texas with $500 in my account" — raw story
          if (daysSinceApproval >= 10 && sequenceStage === 'nurture_3d_sent') {
            await sendNurtureDay10({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_10d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurture10++; totalSent++;
          }

          // Day 21+: Merch email — wear the mission
          if (daysSinceApproval >= 21 && sequenceStage === 'nurture_10d_sent') {
            await sendMerchEmail({ firstName, email });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_merch_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurtureMerch++; totalSent++;
          }

          // Day 35+: Affiliate ask — one link, buyers and ranchers welcome
          if (daysSinceApproval >= 35 && sequenceStage === 'nurture_merch_sent') {
            const referralLink = `${SITE_URL}/access`;
            await sendNurtureAffiliate({ firstName, email, referralLink, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_affiliate_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurtureAffiliate++; totalSent++;
          }
        }

        // ── Phase 2: Rancher available — run closing sequences ────────────────

        if (rancherAvailable) {

        // ── Beef Buyer sequences ──────────────────────────────────────────

        if (segment === 'Beef Buyer') {
          // Day 3+: No referral yet, haven't sent day3 email
          if (daysSinceApproval >= 3 && sequenceStage === 'none') {
            const noReferral = !consumer['Referral Status'] ||
              consumer['Referral Status'] === 'Unmatched' ||
              consumer['Referral Status'] === 'Waitlisted';

            if (noReferral) {
              await sendSequenceEmail_BeefDay3({
                firstName,
                email,
                state: consumer['State'] || 'your area',
                loginUrl,
              });
              await updateRecord(TABLES.CONSUMERS, consumerId, {
                'Sequence Stage': 'day3_sent',
                'Sequence Sent At': new Date().toISOString(),
              });
              beefDay3++; totalSent++;
            }
          }

          // Day 7+: Follow-up on rancher introduction
          if (daysSinceApproval >= 7 && sequenceStage === 'day3_sent') {
            // Find their active referral to get rancher name
            const referrals = await getAllRecords(
              TABLES.REFERRALS,
              `OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")`
            ) as any[];

            const activeReferral = referrals.find(r => {
              const buyerIds = r['Buyer'] || [];
              return Array.isArray(buyerIds) && buyerIds.includes(consumerId);
            });

            const rancherName = activeReferral?.['Suggested Rancher Name'] || 'your rancher';

            await sendSequenceEmail_BeefDay7({ firstName, email, rancherName, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'day7_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            beefDay7++; totalSent++;
          }
        }

        // ── Community sequences ───────────────────────────────────────────

        if (segment === 'Community') {
          const createdAt = new Date(consumer['Created'] || consumer.createdTime || 0).getTime();
          const daysSinceCreation = (now - createdAt) / DAY_MS;

          // Day 7+: Educational content
          if (daysSinceCreation >= 7 && sequenceStage === 'none') {
            await sendSequenceEmail_CommunityDay7({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'community_7d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            community7++; totalSent++;
          }

          // Day 14+: Upgrade prompt
          if (daysSinceCreation >= 14 && sequenceStage === 'community_7d_sent') {
            const upgradeUrl = `${SITE_URL}/member`;
            await sendSequenceEmail_CommunityDay14({ firstName, email, upgradeUrl, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'community_14d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            community14++; totalSent++;
          }
        }

        } // end if (rancherAvailable)

      } catch (err: any) {
        console.error(`Sequence error for consumer ${consumer.id}:`, err.message);
        errors++;
      }

      // Respect Airtable's 5 req/sec limit — each consumer makes up to 2 calls
      await sleep(250);
    }

    // ── Intro check-in: 3 days after Intro Sent At ────────────────────────
    // Query referrals that are in "Intro Sent" status with Intro Sent At > 3 days ago
    try {
      const introReferrals = await getAllRecords(
        TABLES.REFERRALS,
        '{Status} = "Intro Sent"'
      ) as any[];

      for (const referral of introReferrals) {
        try {
          const introSentAt = referral['Intro Sent At'];
          if (!introSentAt) continue;

          const daysSinceIntro = (now - new Date(introSentAt).getTime()) / DAY_MS;
          if (daysSinceIntro < 3) continue;

          // Find the consumer
          const consumerIds = referral['Buyer'] || [];
          if (!Array.isArray(consumerIds) || consumerIds.length === 0) continue;
          const consumerId = consumerIds[0];

          // Find consumer in approved list
          const consumer = approved.find(c => c.id === consumerId);
          if (!consumer) continue;

          const stage = consumer['Sequence Stage'] || 'none';
          if (stage === 'intro_checkin_sent') continue;

          const email = consumer['Email'];
          if (!email) continue;

          const firstName = (consumer['Full Name'] || '').split(' ')[0] || 'there';
          const loginUrl = makeLoginUrl(consumerId, email);

          // Get rancher contact info
          const rancherName = referral['Suggested Rancher Name'] || 'your rancher';
          const rancherEmail = referral['Rancher Email'] || '';
          const rancherPhone = referral['Rancher Phone'] || '';

          await sendIntroCheckInEmail({ firstName, email, rancherName, rancherEmail, rancherPhone, loginUrl });
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'Sequence Stage': 'intro_checkin_sent',
            'Sequence Sent At': new Date().toISOString(),
          });
          introCheckin++; totalSent++;
        } catch (err: any) {
          console.error(`Intro check-in error for referral ${referral.id}:`, err.message);
          errors++;
        }
      }
    } catch (err: any) {
      console.error('Intro check-in query error:', err.message);
    }

    const total = beefDay3 + beefDay7 + community7 + community14 + introCheckin + nurture3 + nurture10 + nurtureMerch + nurtureAffiliate;

    if (total > 0) {
      await sendTelegramUpdate(
        `📧 <b>Email Sequences</b>\n\n✅ ${total} email${total > 1 ? 's' : ''} sent\n` +
        (nurture3 + nurture10 + nurtureMerch + nurtureAffiliate > 0
          ? `🌱 Nurture: day-3 ${nurture3} | day-10 ${nurture10} | merch ${nurtureMerch} | affiliate ${nurtureAffiliate}\n`
          : '') +
        (beefDay3 + beefDay7 + community7 + community14 > 0
          ? `🥩 Closing: beef d3 ${beefDay3} | d7 ${beefDay7} | community d7 ${community7} | d14 ${community14}\n`
          : '') +
        (introCheckin > 0 ? `🔔 Intro check-ins: ${introCheckin}\n` : '') +
        (errors > 0 ? `⚠️ ${errors} errors` : '')
      );
    }

    // ── Rancher agreement reminder drip ─────────────────────────────────────
    // Day 3, 7, 14 after docs sent — nudge to sign agreement
    let rancherReminders = 0;
    try {
      const pipelineRanchers = await getAllRecords(TABLES.RANCHERS, '{Onboarding Status} = "Docs Sent"') as any[];

      for (const rancher of pipelineRanchers) {
        if (totalSent >= MAX_EMAILS_PER_RUN) break;
        const email = rancher['Email'];
        const docsSentAt = rancher['Docs Sent At'];
        if (!email || !docsSentAt) continue;
        if (rancher['Agreement Signed']) continue;

        const daysSinceDocsSent = (now - new Date(docsSentAt).getTime()) / DAY_MS;
        const firstName = (rancher['Operator Name'] || rancher['Ranch Name'] || '').split(' ')[0] || 'there';
        const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'your ranch';
        const rancherState = rancher['State'] || '';

        // Only send at day 3, 7, 14 milestones (check if already sent via Rancher Sequence Stage)
        const stage = rancher['Rancher Sequence Stage'] || 'none';
        let shouldSend = false;
        let subject = '';
        let bodyHtml = '';
        let newStage = '';

        if (daysSinceDocsSent >= 3 && daysSinceDocsSent < 7 && stage === 'none') {
          shouldSend = true;
          newStage = 'reminder_day3';
          subject = `${firstName}, your agreement is ready to sign`;
          bodyHtml = `<p>Hi ${firstName},</p>
            <p>Just a quick reminder — your BuyHalfCow Commission Agreement for <strong>${ranchName}</strong> is ready for your signature.</p>
            <p>Once signed, you can immediately start setting up your ranch page and we can begin sending buyers your way.</p>
            <p><strong>Quick recap:</strong> 10% commission on referred sales only. No upfront fees. Buyers pay you directly.</p>
            <p>If you have any questions, just reply to this email.</p>`;
        } else if (daysSinceDocsSent >= 7 && daysSinceDocsSent < 14 && stage === 'reminder_day3') {
          shouldSend = true;
          newStage = 'reminder_day7';
          subject = `Need help with your agreement, ${firstName}?`;
          bodyHtml = `<p>Hi ${firstName},</p>
            <p>I noticed you haven't signed the BuyHalfCow agreement yet for <strong>${ranchName}</strong>. No pressure — just want to make sure everything makes sense.</p>
            <p>If you have questions about the commission structure, the process, or anything else, just reply to this email and I'll get back to you personally.</p>
            <p>We have buyers actively looking for ranch-direct beef${rancherState ? ` in ${rancherState}` : ''}, and I'd love to get you connected with them.</p>`;
        } else if (daysSinceDocsSent >= 14 && stage === 'reminder_day7') {
          shouldSend = true;
          newStage = 'reminder_day14';
          subject = `Last check-in — buyers waiting in ${rancherState || 'your area'}`;
          bodyHtml = `<p>Hi ${firstName},</p>
            <p>This is my last follow-up about the BuyHalfCow partnership for <strong>${ranchName}</strong>.</p>
            <p>We currently have buyers looking for ranch-direct beef${rancherState ? ` in ${rancherState}` : ''} and your operation would be a great fit. The agreement takes about 2 minutes to review and sign.</p>
            <p>If now isn't the right time, no worries at all. Just reply and let me know, and I'll reach out again when it makes sense.</p>`;
        }

        if (shouldSend) {
          try {
            await sendEmail({
              to: email,
              subject,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                ${bodyHtml}
                <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, Founder<br>BuyHalfCow</p>
              </div>`,
            });
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Rancher Sequence Stage': newStage,
            });
            rancherReminders++;
            totalSent++;
          } catch (e: any) {
            console.error('Rancher reminder error:', e.message);
          }
        }
      }
    } catch (e: any) {
      console.error('Rancher drip query error:', e.message);
    }

    if (rancherReminders > 0) {
      await sendTelegramUpdate(`📋 <b>Rancher Agreement Reminders</b>: ${rancherReminders} sent`);
    }

    return NextResponse.json({ success: true, sent: total + rancherReminders, nurture3, nurture10, nurtureMerch, nurtureAffiliate, beefDay3, beefDay7, community7, community14, introCheckin, rancherReminders, errors });
  } catch (error: any) {
    console.error('Email sequences cron error:', error);
    await sendTelegramUpdate(`⚠️ Email sequences cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
