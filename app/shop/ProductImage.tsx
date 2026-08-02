'use client';

// Product photo with a guaranteed graceful fallback. Shopify/ClickFunnels CDNs
// content-negotiate their images to a web format for real browsers (so the .heic
// source URLs render as webp/jpeg), but if an image ever fails to decode in a
// given browser, onError swaps to the branded placeholder — a card or PDP can
// NEVER show a broken-image icon to cold paid traffic.
//
// Placeholder colors come from brand tokens (bg-bone-deep / text-muted) per the
// Phase 3 design-system migration. Callers pass className for layout; the
// legacy style prop stays supported for dimension/object-fit only (no colors).

import { useState } from 'react';

const Placeholder = () => (
  <div className="w-full h-full flex items-center justify-center bg-bone-deep text-muted font-serif text-sm">
    BuyHalfCow
  </div>
);

export default function ProductImage({
  src,
  alt,
  style,
  className,
}: {
  src: string;
  alt: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <Placeholder />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      style={style}
      className={className}
    />
  );
}
