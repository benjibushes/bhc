import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, createRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendEmail, sendBuyerIntroNotification } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// One-off bulk-processing endpoint.
// Routes all stuck consumers in a given state to a target rancher:
//   - Cancels duplicate Pending Approval referrals (keeps latest per consumer)
//   - Updates the latest stuck referral to Intro Sent, points at target rancher, sends intro emails
//   - Creates fresh Intro Sent referrals for Unmatched/Waitlisted consumers, sends intro emails
// Call: GET /api/admin/route-state-to-rancher?password=ADMIN_PASSWORD&state=CO&slug=the-high-lonesome-ranch
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pw = searchParams.get('password');
  if (pw !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const state = (searchParams.get('state') || 'CO').toUpperCase();
  const slug = searchParams.get('slug') || 'the-high-lonesome-ranch';
  const dryRun = searchParams.get('dry_run') === 'true';

  try {
    // 1. Find target rancher
    const allRanchers: any[] = await getAllRecords(TABLES.RANCHERS);
    const rancher = allRanchers.find((r: any) => (r['Slug'] || '') === slug);
    if (!rancher) {
      return NextResponse.json({ error: `Rancher with slug "${slug}" not found` }, { status: 404 });
    }
    const rancherId = rancher.id;
    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const rancherEmail = rancher['Email'] || '';
    const rancherPhone = rancher['Phone'] || '';
    const rancherSlug = rancher['Slug'] || '';

    // Validate the rancher is actually live
    if (rancher['Active Status'] !== 'Active') {
      return NextResponse.json({ error: `Rancher "${rancherName}" is not Active` }, { status: 400 });
    }

    // 2. Find all consumers in the state with Status=Approved (could be stuck in various referral statuses)
    const consumers: any[] = await getAllRecords(
      TABLES.CONSUMERS,
      `AND({State} = "${escapeAirtableValue(state)}", {Status} = "Approved")`
    );

    // 3. Find all existing referrals in the state
    const referrals: any[] = await getAllRecords(
      TABLES.REFERRALS,
      `{Buyer State} = "${escapeAirtableValue(state)}"`
    );

    // Index referrals by consumer email
    const refsByEmail: Record<string, any[]> = {};
    for (const r of referrals) {
      const email = (r['Buyer Email'] || '').toLowerCase().trim();
      if (!email) continue;
      if (!refsByEmail[email]) refsByEmail[email] = [];
      refsByEmail[email].push(r);
    }

    const now = new Date().toISOString();
    const summary = {
      state,
      targetRancher: rancherName,
      dryRun,
      totalConsumers: consumers.length,
      processed: 0,
      skipped_already_intro_sent: 0,
      updated_stuck_referral: 0,
      created_new_referral: 0,
      canceled_duplicates: 0,
      emails_sent_rancher: 0,
      emails_sent_buyer: 0,
      errors: [] as string[],
      details: [] as any[],
    };

    for (const consumer of consumers) {
      try {
        const buyerId = consumer.id;
        const buyerEmail = (consumer['Email'] || '').toLowerCase().trim();
        const buyerName = consumer['Full Name'] || '';
        const buyerPhone = consumer['Phone'] || '';
        const buyerState = consumer['State'] || state;
        const orderType = consumer['Order Type'] || '';
        const budgetRange = consumer['Budget'] || '';
        const notes = consumer['Notes'] || '';
        const intentScore = consumer['Intent Score'] || 0;
        const intentClassification = consumer['Intent Classification'] || '';
        const referralStatus = consumer['Referral Status'] || '';

        if (!buyerEmail) continue;

        // If they already have an active Intro Sent referral, skip
        const myRefs = refsByEmail[buyerEmail] || [];
        const activeIntroSent = myRefs.find((r: any) =>
          ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Closed Won'].includes(r['Status'])
        );
        if (activeIntroSent) {
          summary.skipped_already_intro_sent++;
          continue;
        }

        summary.processed++;

        // Find Pending Approval referrals (any will do — all are for the same consumer)
        const pendingRefs = myRefs.filter((r: any) => r['Status'] === 'Pending Approval');

        let targetReferralId: string;

        if (pendingRefs.length > 0) {
          // Update the most recent Pending Approval referral
          targetReferralId = pendingRefs[0].id;
          if (!dryRun) {
            await updateRecord(TABLES.REFERRALS, targetReferralId, {
              'Status': 'Intro Sent',
              'Rancher': [rancherId],
              'Suggested Rancher': [rancherId],
              'Suggested Rancher Name': rancherName,
              'Suggested Rancher State': rancher['State'] || state,
              'Match Type': 'Local',
              'Approved At': now,
              'Intro Sent At': now,
            });
          }
          summary.updated_stuck_referral++;

          // Close any duplicate Pending Approval referrals for this consumer
          for (let i = 1; i < pendingRefs.length; i++) {
            if (!dryRun) {
              try {
                await updateRecord(TABLES.REFERRALS, pendingRefs[i].id, {
                  'Status': 'Closed Lost',
                  'Closed At': now,
                  'Notes': `${pendingRefs[i]['Notes'] || ''}\n[Auto-closed duplicate — primary referral routed to ${rancherName}]`.trim(),
                });
              } catch (e: any) {
                summary.errors.push(`Close duplicate ${pendingRefs[i].id}: ${e.message}`);
              }
            }
            summary.canceled_duplicates++;
          }
        } else {
          // No existing Pending Approval — create a new Intro Sent referral
          if (!dryRun) {
            const newRef: any = await createRecord(TABLES.REFERRALS, {
              'Buyer': [buyerId],
              'Status': 'Intro Sent',
              'Buyer Name': buyerName,
              'Buyer Email': buyerEmail,
              'Buyer Phone': buyerPhone,
              'Buyer State': buyerState,
              'Order Type': orderType,
              'Budget Range': budgetRange,
              'Intent Score': intentScore,
              'Intent Classification': intentClassification,
              'Notes': notes,
              'Rancher': [rancherId],
              'Suggested Rancher': [rancherId],
              'Suggested Rancher Name': rancherName,
              'Suggested Rancher State': rancher['State'] || state,
              'Match Type': 'Local',
              'Approved At': now,
              'Intro Sent At': now,
            });
            targetReferralId = newRef.id;
          } else {
            targetReferralId = 'dry-run';
          }
          summary.created_new_referral++;
        }

        // Update consumer referral status
        if (!dryRun) {
          try {
            await updateRecord(TABLES.CONSUMERS, buyerId, {
              'Referral Status': 'Intro Sent',
            });
          } catch (e: any) {
            summary.errors.push(`Update consumer ${buyerId} status: ${e.message}`);
          }
        }

        // Send rancher intro email
        if (!dryRun && rancherEmail) {
          try {
            await sendEmail({
              to: rancherEmail,
              subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                <h1 style="font-family:Georgia,serif;">New Qualified Buyer Lead</h1>
                <p>Hi ${rancherName},</p>
                <p>A qualified buyer in your area came through BuyHalfCow and has been connected to you:</p>
                <p><strong>Buyer:</strong> ${buyerName}</p>
                <p><strong>Email:</strong> ${buyerEmail}</p>
                ${buyerPhone ? `<p><strong>Phone:</strong> ${buyerPhone}</p>` : ''}
                <p><strong>State:</strong> ${buyerState}</p>
                <p><strong>Order:</strong> ${orderType || 'Not specified'}</p>
                ${budgetRange ? `<p><strong>Budget:</strong> ${budgetRange}</p>` : ''}
                ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
                <p>Reach out within 24 hours to close the sale. Reply-all to keep me in the loop.</p>
                <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow | 10% commission on BHC referral sales.</p>
              </div>`,
            });
            summary.emails_sent_rancher++;
          } catch (e: any) {
            summary.errors.push(`Rancher email for ${buyerEmail}: ${e.message}`);
          }
        }

        // Send buyer intro email
        if (!dryRun && buyerEmail) {
          try {
            const buyerToken = jwt.sign(
              { type: 'member-login', consumerId: buyerId, email: buyerEmail },
              JWT_SECRET,
              { expiresIn: '7d' }
            );
            const buyerLoginUrl = `${SITE_URL}/member/verify?token=${buyerToken}`;
            const buyerFirstName = (buyerName || '').split(' ')[0] || 'there';
            await sendBuyerIntroNotification({
              firstName: buyerFirstName,
              email: buyerEmail,
              rancherName,
              rancherEmail,
              rancherPhone,
              rancherSlug,
              loginUrl: buyerLoginUrl,
            });
            summary.emails_sent_buyer++;
          } catch (e: any) {
            summary.errors.push(`Buyer email for ${buyerEmail}: ${e.message}`);
          }
        }

        summary.details.push({
          name: buyerName,
          email: buyerEmail,
          order: orderType,
          budget: budgetRange,
          intent: intentClassification,
          prev_referral_status: referralStatus,
          action: pendingRefs.length > 0 ? 'updated_stuck' : 'created_new',
          referralId: targetReferralId,
        });
      } catch (e: any) {
        summary.errors.push(`Consumer ${consumer.id}: ${e.message}`);
      }
    }

    // Increment rancher's active referral count
    if (!dryRun) {
      try {
        const netNew = summary.updated_stuck_referral + summary.created_new_referral;
        if (netNew > 0) {
          const currentRefs = rancher['Current Active Referrals'] || 0;
          await updateRecord(TABLES.RANCHERS, rancherId, {
            'Current Active Referrals': currentRefs + netNew,
            'Last Assigned At': now,
          });
        }
      } catch (e: any) {
        summary.errors.push(`Increment rancher count: ${e.message}`);
      }
    }

    // Telegram summary
    if (!dryRun) {
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚀 <b>BULK ROUTE COMPLETE</b>\n\n` +
          `State: ${state} → ${rancherName}\n\n` +
          `✅ Processed: ${summary.processed}\n` +
          `🔄 Updated stuck: ${summary.updated_stuck_referral}\n` +
          `🆕 New referrals: ${summary.created_new_referral}\n` +
          `🗑 Canceled dupes: ${summary.canceled_duplicates}\n` +
          `⏭ Skipped (already intro sent): ${summary.skipped_already_intro_sent}\n\n` +
          `📧 Rancher emails sent: ${summary.emails_sent_rancher}\n` +
          `📧 Buyer emails sent: ${summary.emails_sent_buyer}\n\n` +
          `${summary.errors.length > 0 ? `⚠️ Errors: ${summary.errors.length}` : '✨ No errors'}`
        );
      } catch (e) {
        console.error('Telegram bulk summary error:', e);
      }
    }

    return NextResponse.json(summary);
  } catch (error: any) {
    console.error('Bulk route error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
