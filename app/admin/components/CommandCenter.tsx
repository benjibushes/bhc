'use client';

// Admin "Command Center" — the lifeblood overview at the top of /admin.
// A RE-ORG/compose of data that already exists (referrals/stats, analytics,
// funnel-conversion, payments, deliverability, cal) into one scannable block:
// where the business performs, where to unlock, what's stuck.
//
// Fetches the read-only, build-dark-safe /api/admin/command-center aggregator.
// Every section degrades gracefully: a null section renders a soft
// "unavailable" note; a touchpoint metric whose webhook is unconfigured
// renders a muted config HINT instead of a misleading "0".

import { useEffect, useState } from 'react';

// ── Response types (mirror the aggregator route's JSON shape) ──────────────
interface MoneySection {
  openPipelineRevenue: number;
  openPipelineCount: number;
  depositsCollected: number | null;
  depositsOutstanding: number | null;
  depositsCollectedCount: number | null;
  depositsOutstandingCount: number | null;
  closedThisMonthRevenue: number;
  closedThisMonthCount: number;
  // LEGACY rail only (pre-Connect "rancher owes BHC 10%, invoiced after close").
  // Connect deals owe nothing — their fee rides connectFeeCaptured below.
  commissionEarned: number;
  commissionUnpaid: number;
  // CONNECT rail — marketplace fee captured at deposit. null = Payments read failed.
  connectFeeCaptured: number | null;
  connectFeeCount: number | null;
  // EVERY measurable rail — same definition /admin/today's "Earned" uses.
  bhcRevenueAllRails: number;
  // The models BHC sells today: Connect fee + broker deposit + shop margin
  // + founders + brand partners.
  bhcRevenueCurrentRails: number;
  bhcRevenueLegacyRail: number;
  /** Per-rail dollars; null on a rail ⇒ its table failed to read. */
  bhcRevenueByRail?: Record<string, number | null>;
  bhcRevenueRails?: Array<{ rail: string; label: string }>;
  /** What the total covers, in words — rendered under the tiles. */
  bhcRevenueCoverage?: string;
  /** false ⇒ a rail was unreadable; the total is a floor. */
  bhcRevenueComplete?: boolean;
  /** Rails that take money with no amount recorded in Airtable. */
  bhcRevenueOmits?: Array<{ rail: string; why: string }>;
  depositsOutstandingCoverage?: string;
  blendedRoas: number | null;
  adSpend: number | null;
  // Product rail (Rancher Orders — the low-ticket shop). null = table read failed.
  productOrders: number | null;
  productRevenue: number | null;
  productMarginBHC: number | null;
  productUnshipped: number | null;
  productOrdersThisMonth: number | null;
}
interface FunnelStage {
  key: string;
  label: string;
  count: number;
  convFromPrev: number | null;
}
interface FunnelSection {
  stages: FunnelStage[];
  overallSignupToClosed: number | null;
  biggestDrop: { from: string; to: string; lostPct: number; lost: number } | null;
}
interface ChannelRow {
  source: string;
  signups: number;
  closes: number;
  commission: number;
  spend: number;
  roas: number | null;
}
interface ChannelSection {
  sources: ChannelRow[];
  best: string | null;
  worst: string | null;
}
interface TouchpointsSection {
  email: { configured: boolean; opens: number | null; clicks: number | null; delivered: number | null; windowDays?: number; hint: string };
  inbound: { configured: boolean; total: number | null; last24h: number | null; hint: string };
  calls: { configured: boolean; booked: number | null; done: number | null; hint: string };
}
interface UnlockSection {
  uncoveredDemand: Array<{ state: string; qualifiedBuyers: number }>;
  stalledRanchers: Array<{ id: string; name: string; state: string }>;
  nearCapacity: Array<{ id: string; name: string; state: string; current: number; max: number }>;
}
interface CommandCenterData {
  generatedAt: string;
  config: { stallThresholdDays: number; highIntentCutoff: number };
  money: MoneySection | null;
  funnel: FunnelSection | null;
  channel: ChannelSection | null;
  touchpoints: TouchpointsSection | null;
  unlock: UnlockSection | null;
}

// ── Formatting helpers ─────────────────────────────────────────────────────
const usd = (n: number | null | undefined): string =>
  n == null ? '—' : `$${Math.round(n).toLocaleString()}`;
