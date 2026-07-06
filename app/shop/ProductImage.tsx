'use client';

// Product photo with a guaranteed graceful fallback. Shopify/ClickFunnels CDNs
// content-negotiate their images to a web format for real browsers (so the .heic
// source URLs render as webp/jpeg), but if an image ever fails to decode in a
// given browser, onError swaps to the branded placeholder — a card or PDP can
// NEVER show a broken-image icon to cold paid traffic.

import { useState } from 'react';

const Placeholder = () => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#A7A29A',
      fontFamily: 'Georgia,serif',
      fontSize: 14,
      background: '#EAE6DE',
    }}
  >
    BuyHalfCow
  </div>
);

export default function ProductImage({
  src,
  alt,
  style,
}: {
  src: string;
  alt: string;
  style?: React.CSSProperties;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <Placeholder />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} style={style} />
  );
}
