// app/order/success/page.tsx
//
// Post-payment landing for a low-ticket product purchase (Stripe success_url).
// The buyer just paid — reassure them, and (research: the post-purchase moment
// is the ladder-up) softly point them at a full share. Static + server-rendered;
// the receipt email carries the order detail.

import Link from 'next/link';

export const metadata = { title: "you're set — BuyHalfCow" };

export default function OrderSuccessPage() {
  return (
    <main style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', background: '#F4F1EC' }}>
      <div style={{ maxWidth: 520, width: '100%', background: '#fff', border: '1px solid #A7A29A', padding: '40px', textAlign: 'center', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', color: '#17130E' }}>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: 30, marginBottom: 8 }}>you&rsquo;re set.</div>
        <p style={{ color: '#3D362D', fontSize: 16, lineHeight: 1.6, margin: '0 0 20px' }}>
          your order&rsquo;s in — the ranch is packing it up and shipping it direct to you. a receipt is on its way to your inbox, and you&rsquo;ll get tracking as soon as it ships.
        </p>
        <div style={{ borderTop: '1px solid #D8D0C2', paddingTop: 20, marginTop: 4 }}>
          <p style={{ fontSize: 14, color: '#6B4F3F', margin: '0 0 12px' }}>
            liked what you tasted? a half or whole share is the same beef by the freezer-full.
          </p>
          <Link href="/map" style={{ display: 'inline-block', padding: '12px 24px', background: '#17130E', color: '#F4F1EC', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
            explore full shares &rarr;
          </Link>
        </div>
        <p style={{ fontSize: 12, color: '#A7A29A', marginTop: 24 }}>&mdash; Ben, BuyHalfCow</p>
      </div>
    </main>
  );
}
