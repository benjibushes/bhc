'use client';

// Fires a Meta Pixel ViewContent for this product on mount, so a PDP visitor
// who doesn't buy lands in the "viewed-not-bought" retargeting audience. The
// browser carries the fbp/fbc + consent gate (PixelTracker), and content_ids=
// [productId] is the key a Meta product-catalog audience matches on.
//
// Client-only + no-op unless the pixel is configured. useRef = one fire per
// mount (Strict Mode / re-render safe).

import { useEffect, useRef } from 'react';
import { track } from '@/lib/track';

const PIXEL = process.env.NEXT_PUBLIC_META_PIXEL_ID;

export default function ProductViewTracker({
  productId,
  name,
  price,
}: {
  productId: string;
  name: string;
  price: number;
}) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || !PIXEL) return;
    fired.current = true;
    track('ViewContent', {
      value: price,
      currency: 'USD',
      content_ids: [productId],
      content_type: 'product',
      content_name: name,
      event_id: `product_view_${productId}`,
    });
  }, [productId, name, price]);
  return null;
}
