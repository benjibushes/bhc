import type { MapPin } from '../page';

// Shared "from $X/half" formatting so the pin popup (client) and the SSR list
// (server) never drift. Renders a clean integer dollar amount (no cents — beef
// shares are whole-dollar priced) with a thousands separator, plus the tier the
// price belongs to. Returns '' when the rancher has no price set.
export function fromPriceLabel(pin: Pick<MapPin, 'fromPrice' | 'fromLabel'>): string {
  if (!pin.fromPrice || pin.fromPrice <= 0) return '';
  const amount = `$${Math.round(pin.fromPrice).toLocaleString('en-US')}`;
  return pin.fromLabel ? `from ${amount}/${pin.fromLabel}` : `from ${amount}`;
}

// "Weatherford, TX" / "TX" / "" — joins city + state for popups and the list.
// City is the differentiator when two ranchers share a state.
export function locationLabel(pin: Pick<MapPin, 'city' | 'state'>): string {
  const city = (pin.city || '').trim();
  const state = (pin.state || '').trim();
  if (city && state) return `${city}, ${state}`;
  return state || city;
}
