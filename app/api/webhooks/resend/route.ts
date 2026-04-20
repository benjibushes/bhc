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
    const body = await request.json();
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

    return NextResponse.json({ ok: true, processed: eventType });
  } catch (error: any) {
    console.error('Resend webhook error:', error);
    return NextResponse.json({ ok: true, error: error.message });
  }
}
