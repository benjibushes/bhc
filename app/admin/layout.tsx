'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Toaster } from 'sonner';
import CommandPalette from './CommandPalette';
import { ADMIN_NAV, ADMIN_NAV_GROUPS, activeNavHref } from './nav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const isLoginPage = pathname === '/admin/login';

  useEffect(() => {
    if (isLoginPage) {
      setAuthed(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/auth');
        if (cancelled) return;
        if (res.ok) {
          setAuthed(true);
        } else {
          setAuthed(false);
          router.push('/admin/login');
        }
      } catch {
        if (!cancelled) {
          setAuthed(false);
          router.push('/admin/login');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoginPage, router, pathname]);

  // Login page: render children directly, no shell
  if (isLoginPage) {
    return (
      <>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </>
    );
  }

  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bone">
        <div className="w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authed) return null;

  const activeHref = activeNavHref(pathname);

  return (
    <div className="min-h-screen bg-bone text-charcoal">
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between bg-white border-b border-dust px-4 py-3">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 -ml-2"
          aria-label="Open navigation"
        >
          <span className="block w-5 h-0.5 bg-charcoal mb-1" />
          <span className="block w-5 h-0.5 bg-charcoal mb-1" />
          <span className="block w-5 h-0.5 bg-charcoal" />
        </button>
        <Link href="/admin/today/v2" className="font-[family-name:var(--font-serif)] text-lg">
          BuyHalfCow · Admin
        </Link>
        <button
          onClick={() => (document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })))}
          className="text-xs text-saddle"
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
          } fixed lg:sticky lg:top-0 lg:translate-x-0 z-50 inset-y-0 left-0 w-64 bg-white border-r border-dust h-screen overflow-y-auto transition-transform lg:transition-none`}
        >
          <div className="p-5 border-b border-dust">
            <Link
              href="/admin/today/v2"
              className="block font-[family-name:var(--font-serif)] text-xl"
              onClick={() => setSidebarOpen(false)}
            >
              BuyHalfCow
            </Link>
            <p className="text-xs text-saddle mt-0.5">Admin</p>
            <button
              onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
              className="mt-3 w-full flex items-center justify-between px-3 py-2 text-sm border border-dust hover:border-charcoal bg-bone"
            >
              <span className="text-saddle">Search…</span>
              <kbd className="text-xs text-dust font-mono">⌘K</kbd>
            </button>
          </div>

          <nav className="p-3 space-y-5">
            {ADMIN_NAV_GROUPS.map((g) => (
              <div key={g}>
                <p className="text-[10px] font-semibold text-dust tracking-widest px-2 mb-1">
                  {g}
                </p>
                <ul className="space-y-0.5">
                  {ADMIN_NAV.filter((n) => n.group === g).map((item) => {
                    const active = item.href === activeHref;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setSidebarOpen(false)}
                          className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded ${
                            active
                              ? 'bg-charcoal text-bone'
                              : 'text-charcoal hover:bg-bone'
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

          <div className="p-3 border-t border-dust mt-4">
            <button
              onClick={async () => {
                await fetch('/api/admin/auth', { method: 'DELETE' });
                router.push('/admin/login');
              }}
              className="w-full text-left px-2 py-1.5 text-sm text-saddle hover:bg-bone rounded"
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
  );
}
