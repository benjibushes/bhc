'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

// External hats CTA links straight to merch store; middleware /hats also
// redirects there but using the absolute URL in nav avoids a same-origin
// hop and lets us decorate with UTM at the nav-click level.
const HATS_NAV_URL =
  'https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=nav&utm_campaign=hat-launch';

// Full link set — every destination lives here so the mobile menu (and any
// future "More" surface) stays exhaustive and nothing becomes unreachable.
const NAV_LINKS = [
  { href: '/map', label: 'Map' },
  { href: '/ranchers', label: 'Ranchers' },
  { href: '/sell', label: 'Sell Your Beef' },
  { href: '/wins', label: 'Wins' },
  { href: '/founders', label: 'Founders' },
  { href: '/brand-partners', label: 'Brands' },
  { href: '/wholesale', label: 'Wholesale' },
  { href: HATS_NAV_URL, label: 'Hats', external: true },
  { href: '/about', label: 'About' },
  { href: '/faq', label: 'FAQ' },
];

// Desktop top-level nav — trimmed to the 6 highest-intent destinations so the
// bar doesn't wrap/overflow before the CTAs. The rest (Brands, Wholesale,
// About, Wins) stay reachable in the mobile menu + the site footer.
const PRIMARY_NAV_LABELS = new Set(['Map', 'Ranchers', 'Sell Your Beef', 'Founders', 'Hats', 'FAQ']);
const PRIMARY_NAV_LINKS = NAV_LINKS.filter((l) => PRIMARY_NAV_LABELS.has(l.label));

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="border-b border-dust bg-bone/95 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <Image
              src="/bhc-logo.png"
              alt="BuyHalfCow"
              width={36}
              height={36}
              className="object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span className="font-serif text-lg tracking-tight hidden sm:inline">BuyHalfCow</span>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden lg:flex items-center gap-6">
            {PRIMARY_NAV_LINKS.map(link => (
              link.external ? (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-saddle hover:text-charcoal transition-colors"
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm text-saddle hover:text-charcoal transition-colors"
                >
                  {link.label}
                </Link>
              )
            ))}
          </nav>

          {/* Desktop CTAs — the buyer door is labeled by its JOB ("My Order"),
              not a generic "Log In": buyers who paid a deposit need to KNOW
              there's a place to see status/tracking. Rancher login gets its own
              explicit link so neither audience guesses. */}
          <div className="hidden lg:flex items-center gap-3">
            <Link
              href="/member/login"
              className="text-sm text-saddle hover:text-charcoal transition-colors"
            >
              My Order
            </Link>
            <Link
              href="/rancher/login"
              className="text-sm text-saddle hover:text-charcoal transition-colors"
            >
              Rancher Log In
            </Link>
            <Link
              href="/access"
              className="text-sm px-5 py-2 bg-charcoal text-bone hover:bg-saddle transition-colors tracking-wide uppercase"
            >
              Join
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setOpen(!open)}
            className="lg:hidden p-2 text-charcoal"
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {open ? (
                <path d="M6 6l12 12M6 18L18 6" />
              ) : (
                <path d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile Menu */}
        {open && (
          <div className="lg:hidden border-t border-dust py-4 space-y-1">
            {NAV_LINKS.map(link => link.external ? (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="block py-2 text-sm text-saddle hover:text-charcoal transition-colors"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="block py-2 text-sm text-saddle hover:text-charcoal transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <div className="pt-3 border-t border-dust mt-3 space-y-2">
              <Link
                href="/member/login"
                onClick={() => setOpen(false)}
                className="block py-2 text-sm text-saddle hover:text-charcoal"
              >
                My Order (Member Login)
              </Link>
              <Link
                href="/rancher/login"
                onClick={() => setOpen(false)}
                className="block py-2 text-sm text-saddle hover:text-charcoal"
              >
                Rancher Login
              </Link>
              <Link
                href="/access"
                onClick={() => setOpen(false)}
                className="block py-2 text-sm font-medium text-charcoal"
              >
                Get Access
              </Link>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
