// app/order/[id]/page.tsx
//
// BUYER ORDER STATUS — the surface the product rail never had.
//
// Before this, a buyer's entire state model was their inbox: the only
// non-admin, non-rancher, non-cron reader of Rancher Orders was the reviews
// query. "Did it ship?" had nowhere to go but a support reply. This is the
// page every product email now links to.
//
// [id] IS THE SIGNED TOKEN (lib/orderStatusLink, purpose:'order-status') —
// never a raw record id, same durable-link idiom as /r/d, /r/b, /r/p and /r/f.
// A raw `rec…` in this slot fails verification and lands on the honest
// "link isn't valid" card, so the page cannot be opened by guessing.
//
// Strictly READ-ONLY: no action, no money movement, no session minted. The
// worst a forwarded link can do is show that one order — exactly what
// forwarding the receipt email already does.
//
// Sibling static routes /order/success and /order/cancelled keep priority
// over this dynamic segment (Next resolves static first).

import type { Metadata } from 'next';
import Link from 'next/link';
import Card from '../../components/Card';
import Button from '../../components/Button';
import { getRecordById, TABLES } from '@/lib/airtable';
import { verifyOrderStatusToken } from '@/lib/orderStatusLink';
import { buildOrderStatusView, type OrderStatusView } from '@/lib/orderStatusView';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'your order — BuyHalfCow',
  // An order card must never enter search, and the token must never ride a
  // referrer to a third party.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const fmtDate = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const money = (n: number) => `$${Number(n || 0).toFixed(2)}`;

function DeadLink() {
  return (
    <main className="min-h-[70vh] flex items-center justify-center px-5 py-10 bg-bone text-charcoal">
      <Card padding="lg" className="max-w-[520px] w-full text-center">
        <h1 className="font-serif text-2xl mb-2 lowercase">this order link isn&rsquo;t valid.</h1>
        <p className="text-charcoal text-base leading-relaxed mb-5">
          it may have expired, or it got clipped when the email was forwarded. open the link
          straight from your order receipt &mdash; or tell us and we&rsquo;ll look it up by hand.
        </p>
        <Button href="/support" fullWidth>
          get help with an order &rarr;
        </Button>
        <p className="text-xs text-dust mt-6">&mdash; Ben, BuyHalfCow</p>
      </Card>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2.5 border-t border-dust first:border-t-0">
      <div className="text-[10px] uppercase tracking-wider text-saddle mb-0.5">{label}</div>
      <div className="text-[14.5px] leading-relaxed">{children}</div>
    </div>
  );
}

