// C4 — server-side error tracking (Sentry, manual App Router setup).
// INERT BY DESIGN: nothing initializes unless SENTRY_DSN is set, so the app
// builds + runs identically until the founder adds the DSN in Vercel env.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // No DSN → no-op. The founder activates this by setting SENTRY_DSN.
  if (!process.env.SENTRY_DSN) return;

  if (
    process.env.NEXT_RUNTIME === "nodejs" ||
    process.env.NEXT_RUNTIME === "edge"
  ) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      // Keep perf tracing cheap; errors are the point of this install.
      tracesSampleRate: 0.1,
    });
  }
}

// App Router server-error hook: captures errors from Server Components,
// route handlers, and server actions (the checkout-500-loop class of bug).
// captureRequestError is a safe no-op when Sentry was never initialized.
export const onRequestError = Sentry.captureRequestError;
