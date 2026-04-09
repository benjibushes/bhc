import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramReferralNotification, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail, sendBuyerIntroNotification } from '@/lib/email';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(request: Request) {
  try {
    // Allow admin (via cookie) or internal calls (via shared secret header)
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const authHeader = request.headers.get('x-internal-secret') || '';
    const cookieStore = await cookies();
    const adminCookie = cookieStore.get('bhc-admin-auth');
    const isAdmin = adminCookie?.value === 'authenticated';
    const isInternal = internalSecret && authHeader === internalSecret;

    if (!isAdmin && !isInternal) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      buyerState, buyerId, buyerName, buyerEmail, buyerPhone,
      orderType, budgetRange, intentScore, intentClassification, notes,
      campaign,
    } = body;

    if (!buyerState || !buyerId) {
      return NextResponse.json({ error: 'buyerState and buyerId are required' }, { status: 400 });
    }

    const allRanchers: any[] = await getAllRecords(TABLES.RANCHERS);

    // Helper: check if rancher is active, signed, and under capacity
    const isEligibleBase = (r: any) => {
      const activeStatus = r['Active Status'] || '';
      const agreementSigned = r['Agreement Signed'] || false;
      const onboardingStatus = r['Onboarding Status'] || '';
      const maxReferrals = r['Max Active Referalls'] || 5;
      const currentReferrals = r['Current Active Referrals'] || 0;
      if (activeStatus !== 'Active') return false;
      if (!agreementSigned) return false;
      if (onboardingStatus && onboardingStatus !== 'Live') return false;
      if (currentReferrals >= maxReferrals) return false;
      return true;
    };

    // ── PRIORITY: If lead came from a specific rancher's page, assign to THAT rancher ──
    // Always assign to the page rancher — even at capacity. They clicked "Buy" on THIS rancher.
    // Only require Active + Agreement Signed (skip capacity check for direct page leads).
    let directMatchRancher: any = null;
    let matchType: string | null = null;
    if (campaign && campaign.startsWith('rancher-')) {
      const rancherSlug = campaign.replace('rancher-', '');
      directMatchRancher = allRanchers.find((r: any) => {
        const slug = r['Slug'] || '';
        const activeStatus = r['Active Status'] || '';
        const agreementSigned = r['Agreement Signed'] || false;
        const onboardingStatus = r['Onboarding Status'] || '';
        return slug === rancherSlug && activeStatus === 'Active' && agreementSigned &&
          (!onboardingStatus || onboardingStatus === 'Live');
      });
      if (directMatchRancher) {
        matchType = 'direct';
      }
    }

    let topMatch: any = null;

    if (directMatchRancher) {
      // Lead came from this rancher's page — assign directly to them
      topMatch = directMatchRancher;
    } else {
      // Standard matching: local first, then nationwide
      const localEligible = allRanchers.filter((r: any) => {
        if (!isEligibleBase(r)) return false;
        const state = r['State'] || '';
        const statesServed = r['States Served'] || '';
        return (
          state === buyerState ||
          (typeof statesServed === 'string' && statesServed.split(',').map((s: string) => s.trim()).includes(buyerState)) ||
          (Array.isArray(statesServed) && statesServed.includes(buyerState))
        );
      });

      const nationwideEligible = allRanchers.filter((r: any) => {
        if (!isEligibleBase(r)) return false;
        return r['Ships Nationwide'] === true || r['Ships Nationwide'] === 1;
      });

      const eligible = localEligible.length > 0 ? localEligible : nationwideEligible;
      matchType = localEligible.length > 0 ? 'local' : nationwideEligible.length > 0 ? 'nationwide' : null;

      eligible.sort((a: any, b: any) => {
        const aRefs = a['Current Active Referrals'] || 0;
        const bRefs = b['Current Active Referrals'] || 0;
        if (aRefs !== bRefs) return aRefs - bRefs;

        const aDate = a['Last Assigned At'] ? new Date(a['Last Assigned At']).getTime() : 0;
        const bDate = b['Last Assigned At'] ? new Date(b['Last Assigned At']).getTime() : 0;
        if (aDate !== bDate) return aDate - bDate;

        const aScore = a['Performance Score'] || 50;
        const bScore = b['Performance Score'] || 50;
        return bScore - aScore;
      });

      topMatch = eligible.length > 0 ? eligible[0] : null;
    }

    const referralFields: Record<string, any> = {
      'Buyer': [buyerId],
      'Status': 'Pending Approval',
      'Buyer Name': buyerName || '',
      'Buyer Email': buyerEmail || '',
      'Buyer Phone': buyerPhone || '',
      'Buyer State': buyerState,
      'Order Type': orderType || '',
      'Budget Range': budgetRange || '',
      'Intent Score': intentScore || 0,
      'Intent Classification': intentClassification || '',
      'Notes': notes || '',
    };

    if (topMatch) {
      referralFields['Suggested Rancher'] = [topMatch.id];
      referralFields['Suggested Rancher Name'] = topMatch['Operator Name'] || topMatch['Ranch Name'] || '';
      referralFields['Suggested Rancher State'] = topMatch['State'] || '';
      if (matchType === 'direct') {
        referralFields['Match Type'] = 'Direct (Rancher Page)';
      } else if (matchType === 'nationwide') {
        referralFields['Match Type'] = 'Nationwide';
      } else {
        referralFields['Match Type'] = 'Local';
      }
    }

    let referral: any;
    try {
      referral = await createRecord(TABLES.REFERRALS, referralFields);
    } catch (e: any) {
      console.warn('Could not create referral record:', e?.message);
      return NextResponse.json({
        success: false,
        error: 'Referrals table not accessible. Please check Airtable API token permissions.',
        matchFound: !!topMatch,
        suggestedRancher: topMatch ? {
          id: topMatch.id,
          name: topMatch['Operator Name'] || topMatch['Ranch Name'],
          state: topMatch['State'],
        } : null,
      }, { status: 503 });
    }

    // Increment rancher's active referral count so capacity limit works in real-time
    const now = new Date().toISOString();
    if (topMatch) {
      try {
        const currentRefs = topMatch['Current Active Referrals'] || 0;
        const newRefs = currentRefs + 1;
        await updateRecord(TABLES.RANCHERS, topMatch.id, {
          'Current Active Referrals': newRefs,
          'Last Assigned At': now,
        });

        // Capacity alerts
        const maxRefs = topMatch['Max Active Referalls'] || 5;
        const rancherName = topMatch['Operator Name'] || topMatch['Ranch Name'] || 'Unknown';
        const rancherState = topMatch['State'] || 'Unknown';
        if (maxRefs > 0) {
          const capacityPct = newRefs / maxRefs;
          if (newRefs >= maxRefs) {
            // 100% — at capacity
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `🔴 <b>AT CAPACITY:</b> ${rancherName} in ${rancherState} is FULL (${newRefs}/${maxRefs}). New leads in ${rancherState} will waitlist until capacity frees up.`
              );
            } catch (e) {
              console.error('Error sending capacity-full Telegram alert:', e);
            }
          } else if (capacityPct >= 0.8) {
            // 80%+ — warning
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `⚠️ <b>CAPACITY ALERT:</b> ${rancherName} in ${rancherState} is at ${newRefs}/${maxRefs} referrals (80%+). Consider recruiting another rancher in ${rancherState}.`
              );
            } catch (e) {
              console.error('Error sending capacity-warning Telegram alert:', e);
            }
          }
        }
      } catch (e) {
        console.error('Error incrementing rancher referral count:', e);
      }
    }

    // ── AUTO-APPROVE: Direct rancher page leads get instant intro (no Telegram wait) ──
    if (matchType === 'direct' && topMatch) {
      try {
        // Update referral to Intro Sent immediately
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'Status': 'Intro Sent',
          'Rancher': [topMatch.id],
          'Approved At': now,
          'Intro Sent At': now,
        });

        // Update consumer status
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Referral Status': 'Intro Sent',
        });

        const rancherName = topMatch['Operator Name'] || topMatch['Ranch Name'] || '';
        const rancherEmail = topMatch['Email'] || '';
        const rancherPhone = topMatch['Phone'] || '';

        // Send rancher the buyer's info
        if (rancherEmail) {
          await sendEmail({
            to: rancherEmail,
            subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
              <h1 style="font-family:Georgia,serif;">New Qualified Buyer Lead</h1>
              <p>Hi ${rancherName},</p>
              <p>A buyer just clicked to purchase through your BuyHalfCow page and has been automatically connected to you:</p>
              <p><strong>Buyer:</strong> ${buyerName}</p>
              <p><strong>Email:</strong> ${buyerEmail}</p>
              ${buyerPhone ? `<p><strong>Phone:</strong> ${buyerPhone}</p>` : ''}
              <p><strong>State:</strong> ${buyerState}</p>
              <p><strong>Order:</strong> ${orderType || 'Not specified'}</p>
              ${budgetRange ? `<p><strong>Budget:</strong> ${budgetRange}</p>` : ''}
              ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
              <p>Reach out directly to close the sale. Reply-all to keep me in the loop.</p>
              <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow</p>
            </div>`,
          });
        }

        // Send buyer the rancher's info
        if (buyerEmail) {
          const buyerToken = jwt.sign(
            { type: 'member-login', consumerId: buyerId, email: buyerEmail.trim().toLowerCase() },
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
            rancherSlug: topMatch['Slug'] || '',
            loginUrl: buyerLoginUrl,
          });
        }

        // Info-only Telegram notification (no buttons)
        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `✅ <b>AUTO-APPROVED (Direct Page Lead)</b>\n\n` +
            `👤 ${buyerName} in ${buyerState}\n` +
            `🤠 → ${rancherName}\n` +
            `📦 ${orderType || 'Not specified'}\n` +
            `Intro emails sent to both parties automatically.`
          );
        } catch (e) {
          console.error('Telegram auto-approve notification error:', e);
        }
      } catch (e) {
        console.error('Error auto-approving direct page lead:', e);
      }
    } else {
      // Standard flow: set to Pending Approval and wait for Telegram approval
      try {
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Referral Status': topMatch ? 'Pending Approval' : 'Waitlisted',
        });
      } catch (e) {
        console.error('Error updating consumer referral status:', e);
      }

      // Send Telegram notification with approval buttons
      try {
        await sendTelegramReferralNotification({
          referralId: referral.id,
          buyerName: buyerName || 'Unknown',
          buyerState,
          orderType: orderType || 'Not specified',
          budgetRange: budgetRange || 'Not specified',
          intentScore: intentScore || 0,
          intentClassification: intentClassification || 'N/A',
          notes: notes || '',
          matchType: matchType || undefined,
          suggestedRancher: topMatch ? {
            name: topMatch['Operator Name'] || topMatch['Ranch Name'] || 'Unknown',
            activeReferrals: topMatch['Current Active Referrals'] || 0,
            maxReferrals: topMatch['Max Active Referalls'] || 5,
          } : null,
        });
      } catch (e) {
        console.error('Error sending Telegram notification:', e);
      }
    }

    return NextResponse.json({
      success: true,
      referralId: referral.id,
      matchFound: !!topMatch,
      matchType,
      suggestedRancher: topMatch ? {
        id: topMatch.id,
        name: topMatch['Operator Name'] || topMatch['Ranch Name'],
        state: topMatch['State'],
        shipsNationwide: topMatch['Ships Nationwide'] === true,
        activeReferrals: topMatch['Current Active Referrals'] || 0,
        maxReferrals: topMatch['Max Active Referalls'] || 5,
      } : null,
    });
  } catch (error: any) {
    console.error('Matching engine error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