export default async function OrderStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: token } = await params;
  const verified = verifyOrderStatusToken(token);
  if (!verified.ok) return <DeadLink />;

  // Read the order. A blip must not look like a bad link — but we also must
  // never leak whether an id exists, so a genuine miss renders the same card.
  let order: any = null;
  try {
    order = await getRecordById(TABLES.RANCHER_ORDERS, verified.payload.orderId);
  } catch {
    order = null;
  }
  if (!order) return <DeadLink />;

  // Rancher contact + pickup truth, and the product's own ship promise. Both
  // best-effort: a failure drops those blocks, never the order card.
  const rancherId = String(order['Rancher Record ID'] || '').trim();
  const productId = String(order['Product Record ID'] || '').trim();
  const [rancher, product] = await Promise.all([
    rancherId ? getRecordById(TABLES.RANCHERS, rancherId).catch(() => null) : Promise.resolve(null),
    productId ? getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null) : Promise.resolve(null),
  ]);

  const v: OrderStatusView = buildOrderStatusView(
    { ...order, id: order.id },
    rancher as any,
    (product as any)?.['Ships In Days'],
  );

  const badgeClass =
    v.state === 'shipped' || v.state === 'delivered'
      ? 'bg-sage text-bone'
      : v.state === 'refunded' || v.state === 'cancelled'
        ? 'border border-dust text-saddle'
        : 'bg-charcoal text-bone';

  return (
    <main className="min-h-[70vh] bg-bone text-charcoal px-4 pt-7 pb-14">
      <div className="max-w-[560px] mx-auto">
        {/* The buyer's name is NEVER lowercased — the brand's lowercase voice
            applies to our words, not to someone's name ("mcdonald's order"). */}
        <h1 className="font-serif text-2xl mb-1">
          {v.buyerFirstName ? `${v.buyerFirstName}’s order` : 'your order'}
        </h1>
        <p className="text-[13px] text-saddle mb-4">
          {v.quantity > 1 ? `${v.quantity}× ` : ''}
          {v.productName}
          {v.rancherName ? ` from ${v.rancherName}` : ''}
        </p>

        <Card padding="sm" className="mb-4">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 ${badgeClass}`}>
              {v.statusLabel}
            </span>
            {v.orderedAt && (
              <span className="text-xs text-saddle ml-auto">ordered {fmtDate(v.orderedAt)}</span>
            )}
          </div>
          <p className="text-[14.5px] leading-relaxed">{v.statusDetail}</p>
          {v.runningLate && (
            <p className="text-[13px] leading-relaxed text-rust mt-2">
              this one is past the ship window the ranch quoted
              {v.promisedShipBy ? ` (${fmtDate(v.promisedShipBy)})` : ''}. we&rsquo;re already on it
              &mdash; and you can reply to any of our emails to reach a real person.
            </p>
          )}
        </Card>

        <Card padding="sm" className="mb-4">
          <Row label="what you bought">
            {v.quantity > 1 ? `${v.quantity}× ` : ''}
            {v.productName}
          </Row>
          <Row label="what you paid">{money(v.buyerPaid)}</Row>

          {v.trackingNumber && (
            <Row label="tracking">
              {v.trackingUrl ? (
                <a
                  href={v.trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="underline hover:text-saddle transition-colors break-all"
                >
                  {v.carrier ? `${v.carrier} · ` : ''}
                  {v.trackingNumber} &rarr;
                </a>
              ) : (
                <span className="break-all">
                  {v.carrier ? `${v.carrier} · ` : ''}
                  {v.trackingNumber}
                </span>
              )}
            </Row>
          )}
          {v.shippedAt && <Row label="shipped">{fmtDate(v.shippedAt)}</Row>}
          {!v.shippedAt && v.promisedShipBy && v.state === 'new' && (
            <Row label="expected to ship by">{fmtDate(v.promisedShipBy)}</Row>
          )}
          {v.endedAt && (
            <Row label={v.state === 'cancelled' ? 'cancelled' : 'refunded'}>{fmtDate(v.endedAt)}</Row>
          )}

          {v.kind === 'pickup' ? (
            (v.pickupAddress || v.pickupInstructions) && (
              <Row label="pickup">
                {v.pickupAddress && <div className="font-medium">{v.pickupAddress}</div>}
                {v.pickupInstructions && (
                  <div className="text-saddle whitespace-pre-line">{v.pickupInstructions}</div>
                )}
              </Row>
            )
          ) : v.shipTo ? (
            <Row label="shipping to">
              <span className="whitespace-pre-line">{v.shipTo}</span>
            </Row>
          ) : null}
        </Card>

        {(v.rancherEmail || v.rancherPhone) && (
          <Card padding="sm" className="mb-4">
            <div className="text-[10px] uppercase tracking-wider text-saddle mb-1">your rancher</div>
            <div className="text-[14.5px] leading-relaxed">
              <div className="font-medium">{v.rancherName || 'the ranch'}</div>
              {v.rancherEmail && (
                <a href={`mailto:${v.rancherEmail}`} className="underline hover:text-saddle transition-colors break-all">
                  {v.rancherEmail}
                </a>
              )}
              {v.rancherPhone && <div>{v.rancherPhone}</div>}
            </div>
          </Card>
        )}

        <p className="text-[13px] text-saddle leading-relaxed">
          anything wrong with this order &mdash; short, late, thawed, whatever &mdash; we make it
          right.{' '}
          <Link href="/support" className="underline hover:text-charcoal transition-colors">
            tell a real person &rarr;
          </Link>
        </p>
        <p className="text-xs text-dust mt-6">&mdash; Ben, BuyHalfCow</p>
      </div>
    </main>
  );
}
