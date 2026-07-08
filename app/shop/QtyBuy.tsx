'use client';

// PDP buy control with a quantity picker (audit fix: a buyer literally could
// not buy 2 of anything — jerky buyers most of all). Qty rides the checkout
// URL (?qty=N) and the buy endpoint re-clamps + stock-checks it server-side.
// Cards keep the one-tap BuyButton; this only renders on the PDP. Deposit-
// style products never use this (one reservation at a time).

import { useState } from 'react';
import Button from '../components/Button';

export default function QtyBuy({
  productId,
  price,
  maxQty,
}: {
  productId: string;
  price: number;
  /** Cap from real stock (Orders Left) — never offer more than exists. */
  maxQty: number;
}) {
  const [qty, setQty] = useState(1);
  const max = Math.max(1, Math.min(5, Math.floor(maxQty)));
  const total = price * qty;

  return (
    <div className="flex items-stretch gap-2">
      {max > 1 && (
        <select
          value={qty}
          onChange={(e) => setQty(Number(e.target.value) || 1)}
          aria-label="quantity"
          className="border border-dust bg-bone px-2 text-[15px]"
        >
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}×</option>
          ))}
        </select>
      )}
      <div className="flex-1">
        <Button href={`/shop/checkout/${productId}${qty > 1 ? `?qty=${qty}` : ''}`} fullWidth>
          buy — ${total.toFixed(2)}
        </Button>
      </div>
    </div>
  );
}
