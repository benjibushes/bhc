// app/marketplace/page.tsx
//
// Alias for ad copy / word-of-mouth ("buyhalfcow.com/marketplace"). The
// canonical surface is /shop (where the product pages + checkout live), so this
// just forwards there — one place, no duplicate catalog.

import { redirect } from 'next/navigation';

export default function MarketplaceAlias() {
  redirect('/shop');
}
