import { applyTransition, TransitionInput } from './transition';
import { dispatchDealEvent } from './events';
import { getRecordById, updateRecord, createRecord, TABLES } from '@/lib/airtable';

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
    // Graceful audit: if the "Deal Events" table doesn't exist, swallow it so a
    // missing optional table never blocks a close.
    audit: async (row) => { try { await createRecord('Deal Events', row); } catch { /* table optional */ } },
    dispatch: dispatchDealEvent,
    nowIso: () => new Date().toISOString(),
  });
}
