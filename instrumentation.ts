// C4 — server-side error tracking (Sentry, manual App Router setup).
// INERT BY DESIGN: nothing initializes unless SENTRY_DSN is set, so the app
// builds + runs identically until the founder adds the DSN in Vercel env.
import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";

export async function register() {
  // DEP0169 mute (log-hygiene audit 2026-08-10): a dependency's url.parse()
  // fires this deprecation on effectively EVERY serverless invocation, and
  // Vercel promotes any stderr output to error level — the production error
  // channel was ~100% this one warning, burying real errors. Surgical drop
  // of exactly DEP0169; every other warning and deprecation still emits.
  // Runs before the Sentry gate on purpose — it must apply DSN or no DSN.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const originalEmitWarning = process.emitWarning.bind(process);
    process.emitWarning = ((
      warning: string | Error,
      ...args: unknown[]
    ): void => {
      // Signatures: (warning, {code}) · (warning, type, code, ctor) ·
      // (Error-with-.code). Cover all three.
      const optionsCode =
        args[0] && typeof args[0] === "object"
          ? (args[0] as { code?: string }).code
          : undefined;
      const positionalCode = typeof args[1] === "string" ? args[1] : undefined;
      const errorCode =
        warning && typeof warning === "object"
          ? (warning as { code?: string }).code
          : undefined;
      if ([optionsCode, positionalCode, errorCode].includes("DEP0169")) return;
      (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
    }) as typeof process.emitWarning;
  }

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
//
// TWO wires (runtime audit 2026-07-28 — the server-error black hole):
//   1. Sentry.captureRequestError — safe no-op until SENTRY_DSN is set.
//   2. sendOperatorSignal (Telegram, loud) — the operator signal that exists
//      TODAY. Money routes with no top-level catch (orders/request,
//      checkout/deposit, webhooks/stripe) land here, so a checkout 500ing at
//      2am pings Ben instead of dying silently in Vercel logs.
// Dedupe: key = hash(routePath + normalized message), 1h window (rides
// operatorSignal's in-memory + Redis claimOnce dedupe) — a route 500ing all
// night is ONE alarm, not hundreds. This handler must NEVER throw: every
// wire is isolated, and a failure here only console.errors.
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  try {
    Sentry.captureRequestError(err, request, context);
  } catch {
    /* Sentry wire must never break the error path */
  }

  try {
    // The operator wire's libs (telegram/email/Redis fallbacks) are written
    // for the Node runtime; skip on edge (Sentry above still captures there).
    if (process.env.NEXT_RUNTIME !== "nodejs") return;

    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message ?? err)
        : String(err);
    // Prefer the ROUTE (e.g. /api/checkout/[refId]/deposit) over the request
    // path — dynamic segments in concrete paths would shatter the dedupe key
    // per-request. request.path is the fallback (Next 16's onRequestError
    // request shape is { path, method, headers }).
    const routePath =
      String((context as { routePath?: unknown })?.routePath || "") ||
      String(request.path || "");

    // Dynamic imports keep instrumentation's static graph tiny and make any
    // bundling failure a caught runtime error instead of a build break.
    const { buildServerErrorSignal } = await import("@/lib/serverErrorSignal");
    const { sendOperatorSignal } = await import("@/lib/operatorSignal");
    await sendOperatorSignal(
      buildServerErrorSignal({
        routePath,
        routerKind: (context as { routerKind?: string })?.routerKind,
        routeType: (context as { routeType?: string })?.routeType,
        method: (request as { method?: string })?.method,
        message,
      }),
    );
  } catch (signalErr) {
    try {
      console.error(
        "[onRequestError] operator signal failed:",
        (signalErr as { message?: string })?.message,
      );
    } catch {
      /* never throw from the error handler */
    }
  }
};
