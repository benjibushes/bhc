// app/order/success/page.tsx
//
// Post-payment landing for a low-ticket product purchase (Stripe success_url +
// Payment Element return_url). The buyer just paid — reassure them, and softly
// point them at a full share + the gear to cook it.
//
// PAYMENT ELEMENT (spec R3): bank-redirect / 3DS returns land here with
// ?redirect_status=. 'failed' must NEVER render "you're set" — it renders an
// honest retry state with a one-tap path back into that product's checkout
// (?pid= rides the return_url for exactly this).
//
// FULFILLMENT TRUTH (middle-journey audit 2026-07-29): every checkout mint now
// passes ?pid=, and this page reads the product to branch its copy — a pickup
// buyer was previously told "shipping it direct to you". Pickup says the ranch
// reaches out to arrange pickup (+ the address when the rancher filled it);
// deposit-style says confirm-before-ship. The Airtable read is best-effort:
// any failure degrades to the generic copy that shipped before this change.
//
// Styled on the brand system — matches the deposit success page so a $20
// jerky buy and an $1,800 deposit read as one company.

import Card from '../../components/Card';
import Button from '../../components/Button';
import { escapeAirtableValue, getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { mintOrderStatusToken, orderStatusPath } from '@/lib/orderStatusLink';

export const metadata = { title: "you're set — BuyHalfCow" };

type OrderKind = 'ship' | 'pickup' | 'deposit' | 'unknown';

// Best-effort fulfillment resolve — never throws, never blocks the paint on a
// broken pid. 'deposit' wins over 'pickup' (the deposit promise — confirm
// details with the rancher first — covers the pickup coordination too).
async function resolveOrderKind(pid: string): Promise<{ kind: OrderKind; pickupAddress: string }> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(pid)) return { kind: 'unknown', pickupAddress: '' };
  try {
    const product: any = await getRecordById(TABLES.RANCHER_PRODUCTS, pid).catch(() => null);
    if (!product) return { kind: 'unknown', pickupAddress: '' };
    if (product['Deposit Style'] === true) return { kind: 'deposit', pickupAddress: '' };
    if (product['Ships Nationwide'] === false) {
      // Pickup — surface the address if the rancher put one on file.
      // Instructions deliberately do NOT render here (they ride the receipt
      // email); the address alone answers "where am I driving?".
      let pickupAddress = '';
      const rancherId = String(product['Rancher Record ID'] || '').trim();
      if (rancherId) {
        const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
        pickupAddress = String(rancher?.['Pickup Address'] || '').trim();
      }
      return { kind: 'pickup', pickupAddress };
    }
    return { kind: 'ship', pickupAddress: '' };
  } catch {
    return { kind: 'unknown', pickupAddress: '' };
  }
}

