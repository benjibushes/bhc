/**
 * lib/owedDeposits — which abandoned checkouts are still MONEY OWED.
 *
 * THE TILE THIS BACKS: /admin/today "Owed to me" (app/api/admin/today/route.ts,
 * money band). The arming runbook treats that screen as ground truth, so a
 * wrong number there is not cosmetic — it is Ben's read on whether the machine
 * is collecting.
 *
 * THE DEFECT (live post-launch audit, 2026-08-18). The tile read
 * owedCents 285000 / owedCount 5. Every one of the five was an abandoned
 * Payments row, and four of them were already collected:
 *
 *   • THREE were retries on ONE referral (recbnzdZB4MixIyh5) whose deposit
 *     settled 2026-07-19. A buyer who fails checkout twice and succeeds on the
 *     third try leaves two abandoned rows behind; nothing swept them.
 *   • A fourth sat on a referral that settled 2026-08-11.
 *   • Exactly one was real: $500, on a referral that went Dormant unpaid.
 *
 * ROOT CAUSE: the old inline filter excluded only rows whose referral was
 * Awaiting-Payment-AND-unpaid (the anti-double-count against the referral side
 * of the same tile). Nothing excluded a referral that had SINCE PAID, and
 * nothing collapsed retries. A referral that pays keeps Status 'Awaiting
 * Payment' until the rancher accepts, so the since-paid rows slipped through
 * the one check that existed. 5.7x overstatement.
 *
 * THE RULE — an abandoned row is owed only when all four hold:
 *   1. Status is 'abandoned';
 *   2. its referral is not already counted on the referral side of the tile;
 *   3. the money never landed — no `Deposit Paid At` on the referral, and no
 *      succeeded (or refunded — you cannot refund what never paid) Payments
 *      row anywhere on that referral;
 *   4. it is the NEWEST abandoned attempt for its referral. Retries are one
 *      ask, and the newest attempt is the amount actually outstanding.
 *
 * Pure functions. No Airtable, no env, no clock.
 */

/** Airtable cells arrive as a plain string or a `{ name }` single-select. */
function cell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && 'name' in (v as any)) return String((v as any).name ?? '');
  return String(v);
}

const statusOf = (row: Record<string, any>): string => cell(row?.['Status']).trim().toLowerCase();

/**
 * Payment statuses that prove money landed on the referral. 'refunded' counts:
 * a refund is evidence of a successful charge, so the ask was answered — the
 * money is no longer OWED even though it later went back out.
 */
const SETTLED_PAYMENT_STATUSES = new Set(['succeeded', 'refunded']);

/** Newest-attempt ordering. An undated row loses to any dated one. */
function attemptTime(row: Record<string, any>): number {
  const t = Date.parse(cell(row?.['Abandoned At']) || cell(row?.['Created At']));
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * The abandoned Payments rows that are genuinely still owed.
 *
 * @param payments   every Payments row in the snapshot.
 * @param referrals  every Referrals row in the snapshot (for `Deposit Paid At`).
 * @param alreadyCountedReferralIds referral ids the CALLER is already counting
 *        on the referral side of the tile (Awaiting Payment + unpaid), so the
 *        same dollars are never counted twice.
 *
 * Returns at most one row per referral, in first-seen order. Rows with no
 * `Referral Id Text` are each kept on their own — two orphans cannot be proven
 * to be the same ask.
 */
export function selectOwedAbandonedPayments(
  payments: Array<Record<string, any>>,
  referrals: Array<Record<string, any>>,
  alreadyCountedReferralIds: Set<string> = new Set(),
): Array<Record<string, any>> {
  // Referrals whose deposit provably landed.
  const settledReferralIds = new Set<string>();
  for (const r of referrals || []) {
    if (r?.['Deposit Paid At']) settledReferralIds.add(String(r.id));
  }
  for (const p of payments || []) {
    const rid = cell(p?.['Referral Id Text']);
    if (!rid) continue;
    if (SETTLED_PAYMENT_STATUSES.has(statusOf(p)) || p?.['Refunded At']) settledReferralIds.add(rid);
  }

  // One slot per referral (or per orphan row), newest attempt wins. A Map
  // keeps first-seen key order, so replacing a value never reshuffles output.
  const bySlot = new Map<string, Record<string, any>>();
  for (const p of payments || []) {
    if (statusOf(p) !== 'abandoned') continue;
    const rid = cell(p?.['Referral Id Text']);
    if (rid && (settledReferralIds.has(rid) || alreadyCountedReferralIds.has(rid))) continue;
    const slot = rid || `__orphan:${String(p?.id ?? bySlot.size)}`;
    const held = bySlot.get(slot);
    if (!held || attemptTime(p) > attemptTime(held)) bySlot.set(slot, p);
  }
  return [...bySlot.values()];
}
