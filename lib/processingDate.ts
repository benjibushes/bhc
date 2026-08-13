// Past-date guard for the rancher "Next Processing Date" field (sweep fix
// 2026-08-13). The field is a one-time manual edit that re-decays every
// processing round — a live rancher page rendered "Next processing August 1,
// 2026" twelve days after the fact, and the same page was flagged stale at a
// July date the cycle before (docs/marketing/ads-state-launch.md). Every
// buyer-facing surface that renders the field must suppress or relabel a past
// value instead of presenting decayed data as a live promise.
//
// Display sites guarded with this helper:
//   • app/ranchers/[slug]/page.tsx  (quick-facts strip + reserve card)
//   • app/checkout/[refId]/deposit/page.tsx  (fulfillment line + scarcity line)
//   • lib/email.ts  (buyer intro processing line + operator call-brief)
//
// Semantics: date-only values ("YYYY-MM-DD" — the rancher portal writes via
// <input type="date">) compare against the current UTC calendar day and are
// past only when STRICTLY before today, so processing day itself still
// renders. Legacy datetime values fall back to a UTC-pinned parse. Blank or
// unparseable values are NOT past — callers already hide empty values, and a
// garbage value should fail open to the existing display path, not vanish
// silently behind this guard.

export function isProcessingDatePast(
  raw: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!raw) return false;
  const s = String(raw);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return d < todayUtc;
  }
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return false;
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) < todayUtc;
}
