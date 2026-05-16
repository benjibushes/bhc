'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminAuthGuard from '../../components/AdminAuthGuard';

type Health = any;

function HealthDashboard() {
  const [data, setData] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const fetchData = async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setData(j);
    } catch (e: any) {
      setErr(e?.message || 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) return <main className="min-h-screen p-8 bg-[#F4F1EC]"><div>Loading…</div></main>;
  if (err) return <main className="min-h-screen p-8 bg-[#F4F1EC]"><div className="text-red-700">Error: {err}</div></main>;
  if (!data) return null;

  const Card = ({ title, value, sub, tone }: { title: string; value: any; sub?: string; tone?: 'good' | 'warn' | 'bad' }) => (
    <div className={`p-4 border-2 ${
      tone === 'bad' ? 'border-red-700 bg-red-50' :
      tone === 'warn' ? 'border-amber-600 bg-amber-50' :
      tone === 'good' ? 'border-green-700 bg-green-50' :
      'border-[#A7A29A] bg-white'
    }`}>
      <p className="text-xs uppercase tracking-wider text-[#6B4F3F]">{title}</p>
      <p className="font-serif text-3xl mt-1">{value}</p>
      {sub ? <p className="text-xs text-[#6B4F3F] mt-1">{sub}</p> : null}
    </div>
  );

  return (
    <main className="min-h-screen p-8 bg-[#F4F1EC] text-[#0E0E0E]">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex justify-between items-center">
          <h1 className="font-serif text-3xl">System Health</h1>
          <div className="flex gap-3">
            <button onClick={fetchData} className="px-4 py-2 text-sm border border-[#A7A29A] hover:bg-[#A7A29A] hover:text-white">↻ Refresh</button>
            <Link href="/admin" className="px-4 py-2 text-sm border border-[#0E0E0E] bg-[#0E0E0E] text-[#F4F1EC]">← Admin</Link>
          </div>
        </div>
        <p className="text-xs text-[#6B4F3F]">Snapshot: {new Date(data.generated_at).toLocaleString()}</p>

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
            <div className="p-4 border-2 border-red-700 bg-red-50">
              <p className="text-xs uppercase tracking-wider text-red-900 mb-2">STUCK — Agreement Signed, Page not Live</p>
              <table className="w-full text-xs">
                <thead><tr className="text-left text-[#6B4F3F]"><th className="pr-3">Rancher</th><th className="pr-3">Onboarding</th><th className="pr-3">Slug</th><th className="pr-3">About</th><th className="pr-3">Payment</th><th></th></tr></thead>
                <tbody>
                  {data.ranchers.stuck_signed_details.map((r: any) => (
                    <tr key={r.id} className="border-t border-red-200">
                      <td className="py-1 pr-3 font-medium">{r.name}</td>
                      <td className="py-1 pr-3">{r.onboarding}</td>
                      <td className="py-1 pr-3">{r.slug ? '✓' : <span className="text-red-700">✗</span>}</td>
                      <td className="py-1 pr-3">{r.about ? '✓' : <span className="text-red-700">✗</span>}</td>
                      <td className="py-1 pr-3">{r.payment ? '✓' : <span className="text-red-700">✗</span>}</td>
                      <td className="py-1"><Link href={`/admin/ranchers/${r.id}`} className="underline">edit →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {Object.entries(data.ranchers.by_onboarding).map(([k, v]: any) => (
              <div key={k} className="px-3 py-2 border border-[#A7A29A] bg-white"><span className="text-[#6B4F3F]">{k}:</span> <strong>{v}</strong></div>
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

        {/* Coverage gap */}
        <section>
          <h2 className="font-serif text-xl mb-3">Coverage Gap (Untapped Demand)</h2>
          <p className="text-sm text-[#6B4F3F] mb-3">
            Live states: <strong>{data.coverage.live_states.length}</strong> ({data.coverage.live_states.join(', ')})
            · <strong>{data.coverage.total_uncovered_buyers}</strong> buyers approved in uncovered states.
          </p>
          <div className="grid grid-cols-3 md:grid-cols-6 lg:grid-cols-10 gap-2 text-sm">
            {data.coverage.uncovered_demand.slice(0, 20).map((u: any) => (
              <div key={u.state} className="px-3 py-2 border border-amber-400 bg-amber-50 text-center">
                <p className="font-bold">{u.state}</p>
                <p className="text-xs text-[#6B4F3F]">{u.buyers} buyers</p>
              </div>
            ))}
          </div>
        </section>

        {/* Referral status breakdown */}
        <section>
          <h2 className="font-serif text-xl mb-3">Referrals by Status</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {Object.entries(data.referrals.by_status).map(([k, v]: any) => (
              <div key={k} className="px-3 py-2 border border-[#A7A29A] bg-white"><span className="text-[#6B4F3F]">{k}:</span> <strong>{v}</strong></div>
            ))}
          </div>
        </section>
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
