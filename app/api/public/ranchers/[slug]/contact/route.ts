import { NextResponse } from 'next/server';
import { getRancherBySlug, getAllRecords, createRecord, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendTrackedContactEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 60;

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const ip = getRequestIp(request);
    const rlMin = await rateLimit(`contact:${ip}`, { requests: 3, window: '1m' });
    if (!rlMin.ok) {
      return NextResponse.json(
        { error: 'Too many messages from this network — wait a minute and try again.' },
        { status: 429 }
      );
    }
    const rlHour = await rateLimit(`contact-hr:${ip}`, { requests: 10, window: '1h' });
    if (!rlHour.ok) {
      return NextResponse.json(
        { error: 'Too many messages from this network in the past hour. Email ben@buyhalfcow.com if this is wrong.' },
        { status: 429 }
      );
    }

    const { slug } = await params;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { name, email, phone, message, smsOptIn } = body;

    // TCPA SMS consent from the store contact form's checkbox (unchecked by
    // default; phone itself is optional). Only meaningful with a non-empty
    // phone attached — same guard as /api/consumers.
    const wantsSms =
      smsOptIn === true && typeof phone === 'string' && phone.trim().length > 0;

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return NextResponse.json({ error: 'Please enter your name' }, { status: 400 });
    }

    if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
    }

    if (!message || typeof message !== 'string' || message.trim().length < 5) {
      return NextResponse.json({ error: 'Please enter a message' }, { status: 400 });
    }

    if (message.length > 5000) {
      return NextResponse.json({ error: 'Message must be under 5000 characters' }, { status: 400 });
    }

    // Look up the rancher
    const rancher: any = await getRancherBySlug(slug);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const rancherName = rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch';
    const rancherEmail = rancher['Email'] || '';
    const operatorName = rancher['Operator Name'] || rancherName;

    if (!rancherEmail) {
      return NextResponse.json({ error: 'This rancher cannot receive messages at this time' }, { status: 400 });
    }

    // Track this contact as a Referral so the pipeline + admin see it and can
    // follow up. If a referral for this buyer↔rancher already exists, just
    // advance its status. Otherwise CREATE one: a cold store contact (buyer
    // found the rancher on /map with no prior referral) previously fired an
    // email into the void — no record, no attribution, no way to route or
    // follow up. That's an invisible, unrecoverable lead.
    try {
      const safeEmail = escapeAirtableValue(email.trim().toLowerCase());
      const existing = await getAllRecords(
        TABLES.REFERRALS,
        `LOWER({Buyer Email}) = "${safeEmail}"`
      );

      let hasReferral = false;
      for (const referral of existing) {
        const r = referral as any;
        const linked: string[] = Array.isArray(r['Rancher']) ? r['Rancher'] : [];
        // Only referrals for THIS rancher count (by link id or legacy name).
        if (!linked.includes(rancher.id) && r['Suggested Rancher Name'] !== rancherName) continue;
        hasReferral = true;
        if (r['Status'] === 'Intro Sent') {
          await updateRecord(TABLES.REFERRALS, referral.id, { 'Status': 'Rancher Contacted' });
        }
      }

      if (!hasReferral) {
        // Upsert the Consumer (by email) so future visits + member login +
        // review attribution work — same pattern as the order-request path.
        let consumerId = '';
        try {
          const existingConsumers: any[] = await getAllRecords(
            TABLES.CONSUMERS,
            `LOWER({Email}) = "${safeEmail}"`
          );
          if (existingConsumers.length > 0) {
            consumerId = existingConsumers[0].id;
            // Consent lives on CONSUMERS (`SMS Opt-In` — the exact field the
            // funnel writes and sendSMSToConsumer gates on). Only ever flips
            // false→true; an unchecked box is not a revocation. Failure here
            // hits the surrounding non-fatal catch.
            if (wantsSms && (existingConsumers[0] as any)['SMS Opt-In'] !== true) {
              await updateRecord(TABLES.CONSUMERS, consumerId, {
                'SMS Opt-In': true,
                'SMS Opt-In At': new Date().toISOString(),
              });
            }
          } else {
            const createdConsumer: any = await createRecord(TABLES.CONSUMERS, {
              'Full Name': name.trim(),
              'Email': email.trim().toLowerCase(),
              'Phone': phone?.trim() || '',
              'Segment': 'Beef Buyer',
              'Source': `rancher-contact:${slug}`,
              'Interests': ['Beef'],
              'Intent Score': 80,
              'Intent Classification': 'High',
              // TCPA consent captured at creation when the box was checked.
              ...(wantsSms
                ? { 'SMS Opt-In': true, 'SMS Opt-In At': new Date().toISOString() }
                : {}),
            });
            consumerId = createdConsumer.id;
          }
        } catch (e: any) {
          console.error('[contact] consumer upsert failed:', e?.message);
          // Non-fatal — still create the referral with denormalized buyer data.
        }

        const referralFields: Record<string, any> = {
          Name: `${name.trim()} → ${rancherName} · Contact`,
          Status: 'Rancher Contacted',
          'Approval Status': 'Pending Rancher Response',
          'Match Type': 'Direct (Rancher Page)',
          'Buyer Name': name.trim(),
          'Buyer Email': email.trim().toLowerCase(),
          'Buyer Phone': phone?.trim() || '',
          'Intent Score': 80,
          'Intent Classification': 'High',
          'Notes': `[Buyer message]\n${message.trim()}\n\n[Source] Store contact form`,
          Rancher: [rancher.id],
        };
        if (consumerId) referralFields.Buyer = [consumerId];
        await createRecord(TABLES.REFERRALS, referralFields);
      }
    } catch (e) {
      console.error('Error tracking contact referral:', e);
      // Non-blocking — continue sending the message
    }

    // Send email to rancher
    await sendTrackedContactEmail({
      rancherName: operatorName,
      rancherEmail,
      buyerName: name.trim(),
      buyerEmail: email.trim().toLowerCase(),
      buyerPhone: phone?.trim() || '',
      message: message.trim(),
    });

    // Send Telegram notification
    try {
      await sendTelegramUpdate(
        `\u{1F4AC} ${name.trim()} messaged ${rancherName} via contact page\n\nEmail: ${email.trim()}\n${phone ? `Phone: ${phone.trim()}\n` : ''}Message: ${message.trim().slice(0, 200)}${message.length > 200 ? '...' : ''}`
      );
    } catch (e) {
      console.error('Telegram notification error:', e);
      // Non-blocking
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error in rancher contact API:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
