'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

const buttons = [
  { href: '/access', label: '🐄 i want real beef', route: 'buyer' as const },
  { href: '/map/add-a-rancher', label: '🤝 i\'m a rancher', route: 'rancher' as const },
  { href: '/brand-partners', label: '💼 i\'m a brand or creator', route: 'brand' as const },
];

export default function StartButtons() {
  useEffect(() => {
    trackEvent('start_view');
  }, []);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
      {buttons.map((b) => (
        <Link
          key={b.route}
          href={b.href}
          onClick={() => trackEvent('start_button_click', { route: b.route })}
          className="flex items-center justify-center min-h-[64px] w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-5 px-6 text-center transition-base hover:bg-divider active:scale-95"
        >
          {b.label}
        </Link>
      ))}
    </div>
  );
}
