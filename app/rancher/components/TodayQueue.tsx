'use client';

// ── "Today" action queue (dashboard UX upgrade, 2026-07-15) ────────────────
// One unified list at the top of the Home tab that tells the rancher their
// day. PURE READ/RENDER: every row is assembled from data the dashboard
// already fetches on mount (the /api/rancher/dashboard referrals payload +
// the Wave C /api/rancher/orders side-load). No new endpoints, no writes —
// each row is one line + one tap that deep-links to the surface where the
// existing action buttons live (Deals-tab cards via the ref-<id> anchors,
// Products tab, inbox, My Page).
//
// Row types + ordering (money first, hottest at the very top):
//   1. deposit paid, slot NOT accepted   → the money-on-table row (hottest)
//   2. accepted deals with no final invoice sent yet
//   3. paid product orders in 'New' (ship / mark picked up — Wave C pickup flag)
//   4. new leads still at Intro Sent (say hi)
//   5. unread buyer messages (parity with the old "what needs you" card)
//   6. finish-setup (only when the go-live ribbon isn't already showing it)
//
// Empty state is calm, not blank — "nothing needs you" is a feature.

// Structural subsets of the page's Referral / ProductOrderSummary shapes —
// only the fields a row actually renders. The page's richer objects satisfy
// these by assignment.
export interface TodayReferral {
  id: string;
  buyer_name: string;
  buyer_state: string;
  order_type: string;
  deposit_amount?: number;
  total_sale_amount?: number;
}

export interface TodayOrder {
  id: string;
  buyerName: string;
  productName: string;
  buyerPaid: number;
  pickup?: boolean;
}

interface TodayRow {
  key: string;
  /** Small uppercase kicker, e.g. "money on the table". */
  kicker: string;
  /** The one-line "what to do" sentence. */
  line: string;
  /** Visual heat: 'hot' = deposit money waiting (amber wash), 'warm' = plain. */
  heat: 'hot' | 'warm';
  onClick: () => void;
}

const MAX_VISIBLE_ROWS = 8;

