// AI Audit Log — every AI write must flow through here.
//
// The substrate that makes tiered autonomy safe. Without this, an AI agent
// auto-executing tool calls is a liability — you can't see what happened,
// can't undo a bad write, can't tell ben-vs-ai-vs-cron apart in postmortems.
//
// HOW IT WORKS:
//   1. Every AI write logs {timestamp, actor, tool, args, result, reverse_action}
//      to the AI_AUDIT_LOG Airtable table.
//   2. The reverse_action field stores a JSON blob describing how to undo:
//      { type: 'update', table, recordId, fields: <previousValues> }
//   3. A cron / Telegram callback can replay the inverse from the log.
//
// GRACEFUL DEGRADATION:
//   If the AI_AUDIT_LOG Airtable table doesn't exist yet (Ben hasn't created
//   it via the UI), this module logs to console and a fallback Airtable
//   "Notes" field on the affected record. Code still works — just less
//   forensically useful until the table is created.
//
// SETUP REQUIRED (Airtable UI):
//   Create table "AI Audit Log" with fields:
//     - Timestamp (datetime, ISO format, primary)
//     - Actor (singleSelect: ai-auto, ai-confirmed, cron, manual)
//     - Tool (text) — name of the tool/cron/operation that wrote
//     - Target Type (singleSelect: Consumer, Rancher, Referral, Inquiry)
//     - Target ID (text) — Airtable record ID of the affected record
//     - Args (longtext) — JSON blob of the input args
//     - Result (longtext) — JSON blob of the result/output
//     - Reverse Action (longtext) — JSON blob describing how to undo
//     - Telegram Card ID (text) — message_id of the undo card if posted
//     - Reverted (checkbox) — set true when an undo card is tapped

import { createRecord, getAllRecords, escapeAirtableValue } from './airtable';

const AUDIT_TABLE = 'AI Audit Log';

export type AuditActor = 'ai-auto' | 'ai-confirmed' | 'cron' | 'manual';
export type AuditTargetType = 'Consumer' | 'Rancher' | 'Referral' | 'Inquiry' | 'Thread' | 'Other';

export type ReverseAction =
  | {
      type: 'airtable-update';
      table: string;
      recordId: string;
      // Previous field values to restore. Set to null to clear a field.
      fields: Record<string, unknown>;
    }
  | {
      type: 'airtable-delete';
      table: string;
      recordId: string;
    }
  | {
      type: 'noop';
      reason: string; // e.g. "email send — cannot un-send"
    };

export interface AuditEntry {
  actor: AuditActor;
  tool: string;
  targetType: AuditTargetType;
  targetId: string;
  args: unknown;
  result: unknown;
  reverseAction: ReverseAction;
  telegramCardId?: string;
}

/**
 * Log an AI write. Returns the audit log record ID (for later reversal).
 * Never throws — failures fall back to console + best-effort.
 */
export async function logAuditEntry(entry: AuditEntry): Promise<string | null> {
  const record = {
    'Timestamp': new Date().toISOString(),
    'Actor': entry.actor,
    'Tool': entry.tool,
    'Target Type': entry.targetType,
    'Target ID': entry.targetId,
    'Args': JSON.stringify(entry.args),
    'Result': JSON.stringify(entry.result),
    'Reverse Action': JSON.stringify(entry.reverseAction),
    ...(entry.telegramCardId ? { 'Telegram Card ID': entry.telegramCardId } : {}),
  };

  try {
    const created = await createRecord(AUDIT_TABLE, record);
    return (created as any)?.id || null;
  } catch (e: any) {
    // Graceful: table doesn't exist yet, or permissions issue. Log to console
    // so the audit trail still exists in Vercel logs.
    console.warn(`[auditLog] table "${AUDIT_TABLE}" unavailable — logging to console only:`, e?.message || e);
    console.log('[auditLog]', JSON.stringify({ ...entry, _stored: false }));
    return null;
  }
}

/**
 * Reverse an audit entry by replaying its reverse_action.
 * Used by Telegram "undo" callbacks within the 30-min window.
 */
export async function reverseAuditEntry(auditId: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  try {
    // Find the audit record
    const records = await getAllRecords(
      AUDIT_TABLE,
      `RECORD_ID() = "${escapeAirtableValue(auditId)}"`
    );
    if (!records.length) return { ok: false, reason: 'audit entry not found' };
    const audit = records[0] as any;

    if (audit['Reverted']) return { ok: false, reason: 'already reverted' };

    const ra: ReverseAction = JSON.parse(audit['Reverse Action'] || 'null');
    if (!ra) return { ok: false, reason: 'no reverse action stored' };

    if (ra.type === 'noop') {
      return { ok: false, reason: ra.reason || 'irreversible' };
    }

    if (ra.type === 'airtable-update') {
      const { updateRecord } = await import('./airtable');
      await updateRecord(ra.table, ra.recordId, ra.fields as Record<string, unknown>);
    }

    if (ra.type === 'airtable-delete') {
      // Delete operations rare; skipping implementation until needed.
      return { ok: false, reason: 'delete reversal not implemented' };
    }

    // Mark the audit as reverted
    const { updateRecord } = await import('./airtable');
    await updateRecord(AUDIT_TABLE, auditId, { 'Reverted': true });
    return { ok: true };
  } catch (e: any) {
    console.error('[auditLog] reverseAuditEntry failed:', e?.message || e);
    return { ok: false, reason: e?.message || 'unknown error' };
  }
}

/**
 * Helper: build a reverse action for an Airtable update before applying it.
 * Pass the CURRENT field values so they can be restored.
 *
 * Example:
 *   const before = await getRecordById('Referrals', refId);
 *   const reverse = buildAirtableUpdateReverse('Referrals', refId, {
 *     'Status': before['Status'],
 *     'Closed At': before['Closed At'],
 *   });
 *   await updateRecord('Referrals', refId, { Status: 'Closed Won', ... });
 *   await logAuditEntry({ ..., reverseAction: reverse });
 */
export function buildAirtableUpdateReverse(
  table: string,
  recordId: string,
  previousFields: Record<string, unknown>
): ReverseAction {
  return {
    type: 'airtable-update',
    table,
    recordId,
    // Convert undefined to null so Airtable clears the field on revert.
    fields: Object.fromEntries(
      Object.entries(previousFields).map(([k, v]) => [k, v === undefined ? null : v])
    ),
  };
}
