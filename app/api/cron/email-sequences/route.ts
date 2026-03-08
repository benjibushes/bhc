import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import {
  sendSequenceEmail_BeefDay3,
  sendSequenceEmail_BeefDay7,
  sendSequenceEmail_CommunityDay7,
  sendSequenceEmail_CommunityDay14,
} from '@/lib/email';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const DAY_MS = 24 * 60 * 60 * 1000;

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

    // Fetch all approved consumers once
    const approved = await getAllRecords(TABLES.CONSUMERS, '{Status} = "Approved"') as any[];

    let beefDay3 = 0, beefDay7 = 0, community7 = 0, community14 = 0, errors = 0;

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
      } catch (err: any) {
        console.error(`Sequence error for consumer ${consumer.id}:`, err.message);
        errors++;
      }
    }

    const total = beefDay3 + beefDay7 + community7 + community14;

    if (total > 0) {
      await sendTelegramUpdate(
        `📧 <b>Email Sequences</b>\n\n✅ ${total} sequence email${total > 1 ? 's' : ''} sent\n` +
        `🥩 Beef day-3: ${beefDay3} | day-7: ${beefDay7}\n` +
        `🏷️ Community day-7: ${community7} | day-14: ${community14}` +
        (errors > 0 ? `\n⚠️ ${errors} errors` : '')
      );
    }

    return NextResponse.json({ success: true, sent: total, beefDay3, beefDay7, community7, community14, errors });
  } catch (error: any) {
    console.error('Email sequences cron error:', error);
    await sendTelegramUpdate(`⚠️ Email sequences cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
