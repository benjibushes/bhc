// app/rancher/shipping-guide/page.tsx
//
// Public, unauthenticated shipping SOP for ranchers (source of truth:
// docs/RANCHER-SHIPPING-GUIDE.md — keep the two in sync when policy
// changes). Linked from the product editor's shipping field and safe to
// text to a rancher mid-phone-call. No auth: nothing sensitive here, and
// a login wall between a rancher and "how do I not melt the beef" costs
// real money.

import type { Metadata } from 'next';
import Container from '../../components/Container';
import Card from '../../components/Card';

export const metadata: Metadata = {
  title: 'Shipping beef that arrives frozen — the rancher guide',
  description:
    'How buyhalfcow ranchers ship frozen beef that arrives frozen: packaging, dry ice math, the Mon–Wed rule, label buying, and pricing your shipping field.',
  alternates: { canonical: '/rancher/shipping-guide' },
};

export default function ShippingGuidePage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal py-12 md:py-16">
      <Container>
        <div className="max-w-[68ch]">
          <h1 className="font-serif text-3xl md:text-4xl mb-2">shipping beef that arrives frozen</h1>
          <p className="text-saddle mb-8">
            the platform handles the order, the money, and the tracking — this page handles the box.
          </p>

          <Card variant="warm" padding="sm" className="border-l-2 border-l-saddle mb-8">
            <p className="m-0 font-medium">
              the one rule: beef arrives frozen or it was free. everything below serves that rule.
            </p>
          </Card>

          <h2 className="font-serif text-2xl mb-3">shelf-stable (jerky, sticks)</h2>
          <ul className="list-disc pl-5 space-y-1.5 text-[15px] mb-8">
            <li>padded mailer, USPS Ground Advantage — real cost usually $4–6.</li>
            <li>set $5 shipping or bake it in and check &ldquo;shipping included&rdquo;.</li>
            <li>ship any day of the week. that&rsquo;s the whole game.</li>
          </ul>

          <h2 className="font-serif text-2xl mb-3">frozen (boxes, bundles, ground)</h2>
          <p className="text-[15px] mb-2 font-medium text-saddle">the box</p>
          <ul className="list-disc pl-5 space-y-1.5 text-[15px] mb-5">
            <li>insulated liner inside sturdy cardboard; beef goes in frozen SOLID.</li>
            <li>dry ice on top of the meat — about 5 lbs per day of transit (1-day ≈ 5 lbs, 2-day ≈ 10 lbs). gel packs are 1-day-only backup, never summer 2-day.</li>
            <li>fill dead air with crumpled kraft paper — air is the enemy.</li>
            <li>&ldquo;contains dry ice — UN1845&rdquo; sticker with the weight (carriers require it).</li>
          </ul>
          <p className="text-[15px] mb-2 font-medium text-saddle">the calendar — this prevents 90% of disasters</p>
          <ul className="list-disc pl-5 space-y-1.5 text-[15px] mb-5">
            <li><strong>ship monday–wednesday only.</strong> a thursday label that slips a day sits in a warehouse all weekend. nothing survives that.</li>
            <li>check the forecast at the DESTINATION. heatwave? hold two days and tell the buyer — they&rsquo;d rather wait than mop.</li>
          </ul>
          <p className="text-[15px] mb-2 font-medium text-saddle">the service</p>
          <ul className="list-disc pl-5 space-y-1.5 text-[15px] mb-5">
            <li>2-day maximum transit, period. UPS/FedEx ground is 1–2 days within ~2 zones and far cheaper than air — check the ground map for your area.</li>
            <li>buy labels on Pirate Ship (free account, commercial rates). paste the tracking number into your dashboard — the buyer gets it automatically.</li>
            <li>buyer more than 2 ground days away? use 2-day air and price it in — or serve &ldquo;local + neighboring states&rdquo; only. honest range beats a $60 air bill you ate.</li>
          </ul>
          <p className="text-[15px] mb-2 font-medium text-saddle">pricing your shipping field</p>
          <ul className="list-disc pl-5 space-y-1.5 text-[15px] mb-8">
            <li>set it at the WORST case you&rsquo;re willing to serve: box + liner + dry ice + label runs $25–45 for a 10–20 lb box at 1–2 zones. you keep 100% of it.</li>
            <li>or fold it into the product price and check &ldquo;shipping included&rdquo; — all-in prices convert better.</li>
          </ul>

          <h2 className="font-serif text-2xl mb-3">when it goes wrong</h2>
          <ul className="list-disc pl-5 space-y-1.5 text-[15px] mb-8">
            <li>arrived soft but still fridge-cold = safe and refreezable — tell the buyer kindly, it happens.</li>
            <li>actually warm = it&rsquo;s gone. tell us from your dashboard or reply to any order email — we make it right with the buyer and figure out the reship together. photos help; forms don&rsquo;t exist.</li>
            <li>one melted box handled generously earns a customer for life.</li>
          </ul>

          <Card variant="warm" padding="sm" className="border-l-2 border-l-sage">
            <p className="m-0 text-[15px] font-medium mb-2">the 60-second checklist</p>
            <ol className="list-decimal pl-5 space-y-1 text-[14px] m-0">
              <li>order push arrives → confirm stock in the dashboard</li>
              <li>frozen solid → liner + dry ice (5 lb per transit day) + kraft fill</li>
              <li>label via pirate ship — ground if ≤2 days, mon–wed only</li>
              <li>dry-ice sticker on the box</li>
              <li>paste tracking into the dashboard → buyer&rsquo;s notified</li>
              <li>heatwave or thursday? hold till monday, message the buyer</li>
            </ol>
          </Card>
        </div>
      </Container>
    </main>
  );
}