// WAVE 2 buyer UI (2026-08-01) — resolve the buyer's freshly-paid order so
// this page can link its signed /order/<token> status page (the one the
// receipt email carries). Stripe appends ?payment_intent= to the Payment
// Element return_url on redirect flows; the webhook writes the Rancher Orders
// row keyed on that PI. Best-effort BY DESIGN: right after payment the
// webhook may not have landed yet, and the non-redirect confirm path carries
// no PI — both fall back to '' and the page points at the receipt email
// instead. Never blocks the paint, never renders a broken link.
async function resolveOrderStatusPath(paymentIntentId: string): Promise<string> {
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return '';
  try {
    const rows = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{Stripe Payment Intent} = "${escapeAirtableValue(paymentIntentId)}"`,
    )) as any[];
    const orderId = String(rows?.[0]?.id || '');
    if (!/^rec[A-Za-z0-9]{14}$/.test(orderId)) return '';
    return orderStatusPath(mintOrderStatusToken({ orderId }));
  } catch {
    return '';
  }
}

export default async function OrderSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_status?: string; pid?: string; payment_intent?: string }>;
}) {
  const sp = await searchParams;
  const failed = String(sp?.redirect_status || '') === 'failed';
  const pid = String(sp?.pid || '');
  const retryHref = /^rec[A-Za-z0-9]{14}$/.test(pid) ? `/shop/checkout/${pid}` : '/shop';

  if (failed) {
    return (
      <main className="min-h-[70vh] flex items-center justify-center px-5 py-10 bg-bone text-charcoal">
        <Card padding="lg" className="max-w-[520px] w-full text-center">
          <h1 className="font-serif text-2xl mb-2 lowercase">that payment didn&rsquo;t go through.</h1>
          <p className="text-charcoal text-base leading-relaxed mb-5">
            your bank declined or cancelled the authorization — <strong>nothing was charged</strong>,
            and your order isn&rsquo;t placed yet.
          </p>
          <Button href={retryHref} fullWidth>try again &rarr;</Button>
          <p className="text-sm text-saddle mt-4">
            keeps happening?{' '}
            <a href="/support" className="underline hover:text-charcoal transition-colors">
              a real person can help
            </a>
            .
          </p>
          <p className="text-xs text-muted mt-6">&mdash; Ben, BuyHalfCow</p>
        </Card>
      </main>
    );
  }

  const [{ kind, pickupAddress }, orderPath] = await Promise.all([
    resolveOrderKind(pid),
    resolveOrderStatusPath(String(sp?.payment_intent || '')),
  ]);

  return (
    <main className="min-h-[70vh] flex items-center justify-center px-5 py-10 bg-bone text-charcoal">
      <Card padding="lg" className="max-w-[520px] w-full text-center">
        <h1 className="font-serif text-3xl mb-2 lowercase">you&rsquo;re set.</h1>
        {kind === 'pickup' ? (
          <>
            <p className="text-charcoal text-base leading-relaxed mb-5">
              your order&rsquo;s in — it&rsquo;s a <strong>local pickup</strong>, so nothing ships.
              the ranch will reach out to arrange your pickup time, and a receipt is on its way to
              your inbox.
            </p>
            {pickupAddress && (
              <p className="text-sm text-saddle leading-relaxed -mt-3 mb-5">
                pickup location: <strong className="text-charcoal">{pickupAddress}</strong>
              </p>
            )}
          </>
        ) : kind === 'deposit' ? (
          <p className="text-charcoal text-base leading-relaxed mb-5">
            your deposit&rsquo;s in — the rancher reaches out first to confirm your size + the
            balance before anything moves. your deposit counts toward the total, and a receipt is
            on its way to your inbox.
          </p>
        ) : (
          <>
            <p className="text-charcoal text-base leading-relaxed mb-5">
              your order&rsquo;s in — the ranch is packing it up and shipping it direct to you. a
              receipt is on its way to your inbox, and you&rsquo;ll get tracking as soon as it
              ships.
            </p>
            {kind === 'unknown' && (
              <p className="text-xs text-saddle leading-relaxed -mt-3 mb-5">
                reserved with a deposit? the rancher reaches out first to confirm your size + the
                balance &mdash; your deposit counts toward it.
              </p>
            )}
          </>
        )}
        {/* WAVE 2 buyer UI — this page used to be a cul-de-sac: no order
            link, no account link, its ONE button an upsell. The buyer's own
            order is the primary action now; the upsell is secondary. */}
        <div className="border-t border-dust pt-5 mt-1 space-y-3">
          {orderPath ? (
            <Button href={orderPath} fullWidth>
              track your order &rarr;
            </Button>
          ) : (
            <p className="text-sm text-saddle leading-relaxed">
              your receipt email has a <strong className="text-charcoal">track your order</strong>{' '}
              link — status, tracking, and your rancher&rsquo;s contact, any time.
            </p>
          )}
          <p className="text-sm text-saddle">
            or see everything on this email in{' '}
            <a href="/member" className="underline hover:text-charcoal transition-colors">
              your dashboard &rarr;
            </a>
          </p>
        </div>
        <div className="border-t border-dust pt-5 mt-5 space-y-3">
          <p className="text-sm text-saddle">
            liked what you tasted? a half or whole share is the same beef by the freezer-full.
          </p>
          <Button href="/map" variant="secondary">explore full shares &rarr;</Button>
          <p className="text-xs text-saddle">
            and the tools to cook it right &mdash;{' '}
            <a href="/gear" className="underline hover:text-charcoal transition-colors">
              the gear ben uses &rarr;
            </a>
          </p>
        </div>
        <p className="text-xs text-muted mt-6">&mdash; Ben, BuyHalfCow</p>
      </Card>
    </main>
  );
}
