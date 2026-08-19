// ─────────────────────────────────────────────────────────────────────────
// SELECT GUARD — the runtime half of the typecast policy.
//
// THE FALSE BELIEF THIS EXISTS TO KILL
//   Three sites in this repo claimed `typecast: true` creates a missing FIELD.
//   It does not. typecast creates missing select OPTIONS, and only options.
//   The difference is the whole bug:
//     - a missing FIELD  → Airtable 422s "Unknown field name", lib/airtable.ts
//                          strips it and alerts. Data lost, but LOUD.
//     - a missing OPTION → typecast MINTS it. The write succeeds. A value no
//                          reader in the codebase recognizes is now sitting in
//                          a select, and every selector that filters on the
//                          real options is silently blind to that row.
//   Proof it happened: Consumers.Order Type carries 'Half Cow' and 'Quarter
//   Cow' (minted, in fire order, after the three real choices); Conversations
//   carries both 'inbound' and 'Inbound'; four select fields carry an ''
//   choice that only a code write of '' can produce.
//
// THE POLICY  (full reasoning in the block above createRecord in lib/airtable.ts)
//   typecast stays ON — hundreds of writes depend on its number/date/link
//   coercion, and flipping it off would 422 the money path mid-transaction,
//   which is strictly worse than a lost label. Instead the MINT VECTOR is
//   closed in-process, before the request leaves: a select value that is not
//   a real option is never sent, so Airtable is never asked to create it.
//
//   How a violation is handled depends on where we are:
//     dev / test / CI (strict)  → THROW. A bad write can never reach a PR green.
//     production     (lenient)  → DROP the offending field, keep the rest of
//                                 the payload, fire a loud operator signal.
//                                 Never throw: a throw inside settleBuyerDeposit
//                                 loses the record of money that already moved.
//   Dropping is not a cop-out — it is what production already does today for
//   these values (the API key cannot create options, so Airtable rejects and
//   lib/airtable.ts strips). This makes that outcome deterministic, loud, and
//   independent of what permissions the key happens to hold this month.
//
// WHAT THIS DOES NOT COVER
//   - Field NAMES. Snapshot staleness would make us drop a legitimately-new
//     field, and Airtable already 422s + alerts on unknown fields. Field names
//     are the static guard's beat (tools/schema-guard.ts).
//   - Snapshot drift the other way: if an option is DELETED in Airtable while
//     the snapshot still lists it, that value can still be minted back.
//     `npm run schema:snapshot -- --check` is what catches that.
// ─────────────────────────────────────────────────────────────────────────

import { AIRTABLE_SELECT_FIELDS, type SelectKind } from './airtableSchema.generated';
import { isOptionAllowlisted } from './schemaGuardAllowlist';

export interface SelectViolation {
  readonly table: string;
  readonly field: string;
  /** The offending literal. For multipleSelects, the first bad member. */
  readonly value: string;
  readonly kind: SelectKind;
  /** Already parked in lib/schema/schemaGuardAllowlist.ts — do not throw. */
  readonly allowlisted: boolean;
}

export interface SelectGuardResult {
  /** The payload that is safe to send. Never the caller's object. */
  readonly fields: Record<string, any>;
  readonly violations: readonly SelectViolation[];
  /** Select fields whose '' was rewritten to null (clear, don't mint ''). */
  readonly normalizedToNull: readonly string[];
  /** True when the table is absent from the snapshot — nothing was checked. */
  readonly unknownTable: boolean;
}

export class SchemaGuardError extends Error {
  readonly violations: readonly SelectViolation[];
  constructor(violations: readonly SelectViolation[]) {
    super(
      `Airtable select guard: ${violations
        .map((v) => `${v.table}.${v.field} = ${JSON.stringify(v.value)} is not an option on that field`)
        .join('; ')}. Use an existing option, or add the option in Airtable and run \`npm run schema:snapshot\`.`,
    );
    this.name = 'SchemaGuardError';
    this.violations = violations;
  }
}

/**
 * Strict = throw on a violation. Lenient = drop + alert.
 *
 * SCHEMA_GUARD_STRICT wins in both directions (break-glass either way).
 * Otherwise: strict everywhere except production. `next build` runs with
 * NODE_ENV=production, so a prerender-time write cannot brick a build either.
 */
