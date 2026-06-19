import type { DealState } from './states.ts';
import { stateToStatus, statusToState, timestampFieldFor } from './states.ts';
import { canTransition } from './transitions.ts';
import type { DealEvent } from './events.ts';

export interface TransitionInput {
  to: DealState;
  actor: string;
  reason?: string;
  extraFields?: Record<string, any>;
}

export interface TransitionDeps {
  getReferral: (id: string) => Promise<{ id: string; fields: Record<string, any> }>;
  updateReferral: (id: string, fields: Record<string, any>) => Promise<void>;
  audit: (row: Record<string, any>) => Promise<void>;
  dispatch: (ev: DealEvent) => Promise<void>;
  nowIso: () => string;
}

export async function applyTransition(
  referralId: string,
  _label: string,
  input: TransitionInput,
  deps: TransitionDeps,
): Promise<{ ok: boolean; noop?: boolean; error?: string }> {
  const rec = await deps.getReferral(referralId);
  const from = statusToState(String(rec.fields.Status || '')) ?? null;

  if (from && stateToStatus(from) === stateToStatus(input.to) && from === input.to) {
    return { ok: true, noop: true };
  }
  if (from && !canTransition(from, input.to)) {
    return { ok: false, error: `illegal transition ${from} -> ${input.to}` };
  }

  const now = deps.nowIso();
  const fields: Record<string, any> = { Status: stateToStatus(input.to), ...(input.extraFields || {}) };
  const tsField = timestampFieldFor(input.to);
  if (tsField && !rec.fields[tsField]) fields[tsField] = now;

  await deps.updateReferral(referralId, fields);
  await deps.audit({
    Referral: [referralId], From: from, To: input.to, Actor: input.actor,
    Reason: input.reason || '', At: now,
  });

  const ev: DealEvent = { referralId, from, to: input.to, actor: input.actor, reason: input.reason, atIso: now };
  await deps.dispatch(ev);
  return { ok: true };
}
