// lib/formatUSD.ts
//
// ONE money format for rancher-facing surfaces — Wave 1A (2026-08-01).
//
// THE BUG: rancher money rendered through a mix of raw `toLocaleString()`
// and `toFixed(0)` calls, so a $2,999.50 sale printed as "$2,999.5" (the
// float's own toString shape) while the next column said "$2999". Pure,
// dependency-free, client-safe.
//
// Contract: whole dollars stay whole ("$2,999" — no ".00" noise on a
// dashboard of round prices); real cents always print as two digits
// ("$2,999.50", never "$2,999.5"). Sub-cent float dust is rounded away.
// NOT for buyer invoices — those use formatMoney in lib/buyerDealStage.ts,
// which always shows cents because an invoice has cents.
export function formatUSD(amount: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0';
  const cents = Math.round(n * 100);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  const hasCents = Math.abs(cents) % 100 !== 0;
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })}`;
}
