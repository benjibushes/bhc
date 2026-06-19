'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import type { DeliverabilitySummary } from '@/lib/deliverabilityStats';

type Health = any;

type DeliverabilityData = {
  ok: boolean;
  summary: DeliverabilitySummary;
  inboundConfigured: boolean;
  eventsConfigured: boolean;
} | null;

function HealthDashboard() {
  const [data, setData] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [deliverability, setDeliverability] = useState<DeliverabilityData>(null);

  const fetchData = async () => {
    setLoading(true);
    setErr('');
    try {
      const [res, dRes] = await Promise.all([
        fetch('/api/admin/health'),
        fetch('/api/admin/deliverability'),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setData(j);
      if (dRes.ok) {
        const dj = await dRes.json();
        setDeliverability(dj);
      }
    } catch (e: any) {
      setErr(e?.message || 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) return <main className="min-h-screen p-8 bg-bone"><div>Loading…</div></main>;
  if (err) return <main className="min-h-screen p-8 bg-bone"><div className="text-weathered">Error: {err}</div></main>;
  if (!data) return null;

  const Card = ({ title, value, sub, tone }: { title: string; value: any; sub?: string; tone?: 'good' | 'warn' | 'bad' }) => (
    <div className={`p-4 border-2 ${
      tone === 'bad' ? 'border-weathered bg-weathered/10' :
      tone === 'warn' ? 'border-amber-dark bg-amber/10' :
      tone === 'good' ? 'border-sage-dark bg-sage/10' :
      'border-dust bg-white'
    }`}>
      <p className="text-xs uppercase tracking-wider text-saddle">{title}</p>
      <p className="font-serif text-3xl mt-1">{value}</p>
      {sub ? <p className="text-xs text-saddle mt-1">{sub}</p> : null}
    </div>
  );

  return (
    <main className="min-h-screen p-8 bg-bone text-charcoal">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex justify-between items-center">
          <h1 className="font-serif text-3xl">System Health</h1>
          <div className="flex gap-3">
            <button onClick={fetchData} className="px-4 py-2 text-sm border border-dust hover:bg-dust hover:text-white">↻ Refresh</button>
            <Link href="/admin" className="px-4 py-2 text-sm border border-charcoal bg-charcoal text-bone">← Admin</Link>
          </div>
        </div>
        <p className="text-xs text-saddle">Snapshot: {new Date(data.generated_at).toLocaleString()}</p>

        {/* Revenue */}
        <section>
          <h2 className="font-serif text-xl mb-3">Revenue</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card title="Closed Won" value={data.revenue.won_total} sub={`${data.revenue.won_last_7d} in last 7d`} tone={data.revenue.won_last_7d > 0 ? 'good' : 'warn'} />
            <Card title="Gross Sales" value={`$${data.revenue.gross_sales.toLocaleString()}`} />
            <Card title="Commission" value={`$${data.revenue.commission_earned.toLocaleString()}`} />
            <Card title="New Signups (7d)" value={data.revenue.new_signups_7d} />
            <Card title="Active Pipeline" value={data.referrals.active} sub="Intro Sent + Contacted + Negotiation" />
          </div>
        </section>

        {/* Ranchers */}
        <section>
          <h2 className="font-serif text-xl mb-3">Ranchers</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Card title="Total" value={data.ranchers.total} />
            <Card title="Live" value={data.ranchers.live} tone="good" />
            <Card title="Verified, not live" value={data.ranchers.verifiedNotLive} tone={data.ranchers.verifiedNotLive > 0 ? 'warn' : undefined} />
            <Card title="Signed but stuck" value={data.ranchers.stuck_signed_not_live} tone={data.ranchers.stuck_signed_not_live > 0 ? 'bad' : 'good'} />
            <Card title="Multi-state approved" value={data.ranchers.multistate_approved} />
          </div>
          {data.ranchers.stuck_signed_details?.length > 0 && (
            <div className="p-4 border-2 border-weathered bg-weathered/10">
              <p className="text-xs uppercase tracking-wider text-weathered mb-2">STUCK — Agreement Signed, Page not Live</p>
              <table className="w-full text-xs">
                <thead><tr className="text-left text-saddle"><th className="pr-3">Rancher</th><th className="pr-3">Onboarding</th><th className="pr-3">Slug</th><th className="pr-3">About</th><th className="pr-3">Payment</th><th></th></tr></thead>
                <tbody>
                  {data.ranchers.stuck_signed_details.map((r: any) => (
                    <tr key={r.id} className="border-t border-weathered/30">
                      <td className="py-1 pr-3 font-medium">{r.name}</td>
                      <td className="py-1 pr-3">{r.onboarding}</td>
                      <td className="py-1 pr-3">{r.slug ? '✓' : <span className="text-weathered">✗</span>}</td>
                      <td className="py-1 pr-3">{r.about ? '✓' : <span className="text-weathered">✗</span>}</td>
                      <td className="py-1 pr-3">{r.payment ? '✓' : <span className="text-weathered">✗</span>}</td>
                      <td className="py-1"><Link href={`/admin/ranchers/${r.id}`} className="underline">edit →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {Object.entries(data.ranchers.by_onboarding).map(([k, v]: any) => (
              <div key={k} className="px-3 py-2 border border-dust bg-white"><span className="text-saddle">{k}:</span> <strong>{v}</strong></div>
            ))}
          </div>
        </section>

        {/* Data Integrity */}
        <section>
          <h2 className="font-serif text-xl mb-3">Data Integrity</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card title="Orphan Pending Approval" value={data.referrals.orphan_pending} tone={data.referrals.orphan_pending === 0 ? 'good' : 'bad'} />
            <Card title="Counter drift" value={data.referrals.counter_drift_ranchers} tone={data.referrals.counter_drift_ranchers === 0 ? 'good' : 'warn'} sub="ranchers with stored ≠ actual" />
            <Card title="Approved, no Stage" value={data.consumers.approved_no_stage} tone={data.consumers.approved_no_stage === 0 ? 'good' : 'warn'} />
            <Card title="YES clickers" value={data.consumers.yes_click_total} sub={`of ${data.consumers.approved} approved`} />
          </div>
        </section>

        {/* Cron Health */}
        <section>
          <h2 className="font-serif text-xl mb-3">Cron Health</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-saddle border-b border-dust/40">
                  <th className="pr-3 py-1">Name</th>
                  <th className="pr-3 py-1">Last Run</th>
                  <th className="pr-3 py-1">Status</th>
                  <th className="pr-3 py-1">Duration</th>
                  <th className="pr-3 py-1">Touched</th>
                  <th className="pr-3 py-1">Notes</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.crons || {})
                  .sort((a: any, b: any) => (b[1].lastRun > a[1].lastRun ? 1 : -1))
                  .map(([name, c]: any) => (
                    <tr key={name} className="border-t border-dust/30">
                      <td className="py-1 pr-3 font-mono">{name}</td>
                      <td className="py-1 pr-3">{c.lastRun ? new Date(c.lastRun).toLocaleString() : '(never)'}</td>
                      <td className="py-1 pr-3">
                        <span className={c.status === 'success' ? 'text-sage-dark' : c.status === 'error' ? 'text-weathered' : c.status === 'maintenance-blocked' ? 'text-amber-dark' : ''}>
                          {c.status || '(unknown)'}
                        </span>
                      </td>
                      <td className="py-1 pr-3">{c.durationMs}ms</td>
                      <td className="py-1 pr-3">{c.recordsTouched}</td>
                      <td className="py-1">{c.notes}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Coverage gap */}
        <section>
          <h2 className="font-serif text-xl mb-3">Coverage Gap (Untapped Demand)</h2>
          <p className="text-sm text-saddle mb-3">
            Live states: <strong>{data.coverage.live_states.length}</strong> ({data.coverage.live_states.join(', ')})
            · <strong>{data.coverage.total_uncovered_buyers}</strong> buyers approved in uncovered states.
          </p>
          <div className="grid grid-cols-3 md:grid-cols-6 lg:grid-cols-10 gap-2 text-sm">
            {data.coverage.uncovered_demand.slice(0, 20).map((u: any) => (
              <div key={u.state} className="px-3 py-2 border border-amber/60 bg-amber/10 text-center">
                <p className="font-bold">{u.state}</p>
                <p className="text-xs text-saddle">{u.buyers} buyers</p>
              </div>
            ))}
          </div>
        </section>

        {/* Referral status breakdown */}
        <section>
          <h2 className="font-serif text-xl mb-3">Referrals by Status</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {Object.entries(data.referrals.by_status).map(([k, v]: any) => (
              <div key={k} className="px-3 py-2 border border-dust bg-white"><span className="text-saddle">{k}:</span> <strong>{v}</strong></div>
            ))}
          </div>
        </section>

        {/* Deliverability */}
        {deliverability && (
          <section>
            <h2 className="font-serif text-xl mb-3">Deliverability</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <Card title="Inbound (24h)" value={deliverability.summary.inboundLast24h} />
              <Card title="Inbound (total)" value={deliverability.summary.inboundTotal} />
              <Card title="Bounced" value={deliverability.summary.bounced} tone={deliverability.summary.bounced > 0 ? 'warn' : undefined} />
              <Card title="Complained" value={deliverability.summary.complained} tone={deliverability.summary.complained > 0 ? 'warn' : undefined} />
              <Card title="Suppressed (total)" value={deliverability.summary.suppressedTotal} />
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${deliverability.inboundConfigured ? 'bg-sage-dark' : 'bg-weathered'}`} />
                <span className="text-saddle">Inbound webhook</span>
                <span className={deliverability.inboundConfigured ? 'text-sage-dark' : 'text-weathered'}>
                  {deliverability.inboundConfigured ? 'configured' : 'not set'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${deliverability.eventsConfigured ? 'bg-sage-dark' : 'bg-weathered'}`} />
                <span className="text-saddle">Event webhook</span>
                <span className={deliverability.eventsConfigured ? 'text-sage-dark' : 'text-weathered'}>
                  {deliverability.eventsConfigured ? 'configured' : 'not set'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${deliverability.summary.healthy ? 'bg-sage-dark' : 'bg-amber-dark'}`} />
                <span className={`font-medium ${deliverability.summary.healthy ? 'text-sage-dark' : 'text-amber-dark'}`}>
                  {deliverability.summary.healthy ? 'LIVE' : 'No inbound yet'}
                </span>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export default function HealthPage() {
  return (
    <AdminAuthGuard>
      <HealthDashboard />
    </AdminAuthGuard>
  );
}
