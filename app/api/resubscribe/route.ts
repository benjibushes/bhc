import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { invalidateSuppressionCache } from '@/lib/email';
import { JWT_SECRET } from '@/lib/secrets';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';
import { sendTelegramUpdate } from '@/lib/telegram';

// POST /api/resubscribe — token-gated reverse of /api/unsubscribe.
//
// Why this exists: accidental unsubscribes (fat-finger in an inbox client,
// mistaken sender, regretted-yesterday) were previously permanent — the only
// recovery path was the operator editing Airtable by hand. The unsubscribe
// token (365d expiry) is replayable per audit, so the same token that took
// the user off the list can put them back on.
//
// The endpoint accepts the same JWT shape /api/unsubscribe issues:
//   { type: 'unsubscribe', email: string }
//
// On success, flips `Unsubscribed = false` on the matching Consumer/Rancher
// row(s), clears suppression cache, logs an audit entry, and notifies via
// Telegram so the operator can see resubscribes happen.
export async function POST(req: NextRequest) {
  let token: string | null = null;
  try {
    const body = await req.json();
    token = typeof body?.token === 'string' ? body.token : null;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!token) {
    return NextResponse.json({ error: 'Token required' }, { status: 400 });
  }

  let email: string | null = null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.type === 'unsubscribe' && decoded?.email) {
      email = String(decoded.email);
    }
  } catch (err) {
    console.warn('Resubscribe token verification failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
  }

  if (!email) {
    return NextResponse.json({ error: 'Token payload missing email' }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const safeEmail = escapeAirtableValue(normalizedEmail);

  try {
    let consumerFlipped = false;
    let rancherFlipped = false;

    const consumers = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${safeEmail}"`,
    );
    if (consumers.length > 0) {
      const rec = consumers[0] as any;
      const previousUnsub = rec['Unsubscribed'];
      const previousUnsubAt = rec['Unsubscribed At'];
      await updateRecord(TABLES.CONSUMERS, rec.id, {
        'Unsubscribed': false,
        'Unsubscribed At': null,
      });
      consumerFlipped = true;
      await logAuditEntry({
        actor: 'manual',
        tool: 'resubscribe',
        targetType: 'Consumer',
        targetId: rec.id,
        args: { email: normalizedEmail },
        result: { unsubscribed: false },
        reverseAction: buildAirtableUpdateReverse(TABLES.CONSUMERS, rec.id, {
          'Unsubscribed': previousUnsub ?? true,
          'Unsubscribed At': previousUnsubAt ?? null,
        }),
      });
    }

    const ranchers = await getAllRecords(
      TABLES.RANCHERS,
      `LOWER({Email}) = "${safeEmail}"`,
    );
    if (ranchers.length > 0) {
      const rec = ranchers[0] as any;
      const previousUnsub = rec['Unsubscribed'];
      await updateRecord(TABLES.RANCHERS, rec.id, {
        'Unsubscribed': false,
      });
      rancherFlipped = true;
      await logAuditEntry({
        actor: 'manual',
        tool: 'resubscribe',
        targetType: 'Rancher',
        targetId: rec.id,
        args: { email: normalizedEmail },
        result: { unsubscribed: false },
        reverseAction: buildAirtableUpdateReverse(TABLES.RANCHERS, rec.id, {
          'Unsubscribed': previousUnsub ?? true,
        }),
      });
    }

    invalidateSuppressionCache();

    if (!consumerFlipped && !rancherFlipped) {
      // No matching row — token was valid but we no longer have a record.
      // Still return success so we don't leak whether the email exists.
      return NextResponse.json({ success: true });
    }

    // Low-key operator alert. Resubscribes are rare and worth knowing about
    // (could indicate confusing email copy, mis-sent campaign, etc).
    try {
      await sendTelegramUpdate(
        `Resubscribe: ${normalizedEmail}` +
        (consumerFlipped ? ' [consumer]' : '') +
        (rancherFlipped ? ' [rancher]' : '')
      );
    } catch (tgErr) {
      console.warn('Resubscribe Telegram alert non-fatal:', tgErr);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Resubscribe error:', error);
    return NextResponse.json({ error: 'Failed to resubscribe' }, { status: 500 });
  }
}
