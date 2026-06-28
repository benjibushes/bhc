// Single source of truth for admin IA. The sidebar (layout.tsx) and the
// ⌘K palette (CommandPalette.tsx) both render from this list — add a page
// here and it appears in both. Order within a group = display order.
//
// Groups:
//   PIPELINE — the daily close loop (desk → queue → referrals → inquiries)
//   MONEY    — cash surfaces (commissions, payments, compliance)
//   GROWTH   — top-of-funnel + marketing (broadcast, affiliates, analytics)
//   SYSTEM   — internal tooling, rarely daily
//
// visibleTo: which roles can see this nav item. Omitted = admin-only.
//   ['admin','onboarding'] — visible to onboarding partner
//   ['admin','ads']        — visible to ads partner

export interface AdminNavItem {
  group: 'PIPELINE' | 'MONEY' | 'GROWTH' | 'SYSTEM';
  icon: string;
  label: string;
  href: string;
  /** Optional ⌘K shortcut hint shown in the palette. */
  shortcut?: string;
  /**
   * Roles that may see this item. Omitted = admin-only (default-deny).
   * The navForRole() helper enforces this at render time.
   */
  visibleTo?: string[];
}

export const ADMIN_NAV: AdminNavItem[] = [
  // PIPELINE — admin-only: referral decisions, go-live, consumer PII
  {
    group: 'PIPELINE', icon: '🎛', label: 'Sales desk', href: '/admin/desk', shortcut: 'g k',
    visibleTo: ['admin', 'onboarding'],
  },
  {
    group: 'PIPELINE', icon: '☀️', label: 'Today', href: '/admin/today/v2', shortcut: 'g t',
    visibleTo: ['admin', 'onboarding'],
  },
  { group: 'PIPELINE', icon: '📨', label: 'All deals', href: '/admin/referrals', shortcut: 'g r' },
  { group: 'PIPELINE', icon: '📬', label: 'Inquiries', href: '/admin/inquiries' },
  { group: 'PIPELINE', icon: '📋', label: 'Full Dashboard', href: '/admin', shortcut: 'g d' },

  // MONEY — admin-only: refunds, payments, commissions
  { group: 'MONEY', icon: '💰', label: 'Commissions', href: '/admin/commissions' },
  { group: 'MONEY', icon: '💳', label: 'Payments', href: '/admin/payments' },
  { group: 'MONEY', icon: '✔️', label: 'Compliance', href: '/admin/compliance' },

  // GROWTH — broadcast/affiliates/campaigns admin-only; analytics+funnel open to ads
  { group: 'GROWTH', icon: '📢', label: 'Broadcast', href: '/admin/broadcast' },
  { group: 'GROWTH', icon: '📣', label: 'Campaigns', href: '/admin/campaigns' },
  { group: 'GROWTH', icon: '🤝', label: 'Affiliates', href: '/admin/affiliates' },
  {
    group: 'GROWTH', icon: '📊', label: 'Analytics', href: '/admin/analytics',
    visibleTo: ['admin', 'ads'],
  },
  {
    group: 'GROWTH', icon: '🪜', label: 'Funnel', href: '/admin/funnel',
    visibleTo: ['admin', 'ads'],
  },
  { group: 'GROWTH', icon: '🗺', label: 'Heatmap', href: '/admin/heatmap' },

  // SYSTEM — migration open to onboarding partner; others admin-only
  { group: 'SYSTEM', icon: '🩺', label: 'Health', href: '/admin/health' },
  { group: 'SYSTEM', icon: '📄', label: 'Page readiness', href: '/admin/page-readiness' },
  { group: 'SYSTEM', icon: '🗃', label: 'Backfill', href: '/admin/backfill' },
  {
    group: 'SYSTEM', icon: '🚚', label: 'Migration', href: '/admin/migration',
    visibleTo: ['admin', 'onboarding'],
  },
  { group: 'SYSTEM', icon: '⚙️', label: 'Settings', href: '/admin/settings', shortcut: 'g s' },
];

export const ADMIN_NAV_GROUPS = ['PIPELINE', 'MONEY', 'GROWTH', 'SYSTEM'] as const;

/**
 * Longest-prefix active match so nested routes highlight exactly one item
 * (/admin/desk/rec123 lights Sales desk; /admin/consumers/rec123 falls
 * through to Full Dashboard, its parent surface).
 */
export function activeNavHref(pathname: string): string | undefined {
  return ADMIN_NAV.map((n) => n.href)
    .filter((h) => pathname === h || pathname.startsWith(h === '/admin' ? '/admin' : h + '/'))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * Filter ADMIN_NAV to items visible to a given role.
 * admin sees everything; partner roles see only items listed in visibleTo.
 */
export function navForRole(role: string): AdminNavItem[] {
  if (role === 'admin') return ADMIN_NAV;
  return ADMIN_NAV.filter((n) => n.visibleTo?.includes(role));
}
