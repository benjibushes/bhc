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
const FOCUSED_PREFIXES = ['/qualify', '/access'];

export function isFocusedRoute(pathname: string | null | undefined): boolean {
  const p = pathname || '';
  return FOCUSED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

export default function ChromeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (isFocusedRoute(pathname)) return null;
  return <>{children}</>;
}