export function isSchemaGuardStrict(): boolean {
  const explicit = process.env.SCHEMA_GUARD_STRICT;
  if (explicit === '1' || explicit === 'true') return true;
  if (explicit === '0' || explicit === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/** Break-glass: turn the whole guard into a no-op (snapshot badly stale). */
export function isSchemaGuardDisabled(): boolean {
  return process.env.SCHEMA_GUARD_OFF === '1' || process.env.SCHEMA_GUARD_OFF === 'true';
}

const EMPTY_RESULT = (fields: Record<string, any>, unknownTable: boolean): SelectGuardResult => ({
  fields,
  violations: [],
  normalizedToNull: [],
  unknownTable,
});

/**
 * Pure. Returns a payload that cannot mint a select option, plus what it had
 * to remove to get there. Does not throw, does not log, does not mutate the
 * input — lib/airtable.ts owns the throw/alert decision.
 */
export function guardSelectWrites(table: string, fields: Record<string, any>): SelectGuardResult {
  const out: Record<string, any> = { ...fields };
  if (isSchemaGuardDisabled()) return EMPTY_RESULT(out, false);

  const specs = AIRTABLE_SELECT_FIELDS[table];
  if (!specs) return EMPTY_RESULT(out, true);

  const violations: SelectViolation[] = [];
  const normalizedToNull: string[] = [];

  for (const field of Object.keys(fields)) {
    const spec = specs[field];
    if (!spec) continue; // not a select (or not a field we know) — hands off
    const value = fields[field];
    if (value === null || value === undefined) continue; // explicit clear

    const flag = (bad: string) => {
      violations.push({
        table,
        field,
        value: bad,
        kind: spec.kind,
        allowlisted: isOptionAllowlisted(table, field, bad),
      });
      delete out[field];
    };

    if (spec.kind === 'multipleSelects') {
      // A set is written whole or not at all — half-writing it would silently
      // drop a member and read as a deliberate deselection.
      const members = Array.isArray(value) ? value : [value];
      const bad = members
        .map((m) => (m && typeof m === 'object' && 'name' in m ? String((m as any).name) : String(m)))
        .find((m) => !spec.choices.includes(m));
      if (bad !== undefined) flag(bad);
      continue;
    }

    // singleSelect. '' is the mint vector that produced the empty choices
    // already sitting in this base: clearing a select means null, not ''.
    if (typeof value === 'string' && value.trim() === '') {
      out[field] = null;
      normalizedToNull.push(field);
      continue;
    }

    const asString = value && typeof value === 'object' && 'name' in value
      ? String((value as any).name)
      : String(value);
    if (!spec.choices.includes(asString)) flag(asString);
  }

  return { fields: out, violations, normalizedToNull, unknownTable: false };
}

/** Violations that must stop the write in strict mode (i.e. not parked). */
export function unparkedViolations(violations: readonly SelectViolation[]): SelectViolation[] {
  return violations.filter((v) => !v.allowlisted);
}

export interface GuardAlert {
  readonly urgency: 'loud' | 'normal';
  readonly summary: string;
  readonly detail: string;
  readonly dedupeKey: string;
}

export interface GuardAction {
  /** Payload safe to send to Airtable. */
  readonly fields: Record<string, any>;
  /** Strict mode + an un-parked violation: the caller must throw. */
  readonly shouldThrow: boolean;
  /** Operator signals to fire (best-effort, never blocking). */
  readonly alerts: readonly GuardAlert[];
  readonly violations: readonly SelectViolation[];
}

/**
 * The whole runtime policy in one pure function, so lib/airtable.ts holds only
 * plumbing and the behaviour is unit-testable without touching Airtable.
 *
 * Note what does NOT alert: rewriting '' to null. That is a silent correction
 * of an idiom, not an incident — alerting on it would train everyone to ignore
 * the channel that also carries the real mints.
 */
export function decideSelectGuardAction(
  table: string,
  fields: Record<string, any>,
  op: 'create' | 'update',
): GuardAction {
  const result = guardSelectWrites(table, fields);
  if (result.violations.length === 0) {
    return { fields: result.fields, shouldThrow: false, alerts: [], violations: [] };
  }

  const unparked = unparkedViolations(result.violations);
  const shouldThrow = unparked.length > 0 && isSchemaGuardStrict();

  const alerts: GuardAlert[] = result.violations.map((v) => ({
    urgency: v.allowlisted ? ('normal' as const) : ('loud' as const),
    summary: `Airtable select guard: ${v.table}.${v.field} (${op})`,
    detail:
      `Code tried to write ${JSON.stringify(v.value)} to ${v.table}.${v.field}, which is not one of that ` +
      `field's options. The value was DROPPED before the request so Airtable could not mint it as a new ` +
      `choice (a minted choice is invisible to every reader). The rest of the payload was written. ` +
      `Fix: use a real option, or add the option in Airtable and run \`npm run schema:snapshot\`.` +
      (v.allowlisted ? ' (Known + parked in lib/schema/schemaGuardAllowlist.ts.)' : ''),
    dedupeKey: `schema-guard:${op}:${v.table}:${v.field}:${v.value}`,
  }));

  return { fields: result.fields, shouldThrow, alerts, violations: result.violations };
}
