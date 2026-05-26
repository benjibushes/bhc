'use client';

// Auth Phase 0 — admin shell now wraps in Clerk's SignedIn/SignedOut.
// Middleware enforces the ADMIN_EMAILS allowlist on the network layer; this
// shell is the client-side render gate + chrome (sidebar, command palette,
// toaster).

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Toaster } from 'sonner';
import { RedirectToSignIn, Show, useClerk } from '@clerk/nextjs';
import CommandPalette from './CommandPalette';

const NAV: { label: string; href: string; icon: string; group: string }[] = [
  { group: 'PIPELINE', icon: '🏠', label: 'Today', href: '/admin/today' },
  { group: 'PIPELINE', icon: '📨', label: 'Referrals', href: '/admin/referrals' },
  { group: 'PIPELINE', icon: '📋', label: 'Full Dashboard', href: '/admin' },
  { group: 'OPS', icon: '💰', label: 'Commissions', href: '/admin/commissions' },
  { group: 'OPS', icon: '📢', label: 'Broadcast', href: '/admin/broadcast' },
  { group: 'OPS', icon: '✔️', label: 'Compliance', href: '/admin/compliance' },
  { group: 'OPS', icon: '🤝', label: 'Affiliates', href: '/admin/affiliates' },
  { group: 'INSIGHT', icon: '📊', label: 'Analytics', href: '/admin/analytics' },
  { group: 'INSIGHT', icon: '🪜', label: 'Funnel', href: '/admin/funnel' },
  { group: 'INSIGHT', icon: '🗺', label: 'Heatmap', href: '/admin/heatmap' },
  { group: 'INSIGHT', icon: '📬', label: 'Inquiries', href: '/admin/inquiries' },
  { group: 'INSIGHT', icon: '🗃', label: 'Backfill', href: '/admin/backfill' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const clerk = useClerk();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Login page hosts Clerk's <SignIn />, so it must render without the gated
  // shell — Clerk would otherwise redirect-loop unauthenticated visitors.
  const isLoginPage = pathname === '/admin/login' || pathname?.startsWith('/admin/login/');

  if (isLoginPage) {
    return (
      <>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </>
    );
  }

  const groups = Array.from(new Set(NAV.map((n) => n.group)));

  return (
    <>
      <Show when="signed-out">
        <RedirectToSignIn redirectUrl="/admin" />
      </Show>
      <Show when="signed-in">
        <div className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
          {/* Mobile top bar */}
          <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between bg-white border-b border-[#A7A29A] px-4 py-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 -ml-2"
              aria-label="Open navigation"
            >
              <span className="block w-5 h-0.5 bg-[#0E0E0E] mb-1" />
              <span className="block w-5 h-0.5 bg-[#0E0E0E] mb-1" />
              <span className="block w-5 h-0.5 bg-[#0E0E0E]" />
            </button>
            <Link href="/admin/today" className="font-[family-name:var(--font-serif)] text-lg">
              BuyHalfCow · Admin
            </Link>
            <button
              onClick={() => (document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })))}
              className="text-xs text-[#6B4F3F]"
              aria-label="Search"
            >
              🔍
            </button>
          </div>

          <div className="flex">
            {/* Sidebar */}
            <aside
              className={`${
                sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              } fixed lg:sticky lg:top-0 lg:translate-x-0 z-50 inset-y-0 left-0 w-64 bg-white border-r border-[#A7A29A] h-screen overflow-y-auto transition-transform lg:transition-none`}
            >
              <div className="p-5 border-b border-[#A7A29A]">
                <Link
                  href="/admin/today"
                  className="block font-[family-name:var(--font-serif)] text-xl"
                  onClick={() => setSidebarOpen(false)}
                >
                  BuyHalfCow
                </Link>
                <p className="text-xs text-[#6B4F3F] mt-0.5">Admin</p>
                <button
                  onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
                  className="mt-3 w-full flex items-center justify-between px-3 py-2 text-sm border border-[#A7A29A] hover:border-[#0E0E0E] bg-[#F4F1EC]"
                >
                  <span className="text-[#6B4F3F]">Search…</span>
                  <kbd className="text-xs text-[#A7A29A] font-mono">⌘K</kbd>
                </button>
              </div>

              <nav className="p-3 space-y-5">
                {groups.map((g) => (
                  <div key={g}>
                    <p className="text-[10px] font-semibold text-[#A7A29A] tracking-widest px-2 mb-1">
                      {g}
                    </p>
                    <ul className="space-y-0.5">
                      {NAV.filter((n) => n.group === g).map((item) => {
                        const active =
                          item.href === '/admin'
                            ? pathname === '/admin'
                            : pathname.startsWith(item.href);
                        return (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              onClick={() => setSidebarOpen(false)}
                              className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded ${
                                active
                                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                                  : 'text-[#0E0E0E] hover:bg-[#F4F1EC]'
                              }`}
                            >
                              <span className="w-5 text-center">{item.icon}</span>
                              <span>{item.label}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </nav>

              <div className="p-3 border-t border-[#A7A29A] mt-4">
                <button
                  onClick={async () => {
                    // Clerk sign-out wipes the session cookie + invalidates server-side.
                    await clerk.signOut({ redirectUrl: '/admin/login' });
                    router.push('/admin/login');
                  }}
                  className="w-full text-left px-2 py-1.5 text-sm text-[#6B4F3F] hover:bg-[#F4F1EC] rounded"
                >
                  Log out
                </button>
              </div>
            </aside>

            {/* Mobile backdrop */}
            {sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden fixed inset-0 z-40 bg-black/40"
                aria-label="Close navigation"
              />
            )}

            {/* Main content */}
            <main className="flex-1 min-w-0">{children}</main>
          </div>

          <CommandPalette />
          <Toaster position="top-right" richColors closeButton />
        </div>
      </Show>
    </>
  );
}
