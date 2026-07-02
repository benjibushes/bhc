// DEMO MODE watermark ribbon — LOCAL ONLY.
//
// Renders a small fixed amber ribbon (bottom-left) on every page when
// NEXT_PUBLIC_DEMO_MODE === 'true', so a screen recording can never be
// mistaken for the live site. Renders NOTHING when the flag is off — and
// since NEXT_PUBLIC_* is inlined at build time, in a production build this
// component compiles down to `return null`. This flag is NEVER set in Vercel.
// See lib/demo/demoMode.ts.

// No 'use client' needed — this is a pure, prop-less server-safe render that
// reads a build-time-inlined public env var. Kept dependency-free on purpose.
export default function DemoBanner() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== 'true') return null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        bottom: 12,
        left: 12,
        zIndex: 2147483647,
        pointerEvents: 'none',
        background: '#F59E0B',
        color: '#1F2937',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '0.02em',
        padding: '6px 12px',
        borderRadius: 9999,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        border: '1px solid #B45309',
      }}
    >
      DEMO MODE · sample data · not live
    </div>
  );
}
