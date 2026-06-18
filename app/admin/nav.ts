// Single source of truth for admin IA. The sidebar (layout.tsx) and the
// ⌘K palette (CommandPalette.tsx) both render from this list — add a page
// here and it appears in both. Order within a group = display order.
//
// Groups:
//   PIPELINE — the daily close loop (desk → queue → referrals → inquiries)
//   MONEY    — cash surfaces (commissions, payments, compliance)
//   GROWTH   — top-of-funnel + marketing (broadcast, affiliates, analytics)
//   SYSTEM   — internal tooling, rarely daily

export interface AdminNavItem {
  group: 'PIPELINE' | 'MONEY' | 'GROWTH' | 'SYSTEM';
  icon: string;
  label: string;
  href: string;
  /** Optional ⌘K shortcut hint shown in the palette. */
  shortcut?: string;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { group: 'PIPELINE', icon: '🎛', label: 'Desk', href: '/admin/today/v2', shortcut: 'g k' },
  { group: 'PIPELINE', icon: '🏠', label: 'Today', href: '/admin/today', shortcut: 'g t' },
  { group: 'PIPELINE', icon: '📨', label: 'Referrals', href: '/admin/referrals', shortcut: 'g r' },
  { group: 'PIPELINE', icon: '📬', label: 'Inquiries', href: '/admin/inquiries' },
  { group: 'PIPELINE', icon: '📋', label: 'Full Dashboard', href: '/admin', shortcut: 'g d' },
  { group: 'MONEY', icon: '💰', label: 'Commissions', href: '/admin/commissions' },
  { group: 'MONEY', icon: '💳', label: 'Payments', href: '/admin/payments' },
  { group: 'MONEY', icon: '✔️', label: 'Compliance', href: '/admin/compliance' },
  { group: 'GROWTH', icon: '📢', label: 'Broadcast', href: '/admin/broadcast' },
  { group: 'GROWTH', icon: '📣', label: 'Campaigns', href: '/admin/campaigns' },
  { group: 'GROWTH', icon: '🤝', label: 'Affiliates', href: '/admin/affiliates' },
  { group: 'GROWTH', icon: '📊', label: 'Analytics', href: '/admin/analytics' },
  { group: 'GROWTH', icon: '🪜', label: 'Funnel', href: '/admin/funnel' },
  { group: 'GROWTH', icon: '🗺', label: 'Heatmap', href: '/admin/heatmap' },
  { group: 'SYSTEM', icon: '🩺', label: 'Health', href: '/admin/health' },
  { group: 'SYSTEM', icon: '🗃', label: 'Backfill', href: '/admin/backfill' },
  { group: 'SYSTEM', icon: '🚚', label: 'Migration', href: '/admin/migration' },
  { group: 'SYSTEM', icon: '⚙️', label: 'Settings', href: '/admin/settings', shortcut: 'g s' },
];

export const ADMIN_NAV_GROUPS = ['PIPELINE', 'MONEY', 'GROWTH', 'SYSTEM'] as const;

/**
 * Longest-prefix active match so nested routes highlight exactly one item
 * (/admin/today/v2 lights Desk, not Today; /admin/consumers/rec123 falls
 * through to Full Dashboard, its parent surface).
 */
export function activeNavHref(pathname: string): string | undefined {
  return ADMIN_NAV.map((n) => n.href)
    .filter((h) => pathname === h || pathname.startsWith(h === '/admin' ? '/admin' : h + '/'))
    .sort((a, b) => b.length - a.length)[0];
}
