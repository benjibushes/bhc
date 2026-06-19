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
  const sameState = !!from && from === input.to;
  const hasExtra = !!(input.extraFields && Object.keys(input.extraFields).length);

  // True no-op: already in the target state with nothing new to write — skip the
  // write + audit + event (idempotent repeat).
  if (sameState && !hasExtra) {
    return { ok: true, noop: true };
  }
  // Illegal-move check applies ONLY to an actual state change. A same-state write
  // (re-affirming the current state while updating fields like Sale Amount/Notes)
  // is always allowed — it must NOT be dropped, or the caller's field edits vanish.
  if (from && !sameState && !canTransition(from, input.to)) {
    return { ok: false, error: `illegal transition ${from} -> ${input.to}` };
  }

  const now = deps.nowIso();
  const fields: Record<string, any> = { Status: stateToStatus(input.to), ...(input.extraFields || {}) };
  const tsField = timestampFieldFor(input.to);
  // Auto-stamp the milestone timestamp only if neither the record nor the caller
  // already provided it (never clobber a caller-supplied or existing value).
  if (tsField && !rec.fields[tsField] && !(input.extraFields && tsField in input.extraFields)) {
    fields[tsField] = now;
  }

  await deps.updateReferral(referralId, fields);

  // Audit + emit ONLY on a real state change — a same-state field update is not a
  // transition and must not re-fire the event/audit.
  if (!sameState) {
    await deps.audit({
      Referral: [referralId], From: from, To: input.to, Actor: input.actor,
      Reason: input.reason || '', At: now,
    });
    const ev: DealEvent = { referralId, from, to: input.to, actor: input.actor, reason: input.reason, atIso: now };
    await deps.dispatch(ev);
  }

  return sameState ? { ok: true, noop: true } : { ok: true };
}
