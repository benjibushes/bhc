/**
 * Commission rate — single source of truth.
 *
 * THE BUG WE'RE PREVENTING:
 * env.example originally had `NEXT_PUBLIC_COMMISSION_RATE=10`. Backend code
 * read this with `Number(... || '0.10')` — so an env value of "10" yielded
 * a rate of 10 (not 0.10), and commission billed as `saleAmount * 10` =
 * 10× the sale price. A $1,500 sale would invoice $15,000.
 *
 * One Vercel env-flip away from catastrophe. This helper normalizes any
 * sane-looking input ("10", "0.10", "10%") into the canonical 0.10 fraction
 * and clamps to (0, 1].
 *
 * Use getCommissionRate() everywhere — never read NEXT_PUBLIC_COMMISSION_RATE
 * directly.
 */

const DEFAULT_RATE = 0.1;

export function getCommissionRate(): number {
  const raw = (process.env.NEXT_PUBLIC_COMMISSION_RATE || '').toString().trim();
  if (!raw) return DEFAULT_RATE;
  const num = Number(raw.replace('%', ''));
  if (!isFinite(num) || num <= 0) return DEFAULT_RATE;
  // Normalize: anything > 1 is treated as a percentage (10 → 0.10).
  // Anything between 0 and 1 is treated as a fraction (0.10 → 0.10).
  const fraction = num > 1 ? num / 100 : num;
  // Hard clamp — never bill more than 100%, never zero.
  if (fraction <= 0) return DEFAULT_RATE;
  if (fraction > 1) return 1;
  return fraction;
}

/**
 * Calculate commission cents-precise. Returns a number rounded to 2 decimals.
 *
 * Uses the env-default rate. Prefer calcCommissionForRancher when you have
 * the rancher record handy — it reads the rancher's locked Commission Rate
 * so closes always honor what the rancher agreed to at signing time.
 */
export function calcCommission(saleAmount: number): number {
  const safeAmount = Number(saleAmount) || 0;
  return Math.round(safeAmount * getCommissionRate() * 100) / 100;
}

/**
 * Normalize a raw 'Commission Rate' field value into a canonical fraction —
 * MONEY-TRUTH TAIL (2026-07-01), finding 1c.
 *
 * THE BUG: the field is human-editable in Airtable. An operator typing "4"
 * (meaning 4%) used to pass the old `raw > 0` check and clamp to 1 → the
 * close path billed 100% of the sale instead of 4%. And a locked 0 (Operator
 * tier — zero commission) read as "no rate", falling back to the 10% default.
 *
 * DECISION TABLE (pinned in lib/commission.test.ts):
 *   null / undefined / ''            → null   (unset — the no-rate close gate fires)
 *   non-numeric garbage / NaN / ±Inf → null
 *   negative                        → null   (never a valid rate)
 *   0                               → 0      (VALID — Operator tier 0%)
 *   0 < raw < 1                     → raw    (already a fraction)
 *   1 ≤ raw < 100                   → raw/100 (typed as percent: 4 → 0.04,
 *                                     10 → 0.10; boundary 1 → 0.01 — no BHC
 *                                     rate is 100%, a literal 1 is a typo for 1%)
 *   raw ≥ 100                       → null   (implausible as fraction OR percent
 *                                     — gate the close, don't guess with money)
 *
 * Numeric strings ("4", "0.04", "4%") are tolerated — Airtable values pass
 * through String() coercions in several routes.
 *
 * null means "no usable locked rate": hasLockedCommissionRate() returns false
 * and the close-path HARD GATE blocks until the operator fixes the field.
 */
export function normalizeCommissionRate(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num =
    typeof raw === 'number' ? raw : Number(String(raw).replace('%', '').trim() || 'NaN');
  if (!Number.isFinite(num)) return null;
  if (num < 0) return null;
  if (num === 0) return 0;
  const fraction = num >= 1 ? num / 100 : num;
  if (fraction >= 1) return null;
  return fraction;
}

/**
 * Is the raw 'Commission Rate' FIELD truly empty (never written)?
 * Distinct from normalizeCommissionRate() === null: garbage ('abc', 400) is
 * NOT empty — it's an operator-owned value (a mistyped negotiated rate) that
 * automated writers (the tier-subscription webhook upsert) must NEVER
 * overwrite. The close gate surfaces garbage; a human resolves it.
 */
export function isCommissionRateFieldEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

/**
 * Per-rancher commission rate. Reads the rancher's `Commission Rate` field
 * (locked at sign-agreement time) through normalizeCommissionRate, falls back
 * to env default only when the field is unset/unusable. Bounded [0, 1).
 *
 * Use this on all close paths so a rancher's invoice always matches what
 * they signed up for. Drift between deals = the Ashcraft-pattern dispute
 * (2026-05-20 incident). A locked 0 (Operator tier) returns 0 — NEVER the
 * env default.
 */
