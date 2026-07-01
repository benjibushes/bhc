// C4 — browser-side error tracking (Sentry, manual App Router setup).
// INERT BY DESIGN: init is gated on NEXT_PUBLIC_SENTRY_DSN (inlined at build
// time), so with no env set the client behaves exactly as before.
import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    // Sample 10% of transactions — enough signal for an ad push without
    // burning quota.
    tracesSampleRate: 0.1,
    // No session replay: keeps the client bundle lean.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

// Instruments App Router navigations for tracing; harmless no-op when
// Sentry.init never ran.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
