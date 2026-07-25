import { applyTransition, TransitionInput } from './transition';
import { dispatchDealEvent } from './events';
import { getRecordById, updateRecord, createRecord, TABLES } from '@/lib/airtable';
import { sendOperatorSignal } from '@/lib/operatorSignal';

// Audit-write failure alarm (bulletproof walkthrough 2026-07-15).
//
// HISTORY: the 'Deal Events' audit write 403'd (NOT_AUTHORIZED) on every deal
// transition for a MONTH and the swallow-all catch below kept it console-only —
// a silent, permanent audit-trail loss. This alarm made the failure LOUD: one
// deduped operator signal per 24h, non-blocking (an audit row must never block
// a close).
//
// STATUS 2026-07-24: RESOLVED AND VERIFIED. The comment here used to claim the
// table "simply DOES NOT EXIST (it was never created)" — that is no longer
// true and was itself a stale-truth trap for the next reader. 'Deal Events'
// EXISTS in base appgLT4z009iwAfhs (tbllZfXqXg1i0i6fI) and is WORKING: 53 rows,
// every field populated (From / To / Actor / At), most recent 2026-07-24.
//
// The alarm STAYS. It is not a workaround for a missing table — it is the
// general safety net for any future audit-write failure (token scope revoked,
// field renamed, rate limit, table archived). What changed is the remediation
// text: don't tell the operator to create a table that already exists.
async function alarmAuditWriteFailure(err: unknown): Promise<void> {
  try {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'system-error',
      summary: `Deal Events audit write failing — deal-transition audit trail is being lost`,
      detail:
        `createRecord('Deal Events') threw: ${(err as any)?.message || String(err)}\n` +
        `The 'Deal Events' table EXISTS and normally works, so this is a regression: check the ` +
        `Airtable token's scopes for the base, whether the table was renamed/archived, whether a ` +
        `field (Referral link-to-Referrals, From, To, Actor, Reason, At) was removed, or a rate limit. ` +
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
