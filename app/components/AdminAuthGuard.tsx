'use client';

// Pass-through kept for import compatibility across the 14 admin pages.
//
// app/admin/layout.tsx is the single auth gate for everything under /admin:
// it fetches /api/admin/auth, blocks render until the check resolves, and
// redirects to /admin/login on failure. This component used to run the same
// fetch a second time on every page mount — pure duplication (2x auth round
// trip per page view) with no extra security: the API routes themselves
// enforce requireAdmin() on every call, so client gating is UX, not defense.
export default function AdminAuthGuard({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
