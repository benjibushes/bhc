'use client';

// Auth Phase 0 — Clerk's <Show> control component gates browser admin
// renders.
//
// Old flow: poll /api/admin/auth, redirect to /admin/login on failure.
// New flow: <Show when="signed-in"> wraps children; <Show when="signed-out">
// hosts <RedirectToSignIn /> to push the unauth user to /admin/login.
//
// Clerk v7 replaced <SignedIn>/<SignedOut> with the <Show> primitive.
//
// Note: proxy.ts and lib/adminAuth.ts already enforce the ADMIN_EMAILS
// allowlist on the network layer. This guard is the client-side render gate.

import { RedirectToSignIn, Show } from '@clerk/nextjs';

export default function AdminAuthGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <RedirectToSignIn redirectUrl="/admin" />
      </Show>
    </>
  );
}
