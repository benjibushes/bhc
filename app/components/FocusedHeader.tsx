'use client';

import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { isFocusedRoute } from './ChromeGate';

// Minimal, no-exit header for focused flows (the quiz). Just the brand mark for
// trust — no nav, no links, nothing to click away to. Pairs with ChromeGate,
// which hides the full site chrome on the same routes. Renders nothing anywhere
// else.
export default function FocusedHeader() {
  const pathname = usePathname();
  if (!isFocusedRoute(pathname)) return null;
  return (
    <div className="flex items-center justify-center gap-2 py-4 border-b border-black/10">
      <Image
        src="/bhc-logo.png"
        alt="BuyHalfCow"
        width={32}
        height={32}
        className="object-contain"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
      <span className="font-serif text-lg tracking-tight">BuyHalfCow</span>
    </div>
  );
}
