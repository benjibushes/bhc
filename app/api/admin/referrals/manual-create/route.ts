import { NextResponse } from 'next/server';
import { createRecord, updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';

// POST /api/admin/referrals/manual-create
// Creates a referral from scratch when the matching engine missed a pairing.
// Body: { buyerId: string, rancherId: string, notes?: string }
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { buyerId, rancherId, notes } = body;

    if (!buyerId || !rancherId) {
      return NextResponse.json({ error: 'buyerId and rancherId required' }, { status: 400 });
    }

    const [buyer, rancher] = await Promise.all([
      getRecordById(TABLES.CONSUMERS, buyerId),
      getRecordById(TABLES.RANCHERS, rancherId),
    ]) as [any, any];

    if (!buyer) return NextResponse.json({ error: 'Buyer not found' }, { status: 404 });
    if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

    // Capacity check
    const cap = Number(rancher['Max Active Referalls']) || 5;
    const current = Number(rancher['Current Active Referrals']) || 0;
    if (current >= cap) {
      return NextResponse.json({
        error: `${rancher['Operator Name'] || 'Rancher'} is at capacity (${current}/${cap})`
      }, { status: 400 });
    }

    const now = new Date().toISOString();
    const referral = await createRecord(TABLES.REFERRALS, {
      'Buyer': [buyerId],
      'Rancher': [rancherId],
      'Suggested Rancher': [rancherId],
      'Status': 'Pending Approval',
      'Buyer Name': buyer['Full Name'] || '',
      'Buyer Email': buyer['Email'] || '',
      'Buyer Phone': buyer['Phone'] || '',
      'Buyer State': buyer['State'] || '',
      'Order Type': buyer['Order Type']?.name || buyer['Order Type'] || '',
      'Budget Range': buyer['Budget']?.name || buyer['Budget'] || '',
      'Intent Score': Number(buyer['Intent Score']) || 0,
      'Intent Classification': buyer['Intent Classification']?.name || buyer['Intent Classification'] || '',
      'Suggested Rancher Name': rancher['Operator Name'] || rancher['Ranch Name'] || '',
      'Suggested Rancher State': rancher['State'] || '',
      'Match Type': 'Manual',
      'Notes': `[MANUAL CREATE ${now.slice(0, 10)}]${notes ? ` ${notes}` : ''}`,
      'Approved At': now,
    });

    // Update consumer referral status + increment rancher counter
    await Promise.all([
      updateRecord(TABLES.CONSUMERS, buyerId, {
        'Referral Status': 'Pending Approval',
      }).catch((e) => console.error('Consumer status update error:', e)),
      updateRecord(TABLES.RANCHERS, rancherId, {
        'Current Active Referrals': current + 1,
        'Last Assigned At': now,
      }).catch((e) => console.error('Rancher counter update error:', e)),
    ]);

    await sendTelegramUpdate(
      `✋ <b>MANUAL REFERRAL CREATED</b>\n👤 ${buyer['Full Name']} (${buyer['State'] || '?'}) → 🤠 ${rancher['Operator Name'] || rancher['Ranch Name']}${notes ? `\nNotes: ${notes}` : ''}\n<i>Approve it in /admin/referrals to fire the intro email.</i>`
    ).catch(() => {});

    return NextResponse.json({
      success: true,
      message: 'Referral created as Pending Approval. Approve to send intro.',
      referralId: referral.id,
    });
  } catch (error: any) {
    console.error('Manual referral create error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