const intc = (n: number | null | undefined): string => (n == null ? '—' : n.toLocaleString());
const pct = (n: number | null | undefined): string => (n == null ? '—' : `${n}%`);

// A single labelled metric tile.
function Metric({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'good' | 'warn';
}) {
  const valueColor =
    tone === 'good' ? 'text-sage-dark' : tone === 'warn' ? 'text-amber-dark' : 'text-charcoal';
  return (
    <div className="p-3 border border-dust bg-white">
      <div className={`font-[family-name:var(--font-serif)] text-2xl ${valueColor}`}>{value}</div>
      <div className="text-xs text-saddle mt-1">{label}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

// A muted metric tile shown when a metric's data source isn't configured yet —
// renders the config hint instead of a fake "0".
function PendingMetric({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="p-3 border border-dashed border-dust bg-bone-deep/40">
      <div className="font-[family-name:var(--font-serif)] text-2xl text-muted">—</div>
      <div className="text-xs text-saddle mt-1">{label}</div>
      <div className="text-xs text-muted mt-0.5 italic">{hint}</div>
    </div>
  );
}

function SectionShell({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-xs font-bold uppercase tracking-wide text-saddle">{title}</h3>
        {badge}
      </div>
      {children}
    </div>
  );
}

function Unavailable({ label }: { label: string }) {
  return (
    <p className="text-xs text-muted italic p-3 border border-dashed border-dust bg-bone-deep/40">
      {label} data unavailable right now.
    </p>
  );
}

export default function CommandCenter() {
  const [data, setData] = useState<CommandCenterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/command-center');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setErrored(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="p-6 border-2 border-charcoal/15 bg-white">
        <p className="text-sm text-saddle">Loading Command Center…</p>
      </div>
    );
  }

  // The aggregator is build-dark-safe and never 500s, but if the whole request
  // failed (network/auth), degrade silently — the rest of /admin still works.
  if (errored || !data) {
    return (
      <div className="p-4 border border-dust bg-white">
        <p className="text-xs text-muted italic">
          Command Center overview is temporarily unavailable. Detail views below are unaffected.
        </p>
      </div>
    );
  }

  const { money, funnel, channel, touchpoints, unlock } = data;

  return (
    <div className="border-2 border-charcoal/20 bg-white">
      <div className="px-5 py-4 border-b border-dust flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-[family-name:var(--font-serif)] text-xl">Command Center</h2>
        <span className="text-xs text-muted">
          The lifeblood at a glance · updated {new Date(data.generatedAt).toLocaleTimeString()}
        </span>
      </div>

      <div className="p-5 space-y-8">
        {/* ── 1. MONEY ───────────────────────────────────────────────── */}
        <SectionShell title="Money">
          {money ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <Metric
                label="Open pipeline"
                value={`${money.openPipelineCount}`}
                sub="active deals (value set at close)"
              />
              {money.depositsCollected == null ? (
                <PendingMetric label="Deposits collected" hint="no payments recorded yet" />
              ) : (
                <Metric
                  label="Deposits collected"
                  value={usd(money.depositsCollected)}
                  sub={`${money.depositsCollectedCount ?? 0} paid`}
                  tone="good"
                />
              )}
              {money.depositsOutstanding == null ? (
                <PendingMetric label="Deposits outstanding" hint="no payments recorded yet" />
              ) : (
                <Metric
                  label="Deposits outstanding"
                  value={usd(money.depositsOutstanding)}
                  sub={`${money.depositsOutstandingCount ?? 0} open ask${
                    money.depositsOutstandingCount === 1 ? '' : 's'
                  }`}
                  tone={money.depositsOutstanding > 0 ? 'warn' : 'default'}
                />
              )}
              <Metric
                label="Closed this month"
                value={usd(money.closedThisMonthRevenue)}
                sub={`${money.closedThisMonthCount} deals`}
                tone="good"
              />
              {/* TWO RAILS, NAMED (2026-07-24). This was one "Commission
                  earned" tile summing a column that only means anything on the
                  deprecated invoice-after-close rail — a Connect close would
                  have surfaced here as a receivable Stripe already banked at
                  deposit. Legacy receivable and Connect fee now stand apart. */}
              {/* THE number. Connect marketplace fee + shop margin — money
                  BHC earned on the two models it actually sells today. Sits
                  ahead of the legacy receivable so the honest figure is the
                  one read first. */}
              {/* THE number — every rail BHC earns on that Airtable can
                  measure. It used to be Connect fee + shop margin only, which
                  omitted the legacy rail: 84% of lifetime revenue. The
                  provenance line under this grid names what it covers. */}
              <Metric
                label="BHC earned (all rails)"
                value={usd(money.bhcRevenueAllRails)}
                sub={`current rails ${usd(money.bhcRevenueCurrentRails)} + legacy ${usd(money.bhcRevenueLegacyRail)}`}
                tone={money.bhcRevenueAllRails > 0 ? 'good' : 'warn'}
              />
              <Metric
                label="BHC earned (current rails)"
                value={usd(money.bhcRevenueCurrentRails)}
                sub={`Connect fee ${usd(money.connectFeeCaptured ?? 0)} + shop margin ${usd(money.productMarginBHC ?? 0)}`}
                tone={money.bhcRevenueCurrentRails > 0 ? 'good' : 'warn'}
              />
              <Metric
                label="Legacy commission (pre-Connect)"
                value={usd(money.commissionEarned)}
                sub={money.commissionUnpaid > 0 ? `${usd(money.commissionUnpaid)} still owed` : 'all invoiced + paid'}
                tone={money.commissionUnpaid > 0 ? 'warn' : 'good'}
              />
              {money.connectFeeCaptured == null ? (
                <PendingMetric label="Connect fees captured" hint="payments read unavailable" />
              ) : (
                <Metric
                  label="Connect fees captured"
                  value={usd(money.connectFeeCaptured)}
                  sub={`taken at deposit · ${money.connectFeeCount ?? 0} deals`}
                  tone="good"
                />
              )}
              {money.blendedRoas == null ? (
                <PendingMetric label="Blended ROAS" hint="log ad spend to compute" />
              ) : (
                <Metric
                  label="Blended ROAS"
                  value={`${money.blendedRoas}x`}
                  sub={money.adSpend != null ? `both rails on ${usd(money.adSpend)} spend` : undefined}
                  tone={money.blendedRoas >= 1 ? 'good' : 'warn'}
                />
              )}
              {/* Product rail — shop (Rancher Orders) money. The money view
                  was blind to this rail before; shop sales counted nowhere. */}
              {money.productRevenue == null ? (
                <PendingMetric label="Shop sales" hint="no product orders yet" />
              ) : (
                <Metric
                  label="Shop sales"
                  value={usd(money.productRevenue)}
                  sub={`${money.productOrders ?? 0} orders · ${usd(money.productMarginBHC ?? 0)} BHC margin`}
                  tone="good"
                />
              )}
              {money.productUnshipped != null && money.productUnshipped > 0 && (
                <Metric
                  label="Awaiting shipment"
                  value={`${money.productUnshipped}`}
                  sub={`${money.productOrdersThisMonth ?? 0} ordered this month`}
                  tone="warn"
                />
              )}
              </div>
          ) : (
            <Unavailable label="Money" />
          )}
          {/* WHAT THESE NUMBERS INCLUDE (money-truth audit, 2026-08-19). Two
              screens totalled two different rail sets under the same words and
              neither said so. Never render a money figure here unlabelled. */}
          {money && (
            <div className="mt-3 text-[11px] leading-snug text-saddle space-y-1">
              {money.bhcRevenueCoverage && (
                <p>
                  <span className="font-semibold">BHC earned =</span> {money.bhcRevenueCoverage}.
                  {money.bhcRevenueComplete === false && ' Some rails unreadable — treat as a floor.'}
                </p>
              )}
              {money.depositsOutstandingCoverage && (
                <p>
                  <span className="font-semibold">Deposits outstanding =</span>{' '}
                  {money.depositsOutstandingCoverage}.
                </p>
              )}
              {!!money.bhcRevenueOmits?.length && (
                <p>
                  <span className="font-semibold">Not counted anywhere:</span>{' '}
                  {money.bhcRevenueOmits.map((o) => o.rail).join('; ')} — money moves in Stripe with
                  no amount recorded in Airtable.
                </p>
              )}
            </div>
          )}
        </SectionShell>

        {/* ── 2. FUNNEL ──────────────────────────────────────────────── */}
        <SectionShell
          title="Funnel"
          badge={
            funnel?.biggestDrop ? (
              <span className="text-xs px-2 py-0.5 bg-amber/15 text-amber-dark border border-amber/60">
                Biggest drop-off: {funnel.biggestDrop.from} → {funnel.biggestDrop.to} (−{funnel.biggestDrop.lostPct}%)
              </span>
            ) : undefined
          }
        >
          {funnel && funnel.stages.length > 0 ? (
            <div className="space-y-3">
              <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
                {funnel.stages.map((st, i) => {
                  const isDrop =
                    funnel.biggestDrop &&
                    i > 0 &&
                    funnel.stages[i - 1].label === funnel.biggestDrop.from &&
                    st.label === funnel.biggestDrop.to;
                  return (
                    <div key={st.key} className="flex items-stretch gap-1">
                      {i > 0 && (
                        <div className="flex flex-col justify-center px-1">
                          <span className={`text-xs ${isDrop ? 'text-amber-dark font-bold' : 'text-muted'}`}>
                            {st.convFromPrev == null ? '·' : `${st.convFromPrev}%`}
                          </span>
                        </div>
                      )}
                      <div
                        className={`min-w-[92px] p-3 border text-center ${
                          isDrop ? 'border-amber/60 bg-amber/10' : 'border-dust bg-white'
                        }`}
                      >
                        <div className="font-[family-name:var(--font-serif)] text-2xl">{intc(st.count)}</div>
                        <div className="text-xs text-saddle mt-1">{st.label}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-saddle">
                Overall signup → closed:{' '}
                <span className="font-medium text-charcoal">{pct(funnel.overallSignupToClosed)}</span>
              </p>
            </div>
          ) : (
            <Unavailable label="Funnel" />
          )}
        </SectionShell>

        {/* ── 3. CHANNEL ─────────────────────────────────────────────── */}
        <SectionShell title="Channel">
          {channel && channel.sources.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs text-saddle uppercase tracking-wide border-b border-dust">
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 px-2 font-medium text-right">Signups</th>
                    <th className="py-2 px-2 font-medium text-right">Closes</th>
                    <th className="py-2 px-2 font-medium text-right">Commission</th>
                    <th className="py-2 pl-2 font-medium text-right">ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {channel.sources.map((s) => {
                    const isBest = s.source === channel.best;
                    const isWorst = s.source === channel.worst;
                    return (
                      <tr
                        key={s.source}
                        className={`border-b border-dust/40 ${
                          isBest ? 'bg-sage/10' : isWorst ? 'bg-weathered/5' : ''
                        }`}
                      >
                        <td className="py-2 pr-4">
                          <span className="font-medium">{s.source}</span>
                          {isBest && (
                            <span className="ml-2 text-xs px-1.5 py-0.5 bg-sage/15 text-sage-dark border border-sage/40">
                              best
                            </span>
                          )}
                          {isWorst && (
                            <span className="ml-2 text-xs px-1.5 py-0.5 bg-weathered/10 text-weathered border border-weathered/40">
                              worst
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right">{intc(s.signups)}</td>
                        <td className="py-2 px-2 text-right">{intc(s.closes)}</td>
                        <td className="py-2 px-2 text-right">{usd(s.commission)}</td>
                        <td className="py-2 pl-2 text-right">
                          {s.roas == null ? <span className="text-muted">—</span> : `${s.roas}x`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-xs text-muted mt-2">
                ROAS shows once ad spend is logged for a source. Sorted by commission.
              </p>
            </div>
          ) : (
            <Unavailable label="Channel" />
          )}
        </SectionShell>

        {/* ── 4. TOUCHPOINTS ─────────────────────────────────────────── */}
        <SectionShell title="Touchpoints">
          {touchpoints ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {/* Email opens / clicks — gated on Resend event webhook */}
              {touchpoints.email.configured ? (
                <>
                  <Metric
                    label="Email opens"
                    value={intc(touchpoints.email.opens)}
                    sub={
                      touchpoints.email.delivered != null
                        ? `of ${intc(touchpoints.email.delivered)} delivered${
                            touchpoints.email.windowDays ? ` · last ${touchpoints.email.windowDays}d` : ''
                          }`
                        : undefined
                    }
                  />
                  <Metric label="Email clicks" value={intc(touchpoints.email.clicks)} />
                </>
              ) : (
                <>
                  <PendingMetric label="Email opens" hint={touchpoints.email.hint} />
                  <PendingMetric label="Email clicks" hint={touchpoints.email.hint} />
                </>
              )}

              {/* Calls booked / done — gated on Cal webhook (CAL_API_KEY) */}
              {touchpoints.calls.configured ? (
                <>
                  <Metric label="Calls booked" value={intc(touchpoints.calls.booked)} />
                  <Metric label="Calls done" value={intc(touchpoints.calls.done)} />
                </>
              ) : (
                <>
                  <PendingMetric label="Calls booked" hint={touchpoints.calls.hint} />
                  <PendingMetric label="Calls done" hint={touchpoints.calls.hint} />
                </>
              )}

              {/* Inbound replies — gated on Resend inbound webhook */}
              {touchpoints.inbound.configured ? (
                <>
                  <Metric
                    label="Inbound replies"
                    value={intc(touchpoints.inbound.total)}
                    sub={touchpoints.inbound.last24h != null ? `${intc(touchpoints.inbound.last24h)} in 24h` : undefined}
                    tone={touchpoints.inbound.last24h && touchpoints.inbound.last24h > 0 ? 'good' : 'default'}
                  />
                  <div />
                </>
              ) : (
                <>
                  <PendingMetric label="Inbound replies" hint={touchpoints.inbound.hint} />
                  <div />
                </>
              )}
            </div>
          ) : (
            <Unavailable label="Touchpoints" />
          )}
        </SectionShell>

        {/* ── 5. WHERE TO UNLOCK ─────────────────────────────────────── */}
        <SectionShell title="Where to unlock">
          {unlock ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* (a) Demand without supply */}
              <div className="p-4 border border-dust bg-bone-deep/30 space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold">Demand, no rancher</h4>
                  <a href="/admin/heatmap" className="text-xs text-amber-dark underline">
                    Heatmap
                  </a>
                </div>
                <p className="text-xs text-saddle">Qualified buyers in states with no live rancher — recruit here.</p>
                {unlock.uncoveredDemand.length === 0 ? (
                  <p className="text-xs text-muted italic">Every state with qualified demand is covered.</p>
                ) : (
                  <ul className="space-y-1">
                    {unlock.uncoveredDemand.map((d) => (
                      <li key={d.state} className="flex items-center justify-between text-sm">
                        <span className="font-medium">{d.state}</span>
                        <span className="text-saddle">
                          {d.qualifiedBuyers} qualified {d.qualifiedBuyers === 1 ? 'buyer' : 'buyers'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* (b) Stalled ranchers */}
              <div className="p-4 border border-dust bg-bone-deep/30 space-y-2">
                <h4 className="text-sm font-bold">Idle ranchers</h4>
                <p className="text-xs text-saddle">Live but 0 active referrals — push leads or check why they&apos;re not receiving.</p>
                {unlock.stalledRanchers.length === 0 ? (
                  <p className="text-xs text-muted italic">No idle live ranchers.</p>
                ) : (
                  <ul className="space-y-1">
                    {unlock.stalledRanchers.map((r) => (
                      <li key={r.id} className="flex items-center justify-between text-sm gap-2">
                        <a href={`/admin/ranchers/${r.id}`} className="font-medium underline hover:text-charcoal truncate">
                          {r.name}
                        </a>
                        <span className="text-saddle shrink-0">{r.state}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* (c) Near capacity */}
              <div className="p-4 border border-dust bg-bone-deep/30 space-y-2">
                <h4 className="text-sm font-bold">Near capacity</h4>
                <p className="text-xs text-saddle">≥80% full — recruit backfill before they cap out.</p>
                {unlock.nearCapacity.length === 0 ? (
                  <p className="text-xs text-muted italic">No ranchers near capacity.</p>
                ) : (
                  <ul className="space-y-1">
                    {unlock.nearCapacity.map((r) => (
                      <li key={r.id} className="flex items-center justify-between text-sm gap-2">
                        <a href={`/admin/ranchers/${r.id}`} className="font-medium underline hover:text-charcoal truncate">
                          {r.name}
                        </a>
                        <span className="text-amber-dark shrink-0">
                          {r.current}/{r.max}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <Unavailable label="Unlock" />
          )}
        </SectionShell>
      </div>
    </div>
  );
}
