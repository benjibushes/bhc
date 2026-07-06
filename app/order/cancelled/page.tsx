// app/order/cancelled/page.tsx
//
// Buyer bailed out of the Stripe Checkout for a low-ticket product (cancel_url).
// No charge. Reassure + leave the door open — no pressure, honest brand voice.

import Link from 'next/link';

export const metadata = { title: 'no charge — BuyHalfCow' };

export default function OrderCancelledPage() {
  return (
    <main style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', background: '#F4F1EC' }}>
      <div style={{ maxWidth: 520, width: '100%', background: '#fff', border: '1px solid #A7A29A', padding: '40px', textAlign: 'center', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', color: '#17130E' }}>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: 28, marginBottom: 8 }}>no charge.</div>
        <p style={{ color: '#3D362D', fontSize: 16, lineHeight: 1.6, margin: '0 0 20px' }}>
          you closed out before finishing &mdash; nothing was charged. your link still works if you want to come back to it, and there&rsquo;s no rush.
        </p>
        <p style={{ fontSize: 14, color: '#6B4F3F', margin: '0 0 16px' }}>
          questions about the cuts or shipping? just reply to the text or email &mdash; a real person answers.
        </p>
        <Link href="/map" style={{ display: 'inline-block', padding: '12px 24px', background: '#17130E', color: '#F4F1EC', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
          browse the ranches &rarr;
        </Link>
        <p style={{ fontSize: 12, color: '#A7A29A', marginTop: 24 }}>&mdash; Ben, BuyHalfCow</p>
      </div>
    </main>
  );
}
