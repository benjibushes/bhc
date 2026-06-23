import React from 'react';
import Container from '../../components/Container';
import Pill from '../../components/Pill';
import Card from '../../components/Card';

// ── "How you get your beef" ──────────────────────────────────────────────
// P1 #5: render the rancher's fulfillment options from the existing setup-
// wizard fields. None of these surfaced on the public page before — buyers
// had to infer logistics from the generic "How it works" copy. This makes
// pickup / delivery / shipping concrete and per-rancher.
//
// Canonical Fulfillment Types (multi-select) match the setup wizard +
// /api/checkout/deposit: 'Local Pickup', 'Local Delivery', 'Cold-Chain
// Shipping'. The Airtable multi-select usually returns string[]; some legacy
// rows return [{name}]. We normalize both. The whole section gates on having
// at least one usable signal so it renders nothing for ranchers who never
// filled it in (never-blank discipline lives in the parent).

export interface FulfillmentData {
  types: string[];
  pickupCity: string;
  deliveryRadiusMiles: number | null;
  shippingLeadTimeDays: number | null;
  costNotes: string;
}

// Normalize the raw Airtable field into a clean FulfillmentData, or null if
// there's nothing to show. Exported so the parent can decide whether to
// render the section (and pass the same object) without duplicating parse
// logic.
export function parseFulfillment(rancher: any): FulfillmentData | null {
  const rawTypes = rancher?.['Fulfillment Types'];
  const types: string[] = Array.isArray(rawTypes)
    ? rawTypes.map((t: any) => (t && typeof t === 'object' && 'name' in t ? String(t.name) : String(t))).filter(Boolean)
    : [];
  const pickupCity = String(rancher?.['Pickup City'] || '').trim();
  const deliveryRadiusMiles = Number(rancher?.['Delivery Radius Miles']) || null;
  const shippingLeadTimeDays = Number(rancher?.['Shipping Lead Time Days']) || null;
  const costNotes = String(rancher?.['Fulfillment Cost Notes'] || '').trim();

  const hasSignal =
    types.length > 0 ||
    !!pickupCity ||
    !!deliveryRadiusMiles ||
    !!shippingLeadTimeDays ||
    !!costNotes;
  if (!hasSignal) return null;

  return { types, pickupCity, deliveryRadiusMiles, shippingLeadTimeDays, costNotes };
}

type Method = {
  key: string;
  title: string;
  detail: string;
  icon: 'pickup' | 'delivery' | 'shipping';
};

function buildMethods(f: FulfillmentData): Method[] {
  const has = (t: string) => f.types.some((x) => x.toLowerCase() === t.toLowerCase());
  const methods: Method[] = [];

  if (has('Local Pickup')) {
    methods.push({
      key: 'pickup',
      title: 'Local pickup',
      detail: f.pickupCity
        ? `Collect your order in ${f.pickupCity} on processing day.`
        : 'Collect your order at the ranch on processing day.',
      icon: 'pickup',
    });
  }
  if (has('Local Delivery')) {
    methods.push({
      key: 'delivery',
      title: 'Local delivery',
      detail: f.deliveryRadiusMiles
        ? `Delivered to your door within ${f.deliveryRadiusMiles} miles.`
        : 'Local delivery available in the surrounding area.',
      icon: 'delivery',
    });
  }
  if (has('Cold-Chain Shipping')) {
    methods.push({
      key: 'shipping',
      title: 'Cold-chain shipping',
      detail: f.shippingLeadTimeDays
        ? `Shipped frozen, arrives ~${f.shippingLeadTimeDays} days after processing.`
        : 'Shipped frozen, packed to stay cold in transit.',
      icon: 'shipping',
    });
  }

  // If types is empty but a sub-field implies a method, infer one so we never
  // show a header with no methods.
  if (methods.length === 0) {
    if (f.pickupCity) {
      methods.push({ key: 'pickup', title: 'Local pickup', detail: `Collect your order in ${f.pickupCity}.`, icon: 'pickup' });
    }
    if (f.deliveryRadiusMiles) {
      methods.push({ key: 'delivery', title: 'Local delivery', detail: `Delivered within ${f.deliveryRadiusMiles} miles.`, icon: 'delivery' });
    }
    if (f.shippingLeadTimeDays) {
      methods.push({ key: 'shipping', title: 'Cold-chain shipping', detail: `Ships ~${f.shippingLeadTimeDays} days after processing.`, icon: 'shipping' });
    }
  }

  return methods;
}

function MethodIcon({ name }: { name: Method['icon'] }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'pickup':
      return (
        <svg {...common}>
          <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z" />
          <circle cx="12" cy="11" r="2.2" />
        </svg>
      );
    case 'delivery':
      return (
        <svg {...common}>
          <path d="M3 7h11v8H3z" />
          <path d="M14 10h4l3 3v2h-7z" />
          <circle cx="7" cy="17" r="1.8" />
          <circle cx="17.5" cy="17" r="1.8" />
        </svg>
      );
    case 'shipping':
      return (
        <svg {...common}>
          <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="M3.3 7L12 12l8.7-5M12 22V12" />
        </svg>
      );
  }
}

export default function FulfillmentSection({ data }: { data: FulfillmentData }) {
  const methods = buildMethods(data);
  // Defensive: parent already gated on parseFulfillment(); if somehow no
  // concrete method AND no cost notes, render nothing rather than an empty
  // header.
  if (methods.length === 0 && !data.costNotes) return null;

  return (
    <section className="py-16 md:py-20">
      <Container>
        <div className="max-w-5xl mx-auto space-y-10">
          <div className="text-center space-y-2">
            <Pill tone="neutral" className="mx-auto">Getting your beef</Pill>
            <h2 className="font-serif text-3xl md:text-4xl">How you get your order</h2>
            <p className="text-saddle max-w-xl mx-auto">
              The ways this ranch can get your beef to you. You confirm the
              details together after you reserve.
            </p>
          </div>

          {methods.length > 0 && (
            <div
              className={`grid gap-5 md:gap-6 ${
                methods.length === 1
                  ? 'max-w-md mx-auto'
                  : methods.length === 2
                    ? 'sm:grid-cols-2 max-w-3xl mx-auto'
                    : 'sm:grid-cols-2 lg:grid-cols-3'
              }`}
            >
              {methods.map((m) => (
                <Card key={m.key} variant="default" padding="lg" className="space-y-3">
                  <div className="text-saddle">
                    <MethodIcon name={m.icon} />
                  </div>
                  <h3 className="font-serif text-xl text-charcoal">{m.title}</h3>
                  <p className="text-sm text-charcoal/75 leading-relaxed">{m.detail}</p>
                </Card>
              ))}
            </div>
          )}

          {data.costNotes && (
            <p className="text-center text-sm text-saddle max-w-2xl mx-auto">
              <span className="uppercase tracking-widest text-xs text-dust mr-2">
                Good to know
              </span>
              {data.costNotes}
            </p>
          )}
        </div>
      </Container>
    </section>
  );
}
