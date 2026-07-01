'use client';

import { usePathname } from 'next/navigation';

// Focused, distraction-free routes. On these, the full site chrome (promo bar,
// nav, footer) is hidden so the flow is a sealed room with no exits.
//
// Why: the /qualify quiz was rendered inside the full marketing site — a
// hat-merch promo bar, the entire nav (Map, Hats, Wholesale, Log In, JOIN), and
// a footer of exit links, on every one of the 4 steps. Only 4.8% of buyers who
// reached it finished. A qualification quiz should be a checkout-style flow with
// one job and zero escape hatches. (2026-06-18)
//
// Add a prefix here to seal another flow.
// '/access' is the unified buyer funnel (2026-06-18) — sealed like '/qualify'
// so the game-like wizard is a checkout-style room with no nav/promo/footer.
// '/book' is the on-site booking keystone (2026-06-19) — sealed so email/SMS
// booking links land on a focused, chrome-free booking page (no escape hatches).
// '/checkout' is the money step BOTH front doors converge on (deposit, success,
// preferences, ask) — sealed 2026-07-01 so the buyer isn't dumped back into the
// full marketing site (nav exit-links, footer, hat-merch promo bar) at the peak
// deposit-anxiety moment. Un-sealing it is exactly the pattern that tanked
// completion to 4.8% (see the demand-funnel history above).
const FOCUSED_PREFIXES = ['/qualify', '/access', '/book', '/checkout'];

export function isFocusedRoute(pathname: string | null | undefined): boolean {
  const p = pathname || '';
  return FOCUSED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

export default function ChromeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (isFocusedRoute(pathname)) return null;
  return <>{children}</>;
}
