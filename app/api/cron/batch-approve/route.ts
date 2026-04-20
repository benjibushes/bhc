import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendConsumerApproval, sendWaitlistEmail, sendBackfillEmail, sendRancherGoLiveEmail } from '@/lib/email';
import { sendTelegramUpdate, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { bulkRouteStateToRancher, getRancherServedStates } from '@/lib/bulkRoute';
import jwt from 'jsonwebtoken';

export const maxDuration = 120;

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs daily at 9am MT — processes pending consumers who qualify for auto-approval
// and kicks off rancher matching for approved Beef Buyers
async function handler(request: Request) {
  try {
    // Maintenance short-circuit: do nothing while the platform is paused.
    if (isMaintenanceMode()) return maintenanceResponse('batch-approve');

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

    // ── CAPACITY COUNTER SELF-HEAL ──────────────────────────────────────────
    // The increment/decrement counter on ranchers can drift (missed decrements,
    // manual Airtable edits, etc.). Reconcile from actual active referrals so
    // the matching engine uses correct capacity numbers.
    let capacityFixed = 0;
    try {
      const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
      const allReferrals = await getAllRecords(TABLES.REFERRALS) as any[];
      const activeStatuses = ['Pending Approval', 'Intro Sent', 'Rancher Contacted', 'Negotiation'];

      // Count actual active referrals per rancher
      const actualCounts: Record<string, number> = {};
      for (const ref of allReferrals) {
        if (!activeStatuses.includes(ref['Status'])) continue;
        const rIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
        const rId = Array.isArray(rIds) ? rIds[0] : null;
        if (rId) {
          actualCounts[rId] = (actualCounts[rId] || 0) + 1;
        }
      }

      // Fix any rancher where the stored counter doesn't match reality
      for (const rancher of allRanchers) {
        const stored = rancher['Current Active Referrals'] || 0;
        const actual = actualCounts[rancher.id] || 0;
        if (stored !== actual) {
          try {
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Current Active Referrals': actual,
            });
            capacityFixed++;
            console.log(`Capacity fix: ${rancher['Operator Name'] || rancher['Ranch Name']} ${stored} → ${actual}`);
          } catch (e: any) {
            console.error(`Capacity fix error for ${rancher.id}:`, e.message);
          }
        }
      }
      if (capacityFixed > 0) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🔧 <b>Capacity Self-Heal</b>\n\nFixed ${capacityFixed} rancher(s) with drifted referral counters.`
        );
      }
    } catch (e: any) {
      console.error('Capacity self-heal error:', e.message);
    }

    // Get all unprocessed consumers — both explicit "Pending" AND blank-status
    // records. New signups arrive with no Status value and were previously being
    // silently skipped, stranding customers in a "can't log in" state.
    const pending = await getAllRecords(
      TABLES.CONSUMERS,
      `OR({Status} = "Pending", {Status} = "", {Status} = BLANK())`
    );

    if (pending.length === 0) {
      await sendTelegramUpdate('⏳ Batch approve ran — no pending consumers.');
      // Don't return yet — still need to retry waitlisted consumers below
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

          // ── AUTO-ROUTE STUCK BUYERS to this newly-live rancher ─────────
          // For every state this rancher serves, find stuck buyers and connect them.
          // Schedules emails for 9am MT next morning so we never spam buyers at 3am.
          try {
            const servedStates = getRancherServedStates({ ...rancher, 'Active Status': 'Active' });
            const tomorrow9amMT = (() => {
              const d = new Date();
              // 9am MT = 15:00 UTC (MDT) or 16:00 UTC (MST). Use 15:00 UTC as the safe slot.
              d.setUTCDate(d.getUTCDate() + 1);
              d.setUTCHours(15, 0, 0, 0);
              return d.toISOString();
            })();
            for (const stateCode of servedStates) {
              try {
                const result = await bulkRouteStateToRancher({
                  state: stateCode,
                  rancherSlug: rancher['Slug'] || '',
                  dryRun: false,
                  scheduledAt: tomorrow9amMT,
                });
                if (result.ok && (result.summary.processed > 0)) {
                  await sendTelegramMessage(
                    TELEGRAM_ADMIN_CHAT_ID,
                    `🚀 <b>AUTO-ROUTED on go-live</b>\n\n` +
                    `${operatorName} (${ranchName}) just went LIVE in ${stateCode}\n\n` +
                    `✅ Processed: ${result.summary.processed} stuck buyers\n` +
                    `🔄 Updated stuck refs: ${result.summary.updated_stuck_referral}\n` +
                    `🆕 New refs: ${result.summary.created_new_referral}\n` +
                    `📧 Emails scheduled for 9am MT tomorrow\n` +
                    `${result.summary.errors.length > 0 ? `⚠️ Errors: ${result.summary.errors.length}` : '✨ No errors'}`
                  );
                }
              } catch (e: any) {
                console.error(`Auto-route on go-live (${stateCode}) error:`, e.message);
              }
            }
          } catch (e: any) {
            console.error('Auto-route on go-live (outer) error:', e.message);
          }
        } catch (e: any) {
          console.error('Auto-go-live error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Auto-go-live query error:', e.message);
    }

    // ── WAITLISTED CONSUMER RETRY ───────────────────────────────────────────
    // Consumers who were previously approved but waitlisted (no rancher at the
    // time) get re-run through matching. This catches buyers who got stuck when
    // a rancher was at capacity but has since freed up (or capacity was healed).
    let waitlistedRetried = 0;
    let waitlistedMatched = 0;
    try {
      const waitlisted = await getAllRecords(
        TABLES.CONSUMERS,
        `AND({Status} = "Approved", {Segment} = "Beef Buyer", OR({Referral Status} = "Waitlisted", {Referral Status} = "Unmatched"))`
      ) as any[];

      for (const consumer of waitlisted) {
        const cState = consumer['State'];
        if (!cState) continue;

        // Skip if they already have an active referral (Intro Sent, Rancher Contacted, etc.)
        // This is double-checked inside matching/suggest too, but skip here to save API calls
        const existingRefStatus = consumer['Referral Status'] || '';
        if (['Intro Sent', 'Rancher Contacted', 'Negotiation'].includes(existingRefStatus)) continue;

        waitlistedRetried++;
        try {
          const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
            },
            body: JSON.stringify({
              buyerState: cState,
              buyerId: consumer.id,
              buyerName: consumer['Full Name'],
              buyerEmail: consumer['Email'],
              buyerPhone: consumer['Phone'],
              orderType: consumer['Order Type'],
              budgetRange: consumer['Budget'],
              intentScore: consumer['Intent Score'],
              intentClassification: consumer['Intent Classification'] || '',
              notes: consumer['Notes'],
            }),
          });
          if (matchRes.ok) {
            const matchData = await matchRes.json().catch(() => ({}));
            if (matchData.matchFound || matchData.referralId) {
              waitlistedMatched++;
            }
          }
        } catch (e: any) {
          console.error(`Waitlist retry error for ${consumer.id}:`, e.message);
        }
        await sleep(300);
      }

      if (waitlistedRetried > 0) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🔄 <b>Waitlist Retry</b>\n\n` +
          `Re-checked ${waitlistedRetried} waitlisted buyers\n` +
          `✅ Matched: ${waitlistedMatched}\n` +
          `⏳ Still waiting: ${waitlistedRetried - waitlistedMatched}`
        );
      }
    } catch (e: any) {
      console.error('Waitlisted retry error:', e.message);
    }

    const summary = `✅ <b>Batch Approval Complete</b>

📥 Pending reviewed: ${pending.length}
✅ Approved: ${approved}
🤝 Matched to ranchers: ${matched}${ranchersGoLive > 0 ? `\n🚀 Ranchers auto-published: ${ranchersGoLive}` : ''}${waitlistedMatched > 0 ? `\n🔄 Waitlisted re-matched: ${waitlistedMatched}/${waitlistedRetried}` : ''}${capacityFixed > 0 ? `\n🔧 Capacity counters fixed: ${capacityFixed}` : ''}${errors.length > 0 ? `\n⚠️ Errors: ${errors.length} (${errors.slice(0, 3).join(', ')})` : ''}`;

    await sendTelegramUpdate(summary);

    return NextResponse.json({ success: true, approved, matched, ranchersGoLive, waitlistedRetried, waitlistedMatched, capacityFixed, errors: errors.length });
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
