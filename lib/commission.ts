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
 */
export function calcCommission(saleAmount: number): number {
  const safeAmount = Number(saleAmount) || 0;
  return Math.round(safeAmount * getCommissionRate() * 100) / 100;
}
