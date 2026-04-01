import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendConsumerApproval, sendWaitlistEmail, sendBackfillEmail, sendRancherGoLiveEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs daily at 9am MT — processes pending consumers who qualify for auto-approval
// and kicks off rancher matching for approved Beef Buyers
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

        // Approve ALL consumers — no intent gate
        const now = new Date().toISOString();
        await updateRecord(TABLES.CONSUMERS, consumerId, { 'Status': 'Approved', 'Approved At': now });

        // Generate login URL for all consumers with email
        const loginUrl = email ? `${SITE_URL}/member/verify?token=${jwt.sign(
          { type: 'member-login', consumerId, email: email.trim().toLowerCase() },
          JWT_SECRET,
          { expiresIn: '7d' }
        )}` : '';

        // Send magic link email + backfill survey for anyone missing order details
        if (email) {
          try {
            await sendConsumerApproval({ firstName, email, loginUrl, segment });
          } catch (emailErr) {
            console.error(`Failed to send approval email to ${email}:`, emailErr);
          }

          // Send backfill survey if we don't know what they want yet
          const missingOrderDetails = !consumer['Order Type'] && !consumer['Budget'];
          if (missingOrderDetails) {
            try {
              await sendBackfillEmail({ firstName, email, loginUrl });
            } catch (emailErr) {
              console.error(`Failed to send backfill email to ${email}:`, emailErr);
            }
          }
        }

        approved++;

        // Trigger matching for Beef Buyers
        if (segment === 'Beef Buyer' && consumer['State']) {
          try {
            const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
              },
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
                  await sendWaitlistEmail({ firstName, email, state: consumer['State'], loginUrl });
                  await updateRecord(TABLES.CONSUMERS, consumerId, { 'Sequence Stage': 'waitlisted' });
                }
              }
            } else {
              // Match API error — still no rancher, notify via waitlist
              const currentStage = consumer['Sequence Stage'] || 'none';
              if (currentStage !== 'waitlisted' && email) {
                await sendWaitlistEmail({ firstName, email, state: consumer['State'], loginUrl });
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

      // Respect Airtable's 5 req/sec limit — each consumer makes ~3-4 calls
      await sleep(250);
    }

    // ── Auto-go-live for verified ranchers with complete pages ──────────────
    let ranchersGoLive = 0;
    try {
      const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
      const readyToGoLive = allRanchers.filter((r: any) => {
        if (r['Onboarding Status'] !== 'Verification Complete') return false;
        if (r['Page Live'] === true) return false;
        // Required: Slug + About Text + at least 1 payment link
        if (!r['Slug']) return false;
        if (!r['About Text']) return false;
        const hasPaymentLink = !!(r['Quarter Payment Link'] || r['Half Payment Link'] || r['Whole Payment Link']);
        if (!hasPaymentLink) return false;
        return true;
      });

      for (const rancher of readyToGoLive) {
        try {
          await updateRecord(TABLES.RANCHERS, rancher.id, {
            'Page Live': true,
            'Onboarding Status': 'Live',
            'Active Status': 'Active',
          });

          const email = rancher['Email'];
          const operatorName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Partner';
          const ranchName = rancher['Ranch Name'] || '';
          if (email) {
            await sendRancherGoLiveEmail({
              operatorName,
              ranchName,
              email,
              dashboardUrl: `${SITE_URL}/rancher`,
            });
          }
          ranchersGoLive++;
        } catch (e: any) {
          console.error('Auto-go-live error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Auto-go-live query error:', e.message);
    }

    const summary = `✅ <b>Batch Approval Complete</b>

📥 Pending reviewed: ${pending.length}
✅ Approved: ${approved}
🤝 Matched to ranchers: ${matched}${ranchersGoLive > 0 ? `\n🚀 Ranchers auto-published: ${ranchersGoLive}` : ''}${errors.length > 0 ? `\n⚠️ Errors: ${errors.length} (${errors.slice(0, 3).join(', ')})` : ''}`;

    await sendTelegramUpdate(summary);

    return NextResponse.json({ success: true, approved, matched, ranchersGoLive, errors: errors.length });
  } catch (error: any) {
    console.error('Batch approve error:', error);
    await sendTelegramUpdate(`⚠️ Batch approval cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
