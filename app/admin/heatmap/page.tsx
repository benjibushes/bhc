'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';

interface StateData {
  state: string;
  buyerCount: number;
  rancherCount: number;
  unmatchedBuyers: number;
  totalCapacity: number;
  activeReferrals: number;
  utilizationPercent: number;
}

export default function HeatmapPage() {
  const [stateData, setStateData] = useState<StateData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [consumersRes, ranchersRes, referralsRes] = await Promise.all([
        fetch('/api/admin/consumers'),
        fetch('/api/admin/ranchers'),
        fetch('/api/referrals'),
      ]);
      const [consumers, ranchers, referrals] = await Promise.all([
        consumersRes.json(),
        ranchersRes.json(),
        referralsRes.json(),
      ]);

      const stateMap: Record<string, StateData> = {};

      const allStates = new Set<string>();
      consumers.forEach((c: any) => { if (c.state) allStates.add(c.state); });
      ranchers.forEach((r: any) => { if (r.state) allStates.add(r.state); });

      allStates.forEach(state => {
        const stateBuyers = consumers.filter((c: any) => c.state === state);
        const stateRanchers = ranchers.filter((r: any) => r.state === state);
        const stateReferrals = referrals.filter((r: any) => r.buyer_state === state);

        const activeRefs = stateReferrals.filter((r: any) =>
          !['Closed Won', 'Closed Lost', 'Dormant'].includes(r.status)
        );

        const unmatched = stateBuyers.filter((c: any) =>
          c.referral_status === 'Unmatched' || !c.referral_status
        );

        const totalCapacity = stateRanchers.reduce(
          (sum: number, r: any) => sum + (r.max_active_referrals || 5), 0
        );

        const utilization = totalCapacity > 0
          ? Math.round((activeRefs.length / totalCapacity) * 100)
          : 0;

        stateMap[state] = {
          state,
          buyerCount: stateBuyers.length,
          rancherCount: stateRanchers.length,
          unmatchedBuyers: unmatched.length,
          totalCapacity,
          activeReferrals: activeRefs.length,
          utilizationPercent: utilization,
        };
      });

      const sorted = Object.values(stateMap).sort((a, b) => b.unmatchedBuyers - a.unmatchedBuyers);
      setStateData(sorted);
    } catch (error) {
      console.error('Error loading heatmap data:', error);
    }
    setLoading(false);
  };

  const getRowColor = (data: StateData) => {
    if (data.rancherCount === 0 && data.buyerCount > 0) return 'bg-weathered/10 border-weathered/30';
    if (data.utilizationPercent > 80) return 'bg-amber/10 border-amber/30';
    if (data.rancherCount > 0 && data.utilizationPercent < 80) return 'bg-sage/10 border-sage/30';
    return 'border-dust';
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-lg text-saddle text-center">Loading heatmap...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  const totalBuyers = stateData.reduce((s, d) => s + d.buyerCount, 0);
  const totalRanchers = stateData.reduce((s, d) => s + d.rancherCount, 0);
  const statesWithNoRanchers = stateData.filter(d => d.rancherCount === 0 && d.buyerCount > 0);
  const statesAtCapacity = stateData.filter(d => d.utilizationPercent >= 80 && d.rancherCount > 0);

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-bone text-charcoal">
        <Container>
          <div className="space-y-8">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  State Coverage Heatmap
                </h1>
                <p className="text-sm text-saddle mt-2">Supply vs demand by state</p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                &larr; Back to Dashboard
              </Link>
            </div>

            <Divider />

            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{stateData.length}</div>
                <div className="text-xs text-saddle">States Active</div>
              </div>
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{totalBuyers}</div>
                <div className="text-xs text-saddle">Total Buyers</div>
              </div>
              <div className="p-4 border border-weathered/40 bg-weathered/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-weathered">{statesWithNoRanchers.length}</div>
                <div className="text-xs text-weathered font-medium">States Without Ranchers</div>
              </div>
              <div className="p-4 border border-amber/60 bg-amber/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-amber-dark">{statesAtCapacity.length}</div>
                <div className="text-xs text-amber-dark font-medium">States Near Capacity</div>
              </div>
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 bg-weathered/15 border border-weathered/40 inline-block"></span> No ranchers (needs recruitment)
              </span>
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 bg-amber/15 border border-amber/60 inline-block"></span> Near capacity (&gt;80%)
              </span>
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 bg-sage/15 border border-sage/40 inline-block"></span> Capacity available
              </span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-charcoal text-bone">
                    <th className="px-4 py-3 text-left">State</th>
                    <th className="px-4 py-3 text-right">Buyers</th>
                    <th className="px-4 py-3 text-right">Ranchers</th>
                    <th className="px-4 py-3 text-right">Unmatched</th>
                    <th className="px-4 py-3 text-right">Active Refs</th>
                    <th className="px-4 py-3 text-right">Total Capacity</th>
                    <th className="px-4 py-3 text-right">Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {stateData.map(d => (
                    <tr key={d.state} className={`border ${getRowColor(d)}`}>
                      <td className="px-4 py-3 font-medium">{d.state}</td>
                      <td className="px-4 py-3 text-right">{d.buyerCount}</td>
                      <td className="px-4 py-3 text-right">{d.rancherCount}</td>
                      <td className="px-4 py-3 text-right font-medium">
                        {d.unmatchedBuyers > 0 ? (
                          <span className="text-weathered">{d.unmatchedBuyers}</span>
                        ) : (
                          <span className="text-sage-dark">0</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">{d.activeReferrals}</td>
                      <td className="px-4 py-3 text-right">{d.totalCapacity}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`px-2 py-0.5 text-xs ${
                          d.utilizationPercent >= 80 ? 'bg-amber/25 text-amber-dark' :
                          d.utilizationPercent > 0 ? 'bg-sage/20 text-sage-dark' :
                          'bg-dust/40 text-saddle'
                        }`}>
                          {d.utilizationPercent}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Priority Recruitment */}
            {statesWithNoRanchers.length > 0 && (
              <div className="p-6 border-2 border-weathered/40 bg-weathered/10 space-y-3">
                <h3 className="font-[family-name:var(--font-serif)] text-xl text-weathered">
                  Priority Recruitment Needed
                </h3>
                <p className="text-sm text-weathered">
                  These states have buyers but no ranchers:
                </p>
                <div className="flex flex-wrap gap-2">
                  {statesWithNoRanchers.map(d => (
                    <span key={d.state} className="px-3 py-1 bg-weathered/20 text-weathered text-sm font-medium">
                      {d.state} ({d.buyerCount} buyers)
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
