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

    const now = Date.now();

    // Fetch all approved consumers + active ranchers once
    const approved = await getAllRecords(TABLES.CONSUMERS, '{Status} = "Approved"') as any[];
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

    for (const consumer of approved) {
      try {
        const email = consumer['Email'];
        const firstName = (consumer['Full Name'] || '').split(' ')[0] || 'there';
        const consumerId = consumer.id;
        const segment = consumer['Segment'] || '';
        const sequenceStage = consumer['Sequence Stage'] || 'none';

        if (!email) continue;

        const approvedAt = consumer['Approved At']
          ? new Date(consumer['Approved At']).getTime()
          : new Date(consumer.createdTime || 0).getTime(); // fallback to created time

        const daysSinceApproval = (now - approvedAt) / DAY_MS;
        const loginUrl = makeLoginUrl(consumerId, email);

        // ── Phase 1 vs Phase 2 determined per consumer by rancher availability ──
        const consumerState = consumer['State'] || '';
        const rancherAvailable = hasRancherAvailable(consumerState);

        if (!rancherAvailable) {
          // Day 3: "What's actually happening right now" — mission update + Instagram
          if (daysSinceApproval >= 3 && daysSinceApproval < 4 && sequenceStage === 'none') {
            await sendNurtureDay3({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_3d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurture3++;
          }

          // Day 10: "I drove to Texas with $500 in my account" — raw story
          if (daysSinceApproval >= 10 && daysSinceApproval < 11 && sequenceStage === 'nurture_3d_sent') {
            await sendNurtureDay10({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_10d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurture10++;
          }

          // Day 21: Merch email — wear the mission
          if (daysSinceApproval >= 21 && daysSinceApproval < 22 && sequenceStage === 'nurture_10d_sent') {
            await sendMerchEmail({ firstName, email });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_merch_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurtureMerch++;
          }

          // Day 35: Affiliate ask — one link, buyers and ranchers welcome
          if (daysSinceApproval >= 35 && daysSinceApproval < 36 && sequenceStage === 'nurture_merch_sent') {
            const referralLink = `${SITE_URL}/access`;
            await sendNurtureAffiliate({ firstName, email, referralLink, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_affiliate_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurtureAffiliate++;
          }
        }

        // ── Phase 2: Rancher available — run closing sequences ────────────────

        if (rancherAvailable) {

        // ── Beef Buyer sequences ──────────────────────────────────────────

        if (segment === 'Beef Buyer') {
          // Day 3: No referral yet, haven't sent day3 email
          if (daysSinceApproval >= 3 && daysSinceApproval < 4 && sequenceStage === 'none') {
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
              beefDay3++;
            }
          }

          // Day 7: Follow-up on rancher introduction
          if (daysSinceApproval >= 7 && daysSinceApproval < 8 && sequenceStage === 'day3_sent') {
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
            beefDay7++;
          }
        }

        // ── Community sequences ───────────────────────────────────────────

        if (segment === 'Community') {
          const createdAt = new Date(consumer['Created'] || consumer.createdTime || 0).getTime();
          const daysSinceCreation = (now - createdAt) / DAY_MS;

          // Day 7: Educational content
          if (daysSinceCreation >= 7 && daysSinceCreation < 8 && sequenceStage === 'none') {
            await sendSequenceEmail_CommunityDay7({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'community_7d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            community7++;
          }

          // Day 14: Upgrade prompt
          if (daysSinceCreation >= 14 && daysSinceCreation < 15 && sequenceStage === 'community_7d_sent') {
            const upgradeUrl = `${SITE_URL}/member`;
            await sendSequenceEmail_CommunityDay14({ firstName, email, upgradeUrl, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'community_14d_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            community14++;
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
          introCheckin++;
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

    return NextResponse.json({ success: true, sent: total, nurture3, nurture10, nurtureMerch, nurtureAffiliate, beefDay3, beefDay7, community7, community14, introCheckin, errors });
  } catch (error: any) {
    console.error('Email sequences cron error:', error);
    await sendTelegramUpdate(`⚠️ Email sequences cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