export function getRancherCommissionRate(rancher: any): number {
  const normalized = normalizeCommissionRate(rancher?.['Commission Rate']);
  if (normalized !== null) return normalized;
  return getCommissionRate();
}

/**
 * Calculate commission for a specific rancher's deal. Per-rancher rate +
 * cents-precise rounding.
 */
export function calcCommissionForRancher(rancher: any, saleAmount: number): number {
  const safeAmount = Number(saleAmount) || 0;
  const rate = getRancherCommissionRate(rancher);
  return Math.round(safeAmount * rate * 100) / 100;
}

/**
 * Has this rancher locked a USABLE explicit commission rate? Used by close
 * paths to refuse Closed Won when the rate is missing — forces the ambiguity
 * to be resolved BEFORE money flows.
 *
 * Finding 1b (2026-07-01): 0 is a VALID locked rate — the Operator tier is
 * explicitly zero-commission. The old `raw > 0` check hard-gated every
 * Operator close (or, on paths that skipped the gate, fell back to billing
 * the 10% default). Emptiness and zero are now distinct: unset/garbage →
 * false (gate), locked 0 → true (close proceeds, commission = $0).
 */
export function hasLockedCommissionRate(rancher: any): boolean {
  return normalizeCommissionRate(rancher?.['Commission Rate']) !== null;
}

/**
 * Rail-split net earnings — SLICE E (2026-07-01). Pure display math; the ONE
 * helper every "your net / your earnings" surface must route through.
 *
 * THE SEMANTICS SPLIT:
 *   - tier_v2: BHC's commission is charged ON TOP of the rancher's price at
 *     deposit time — the BUYER pays it. The rancher keeps 100% of THEIR price,
 *     so net = revenue. Deducting commission here understated tier_v2 earnings
 *     on 4 cockpit surfaces + the CSV and contradicted the "you keep 100%"
 *     close-modal copy.
 *   - legacy (and any unknown rail): the rancher pays commission post-close
 *     via a Stripe invoice, so net = revenue − commission. This branch is
 *     byte-identical to the old math — legacy numbers must not move.
 *
 * `rail` is the rancher's Pricing Model ('legacy' | 'tier_v2'); tolerant of
 * case/whitespace because Airtable singleSelect values pass through String()
 * coercions in several routes. DISPLAY ONLY — never used on a charge path.
 */
export function netEarningsFor(
  rail: string | null | undefined,
  revenue: number,
  commission: number,
): number {
  const rev = Number(revenue) || 0;
  const com = Number(commission) || 0;
  if (String(rail || '').trim().toLowerCase() === 'tier_v2') return rev;
  return rev - com;
}

/**
 * Which economic rail did a SINGLE referral actually ride? — RAIL-PER-ROW
 * (dashboard SaaS audit, 2026-07-08). Findings #3 + #4.
 *
 * THE BUG: earnings math keyed the rail off the rancher's CURRENT
 * `Pricing Model` and applied it to ALL historical rows. A rancher migrated
 * to tier_v2 still has (a) legacy invoice-collected history and (b) off-rail
 * "closed on a call, no deposit" closes — and BOTH were being treated as
 * tier_v2 deposit-rail economics. Result: net earnings overstated by the
 * commission actually paid (Silverline +$440), the tax CSV overstated the
 * same, "Collected — taken at deposit" shown on invoice-collected rows, and
 * — the live money leak — off-rail tier_v2 closes never got a commission
 * invoice AND were force-counted as $0 unpaid, so BHC silently ate the
 * commission (Foodstead +$156.91, growing per close).
 *
 * THE DISCRIMINATOR: a referral rode the tier_v2 DEPOSIT rail — commission
 * skimmed at deposit time via application_fee_amount, so net = full revenue
 * and there is nothing to invoice — IF AND ONLY IF a deposit was actually
 * paid on it (`Deposit Paid At` stamped). Everything else is legacy
 * economics: commission is collected by post-close invoice, net =
 * revenue − commission, and the row IS invoice-eligible. Never per-rancher.
 *
 * Accepts either a raw Airtable record ('Deposit Paid At') or a shaped
 * dashboard/API object (`deposit_paid_at`).
 */
export function referralRail(ref: any): 'tier_v2' | 'legacy' {
  const depositPaidAt =
    ref?.['Deposit Paid At'] ?? ref?.deposit_paid_at ?? ref?.depositPaidAt ?? '';
  return String(depositPaidAt || '').trim() ? 'tier_v2' : 'legacy';
}
