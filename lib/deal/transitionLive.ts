import { applyTransition, TransitionInput } from './transition';
import { dispatchDealEvent } from './events';
import { getRecordById, updateRecord, createRecord, TABLES } from '@/lib/airtable';
import { sendOperatorSignal } from '@/lib/operatorSignal';

// Audit-write failure alarm (bulletproof walkthrough 2026-07-15). The 'Deal
// Events' audit write 403'd (NOT_AUTHORIZED) on every deal transition for a
// MONTH and the swallow-all catch below kept it console-only — a silent,
// permanent audit-trail loss. Verified against the live base schema: the
// table simply DOES NOT EXIST (it was never created), so every transition's
// audit row vanishes. The write stays non-blocking (an audit row must never
// block a close), but the failure is now LOUD: one deduped operator signal
// per 24h naming the table and the fix. Ben-action: create a 'Deal Events'
// table in the Airtable base with fields — Referral (link to Referrals),
// From (text), To (text), Actor (text), Reason (text), At (date-time) — or
// grant the token access if it exists in another base.
async function alarmAuditWriteFailure(err: unknown): Promise<void> {
  try {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'system-error',
      summary: `Deal Events audit write failing — deal-transition audit trail is being lost`,
      detail:
        `createRecord('Deal Events') threw: ${(err as any)?.message || String(err)}\n` +
        `Fix: create a 'Deal Events' table in the Airtable base (fields: Referral link-to-Referrals, ` +
        `From, To, Actor, Reason, At) — or add it to the Airtable token's base scopes. ` +
        `Transitions still complete; only the audit rows are lost.`,
      dedupeKey: 'deal-events-audit-write-failure',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    });
  } catch {
    // Alerting is best-effort — never let the alarm itself touch a close.
  }
}

// Shared Deal Events audit writer. transition() uses it for machine-routed
// state changes; close paths that go through recordClose() instead (the email
// quick-action rail) call it directly so rancher-initiated Closed Lost rows
// land in the same audit table with the same non-blocking + loud-on-failure
// semantics. Row shape mirrors applyTransition's audit callback:
//   { Referral: [id], From, To, Actor, Reason, At }
export async function logDealAudit(row: Record<string, any>): Promise<void> {
  try {
    await createRecord('Deal Events', row);
  } catch (err) {
    await alarmAuditWriteFailure(err);
  }
}

export async function transition(referralId: string, input: TransitionInput) {
  return applyTransition(referralId, '', input, {
    getReferral: async (id) => {
      // getRecordById returns flattened { id, ...fields } — re-wrap so
      // applyTransition can read rec.fields.Status as expected.
      const r: any = await getRecordById(TABLES.REFERRALS, id);
      const { id: _id, ...fields } = r ?? {};
      return { id, fields: fields ?? {} };
    },
    updateReferral: async (id, fields) => { await updateRecord(TABLES.REFERRALS, id, fields); },
    // Graceful audit: a failed audit write never blocks a close — but it is
    // no longer silent (see alarmAuditWriteFailure above; deduped 24h).
    audit: logDealAudit,
    dispatch: dispatchDealEvent,
    nowIso: () => new Date().toISOString(),
  });
}
