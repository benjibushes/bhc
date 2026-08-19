// ─────────────────────────────────────────────────────────────────────────
// SCHEMA GUARD ALLOWLIST — the ONE place a known schema mismatch is parked.
//
// An entry does NOT make the write work. It only says "we already know, it is
// on Ben's list, don't fail the build on it." At runtime an allowlisted value
// is still DROPPED (never minted) and an allowlisted field is still stripped
// by Airtable — the allowlist silences the alarm, not the guard.
//
// EVERY entry MUST carry:
//   reason    — why the code writes something the base doesn't have, in words
//               a stranger can act on
//   addedOn   — YYYY-MM-DD, the day it was parked
//   expiresOn — YYYY-MM-DD, the day it stops being "pending" and starts being
//               rot. Past this date the guard prints an EXPIRED banner every
//               run (it does not fail — a stale entry must not brick an
//               unrelated PR, it must nag).
// lib/schema/schemaGuardAllowlist.test.ts enforces all three, so a silent
// skip is impossible: there is no way to add an entry without a reason and a
// date, and the guard PRINTS every entry it honored on every run.
//
// Two shapes:
//   { table, field, value } — the field exists, the OPTION does not.
//   { table, field }        — the FIELD does not exist on the table at all.
//
// To retire an entry: Ben adds the field/option in Airtable, someone runs
// `npm run schema:snapshot`, and deletes the line. tools/schema-guard.ts
// fails on an entry that is no longer a real mismatch, so the list cannot rot
// upward either.
// ─────────────────────────────────────────────────────────────────────────

export interface AllowlistEntry {
  /** Airtable table name, exactly as in lib/airtable.ts TABLES. */
  readonly table: string;
  /** Airtable field name, exactly as written by the code. */
  readonly field: string;
  /** The select option that does not exist. Omit to allowlist a missing FIELD. */
  readonly value?: string;
  /** Why this is not fixed yet. Required. */
  readonly reason: string;
  /** YYYY-MM-DD it was parked. Required. */
  readonly addedOn: string;
  /** YYYY-MM-DD it starts nagging. Required. */
  readonly expiresOn: string;
}

// Everything below was found by the FIRST run of `npm run schema:check`
// (2026-08-18). Each one is a real write the code performs today against a
// field or option the base does not have. A companion agent is reporting the
// whole set to Ben for schema addition; nothing here is "fine".
export const SCHEMA_GUARD_ALLOWLIST: readonly AllowlistEntry[] = [
  // ── Missing OPTIONS on existing select fields ───────────────────────────
  {
    table: 'Payments',
    field: 'Status',
    value: 'requires_webhook_replay',
    reason:
      'markDepositRequiresReplay (lib/contracts/payments.ts) parks a paid-but-unwebhooked deposit in a state the reaper can re-drive. Payments.Status has no such option, so the flip is dropped and the row stays "pending" — recoverable, but the operator loses the "this one needs a replay" signal. Needs the option added; lib/contracts/payments.ts is owned by another workstream this cycle.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Payments',
    field: 'Status',
    value: 'awaiting_auth',
    reason:
      'app/api/webhooks/stripe requires_action handler marks a 3DS-pending PaymentIntent. Option missing; the Telegram alert still fires, so the operator signal survives the drop.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Referrals',
    field: 'Status',
    value: 'Refunded',
    reason:
      'lib/refundLifecycle.ts refundReferralClearFields — the refund restore path. Referrals.Status has no "Refunded" option, so the flip is dropped and a refunded deal keeps its pre-refund status. The two readers that mattered are now defended and pinned: canSendFinalInvoice blocks on the cleared Deposit Paid At, and restoreReferralAfterRefund keys idempotency on the Refunded At STAMP via isRefundRestoreComplete (a Status-only guard never fired, so a redelivered charge.refunded re-ran the restore — duplicate rancher notice + a second decrementCapacity). Adding the option in Airtable retires this entry and costs nothing either way.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Ranchers',
    field: 'Stripe Connect Status',
    value: 'detached',
    reason:
      'app/api/webhooks/stripe-connect account.application.deauthorized. The co-written "Active Status": "Paused" IS a real option and is what actually gates routing, so the drop costs a label, not the pause.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Consumers',
    field: 'Sequence Stage',
    value: 'CLOSED_M2',
    reason:
      'app/api/cron/email-sequences post-purchase monthly letters. Stage stamps M2/M3/M4/REPEAT have no options; the co-written "Sequence Sent At" is the dwell anchor so the chain does not re-fire, it just cannot advance past CLOSED_CUTS.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Consumers',
    field: 'Sequence Stage',
    value: 'CLOSED_M3',
    reason: 'Same chain as CLOSED_M2 — see that entry.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Consumers',
    field: 'Sequence Stage',
    value: 'CLOSED_M4',
    reason: 'Same chain as CLOSED_M2 — see that entry.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Consumers',
    field: 'Sequence Stage',
    value: 'CLOSED_REPEAT',
    reason: 'Same chain as CLOSED_M2 — see that entry. This is the month-5 repeat ask.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Consumers',
    field: 'Founder Tier',
    value: 'REFUNDED',
    reason:
      'app/api/webhooks/stripe founder lifetime refund. Founder Tier only carries the five real tiers; the terminal markers were never added. "Founder Refunded At" is co-written and IS the durable audit, so the drop costs the Wall label only.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Consumers',
    field: 'Founder Tier',
    value: 'DISPUTED',
    reason: 'Same handler as REFUNDED — see that entry. "Founder Disputed At" is the durable audit.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Campaigns',
    field: 'Status',
    value: 'Scheduled',
    reason:
      'app/api/admin/broadcast schedules a future broadcast. Campaigns.Status has Pending/Sending/.../Failed but no Scheduled; "Scheduled For" is the field the send cron actually selects on, so the drop does not strand the broadcast.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
  {
    table: 'Campaigns',
    field: 'Status',
    value: 'Draft',
    reason:
      'lib/aiMemory parks its singleton memory row in the Campaigns table and wants it inert. No Draft option exists. The row is found by Campaign Name, never by Status, so the drop is cosmetic — but it is still a write the base rejects.',
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },

  // ── Empty-select write in a file another workstream owns ───────────────
  {
    table: 'Consumers',
    field: 'Sequence Stage',
    value: '',
    reason:
      "lib/contracts/payments restoreReferralAfterRefund resets the buyer's nurture stage with '' instead of null. lib/schema/selectGuard now normalises '' to null at the choke point, so the mint cannot happen either way — this entry exists only because lib/contracts/payments is owned by another workstream this cycle and must not be touched here. Delete it once that file writes null.",
    addedOn: '2026-08-18',
    expiresOn: '2026-09-30',
  },
];

// \u0000 separator: it cannot occur inside an Airtable table or field name,
// so a FIELD entry can never collide with an OPTION entry whose value is ''.
const key = (table: string, field: string, value?: string) =>
  `${table}\u0000${field}\u0000${value ?? '\u0000FIELD'}`;

const INDEX: ReadonlySet<string> = new Set(
  SCHEMA_GUARD_ALLOWLIST.map((e) => key(e.table, e.field, e.value)),
);

/** Is this exact (table, field, value) mismatch already parked? */
export function isOptionAllowlisted(table: string, field: string, value: string): boolean {
  return INDEX.has(key(table, field, value));
}

/** Is this whole (table, field) parked as a not-yet-created FIELD? */
export function isFieldAllowlisted(table: string, field: string): boolean {
  return INDEX.has(key(table, field));
}
