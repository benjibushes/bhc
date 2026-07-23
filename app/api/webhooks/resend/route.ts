import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { invalidateSuppressionCache } from '@/lib/email';
import { findRancherByEmail } from '@/lib/rancherLookup';

// Rancher front-door email templates (P3d, onboarding hardening 2026-07-23).
// A HARD bounce / complaint on one of these means the rancher never received
// their welcome / setup link / approval — the Vale Creek / Justin unreachable
// class — and needs a HUMAN rescue now, not just the silent auto-unsub below.
// These are the exact Template Name strings logged to Email Sends by the
// matching senders in lib/email.ts.
const RANCHER_ONBOARDING_TEMPLATES: ReadonlySet<string> = new Set([
  'sendRancherApplyAutoApproved',
  'sendRancherSelfSubmitWelcome',
  'sendRancherSetupLink',
  'sendRancherApproval',
]);

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
        // T5 (2026-06-10): Telegram alert on Svix sig fail. Lost bounce/
        // complaint visibility = suppression list breaks = sender rep tanks.
        try {
          const { sendOperatorSignal } = await import('@/lib/operatorSignal');
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'system-error',
            summary: 'Resend webhook SIGNATURE FAIL',
            detail: `${verify.reason || 'unknown'} — bounce/complaint events dropping. Verify RESEND_WEBHOOK_SECRET in Vercel matches Resend dashboard.`,
            dedupeKey: 'resend-sig-fail',
            dedupeWindowMs: 5 * 60 * 1000,
          });
        } catch {}
        return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.error('[resend] RESEND_WEBHOOK_SECRET unset in prod — refusing all requests');
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: 'Resend webhook secret UNSET in prod',
          detail: 'All Resend events being rejected. Set RESEND_WEBHOOK_SECRET in Vercel env.',
          dedupeKey: 'resend-secret-missing',
          dedupeWindowMs: 60 * 60 * 1000,
        });
      } catch {}
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
    // Escape before interpolating into any filterByFormula — an address like
    // a"b@x.com would otherwise break out of the quoted literal (formula
    // injection). Airtable stores the raw (unescaped) value, so equality still
    // matches the real record.
    const safeEmail = escapeAirtableValue(recipientEmail);

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
          `LOWER({Email}) = "${safeEmail}"`
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

      // Mark rancher as well (in case it's a rancher email). 2026-07-21: also
      // stamp the Bounced/Complained checkboxes — they exist on Ranchers but
      // only the Notes line was ever written, so the rancher-side suppression
      // reads gated on a field nothing wrote (the Vale Creek phantom: her
      // 07-20 bounce DID process, but only into Notes, and the blank checkbox
      // was mis-read as "webhook not firing").
      try {
        const ranchers = await getAllRecords(
          TABLES.RANCHERS,
          `LOWER({Email}) = "${safeEmail}"`
        ) as any[];
        for (const r of ranchers) {
          const rancherUpdates: Record<string, any> = {
            'Notes': `${r['Notes'] || ''}\n[Auto-flag ${new Date().toISOString().slice(0, 10)}] Email ${reason}`.trim(),
          };
          if (eventType === 'email.bounced') rancherUpdates['Bounced'] = true;
          if (eventType === 'email.complained') rancherUpdates['Complained'] = true;
          await updateRecord(TABLES.RANCHERS, r.id, rancherUpdates);
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

      // ── RANCHER-ONBOARDING RESCUE (P3d, 2026-07-23) ─────────────────────
      // The generic auto-unsub above is silent-by-design. But a dead address
      // we used for a rancher's welcome / setup link / approval means the
      // rancher is UNREACHABLE at the front door (Vale Creek / Justin class)
      // and must be hand-rescued NOW. Fire a LOUD deduped signal on TOP of
      // the auto-unsub. Complaints always qualify; bounces only when HARD —
      // Resend's bounce.type is 'Permanent' for a dead mailbox vs 'Transient'
      // / 'Undetermined' for a soft retry (treat unknown/blank as hard so a
      // real dead address is never missed). Scope to the onboarding cohort by
      // matching a recent Email Sends row for this recipient against
      // RANCHER_ONBOARDING_TEMPLATES (the webhook payload carries the subject
      // but not the template name). Deduped per Resend message-id so a
      // redelivered webhook can't re-alarm.
      try {
        const bounceType = String(data.bounce?.type || '').toLowerCase();
        const isHardBounce =
          eventType === 'email.bounced' &&
          (bounceType === '' || bounceType === 'permanent');
        const isComplaint = eventType === 'email.complained';
        if (isHardBounce || isComplaint) {
          const sinceISO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
          const sends = await getAllRecords(
            TABLES.EMAIL_SENDS,
            `AND(LOWER({Recipient Email}) = "${safeEmail}", {Sent At} > "${sinceISO}")`
          ) as any[];
          const onboardingSend = sends.find((s) =>
            RANCHER_ONBOARDING_TEMPLATES.has(String(s['Template Name'] || ''))
          );
          if (onboardingSend) {
            const rancher = await findRancherByEmail(recipientEmail).catch(() => null);
            const who = rancher
              ? String(rancher['Ranch Name'] || rancher['Operator Name'] || 'a rancher')
              : 'a rancher';
            const messageId = data.email_id || data.id || recipientEmail;
            const { sendOperatorSignal } = await import('@/lib/operatorSignal');
            await sendOperatorSignal({
              urgency: 'loud',
              kind: 'stuck-rancher',
              summary: `Setup/welcome email to ${recipientEmail} HARD ${isComplaint ? 'COMPLAINT' : 'BOUNCED'} — rancher unreachable by email, rescue manually`,
              detail:
                `${isComplaint ? 'Spam complaint' : 'Hard bounce'} on ${recipientEmail} ` +
                `(onboarding template: ${onboardingSend['Template Name']}). ${who} never got their ` +
                `welcome / setup link / approval and cannot be reached by email — hand-rescue now ` +
                `(call / alternate address). This is the Vale Creek / Justin class.`,
              refs: rancher
                ? [{ type: 'rancher', id: rancher.id, label: String(rancher['Ranch Name'] || '') }]
                : undefined,
              dedupeKey: `rancher-onboarding-bounce:${messageId}`,
              dedupeWindowMs: 24 * 60 * 60 * 1000,
            });
          }
        }
      } catch (e: any) {
        console.error('[resend] rancher-onboarding rescue alert failed:', e?.message);
      }
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
          `LOWER({Email}) = "${safeEmail}"`
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
            `AND({Recipient Email} = "${safeEmail}", IS_AFTER({Sent At}, "${cutoff}"))`
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
