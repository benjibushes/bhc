import { NextResponse } from 'next/server';
import { createRecord, getAllRecords, getRecordById, updateRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendInquiryToRancher, sendInquiryAlertToAdmin } from '@/lib/email';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ip = getRequestIp(request);
    const rlMin = await rateLimit(`inquiry:${ip}`, { requests: 3, window: '1m' });
    if (!rlMin.ok) {
      return NextResponse.json(
        { error: 'Too many inquiries from this network — wait a minute and try again.' },
        { status: 429 }
      );
    }
    const rlHour = await rateLimit(`inquiry-hr:${ip}`, { requests: 10, window: '1h' });
    if (!rlHour.ok) {
      return NextResponse.json(
        { error: 'Too many inquiries from this network in the past hour. Email ben@buyhalfcow.com if this is wrong.' },
        { status: 429 }
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { consumerId, rancherId, consumerName, consumerEmail, consumerPhone, message, interestType, smsOptIn } = body;

    if (!rancherId || !consumerName || !consumerEmail || !message) {
      return NextResponse.json({ error: 'Missing required fields for inquiry' }, { status: 400 });
    }

    // Look up rancher to get verified email and ranch name
    let rancherEmail = '';
    let ranchName = '';
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
      rancherEmail = rancher['Email'] || '';
      ranchName = rancher['Ranch Name'] || '';
    } catch (err) {
      console.error('Could not fetch rancher for inquiry:', err);
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    if (!rancherEmail || !ranchName) {
      return NextResponse.json({ error: 'Rancher data incomplete' }, { status: 400 });
    }

    // Map interest type to title case for Airtable select field
    const interestLabels: Record<string, string> = {
      half_cow: 'Half Cow',
      quarter_cow: 'Quarter Cow',
      whole_cow: 'Whole Cow',
      custom: 'Custom Order',
    };
    const normalizedInterestType = interestType ? (interestLabels[interestType] || interestType) : '';

    // Optionally fetch consumer for campaign tracking
    let source = 'direct';
    if (consumerId) {
      try {
        const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId);
        if (consumer?.['Campaign']) {
          source = consumer['Campaign'] as string;
        } else if (consumer?.['Source']) {
          source = consumer['Source'] as string;
        }
      } catch (err) {
        console.log('Could not fetch consumer for campaign tracking:', err);
      }
    }

    const inquiryFields: any = {
      'Rancher ID': rancherId,
      'Consumer Name': consumerName,
      'Consumer Email': consumerEmail,
      'Consumer Phone': consumerPhone || '',
      'Rancher Email': rancherEmail,
      'Ranch Name': ranchName,
      'Message': message,
      'Status': 'Pending',
      'Sale Amount': 0,
      'Commission Amount': 0,
      'Source': source,
    };

    if (consumerId) {
      inquiryFields['Consumer ID'] = consumerId;
    }

    if (normalizedInterestType) {
      inquiryFields['Interest Type'] = normalizedInterestType;
    }

    const record = await createRecord(TABLES.INQUIRIES, inquiryFields);

    // TCPA SMS consent from the store inquiry form. The Inquiries table has
    // no consent column — consent lives on CONSUMERS (`SMS Opt-In`, the exact
    // field the funnel writes and sendSMSToConsumer gates on) — so record it
    // there when a matching Consumer exists. Only ever flips false→true (an
    // unchecked box means "no new consent granted", never a revocation),
    // requires a non-empty phone (same guard as /api/consumers), and never
    // fails the inquiry itself.
    if (smsOptIn === true && consumerPhone && String(consumerPhone).trim().length > 0) {
      try {
        let consumerRecordId = consumerId || '';
        let consumerRecord: any = null;
        if (consumerRecordId) {
          consumerRecord = await getRecordById(TABLES.CONSUMERS, consumerRecordId).catch(() => null);
        } else {
          const safeEmail = escapeAirtableValue(String(consumerEmail).trim().toLowerCase());
          const matches: any[] = await getAllRecords(
            TABLES.CONSUMERS,
            `LOWER({Email}) = "${safeEmail}"`
          );
          if (matches.length > 0) {
            consumerRecord = matches[0];
            consumerRecordId = matches[0].id;
          }
        }
        if (consumerRecordId && consumerRecord && consumerRecord['SMS Opt-In'] !== true) {
          await updateRecord(TABLES.CONSUMERS, consumerRecordId, {
            'SMS Opt-In': true,
            'SMS Opt-In At': new Date().toISOString(),
          });
        }
      } catch (e: any) {
        console.error('[inquiries] SMS opt-in record failed (non-fatal):', e?.message);
      }
    }

    // ONLY send alert to admin - rancher email goes out AFTER approval
    await sendInquiryAlertToAdmin({
      ranchName,
      rancherEmail,
      consumerName,
      consumerEmail,
      interestType: normalizedInterestType,
      message,
      inquiryId: record.id,
    });

    return NextResponse.json({ success: true, inquiry: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating inquiry:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// Extract a single labelled field ("State: TX", "Monthly Volume: 200 lb") out of
// the structured Notes payload that /api/wholesale/signup writes. Falls back to
// empty string when not present — wholesale rows have no canonical State column
// today so this is the only reliable read path until a schema migration.
function readWholesaleField(notes: string | undefined | null, label: string): string {
  if (!notes) return '';
  const re = new RegExp(`^${label}:\\s*(.+)$`, 'm');
  const m = String(notes).match(re);
  return m ? m[1].trim() : '';
}

export async function GET() {
  try {
    const inquiries = await getAllRecords(TABLES.INQUIRIES);

    // Fetch rancher details and normalize field names. Wholesale rows have
    // no Rancher ID — their Ranch Name field is co-opted to store the
    // applicant's business name. The matchedRancherIds field (newline-
    // delimited string) is set by admin when they match the buyer to
    // ranchers — those IDs hydrate into matched_ranchers[].
    const inquiriesWithRanchers = await Promise.all(
      inquiries.map(async (inquiry: any) => {
        const rancherId = inquiry['Rancher ID'];
        const interestType = inquiry['Interest Type'] || '';
        const isWholesale = interestType === 'Wholesale';

        // For retail/standard inquiries — hydrate the linked rancher row.
        let rancherData = {
          ranch_name: 'Unknown',
          operator_name: 'Unknown',
          email: '',
          state: '',
        };

        if (rancherId && !isWholesale) {
          try {
            const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
            rancherData = {
              ranch_name: rancher['Ranch Name'] || 'Unknown',
              operator_name: rancher['Operator Name'] || 'Unknown',
              email: rancher['Email'] || '',
              state: rancher['State'] || '',
            };
          } catch (err) {
            console.log(`Could not fetch rancher ${rancherId}:`, err);
          }
        } else if (isWholesale) {
          // Wholesale rows: Ranch Name field stores the business name. Surface
          // it so the admin queue can render "Acme Butchery" without the
          // confusing "Unknown" rancher fallback.
          rancherData = {
            ranch_name: inquiry['Ranch Name'] || '',
            operator_name: inquiry['Consumer Name'] || '',
            email: '',
            state: readWholesaleField(inquiry['Notes'], 'State'),
          };
        }

        // Wholesale-matched ranchers are stored as a newline-delimited list
        // of record IDs in the "Matched Ranchers" long-text field (schema
        // addition flagged for ops). Best-effort hydration so the admin can
        // see who got pushed without an extra round-trip.
        let matchedRanchers: { id: string; ranch_name: string; operator_name: string; state: string }[] = [];
        const matchedIdsRaw = inquiry['Matched Rancher IDs'] || '';
        if (isWholesale && matchedIdsRaw) {
          const ids = String(matchedIdsRaw)
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
          matchedRanchers = await Promise.all(
            ids.map(async (rid) => {
              try {
                const r: any = await getRecordById(TABLES.RANCHERS, rid);
                return {
                  id: rid,
                  ranch_name: r['Ranch Name'] || '',
                  operator_name: r['Operator Name'] || '',
                  state: r['State'] || '',
                };
              } catch {
                return { id: rid, ranch_name: '', operator_name: '', state: '' };
              }
            }),
          );
        }

        return {
          id: inquiry.id,
          consumer_name: inquiry['Consumer Name'] || '',
          consumer_email: inquiry['Consumer Email'] || '',
          consumer_phone: inquiry['Consumer Phone'] || '',
          message: inquiry['Message'] || '',
          interest_type: interestType,
          status: inquiry['Status'] || 'Pending',
          sale_amount: inquiry['Sale Amount'] || 0,
          commission_amount: inquiry['Commission Amount'] || 0,
          commission_paid: inquiry['Commission Paid'] || false,
          notes: inquiry['Notes'] || null,
          created_at: inquiry['Created'] || inquiry._createdTime || new Date().toISOString(),
          status_changed_at: inquiry['Status Changed At'] || null,
          business_name: isWholesale ? (inquiry['Ranch Name'] || '') : '',
          buyer_state: isWholesale ? readWholesaleField(inquiry['Notes'], 'State') : '',
          matched_ranchers: matchedRanchers,
          ranchers: rancherData,
        };
      })
    );

    return NextResponse.json(inquiriesWithRanchers);
  } catch (error: any) {
    console.error('API error fetching inquiries:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