const fmtMoney = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function TodayQueue({
  depositAwaitRefs,
  invoiceDueRefs,
  newOrders,
  newLeadRefs,
  unreadCount,
  setupRow,
  onJumpToReferral,
  onGoToProducts,
  onGoToDeals,
  onOpenInbox,
  onSetupClick,
}: {
  /** Deposit paid, rancher hasn't accepted the slot yet — hottest rows. */
  depositAwaitRefs: TodayReferral[];
  /** Slot accepted + deposit paid, final invoice not sent yet. */
  invoiceDueRefs: TodayReferral[];
  /** Product orders still in Status='New' (paid, not shipped/picked up). */
  newOrders: TodayOrder[];
  /** Referrals still at Intro Sent — leads awaiting a first response. */
  newLeadRefs: TodayReferral[];
  unreadCount: number;
  /** null hides the row (e.g. the go-live ribbon already owns setup). */
  setupRow: { done: number; total: number; nextLabel: string } | null;
  onJumpToReferral: (id: string) => void;
  onGoToProducts: () => void;
  onGoToDeals: () => void;
  onOpenInbox: () => void;
  onSetupClick: () => void;
}) {
  const rows: TodayRow[] = [];

  // 1 — deposits awaiting acceptance. Buyer money already landed; the slot
  // isn't locked until the rancher accepts. Hottest thing on the ranch.
  for (const r of depositAwaitRefs) {
    const amt = r.deposit_amount && r.deposit_amount > 0 ? ` — ${fmtMoney(r.deposit_amount)} deposit paid` : '';
    rows.push({
      key: `deposit-${r.id}`,
      kicker: 'money on the table',
      line: `accept ${r.buyer_name || 'a buyer'}'s slot${amt}`,
      heat: 'hot',
      onClick: () => onJumpToReferral(r.id),
    });
  }

  // 2 — final invoices to send on accepted, deposit-paid deals.
  for (const r of invoiceDueRefs) {
    const balance =
      r.total_sale_amount && r.total_sale_amount > 0 && r.deposit_amount && r.deposit_amount > 0
        ? ` — ${fmtMoney(r.total_sale_amount - r.deposit_amount)} balance`
        : '';
    rows.push({
      key: `invoice-${r.id}`,
      kicker: 'send the invoice',
      line: `invoice ${r.buyer_name || 'your buyer'} for the rest${balance}`,
      heat: 'warm',
      onClick: () => onJumpToReferral(r.id),
    });
  }

  // 3 — paid product orders waiting on fulfillment. Wave C pickup flag: a
  // pickup order never "ships" — say the true action.
  for (const o of newOrders) {
    rows.push({
      key: `order-${o.id}`,
      kicker: 'paid order',
      line: o.pickup
        ? `${o.buyerName || 'a buyer'} is picking up ${o.productName || 'an order'} — mark it when they do`
        : `ship ${o.productName || 'an order'} to ${o.buyerName || 'your buyer'}`,
      heat: 'warm',
      onClick: onGoToProducts,
    });
  }

  // 4 — new leads awaiting a first response.
  for (const r of newLeadRefs) {
    const detail = [r.order_type, r.buyer_state].filter(Boolean).join(' · ');
    rows.push({
      key: `lead-${r.id}`,
      kicker: 'new buyer',
      line: `say hi to ${r.buyer_name || 'a new buyer'}${detail ? ` (${detail})` : ''}`,
      heat: 'warm',
      onClick: () => onJumpToReferral(r.id),
    });
  }

  // 5 — unread buyer messages.
  if (unreadCount > 0) {
    rows.push({
      key: 'unread',
      kicker: 'messages',
      line: unreadCount === 1 ? 'read 1 unread message' : `read ${unreadCount} unread messages`,
      heat: 'warm',
      onClick: onOpenInbox,
    });
  }

  // 6 — finish setup (suppressed while the go-live ribbon owns it).
  if (setupRow) {
    rows.push({
      key: 'setup',
      kicker: 'finish setup',
      line: `${setupRow.done} of ${setupRow.total} done — next: ${setupRow.nextLabel.toLowerCase()}`,
      heat: 'warm',
      onClick: onSetupClick,
    });
  }

  const visible = rows.slice(0, MAX_VISIBLE_ROWS);
  const overflow = rows.length - visible.length;

  return (
    <section aria-label="Today" className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="font-serif text-2xl">today</h2>
        {rows.length > 0 && (
          <span className="text-sm text-saddle">
            {rows.length} thing{rows.length === 1 ? '' : 's'} need{rows.length === 1 ? 's' : ''} you
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="border border-dust bg-white p-6 text-center rounded-sm">
          <p className="font-serif text-xl text-charcoal">nothing needs you</p>
          <p className="text-sm text-saddle mt-1">
            we&rsquo;ll ping you when it does.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={row.onClick}
              className={`w-full text-left rounded-sm border border-l-4 transition-colors p-4 min-h-[56px] flex items-center justify-between gap-3 ${
                row.heat === 'hot'
                  ? 'border-dust border-l-amber-dark bg-amber/10 hover:bg-amber/20'
                  : 'border-dust border-l-charcoal bg-white hover:bg-bone-warm'
              }`}
            >
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                  {row.kicker}
                </p>
                <p className="font-serif text-base sm:text-lg text-charcoal mt-0.5 truncate">
                  {row.line}
                </p>
              </div>
              <span aria-hidden className="text-xl text-saddle shrink-0">
                →
              </span>
            </button>
          ))}
          {overflow > 0 && (
            <button
              type="button"
              onClick={onGoToDeals}
              className="w-full text-left rounded-sm border border-dust bg-bone-warm hover:bg-bone-deep transition-colors px-4 py-3 text-sm text-saddle"
            >
              + {overflow} more in deals →
            </button>
          )}
        </div>
      )}
    </section>
  );
}
