'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';
import AdminAuthGuard from '../../components/AdminAuthGuard';

interface CampaignStats {
  campaignName: string;
  emailsSent: number;
  signUps: number;
  inquiries: number;
  sales: number;
  totalRevenue: number;
  totalCommission: number;
}

// P1 audit D-5: per-Source attribution row
interface SourceRow {
  source: string;
  signups: number;
  matches: number;
  closes: number;
  commissionDue: number;
}

interface AnalyticsData {
  filter?: { sinceDays: number | null; label: string };
  overview: {
    totalConsumers: number;
    totalInquiries: number;
    totalSales: number;
    totalRevenue: number;
    totalCommission: number;
    conversionRate: number;
  };
  campaigns: CampaignStats[];
  sourceBreakdown?: SourceRow[];
  recentActivity: {
    type: 'signup' | 'inquiry' | 'sale';
    name: string;
    details: string;
    source: string;
    amount?: number;
    date: string;
  }[];
}

// Date filter dropdown options. 'all' is back-compat.
type SinceFilter = '7' | '30' | '90' | 'all';
const SINCE_LABELS: Record<SinceFilter, string> = {
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
  'all': 'All time',
};

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  // P1 audit D-5: date filter state. Default '30' since "did this week's
  // campaign perform?" is the most common question — all-time was the bug.
  const [sinceFilter, setSinceFilter] = useState<SinceFilter>('30');

  useEffect(() => {
    fetchAnalytics(sinceFilter);
  }, [sinceFilter]);

  const fetchAnalytics = async (since: SinceFilter) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/analytics?sinceDays=${since}`);
      const analyticsData = await response.json();
      setData(analyticsData);
    } catch (err) {
      console.error('Error fetching analytics:', err);
    }
    setLoading(false);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatPercent = (value: number) => {
    return `${(value * 100).toFixed(1)}%`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-center">Loading analytics...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  if (!data) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-center">Failed to load analytics.</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="space-y-8">
            {/* Header */}
            <div className="flex justify-between items-start">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-4xl mb-2">
                  Analytics & Attribution
                </h1>
                <p className="text-saddle">
                  Track campaign performance and revenue · <strong>{data.filter?.label || SINCE_LABELS[sinceFilter]}</strong>
                </p>
              </div>
              <div className="flex gap-2 items-center">
                {/* P1 audit D-5: date range selector */}
                <label className="text-sm text-saddle flex items-center gap-2">
                  Range:
                  <select
                    value={sinceFilter}
                    onChange={(e) => setSinceFilter(e.target.value as SinceFilter)}
                    className="px-3 py-2 border border-dust bg-bone text-sm"
                  >
                    <option value="7">{SINCE_LABELS['7']}</option>
                    <option value="30">{SINCE_LABELS['30']}</option>
                    <option value="90">{SINCE_LABELS['90']}</option>
                    <option value="all">{SINCE_LABELS['all']}</option>
                  </select>
                </label>
                <Link
                  href="/admin"
                  className="px-4 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
                >
                  ← Back to Admin
                </Link>
                <button
                  onClick={async () => {
                    await fetch('/api/admin/auth', { method: 'DELETE' });
                    window.location.href = '/admin/login';
                  }}
                  className="px-4 py-2 text-sm border border-weathered text-weathered hover:bg-weathered hover:text-white transition-colors"
                >
                  Logout
                </button>
              </div>
            </div>

            <Divider />

            {/* Overview Stats */}
            <div>
              <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-4">
                Performance Overview
              </h2>
              <div className="grid md:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="p-6 border border-dust bg-white">
                  <div className="text-sm text-saddle mb-1">Total Consumers</div>
                  <div className="text-3xl font-[family-name:var(--font-serif)]">
                    {data.overview.totalConsumers}
                  </div>
                </div>
                <div className="p-6 border border-dust bg-white">
                  <div className="text-sm text-saddle mb-1">Total Inquiries</div>
                  <div className="text-3xl font-[family-name:var(--font-serif)]">
                    {data.overview.totalInquiries}
                  </div>
                </div>
                <div className="p-6 border border-dust bg-white">
                  <div className="text-sm text-saddle mb-1">Sales Closed</div>
                  <div className="text-3xl font-[family-name:var(--font-serif)]">
                    {data.overview.totalSales}
                  </div>
                </div>
                <div className="p-6 border border-charcoal bg-white">
                  <div className="text-sm text-saddle mb-1">Total Revenue</div>
                  <div className="text-2xl font-[family-name:var(--font-serif)]">
                    {formatCurrency(data.overview.totalRevenue)}
                  </div>
                </div>
                <div className="p-6 border border-charcoal bg-white">
                  <div className="text-sm text-saddle mb-1">Your Commission</div>
                  <div className="text-2xl font-[family-name:var(--font-serif)]">
                    {formatCurrency(data.overview.totalCommission)}
                  </div>
                </div>
                <div className="p-6 border border-dust bg-white">
                  <div className="text-sm text-saddle mb-1">Conversion Rate</div>
                  <div className="text-3xl font-[family-name:var(--font-serif)]">
                    {formatPercent(data.overview.conversionRate)}
                  </div>
                </div>
              </div>
            </div>

            <Divider />

            {/* Campaign Performance Table */}
            <div>
              <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-4">
                Campaign Performance
              </h2>
              {data.campaigns.length === 0 ? (
                <div className="p-8 border border-dust bg-white text-center text-saddle">
                  No campaign data yet. Send your first broadcast email to start tracking!
                </div>
              ) : (
                <div className="overflow-x-auto border border-dust">
                  <table className="w-full bg-white">
                    <thead>
                      <tr className="border-b border-dust bg-bone">
                        <th className="text-left p-4 font-medium">Campaign</th>
                        <th className="text-right p-4 font-medium">Emails</th>
                        <th className="text-right p-4 font-medium">Sign-ups</th>
                        <th className="text-right p-4 font-medium">Inquiries</th>
                        <th className="text-right p-4 font-medium">Sales</th>
                        <th className="text-right p-4 font-medium">Revenue</th>
                        <th className="text-right p-4 font-medium">Commission</th>
                        <th className="text-right p-4 font-medium">ROI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.campaigns.map((campaign, idx) => {
                        const roi = campaign.emailsSent > 0 
                          ? (campaign.totalCommission / campaign.emailsSent) 
                          : 0;
                        
                        return (
                          <tr key={idx} className="border-b border-dust hover:bg-bone">
                            <td className="p-4 font-medium">{campaign.campaignName}</td>
                            <td className="p-4 text-right">{campaign.emailsSent}</td>
                            <td className="p-4 text-right">{campaign.signUps}</td>
                            <td className="p-4 text-right">{campaign.inquiries}</td>
                            <td className="p-4 text-right">{campaign.sales}</td>
                            <td className="p-4 text-right">{formatCurrency(campaign.totalRevenue)}</td>
                            <td className="p-4 text-right font-semibold">{formatCurrency(campaign.totalCommission)}</td>
                            <td className="p-4 text-right text-sm text-saddle">
                              {formatCurrency(roi)}/email
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <Divider />

            {/* P1 audit D-5: per-Source attribution breakdown */}
            <div>
              <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-2">
                Source Attribution
              </h2>
              <p className="text-sm text-saddle mb-4">
                Funnel by Consumer Source — organic vs rancher-page vs partner-XXX vs exit-intent.
                Closest signal to per-channel CAC w/o paid-ad spend integration.
              </p>
              {!data.sourceBreakdown || data.sourceBreakdown.length === 0 ? (
                <div className="p-8 border border-dust bg-white text-center text-saddle">
                  No source data in this range.
                </div>
              ) : (
                <div className="overflow-x-auto border border-dust">
                  <table className="w-full bg-white">
                    <thead>
                      <tr className="border-b border-dust bg-bone">
                        <th className="text-left p-4 font-medium">Source</th>
                        <th className="text-right p-4 font-medium">Signups</th>
                        <th className="text-right p-4 font-medium">Matches</th>
                        <th className="text-right p-4 font-medium">Closes</th>
                        <th className="text-right p-4 font-medium">Commission $</th>
                        <th className="text-right p-4 font-medium">Conv %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sourceBreakdown.map((s, idx) => {
                        const convRate = s.signups > 0 ? s.closes / s.signups : 0;
                        return (
                          <tr key={idx} className="border-b border-dust hover:bg-bone">
                            <td className="p-4 font-medium">{s.source}</td>
                            <td className="p-4 text-right">{s.signups}</td>
                            <td className="p-4 text-right">{s.matches}</td>
                            <td className="p-4 text-right">{s.closes}</td>
                            <td className="p-4 text-right font-semibold">{formatCurrency(s.commissionDue)}</td>
                            <td className="p-4 text-right text-sm text-saddle">{formatPercent(convRate)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <Divider />

            {/* Recent Activity Feed */}
            <div>
              <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-4">
                Recent Activity
              </h2>
              {data.recentActivity.length === 0 ? (
                <div className="p-8 border border-dust bg-white text-center text-saddle">
                  No recent activity.
                </div>
              ) : (
                <div className="space-y-3">
                  {data.recentActivity.map((activity, idx) => {
                    const icon = activity.type === 'signup' ? '👤' : activity.type === 'inquiry' ? '📧' : '💰';
                    const bgColor = activity.type === 'sale' ? 'bg-charcoal text-white' : 'bg-white';
                    
                    return (
                      <div key={idx} className={`p-4 border border-dust ${bgColor}`}>
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <span className="text-2xl">{icon}</span>
                            <div>
                              <div className="font-medium">
                                {activity.type === 'signup' && `New Sign-up: ${activity.name}`}
                                {activity.type === 'inquiry' && `New Inquiry: ${activity.name}`}
                                {activity.type === 'sale' && `Sale Completed: ${activity.name}`}
                              </div>
                              <div className={`text-sm ${activity.type === 'sale' ? 'text-dust/60' : 'text-saddle'}`}>
                                {activity.details}
                              </div>
                              <div className={`text-xs mt-1 ${activity.type === 'sale' ? 'text-dust' : 'text-dust'}`}>
                                Source: {activity.source || 'organic'}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            {activity.amount && (
                              <div className="font-semibold mb-1">
                                {formatCurrency(activity.amount)}
                              </div>
                            )}
                            <div className={`text-xs ${activity.type === 'sale' ? 'text-dust' : 'text-dust'}`}>
                              {formatDate(activity.date)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Referral Analytics */}
            {(data as any).referralStats && (
              <>
                <Divider />
                <div>
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-4">
                    Referral Pipeline
                  </h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="p-4 border border-dust bg-white text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)]">{(data as any).referralStats.total}</div>
                      <div className="text-xs text-saddle">Total Referrals</div>
                    </div>
                    <div className="p-4 border border-amber/60 bg-amber/10 text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)] text-amber-dark">{(data as any).referralStats.pending}</div>
                      <div className="text-xs text-amber-dark">Pending Approval</div>
                    </div>
                    <div className="p-4 border border-sage/40 bg-sage/10 text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)] text-sage-dark">{(data as any).referralStats.closedWon}</div>
                      <div className="text-xs text-sage-dark">Closed Won</div>
                    </div>
                    <div className="p-4 border border-dust bg-white text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)]">{(data as any).referralStats.avgDaysToClose}d</div>
                      <div className="text-xs text-saddle">Avg Days to Close</div>
                    </div>
                  </div>

                  {(data as any).referralStats.revenueByState.length > 0 && (
                    <div className="mb-6">
                      <h3 className="text-lg font-medium mb-3">Revenue by State</h3>
                      <div className="space-y-2">
                        {(data as any).referralStats.revenueByState.slice(0, 10).map((s: any) => (
                          <div key={s.state} className="flex items-center justify-between p-3 border border-dust bg-white">
                            <span className="font-medium">{s.state}</span>
                            <span className="font-[family-name:var(--font-serif)]">{formatCurrency(s.revenue)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 className="text-lg font-medium mb-3">Intent Score Correlation</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 border border-sage/40 bg-sage/10">
                        <div className="text-sm text-sage-dark font-medium">High Intent</div>
                        <div className="text-2xl font-[family-name:var(--font-serif)] text-sage-dark">
                          {((data as any).referralStats.intentCorrelation.high.rate * 100).toFixed(0)}%
                        </div>
                        <div className="text-xs text-sage-dark">
                          {(data as any).referralStats.intentCorrelation.high.closed}/{(data as any).referralStats.intentCorrelation.high.total} closed
                        </div>
                      </div>
                      <div className="p-4 border border-amber/60 bg-amber/10">
                        <div className="text-sm text-amber-dark font-medium">Medium Intent</div>
                        <div className="text-2xl font-[family-name:var(--font-serif)] text-amber-dark">
                          {((data as any).referralStats.intentCorrelation.medium.rate * 100).toFixed(0)}%
                        </div>
                        <div className="text-xs text-amber-dark">
                          {(data as any).referralStats.intentCorrelation.medium.closed}/{(data as any).referralStats.intentCorrelation.medium.total} closed
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Quick Actions */}
            <div className="pt-8">
              <div className="flex flex-wrap gap-4 justify-center">
                <Link
                  href="/admin/referrals"
                  className="px-6 py-3 bg-charcoal text-bone hover:bg-divider transition-colors"
                >
                  Referral Queue
                </Link>
                <Link
                  href="/admin/commissions"
                  className="px-6 py-3 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
                >
                  Commission Ledger
                </Link>
                <Link
                  href="/admin/heatmap"
                  className="px-6 py-3 border border-dust hover:bg-dust transition-colors"
                >
                  State Heatmap
                </Link>
                <Link
                  href="/admin/broadcast"
                  className="px-6 py-3 border border-dust hover:bg-dust transition-colors"
                >
                  Broadcast Email
                </Link>
              </div>
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}


