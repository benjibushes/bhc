// /demo — the launcher index for recording rancher-onboarding tutorials.
//
// Only meaningfully useful when NEXT_PUBLIC_DEMO_MODE==='true' (a local-only
// flag never set in Vercel — see lib/demo/demoMode.ts). In production builds
// without the flag this page 404s (GTM cut list 2026-08-01) — an internal
// recording tool has no business rendering on the public site. In local dev
// it still renders with the "demo mode is off" banner + instructions.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Demo Launcher',
  robots: { index: false, follow: false },
};

const RUN_CMD = 'NEXT_PUBLIC_DEMO_MODE=true npm run dev';

const SURFACES: { href: string; label: string; show: string }[] = [
  {
    href: '/rancher',
    label: 'Rancher dashboard',
    show: 'The money view — earnings, active leads across every pipeline stage, and the inbox with unread buyer messages. Auto-logged-in as Demo Creek Cattle Co (no password).',
  },
  {
    href: '/ranchers/demo-creek-cattle',
    label: 'Your storefront',
    show: 'The public landing page a buyer sees — cover photo, pricing for Quarter / Half / Whole, gallery, testimonials, and the reserve-with-deposit button.',
  },
  {
    href: '/access',
    label: 'What buyers see',
    show: 'The buyer funnel / quiz — the front door prospects come through before they get matched to a rancher.',
  },
  {
    href: '/map',
    label: 'Discovery map',
    show: 'The rancher discovery map — the demo ranch appears as a live pin buyers can browse.',
  },
];

export default function DemoLauncherPage() {
  const on = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

  // Never render publicly: prod without the demo flag → 404. Both values are
  // inlined at build time, so Vercel prod builds compile this to a plain 404.
  if (process.env.NODE_ENV === 'production' && !on) {
    notFound();
  }

  return (
    <main
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '48px 24px 96px',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        color: '#1F2937',
        lineHeight: 1.6,
      }}
    >
      <p
        style={{
          display: 'inline-block',
          background: on ? '#DCFCE7' : '#FEF3C7',
          color: on ? '#166534' : '#92400E',
          border: `1px solid ${on ? '#86EFAC' : '#FCD34D'}`,
          borderRadius: 9999,
          padding: '4px 12px',
          fontSize: 13,
          fontWeight: 700,
          margin: 0,
        }}
      >
        {on ? '🐮 DEMO MODE IS ON — fake data, no external calls' : '⚠️ Demo mode is OFF'}
      </p>

      <h1 style={{ fontSize: 32, fontWeight: 800, margin: '20px 0 8px' }}>
        BuyHalfCow — Demo Launcher
      </h1>
      <p style={{ margin: '0 0 24px', color: '#4B5563' }}>
        A safe sandbox for screen-recording rancher-onboarding tutorials. Every
        surface below renders realistic <strong>fake</strong> data and makes
        <strong> zero</strong> external calls — no Airtable, Stripe, email, SMS,
        or Telegram. Nothing you click here touches production.
      </p>

      {!on && (
        <div
          style={{
            background: '#FFFBEB',
            border: '1px solid #FCD34D',
            borderRadius: 12,
            padding: '16px 20px',
            margin: '0 0 28px',
          }}
        >
          <p style={{ margin: '0 0 8px', fontWeight: 700 }}>
            Demo mode is off — start the server with the flag:
          </p>
          <code
            style={{
              display: 'block',
              background: '#1F2937',
              color: '#F9FAFB',
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 14,
              overflowX: 'auto',
            }}
          >
            {RUN_CMD}
          </code>
        </div>
      )}

      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 12px' }}>
        Surfaces to record
      </h2>
      <div style={{ display: 'grid', gap: 12 }}>
        {SURFACES.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            style={{
              display: 'block',
              textDecoration: 'none',
              color: 'inherit',
              background: '#FFFFFF',
              border: '1px solid #E5E7EB',
              borderRadius: 12,
              padding: '16px 20px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span style={{ fontSize: 17, fontWeight: 700 }}>{s.label}</span>
              <span style={{ fontSize: 13, color: '#6B7280', fontFamily: 'monospace' }}>
                {s.href}
              </span>
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: '#4B5563' }}>
              {s.show}
            </p>
          </Link>
        ))}
      </div>

      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '32px 0 12px' }}>
        How to run it
      </h2>
      <code
        style={{
          display: 'block',
          background: '#1F2937',
          color: '#F9FAFB',
          padding: '12px 16px',
          borderRadius: 8,
          fontSize: 14,
          overflowX: 'auto',
        }}
      >
        {RUN_CMD}
      </code>
      <p style={{ margin: '12px 0 0', fontSize: 14, color: '#6B7280' }}>
        Full guide: <code>docs/DEMO-MODE.md</code>. The flag is never set in
        Vercel, so production is untouched.
      </p>
    </main>
  );
}
