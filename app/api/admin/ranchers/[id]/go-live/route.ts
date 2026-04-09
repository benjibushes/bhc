import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Check admin auth cookie
    const cookieStore = await cookies();
    const authCookie = cookieStore.get('bhc-admin-auth');

    if (authCookie?.value !== 'authenticated') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;

    await updateRecord(TABLES.RANCHERS, id, { 'Page Live': true });

    // Waitlist blast: auto-match waiting buyers in this rancher's state(s)
    let matched = 0;
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, id);
      const ranchName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
      const rancherState = rancher['State'] || '';
      const statesServedRaw = rancher['States Served'] || '';
      const statesServed: string[] = Array.isArray(statesServedRaw)
        ? statesServedRaw
        : typeof statesServedRaw === 'string'
          ? statesServedRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
          : [];

      const allStates = new Set<string>();
      if (rancherState) allStates.add(rancherState);
      statesServed.forEach((s: string) => allStates.add(s));

      if (allStates.size > 0) {
        const allConsumers: any[] = await getAllRecords(TABLES.CONSUMERS);
        const waitingBuyers = allConsumers.filter((c: any) => {
          const status = c['Status'] || '';
          const refStatus = c['Referral Status'] || '';
          const consumerState = c['State'] || '';
          if (status !== 'Approved') return false;
          if (refStatus !== 'Unmatched' && refStatus !== 'Waitlisted') return false;
          return allStates.has(consumerState);
        }).slice(0, 50);

        for (const buyer of waitingBuyers) {
          try {
            const res = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(INTERNAL_API_SECRET ? { 'x-internal-secret': INTERNAL_API_SECRET } : {}),
              },
              body: JSON.stringify({
                buyerId: buyer.id,
                buyerState: buyer['State'] || '',
                buyerName: buyer['Full Name'] || '',
                buyerEmail: buyer['Email'] || '',
                buyerPhone: buyer['Phone'] || '',
                orderType: buyer['Order Type'] || '',
                budgetRange: buyer['Budget'] || buyer['Budget Range'] || '',
                intentScore: buyer['Intent Score'] || 0,
                intentClassification: buyer['Intent Classification'] || '',
                notes: buyer['Notes'] || '',
              }),
            });
            if (res.ok) {
              const result = await res.json();
              if (result.matchFound) matched++;
            }
          } catch (e) {
            console.error(`Waitlist blast (admin): error matching ${buyer['Full Name'] || buyer.id}:`, e);
          }
        }

        // Notify via Telegram
        if (matched > 0) {
          try {
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `🚀 <b>${ranchName}</b> is LIVE in <b>${rancherState}</b> — auto-matched <b>${matched}</b> waiting buyer${matched === 1 ? '' : 's'}`
            );
          } catch (e) {
            console.error('Telegram waitlist blast notification error:', e);
          }
        }
      }
    } catch (e) {
      console.error('Waitlist blast error (admin go-live):', e);
    }

    return NextResponse.json({ success: true, matched });
  } catch (error: any) {
    console.error('Error setting rancher page live:', error);
    return NextResponse.json({ error: error.message || 'Failed to go live' }, { status: 500 });
  }
}
