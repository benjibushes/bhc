import Link from 'next/link';

// Storefront Buy control. Links to the on-domain checkout page
// (/shop/checkout/[id]), which mounts the whitelabeled embedded Stripe form —
// or, if the publishable key isn't set, falls back to a hosted redirect. Either
// way it's one tap and the buyer stays on buyhalfcow.com.

export default function BuyButton({ productId, price }: { productId: string; price: number }) {
  return (
    <Link
      href={`/shop/checkout/${productId}`}
      style={{
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        padding: '12px',
        background: '#17130E',
        color: '#F4F1EC',
        fontSize: 15,
        fontWeight: 600,
        textAlign: 'center',
        textDecoration: 'none',
      }}
    >
      buy — ${price.toFixed(0)}
    </Link>
  );
}
