// lib/operationType.ts — operation-type labels (P4, MARKETING-REVAMP 2026-08
// principle 4, Ben's direct mandate 2026-08-08).
//
// BHC represents BOTH kinds of outfit, and the buyer must never guess which
// one they're buying from:
//
//   • "ships frozen, nationwide"        — products/operations that ship
//   • "local share — serves [state]"    — local share ranches
//
// This module is the ONE place the label is derived, so every surface (shop
// cards, PDP, ranch stalls, share pages, receipt/shipped/intro emails, the
// future Ranch Stand Digest) says exactly the same thing. Deliberately PURE —
// no Airtable, no env — so the client grid can import it and every rule is
// unit-tested (lib/operationType.test.ts).
//
// HARD INVARIANT: unknown or ambiguous input returns null and the caller
// renders NOTHING. A missing label is honest; a wrong label is a lie.
//
// Classification rules (from the fields that actually exist):
//   product  — localOnly (Ships Nationwide === false) is a pickup-at-the-ranch
//              product: NEITHER kind; its surfaces already carry the explicit
//              "local pickup at the ranch — no shipping" copy, so → null.
//              Everything else ships (isSellableRow requires Ships Nationwide
//              !== false), including deposit-style rows — the deposit MECHANIC
//              never flips a shippable product to local-share. Label text:
//              frozen only when we KNOW it ships frozen (shelfStable === false
//              and not merch); shelf-stable, merch, or unknown-shelf-stability
//              (e.g. PI-metadata email paths) get the frozen-agnostic
//              "ships nationwide".
//   share    — a share ranch serves its home state; the label interpolates the
//              full state name. No normalizable state → null.

import { normalizeState, stateName } from './states';

export type OperationKind = 'ships-nationwide' | 'local-share';

export interface OperationType {
  kind: OperationKind;
  label: string;
}

export type OperationTypeInput =
  | {
      type: 'product';
      /** Ships Nationwide === false — pickup-at-the-ranch, no label. */
      localOnly?: boolean;
      /** true = shelf-stable; false = ships frozen; undefined = unknown. */
      shelfStable?: boolean;
      /** Deposit-mechanic flag — presentation only, still ships. */
      depositStyle?: boolean;
      /** Airtable Category (e.g. 'Merch') — merch never claims frozen. */
      category?: string;
      /** Browse-group key (StandProduct shape, e.g. 'merch'). */
      group?: string;
    }
  | {
      type: 'share-ranch';
      /** Ranch home state — code or full name; unknown → null. */
      state?: unknown;
    };

/**
 * Derive the operation-type label for one product or share ranch.
 * Returns null whenever classification is uncertain — callers render nothing.
 */
export function operationTypeFor(
  input: OperationTypeInput | null | undefined,
): OperationType | null {
  if (!input || typeof input !== 'object') return null;

  if (input.type === 'product') {
    if (input.localOnly === true) return null; // pickup — its own copy already labels it
    const isMerch =
      /^merch$/i.test(String(input.category || '').trim()) ||
      /^merch$/i.test(String(input.group || '').trim());
    const shipsFrozen = input.shelfStable === false && !isMerch;
    return {
      kind: 'ships-nationwide',
      label: shipsFrozen ? 'ships frozen, nationwide' : 'ships nationwide',
    };
  }

  if (input.type === 'share-ranch') {
    const st = normalizeState(input.state);
    if (!st) return null;
    return { kind: 'local-share', label: `local share — serves ${stateName(st)}` };
  }

  return null;
}

/**
 * Stand-level label for a ranch stall (/shop): the stand is ships-nationwide
 * ONLY when every rendered item classifies as ships-nationwide. Any pickup
 * item (or an empty stand) → null — never claim a whole stand ships when part
 * of it is drive-to-the-ranch. Mixed frozen + shelf-stable/merch stands get
 * the frozen-agnostic label.
 */
export function operationTypeForStand(
  items: Array<{
    localOnly?: boolean;
    shelfStable?: boolean;
    depositStyle?: boolean;
    category?: string;
    group?: string;
  }>,
): OperationType | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const ops = items.map((p) =>
    operationTypeFor({
      type: 'product',
      localOnly: p.localOnly,
      shelfStable: p.shelfStable,
      depositStyle: p.depositStyle,
      category: p.category,
      group: p.group,
    }),
  );
  if (ops.some((o) => !o || o.kind !== 'ships-nationwide')) return null;
  const labels = new Set(ops.map((o) => (o as OperationType).label));
  return labels.size === 1
    ? (ops[0] as OperationType)
    : { kind: 'ships-nationwide', label: 'ships nationwide' };
}

/**
 * The digest-ready one-line email block. One quiet saddle-toned line — the
 * receipt/shipped/intro emails render it today; the Ranch Stand Digest (P3′)
 * reuses it per product/ranch block. '' for null so callers can interpolate
 * unconditionally. Labels are internally-derived strings (no user data), so
 * no HTML escaping is required.
 */
export function operationTypeEmailLine(op: OperationType | null): string {
  if (!op) return '';
  return `<p style="font-size:12px;color:#6B4F3F;margin:4px 0 10px 0;">${op.label}</p>`;
}
