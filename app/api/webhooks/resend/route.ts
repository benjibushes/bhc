import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { invalidateSuppressionCache } from '@/lib/email';

// Resend webhook handler — processes bounce, complaint, and delivery events.
// Configure in Resend dashboard: Settings > Webhooks > Add endpoint
// URL: https://buyhalfcow.com/api/webhooks/resend
// Events: email.bounced, email.complained, email.delivery_delayed
//
// When someone marks your email as spam (complained) or the address bounces,
// this handler marks the consumer/rancher as Unsubscribed in Airtable so we
// stop emailing them. Without this, repeat sends to complainers destroy your
// sender reputation.
export async function POST(request: Request) {
  try {
    // Audit finding 2026-05-20 #40: previously unsigned — anyone could POST
    // email.complained to auto-unsubscribe arbitrary recipients. Verify via
    // Svix signature when RESEND_WEBHOOK_SECRET set; fail-closed in prod
    // when unset.
    const rawBody = await request.text();
    const secret = process.env.RESEND_WEBHOOK_SECRET || '';
    if (secret) {
      const { verifySvixSignature } = await import('@/lib/svixVerify');
      const verify = verifySvixSignature({
        body: rawBody,
        svixId: request.headers.get('svix-id'),
        svixTimestamp: request.headers.get('svix-timestamp'),
        svixSignature: request.headers.get('svix-signature'),
        secret,
      });
      if (!verify.ok) {
        console.warn('[resend] signature rejected:', verify.reason);
        return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.error('[resend] RESEND_WEBHOOK_SECRET unset in prod — refusing all requests');
      return NextResponse.json({ ok: false, error: 'webhook secret not configured' }, { status: 401 });
    }
    const body = JSON.parse(rawBody);
    const { type, data } = body;

    if (!type || !data) {
      return NextResponse.json({ ok: true, skipped: 'no type/data' });
    }

    const recipientEmail = (data.to?.[0] || data.email || '').toLowerCase().trim();
    if (!recipientEmail) {
      return NextResponse.json({ ok: true, skipped: 'no recipient' });
    }

    const eventType = type as string;
    console.log(`Resend webhook: ${eventType} for ${recipientEmail}`);

    if (eventType === 'email.bounced' || eventType === 'email.complained') {
      const reason = eventType === 'email.bounced' ? 'bounced' : 'spam complaint';

      // Mark consumer as unsubscribed + flag specific reason. Both fields are
      // checked by the suppression list — Unsubscribed for soft opt-outs,
      // Bounced/Complained for hard signals that affect sender reputation.
      try {
        const consumers = await getAllRecords(
          TABLES.CONSUMERS,
          `{Email} = "${recipientEmail}"`
        ) as any[];
        for (const c of consumers) {
          const updates: Record<string, any> = {
            'Unsubscribed': true,
            'Notes': `${c['Notes'] || ''}\n[Auto-unsub ${new Date().toISOString().slice(0, 10)}] ${reason}`.trim(),
          };
          if (eventType === 'email.bounced') updates['Bounced'] = true;
          if (eventType === 'email.complained') updates['Complained'] = true;
          await updateRecord(TABLES.CONSUMERS, c.id, updates);
        }
      } catch (e: any) {
        console.error('Resend webhook — consumer update error:', e.message);
      }

      // Mark rancher as well (in case it's a rancher email)
      try {
        const ranchers = await getAllRecords(
          TABLES.RANCHERS,
          `{Email} = "${recipientEmail}"`
        ) as any[];
        for (const r of ranchers) {
          await updateRecord(TABLES.RANCHERS, r.id, {
            'Notes': `${r['Notes'] || ''}\n[Auto-flag ${new Date().toISOString().slice(0, 10)}] Email ${reason}`.trim(),
          });
        }
      } catch (e: any) {
        console.error('Resend webhook — rancher update error:', e.message);
      }

      // Invalidate the in-memory suppression cache so the next email send
      // sees this address as blocked immediately (rather than waiting up to
      // 5 min for the cache to expire).
      invalidateSuppressionCache();

      // Alert Ben
      const emoji = eventType === 'email.bounced' ? '📭' : '🚫';
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `${emoji} <b>Email ${reason.toUpperCase()}</b>\n\n` +
        `${recipientEmail}\n` +
        `Auto-unsubscribed from future emails.`
      ).catch(() => {});
    }

    if (eventType === 'email.delivery_delayed') {
      // Info-only — no action needed, but log it
      console.warn(`Resend delivery delayed for ${recipientEmail}`);
    }

    // F5 — engagement events: opened / clicked / delivered
    // Stamps Email Sends row + Consumer record for desk visibility (F13).
    if (eventType === 'email.opened' || eventType === 'email.clicked' || eventType === 'email.delivered') {
      try {
        const now = new Date().toISOString();
        // Find Consumer for this recipient
        const consumers = await getAllRecords(
          TABLES.CONSUMERS,
          `{Email} = "${recipientEmail}"`
        ) as any[];
        for (const c of consumers) {
          const updates: Record<string, any> = { 'Last Email Event At': now };
          if (eventType === 'email.delivered') {
            updates['Last Email Delivered At'] = now;
          }
          if (eventType === 'email.opened') {
            updates['Last Email Opened At'] = now;
            updates['Email Opens'] = Number(c['Email Opens'] || 0) + 1;
          }
          if (eventType === 'email.clicked') {
            updates['Last Email Clicked At'] = now;
            updates['Email Clicks'] = Number(c['Email Clicks'] || 0) + 1;
          }
          try {
            await updateRecord(TABLES.CONSUMERS, c.id, updates);
          } catch (e: any) {
            // Schema may be missing these fields — non-fatal
            console.warn('[resend] Consumer update skipped (schema?):', e?.message);
          }
        }

        // Stamp latest Email Sends row for this recipient (within 7d)
        try {
          const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const sends = await getAllRecords(
            TABLES.EMAIL_SENDS,
            `AND({Recipient Email} = "${recipientEmail}", IS_AFTER({Sent At}, "${cutoff}"))`
          ) as any[];
          sends.sort((a, b) => String(b['Sent At'] || '').localeCompare(String(a['Sent At'] || '')));
          const latest = sends[0];
          if (latest) {
            const updates: Record<string, any> = { 'Last Event At': now };
            if (eventType === 'email.delivered') updates['Delivered At'] = now;
            if (eventType === 'email.opened') {
              updates['Opened At'] = latest['Opened At'] || now;
              updates['Open Count'] = Number(latest['Open Count'] || 0) + 1;
            }
            if (eventType === 'email.clicked') {
              updates['Clicked At'] = latest['Clicked At'] || now;
              updates['Click Count'] = Number(latest['Click Count'] || 0) + 1;
            }
            try {
              await updateRecord(TABLES.EMAIL_SENDS, latest.id, updates);
            } catch (e: any) {
              console.warn('[resend] Email Sends update skipped (schema?):', e?.message);
            }
          }
        } catch (e: any) {
          console.warn('[resend] Email Sends lookup failed:', e?.message);
        }
      } catch (e: any) {
        console.warn('[resend] engagement processing failed:', e?.message);
      }
    }

    return NextResponse.json({ ok: true, processed: eventType });
  } catch (error: any) {
    console.error('Resend webhook error:', error);
    return NextResponse.json({ ok: true, error: error.message });
  }
}
