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
    if (data.rancherCount === 0 && data.buyerCount > 0) return 'bg-red-50 border-red-200';
    if (data.utilizationPercent > 80) return 'bg-yellow-50 border-yellow-200';
    if (data.rancherCount > 0 && data.utilizationPercent < 80) return 'bg-green-50 border-green-200';
    return 'border-[#A7A29A]';
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <p className="text-lg text-[#6B4F3F] text-center">Loading heatmap...</p>
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
      <main className="min-h-screen py-12 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="space-y-8">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  State Coverage Heatmap
                </h1>
                <p className="text-sm text-[#6B4F3F] mt-2">Supply vs demand by state</p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 text-sm border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
              >
                &larr; Back to Dashboard
              </Link>
            </div>

            <Divider />

            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 border border-[#A7A29A] text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{stateData.length}</div>
                <div className="text-xs text-[#6B4F3F]">States Active</div>
              </div>
              <div className="p-4 border border-[#A7A29A] text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{totalBuyers}</div>
                <div className="text-xs text-[#6B4F3F]">Total Buyers</div>
              </div>
              <div className="p-4 border border-red-300 bg-red-50 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-red-700">{statesWithNoRanchers.length}</div>
                <div className="text-xs text-red-700 font-medium">States Without Ranchers</div>
              </div>
              <div className="p-4 border border-yellow-300 bg-yellow-50 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-yellow-700">{statesAtCapacity.length}</div>
                <div className="text-xs text-yellow-700 font-medium">States Near Capacity</div>
              </div>
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 bg-red-100 border border-red-300 inline-block"></span> No ranchers (needs recruitment)
              </span>
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 bg-yellow-100 border border-yellow-300 inline-block"></span> Near capacity (&gt;80%)
              </span>
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 bg-green-100 border border-green-300 inline-block"></span> Capacity available
              </span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#0E0E0E] text-[#F4F1EC]">
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
                          <span className="text-red-700">{d.unmatchedBuyers}</span>
                        ) : (
                          <span className="text-green-700">0</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">{d.activeReferrals}</td>
                      <td className="px-4 py-3 text-right">{d.totalCapacity}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`px-2 py-0.5 text-xs ${
                          d.utilizationPercent >= 80 ? 'bg-yellow-200 text-yellow-800' :
                          d.utilizationPercent > 0 ? 'bg-green-200 text-green-800' :
                          'bg-gray-200 text-gray-600'
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
              <div className="p-6 border-2 border-red-300 bg-red-50 space-y-3">
                <h3 className="font-[family-name:var(--font-serif)] text-xl text-red-800">
                  Priority Recruitment Needed
                </h3>
                <p className="text-sm text-red-700">
                  These states have buyers but no ranchers:
                </p>
                <div className="flex flex-wrap gap-2">
                  {statesWithNoRanchers.map(d => (
                    <span key={d.state} className="px-3 py-1 bg-red-200 text-red-800 text-sm font-medium">
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
