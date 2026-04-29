import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendTelegramUpdate } from '@/lib/telegram';
import {
  sendSequenceEmail_BeefDay3,
  sendSequenceEmail_BeefDay7,
  sendSequenceEmail_CommunityDay7,
  sendSequenceEmail_CommunityDay14,
  sendIntroCheckInEmail,
  sendMerchEmail,
  sendNurtureWhy,
  sendNurtureHow,
  sendNurtureUrgency,
  sendNurtureReferral,
  sendAbandonedRecoveryEmail,
  sendEmail,
} from '@/lib/email';

import jwt from 'jsonwebtoken';

// Bumped from 60s — the cron iterates 1200+ approved consumers and was
// timing out daily for a week, leaving 955 buyers stuck in 'none' stage.
// 180s leaves headroom for ~75 emails + Airtable updates per run.
export const maxDuration = 180;

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
    if (isMaintenanceMode()) return maintenanceResponse('email-sequences');

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

    // ── ABANDONED APPLICATION RECOVERY ────────────────────────────────────
    // 3-email recapture sequence for visitors who entered email on /access
    // but didn't complete the form. Industry recovery rate: 8-15%.
    // Records are created by /api/abandoned-app with Source='abandoned_application'
    // and Sequence Stage='abandoned_pending'.
    let abandonedRecovered = 0;
    try {
      const abandoned = await getAllRecords(
        TABLES.CONSUMERS,
        `AND({Source} = "abandoned_application", {Status} != "Approved")`
      ) as any[];
      const ABANDON_LIMIT_PER_RUN = 30;
      let abandonSent = 0;
      for (const rec of abandoned) {
        if (abandonSent >= ABANDON_LIMIT_PER_RUN) break;
        if (rec['Unsubscribed']) continue;
        const email = (rec['Email'] || '').trim().toLowerCase();
        if (!email) continue;
        const stage = rec['Sequence Stage'] || 'abandoned_pending';
        const createdAt = new Date(rec.createdTime || 0).getTime();
        const lastSent = rec['Sequence Sent At'] ? new Date(rec['Sequence Sent At']).getTime() : 0;
        const ageHours = (now - createdAt) / (60 * 60 * 1000);
        const hoursSinceLast = lastSent ? (now - lastSent) / (60 * 60 * 1000) : Infinity;
        const firstName = (rec['Full Name'] || '').replace('(abandoned signup)', '').split(' ')[0] || '';

        let send: 1 | 2 | 3 | null = null;
        let nextStage = '';
        if (stage === 'abandoned_pending' && ageHours >= 24) {
          send = 1; nextStage = 'abandoned_email1_sent';
        } else if (stage === 'abandoned_email1_sent' && hoursSinceLast >= 72) {
          send = 2; nextStage = 'abandoned_email2_sent';
        } else if (stage === 'abandoned_email2_sent' && hoursSinceLast >= 7 * 24) {
          send = 3; nextStage = 'abandoned_email3_sent';
        }

        if (!send) continue;

        try {
          await sendAbandonedRecoveryEmail({ email, firstName, stage: send });
          await updateRecord(TABLES.CONSUMERS, rec.id, {
            'Sequence Stage': nextStage,
            'Sequence Sent At': new Date().toISOString(),
          });
          abandonedRecovered++;
          abandonSent++;
        } catch (e: any) {
          console.error('Abandoned recovery email error:', e?.message);
        }
      }
    } catch (e: any) {
      console.error('Abandoned recovery query error:', e?.message);
    }

    // Fetch all approved consumers + active ranchers once
    const approvedRaw = await getAllRecords(TABLES.CONSUMERS, '{Status} = "Approved"') as any[];
    // Skip unsubscribed consumers
    const approved = approvedRaw.filter((c: any) => !c['Unsubscribed']);
    const activeRanchers = await getAllRecords(TABLES.RANCHERS, '{Active Status} = "Active"') as any[];

    // Cache active referrals ONCE (was re-fetched per Day-7 buyer inside the
    // loop — turned a 500ms call into 50 × 500ms = 25s per cron run, the
    // primary timeout cause). Now indexed by buyer ID for O(1) lookup.
    const activeReferralsRaw = await getAllRecords(
      TABLES.REFERRALS,
      'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")'
    ) as any[];
    const referralsByBuyer = new Map<string, any>();
    for (const r of activeReferralsRaw) {
      const buyerIds = r['Buyer'] || [];
      const id = Array.isArray(buyerIds) ? buyerIds[0] : null;
      if (id && !referralsByBuyer.has(id)) referralsByBuyer.set(id, r);
    }

    // Helper: does this consumer have a rancher available IN THEIR STATE?
    // Local-only routing policy — Ships Nationwide is no longer honored.
    // Checks both primary State and States Served (multi-state ranchers).
    function hasRancherAvailable(consumerState: string): boolean {
      const target = (consumerState || '').toUpperCase().trim();
      if (!target) return false;
      return activeRanchers.some((r: any) => {
        const primary = (r['State'] || '').toUpperCase().trim();
        if (primary === target) return true;
        const served = String(r['States Served'] || '')
          .split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean);
        return served.includes(target);
      });
    }

    let beefDay3 = 0, beefDay7 = 0, community7 = 0, community14 = 0, introCheckin = 0,
        nurture3 = 0, nurture10 = 0, nurtureMerch = 0, nurtureAffiliate = 0, errors = 0;
    // Cap at 50 emails per run to avoid Resend rate limits and spam flags
    const MAX_EMAILS_PER_RUN = 50;
    let totalSent = 0;
    // Track sends within this loop so we can sleep AFTER actual work (not
    // after every iteration). The old `await sleep(250)` after every consumer
    // meant 1260 × 250ms = 5+ minutes wasted on no-op iterations, blowing
    // the maxDuration budget before doing real work. Now we only sleep when
    // we actually fired an email.
    let sentBeforeIter = 0;

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
          // Day 3: Why buying direct matters
          if (daysSinceApproval >= 3 && sequenceStage === 'none') {
            await sendNurtureWhy({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_why_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurture3++; totalSent++;
          }

          // Day 7: How buying a half cow actually works
          if (daysSinceApproval >= 7 && sequenceStage === 'nurture_why_sent') {
            await sendNurtureHow({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_how_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurture10++; totalSent++;
          }

          // Day 14: Processing dates fill up — soft urgency
          if (daysSinceApproval >= 14 && sequenceStage === 'nurture_how_sent') {
            await sendNurtureUrgency({ firstName, email, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_urgency_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurtureMerch++; totalSent++;
          }

          // Day 21: Merch email — wear the mission
          if (daysSinceApproval >= 21 && sequenceStage === 'nurture_urgency_sent') {
            await sendMerchEmail({ firstName, email });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_merch_sent',
              'Sequence Sent At': new Date().toISOString(),
            });
            nurtureMerch++; totalSent++;
          }

          // Day 30: Referral ask — know someone who'd love this?
          if (daysSinceApproval >= 30 && sequenceStage === 'nurture_merch_sent') {
            const referralLink = `${SITE_URL}/access`;
            await sendNurtureReferral({ firstName, email, referralLink, loginUrl });
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'nurture_referral_sent',
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
            // Use the cached referrals map — was re-fetching all referrals
            // from Airtable on every Day-7-eligible consumer (the timeout
            // cause). Lookup is O(1) now.
            const activeReferral = referralsByBuyer.get(consumerId);
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

      // Only pace when we ACTUALLY sent something — Airtable rate limit
      // applies to writes, not iterations. No-op consumers cost ~0ms so we
      // can iterate the full 1200+ list quickly looking for who needs an
      // email, then pace 250ms between actual sends.
      if (totalSent > sentBeforeIter) {
        sentBeforeIter = totalSent;
        await sleep(250);
      }
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

    return NextResponse.json({ success: true, sent: total + rancherReminders + abandonedRecovered, abandonedRecovered, nurture3, nurture10, nurtureMerch, nurtureAffiliate, beefDay3, beefDay7, community7, community14, introCheckin, rancherReminders, errors });
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
