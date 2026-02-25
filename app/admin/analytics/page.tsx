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

interface AnalyticsData {
  overview: {
    totalConsumers: number;
    totalInquiries: number;
    totalSales: number;
    totalRevenue: number;
    totalCommission: number;
    conversionRate: number;
  };
  campaigns: CampaignStats[];
  recentActivity: {
    type: 'signup' | 'inquiry' | 'sale';
    name: string;
    details: string;
    source: string;
    amount?: number;
    date: string;
  }[];
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      const response = await fetch('/api/admin/analytics');
      const analyticsData = await response.json();
      setData(analyticsData);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching analytics:', err);
      setLoading(false);
    }
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
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
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
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <p className="text-center">Failed to load analytics.</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="space-y-8">
            {/* Header */}
            <div className="flex justify-between items-start">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-4xl mb-2">
                  Analytics & Attribution
                </h1>
                <p className="text-[#6B4F3F]">
                  Track campaign performance and revenue
                </p>
              </div>
              <div className="flex gap-2">
                <Link
                  href="/admin"
                  className="px-4 py-2 border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
                >
                  ← Back to Admin
                </Link>
                <button
                  onClick={async () => {
                    await fetch('/api/admin/auth', { method: 'DELETE' });
                    window.location.href = '/admin/login';
                  }}
                  className="px-4 py-2 text-sm border border-[#8C2F2F] text-[#8C2F2F] hover:bg-[#8C2F2F] hover:text-white transition-colors"
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
                <div className="p-6 border border-[#A7A29A] bg-white">
                  <div className="text-sm text-[#6B4F3F] mb-1">Total Consumers</div>
                  <div className="text-3xl font-[family-name:var(--font-serif)]">
                    {data.overview.totalConsumers}
                  </div>
                </div>
                <div className="p-6 border border-[#A7A29A] bg-white">
                  <div className="text-sm text-[#6B4F3F] mb-1">Total Inquiries</div>
                  <div className="text-3xl font-[family-name:var(--font-serif)]">
                    {data.overview.totalInquiries}
                  </div>
                </div>
                <div className="p-6 border border-[#A7A29A] bg-white">
                  <div className="text-sm text-[#6B4F3F] mb-1">Sales Closed</div>
                  <div className="text-3xl font-[family-name:var(--font-serif)]">
                    {data.overview.totalSales}
                  </div>
                </div>
                <div className="p-6 border border-[#0E0E0E] bg-white">
                  <div className="text-sm text-[#6B4F3F] mb-1">Total Revenue</div>
                  <div className="text-2xl font-[family-name:var(--font-serif)]">
                    {formatCurrency(data.overview.totalRevenue)}
                  </div>
                </div>
                <div className="p-6 border border-[#0E0E0E] bg-white">
                  <div className="text-sm text-[#6B4F3F] mb-1">Your Commission</div>
                  <div className="text-2xl font-[family-name:var(--font-serif)]">
                    {formatCurrency(data.overview.totalCommission)}
                  </div>
                </div>
                <div className="p-6 border border-[#A7A29A] bg-white">
                  <div className="text-sm text-[#6B4F3F] mb-1">Conversion Rate</div>
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
                <div className="p-8 border border-[#A7A29A] bg-white text-center text-[#6B4F3F]">
                  No campaign data yet. Send your first broadcast email to start tracking!
                </div>
              ) : (
                <div className="overflow-x-auto border border-[#A7A29A]">
                  <table className="w-full bg-white">
                    <thead>
                      <tr className="border-b border-[#A7A29A] bg-[#F4F1EC]">
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
                          <tr key={idx} className="border-b border-[#A7A29A] hover:bg-[#F4F1EC]">
                            <td className="p-4 font-medium">{campaign.campaignName}</td>
                            <td className="p-4 text-right">{campaign.emailsSent}</td>
                            <td className="p-4 text-right">{campaign.signUps}</td>
                            <td className="p-4 text-right">{campaign.inquiries}</td>
                            <td className="p-4 text-right">{campaign.sales}</td>
                            <td className="p-4 text-right">{formatCurrency(campaign.totalRevenue)}</td>
                            <td className="p-4 text-right font-semibold">{formatCurrency(campaign.totalCommission)}</td>
                            <td className="p-4 text-right text-sm text-[#6B4F3F]">
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

            {/* Recent Activity Feed */}
            <div>
              <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-4">
                Recent Activity
              </h2>
              {data.recentActivity.length === 0 ? (
                <div className="p-8 border border-[#A7A29A] bg-white text-center text-[#6B4F3F]">
                  No recent activity.
                </div>
              ) : (
                <div className="space-y-3">
                  {data.recentActivity.map((activity, idx) => {
                    const icon = activity.type === 'signup' ? '👤' : activity.type === 'inquiry' ? '📧' : '💰';
                    const bgColor = activity.type === 'sale' ? 'bg-[#0E0E0E] text-white' : 'bg-white';
                    
                    return (
                      <div key={idx} className={`p-4 border border-[#A7A29A] ${bgColor}`}>
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <span className="text-2xl">{icon}</span>
                            <div>
                              <div className="font-medium">
                                {activity.type === 'signup' && `New Sign-up: ${activity.name}`}
                                {activity.type === 'inquiry' && `New Inquiry: ${activity.name}`}
                                {activity.type === 'sale' && `Sale Completed: ${activity.name}`}
                              </div>
                              <div className={`text-sm ${activity.type === 'sale' ? 'text-gray-300' : 'text-[#6B4F3F]'}`}>
                                {activity.details}
                              </div>
                              <div className={`text-xs mt-1 ${activity.type === 'sale' ? 'text-gray-400' : 'text-[#A7A29A]'}`}>
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
                            <div className={`text-xs ${activity.type === 'sale' ? 'text-gray-400' : 'text-[#A7A29A]'}`}>
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
                    <div className="p-4 border border-[#A7A29A] bg-white text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)]">{(data as any).referralStats.total}</div>
                      <div className="text-xs text-[#6B4F3F]">Total Referrals</div>
                    </div>
                    <div className="p-4 border border-yellow-300 bg-yellow-50 text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)] text-yellow-700">{(data as any).referralStats.pending}</div>
                      <div className="text-xs text-yellow-700">Pending Approval</div>
                    </div>
                    <div className="p-4 border border-green-300 bg-green-50 text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)] text-green-700">{(data as any).referralStats.closedWon}</div>
                      <div className="text-xs text-green-700">Closed Won</div>
                    </div>
                    <div className="p-4 border border-[#A7A29A] bg-white text-center">
                      <div className="text-2xl font-[family-name:var(--font-serif)]">{(data as any).referralStats.avgDaysToClose}d</div>
                      <div className="text-xs text-[#6B4F3F]">Avg Days to Close</div>
                    </div>
                  </div>

                  {(data as any).referralStats.revenueByState.length > 0 && (
                    <div className="mb-6">
                      <h3 className="text-lg font-medium mb-3">Revenue by State</h3>
                      <div className="space-y-2">
                        {(data as any).referralStats.revenueByState.slice(0, 10).map((s: any) => (
                          <div key={s.state} className="flex items-center justify-between p-3 border border-[#A7A29A] bg-white">
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
                      <div className="p-4 border border-green-300 bg-green-50">
                        <div className="text-sm text-green-700 font-medium">High Intent</div>
                        <div className="text-2xl font-[family-name:var(--font-serif)] text-green-800">
                          {((data as any).referralStats.intentCorrelation.high.rate * 100).toFixed(0)}%
                        </div>
                        <div className="text-xs text-green-700">
                          {(data as any).referralStats.intentCorrelation.high.closed}/{(data as any).referralStats.intentCorrelation.high.total} closed
                        </div>
                      </div>
                      <div className="p-4 border border-yellow-300 bg-yellow-50">
                        <div className="text-sm text-yellow-700 font-medium">Medium Intent</div>
                        <div className="text-2xl font-[family-name:var(--font-serif)] text-yellow-800">
                          {((data as any).referralStats.intentCorrelation.medium.rate * 100).toFixed(0)}%
                        </div>
                        <div className="text-xs text-yellow-700">
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
                  className="px-6 py-3 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors"
                >
                  Referral Queue
                </Link>
                <Link
                  href="/admin/commissions"
                  className="px-6 py-3 border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
                >
                  Commission Ledger
                </Link>
                <Link
                  href="/admin/heatmap"
                  className="px-6 py-3 border border-[#A7A29A] hover:bg-[#A7A29A] transition-colors"
                >
                  State Heatmap
                </Link>
                <Link
                  href="/admin/broadcast"
                  className="px-6 py-3 border border-[#A7A29A] hover:bg-[#A7A29A] transition-colors"
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


