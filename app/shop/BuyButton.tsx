import Button from '../components/Button';

// Storefront Buy control. Links to the on-domain checkout page
// (/shop/checkout/[id]), which mounts the whitelabeled embedded Stripe form —
// or, if the publishable key isn't set, falls back to a hosted redirect. Either
// way it's one tap and the buyer stays on buyhalfcow.com.
//
// Uses the shared Button primitive (design-system migration, Phase 3) so a
// shop buy button and a deposit CTA are literally the same component.

export default function BuyButton({ productId, price }: { productId: string; price: number }) {
  return (
    <Button href={`/shop/checkout/${productId}`} fullWidth>
      buy — ${price.toFixed(2)}
    </Button>
  );
}
