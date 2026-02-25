import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramReferralNotification } from '@/lib/telegram';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      buyerState, buyerId, buyerName, buyerEmail, buyerPhone,
      orderType, budgetRange, intentScore, intentClassification, notes,
    } = body;

    if (!buyerState || !buyerId) {
      return NextResponse.json({ error: 'buyerState and buyerId are required' }, { status: 400 });
    }

    const allRanchers: any[] = await getAllRecords(TABLES.RANCHERS);

    const eligible = allRanchers.filter((r: any) => {
      const activeStatus = r['Active Status'] || '';
      const agreementSigned = r['Agreement Signed'] || false;
      const onboardingStatus = r['Onboarding Status'] || '';
      const state = r['State'] || '';
      const statesServed = r['States Served'] || '';
      const maxReferrals = r['Max Active Referrals'] || 5;
      const currentReferrals = r['Current Active Referrals'] || 0;

      if (activeStatus !== 'Active') return false;
      if (!agreementSigned) return false;
      if (onboardingStatus && onboardingStatus !== 'Live') return false;

      const servesState =
        state === buyerState ||
        (typeof statesServed === 'string' && statesServed.split(',').map((s: string) => s.trim()).includes(buyerState)) ||
        (Array.isArray(statesServed) && statesServed.includes(buyerState));

      if (!servesState) return false;
      if (currentReferrals >= maxReferrals) return false;

      return true;
    });

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

    // Update consumer referral status
    try {
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Referral Status': 'Pending Approval',
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
        suggestedRancher: topMatch ? {
          name: topMatch['Operator Name'] || topMatch['Ranch Name'] || 'Unknown',
          activeReferrals: topMatch['Current Active Referrals'] || 0,
          maxReferrals: topMatch['Max Active Referrals'] || 5,
        } : null,
      });
    } catch (e) {
      console.error('Error sending Telegram notification:', e);
    }

    return NextResponse.json({
      success: true,
      referralId: referral.id,
      matchFound: !!topMatch,
      suggestedRancher: topMatch ? {
        id: topMatch.id,
        name: topMatch['Operator Name'] || topMatch['Ranch Name'],
        state: topMatch['State'],
        activeReferrals: topMatch['Current Active Referrals'] || 0,
        maxReferrals: topMatch['Max Active Referrals'] || 5,
      } : null,
    });
  } catch (error: any) {
    console.error('Matching engine error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
