'use client';

// WAVE 2 (2026-06-30): shared nav spine for the rancher sub-pages that used to
// be dead-ends. Before this, /rancher/inbox (Messages) and /rancher/billing
// (Money) rendered with NO way back to the dashboard — a rancher who landed on
// either was stranded. This strip mirrors the in-dashboard cockpit spine so the
// rancher can always get home and jump between sections.
//
// IA / copy only — no data, no money logic. Brand tokens throughout.

import Link from 'next/link';

type SectionKey = 'home' | 'deals' | 'my_page' | 'messages' | 'money';

const SECTIONS: { key: SectionKey; label: string; href: string }[] = [
  // The in-dashboard tabs are reached via ?tab= so a deep link lands on the
  // right section (page.tsx reads the tab from the hash/return — these just
  // route the rancher home to the cockpit).
  { key: 'home', label: 'Home', href: '/rancher' },
  { key: 'deals', label: 'Deals', href: '/rancher#deals' },
  { key: 'my_page', label: 'My Page', href: '/rancher#my_page' },
  { key: 'messages', label: 'Messages', href: '/rancher/inbox' },
  { key: 'money', label: 'Money', href: '/rancher/billing' },
];

export default function RancherSubNav({ active }: { active: SectionKey }) {
  return (
    <nav className="bg-bone border-b border-dust" aria-label="Rancher dashboard">
      <div className="max-w-4xl mx-auto px-6 py-3 space-y-3">
        <Link
          href="/rancher"
          className="inline-flex items-center gap-1.5 text-sm text-saddle hover:text-charcoal transition-colors"
        >
          <span aria-hidden>←</span> back to dashboard
        </Link>
        <div className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <Link
              key={s.key}
              href={s.href}
              aria-current={active === s.key ? 'page' : undefined}
              className={`px-4 py-2.5 min-h-[44px] flex items-center text-sm font-medium tracking-wider uppercase transition-colors ${
                active === s.key
                  ? 'bg-charcoal text-bone'
                  : 'border border-dust hover:bg-charcoal hover:text-bone'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
