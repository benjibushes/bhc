import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramReferralNotification } from '@/lib/telegram';
import { cookies } from 'next/headers';

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

    // Local ranchers: serve the buyer's specific state
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

    // Nationwide ranchers: ships to all states (fallback if no local match)
    const nationwideEligible = allRanchers.filter((r: any) => {
      if (!isEligibleBase(r)) return false;
      return r['Ships Nationwide'] === true || r['Ships Nationwide'] === 1;
    });

    // Prefer local; fall back to nationwide
    const eligible = localEligible.length > 0 ? localEligible : nationwideEligible;
    const matchType: 'local' | 'nationwide' | null =
      localEligible.length > 0 ? 'local' : nationwideEligible.length > 0 ? 'nationwide' : null;

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

    const topMatch = eligible.length > 0 ? eligible[0] : null;

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
      if (matchType === 'nationwide') {
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
    if (topMatch) {
      try {
        const currentRefs = topMatch['Current Active Referrals'] || 0;
        await updateRecord(TABLES.RANCHERS, topMatch.id, {
          'Current Active Referrals': currentRefs + 1,
          'Last Assigned At': new Date().toISOString(),
        });
      } catch (e) {
        console.error('Error incrementing rancher referral count:', e);
      }
    }

    try {
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Referral Status': topMatch ? 'Pending Approval' : 'Waitlisted',
      });
    } catch (e) {
      console.error('Error updating consumer referral status:', e);
    }

    // Send Telegram notification
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
