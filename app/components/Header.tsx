'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

const NAV_LINKS = [
  { href: '/ranchers', label: 'Ranchers' },
  { href: '/land', label: 'Land' },
  { href: '/about', label: 'About' },
  { href: '/faq', label: 'FAQ' },
  { href: '/news', label: 'News' },
];

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
          <nav className="hidden md:flex items-center gap-6">
            {NAV_LINKS.map(link => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-saddle hover:text-charcoal transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Desktop CTAs */}
          <div className="hidden md:flex items-center gap-3">
            <Link
              href="/member/login"
              className="text-sm text-saddle hover:text-charcoal transition-colors"
            >
              Log In
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
            className="md:hidden p-2 text-charcoal"
            aria-label="Toggle menu"
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
          <div className="md:hidden border-t border-dust py-4 space-y-1">
            {NAV_LINKS.map(link => (
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
                Member Login
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
                Join The HERD
              </Link>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
