'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';
import AdminAuthGuard from '../components/AdminAuthGuard';

type Tab = 'consumers' | 'ranchers' | 'brands' | 'landDeals';

interface Consumer {
  id: string;
  first_name: string;
  email: string;
  phone: string;
  state: string;
  interests: string[];
  status: string;
  membership: string;
  created_at: string;
}

interface Rancher {
  id: string;
  ranch_name: string;
  operator_name: string;
  email: string;
  phone: string;
  state: string;
  beef_types: string;
  status: string;
  certified: boolean;
  ranch_tour_interested?: boolean;
  ranch_tour_availability?: string;
  created_at: string;
}

interface Brand {
  id: string;
  brand_name: string;
  contact_name: string;
  email: string;
  product_type: string;
  discount_offered: number;
  status: string;
  active: boolean;
  created_at: string;
}

interface LandDeal {
  id: string;
  seller_name: string;
  property_location: string;
  state: string;
  acreage: number;
  asking_price: string;
  status: string;
  visible_to_members: boolean;
  created_at: string;
}

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<Tab>('consumers');
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [ranchers, setRanchers] = useState<Rancher[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [landDeals, setLandDeals] = useState<LandDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [rancherStateFilter, setRancherStateFilter] = useState<string>('');
  const [consumerStateFilter, setConsumerStateFilter] = useState<string>('');

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const [consumersRes, ranchersRes, brandsRes, landDealsRes] = await Promise.all([
        fetch('/api/admin/consumers'),
        fetch('/api/admin/ranchers'),
        fetch('/api/admin/brands'),
        fetch('/api/admin/landDeals'),
      ]);

      const [consumersData, ranchersData, brandsData, landDealsData] = await Promise.all([
        consumersRes.json(),
        ranchersRes.json(),
        brandsRes.json(),
        landDealsRes.json(),
      ]);

      setConsumers(consumersData);
      setRanchers(ranchersData);
      setBrands(brandsData);
      setLandDeals(landDealsData);
    } catch (error) {
      console.error('Error fetching admin data:', error);
    }
    setLoading(false);
  };

  const updateConsumerStatus = async (id: string, status: string, membership: string) => {
    try {
      await fetch(`/api/admin/consumers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, membership }),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating consumer:', error);
    }
  };

  const updateRancherStatus = async (id: string, status: string, certified: boolean, callScheduled?: boolean) => {
    try {
      const body: any = { status, certified };
      if (callScheduled !== undefined) {
        body.call_scheduled = callScheduled;
      }
      await fetch(`/api/admin/ranchers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating rancher:', error);
    }
  };

  const updateBrandStatus = async (id: string, status: string, active: boolean) => {
    try {
      await fetch(`/api/admin/brands/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, active }),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating brand:', error);
    }
  };

  const updateLandDealStatus = async (id: string, status: string, visible: boolean) => {
    try {
      await fetch(`/api/admin/landDeals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, visible_to_members: visible }),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating land deal:', error);
    }
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <div className="text-center"><p className="text-lg text-[#6B4F3F]">Loading admin dashboard...</p>
            </div>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="flex justify-between items-start mb-8">
            <div className="text-left space-y-4">
              <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                Admin Dashboard
              </h1>
            </div>
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

          <div className="text-center space-y-4">
            <p className="text-sm text-[#6B4F3F]">Internal CRM — BuyHalfCow</p>
          </div>

          <Divider />

          {/* Stats Overview */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{consumers.length}</div>
              <div className="text-sm text-[#6B4F3F]">Consumers</div>
            </div>
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{ranchers.length}</div>
              <div className="text-sm text-[#6B4F3F]">Ranchers</div>
            </div>
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{brands.length}</div>
              <div className="text-sm text-[#6B4F3F]">Brands</div>
            </div>
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{landDeals.length}</div>
              <div className="text-sm text-[#6B4F3F]">Land Deals</div>
            </div>
          </div>

          {/* Action Links */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Button href="/admin/broadcast" variant="secondary">
              📧 Send Broadcast Email
            </Button>
            <Button href="/admin/analytics" variant="secondary">
              📊 View Analytics & ROI
            </Button>
            <Button href="/admin/inquiries" variant="secondary">
              💰 Manage Inquiries
            </Button>
          </div>

          {/* Tab Navigation */}
          <div className="flex flex-wrap gap-2 border-b border-[#A7A29A]">
            <button
              onClick={() => setActiveTab('consumers')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'consumers'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Consumers
            </button>
            <button
              onClick={() => setActiveTab('ranchers')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'ranchers'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Ranchers
            </button>
            <button
              onClick={() => setActiveTab('brands')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'brands'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Brands
            </button>
            <button
              onClick={() => setActiveTab('landDeals')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'landDeals'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Land Deals
            </button>
          </div>

          {/* Tab Content */}
          <div className="mt-8">
            {/* CONSUMERS TAB */}
            {activeTab === 'consumers' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl">Consumer Applications</h2>
                  
                  <div className="flex items-center gap-3">
                    <select
                      value={consumerStateFilter}
                      onChange={(e) => setConsumerStateFilter(e.target.value)}
                      className="px-4 py-2 border-2 border-[#0E0E0E] bg-[#F4F1EC] text-sm font-medium"
                    >
                      <option value="">All States ({consumers.length})</option>
                      {Array.from(new Set(consumers.map(c => c.state).filter(Boolean))).sort().map(state => {
                        const count = consumers.filter(c => c.state === state).length;
                        return <option key={state} value={state}>{state} ({count})</option>;
                      })}
                    </select>
                    
                    {consumerStateFilter && (
                      <button
                        onClick={async () => {
                          const filtered = consumers.filter(c => c.state === consumerStateFilter && c.status === 'pending');
                          if (filtered.length === 0) {
                            alert('No pending consumers in this state');
                            return;
                          }
                          if (!confirm(`Approve ${filtered.length} pending consumer(s) in ${consumerStateFilter}?`)) return;
                          for (const consumer of filtered) {
                            await updateConsumerStatus(consumer.id, 'approved', consumer.membership);
                          }
                          fetchAllData();
                        }}
                        className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] text-sm font-medium whitespace-nowrap"
                      >
                        ✓ Approve All Pending
                      </button>
                    )}
                  </div>
                </div>
                
                {consumers.length === 0 ? (
                  <p className="text-[#6B4F3F]">No consumers yet.</p>
                ) : (
                  <>
                    {consumerStateFilter && (
                      <p className="text-sm text-[#6B4F3F] mb-4">
                        Showing {consumers.filter(c => c.state === consumerStateFilter).length} consumer(s) in {consumerStateFilter}
                      </p>
                    )}
                    <div className="space-y-4">
                      {consumers
                        .filter(c => !consumerStateFilter || c.state === consumerStateFilter)
                        .map((consumer) => (
                      <div key={consumer.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <h3 className="font-medium text-lg">{consumer.first_name}</h3>
                            <p className="text-sm text-[#6B4F3F]">{consumer.email} · {consumer.phone}</p>
                            <p className="text-sm">State: {consumer.state}</p>
                            <p className="text-sm">Interests: {consumer.interests?.join(', ') || 'N/A'}</p>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <select
                              value={consumer.status}
                              onChange={(e) => updateConsumerStatus(consumer.id, e.target.value, consumer.membership)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <select
                              value={consumer.membership}
                              onChange={(e) => updateConsumerStatus(consumer.id, consumer.status, e.target.value)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="none">No Access</option>
                              <option value="active">Active Member</option>
                              <option value="inactive">Inactive</option>
                            </select>
                          </div>
                        </div>
                        <p className="text-xs text-[#6B4F3F]">
                          Applied: {new Date(consumer.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* RANCHERS TAB */}
            {activeTab === 'ranchers' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl">Rancher Applications</h2>
                  
                  <div className="flex items-center gap-3">
                    <select
                      value={rancherStateFilter}
                      onChange={(e) => setRancherStateFilter(e.target.value)}
                      className="px-4 py-2 border-2 border-[#0E0E0E] bg-[#F4F1EC] text-sm font-medium"
                    >
                      <option value="">All States ({ranchers.length})</option>
                      {Array.from(new Set(ranchers.map(r => r.state).filter(Boolean))).sort().map(state => {
                        const count = ranchers.filter(r => r.state === state).length;
                        return <option key={state} value={state}>{state} ({count})</option>;
                      })}
                    </select>
                    
                    {rancherStateFilter && (
                      <>
                        <button
                          onClick={async () => {
                            const filtered = ranchers.filter(r => r.state === rancherStateFilter && r.status === 'pending');
                            if (filtered.length === 0) {
                              alert('No pending ranchers in this state');
                              return;
                            }
                            if (!confirm(`Approve ${filtered.length} pending rancher(s) in ${rancherStateFilter}?`)) return;
                            for (const rancher of filtered) {
                              await updateRancherStatus(rancher.id, 'approved', rancher.certified);
                            }
                            fetchAllData();
                          }}
                          className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] text-sm font-medium whitespace-nowrap"
                        >
                          ✓ Approve All Pending
                        </button>
                        <button
                          onClick={async () => {
                            const filtered = ranchers.filter(r => r.state === rancherStateFilter && r.status === 'approved' && !r.certified);
                            if (filtered.length === 0) {
                              alert('No uncertified approved ranchers in this state');
                              return;
                            }
                            if (!confirm(`Certify ${filtered.length} rancher(s) in ${rancherStateFilter}?`)) return;
                            for (const rancher of filtered) {
                              await updateRancherStatus(rancher.id, 'approved', true);
                            }
                            fetchAllData();
                          }}
                          className="px-4 py-2 bg-transparent text-[#0E0E0E] border-2 border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] text-sm font-medium whitespace-nowrap"
                        >
                          🏅 Certify All Approved
                        </button>
                      </>
                    )}
                  </div>
                </div>
                
                {ranchers.length === 0 ? (
                  <p className="text-[#6B4F3F]">No rancher applications yet.</p>
                ) : (
                  <>
                    {rancherStateFilter && (
                      <p className="text-sm text-[#6B4F3F] mb-4">
                        Showing {ranchers.filter(r => r.state === rancherStateFilter).length} rancher(s) in {rancherStateFilter}
                      </p>
                    )}
                    <div className="space-y-4">
                      {ranchers
                        .filter(r => !rancherStateFilter || r.state === rancherStateFilter)
                        .map((rancher) => (
                      <div key={rancher.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="flex-1 min-w-[200px]">
                            <h3 className="font-medium text-lg">{rancher.ranch_name}</h3>
                            <p className="text-sm text-[#6B4F3F]">Operator: {rancher.operator_name}</p>
                            <p className="text-sm">{rancher.email} · {rancher.phone}</p>
                            <p className="text-sm">State: {rancher.state}</p>
                            <p className="text-sm">Beef Types: {rancher.beef_types}</p>
                            {(rancher as any).call_scheduled && (
                              <p className="text-xs mt-2 px-2 py-1 bg-green-50 border border-green-600 text-green-700 inline-block">
                                ✓ Call Scheduled via Calendly
                              </p>
                            )}
                            {rancher.ranch_tour_interested && (
                              <p className="text-xs mt-2 text-[#8C2F2F]">
                                🤠 Interested in ranch tour
                                {rancher.ranch_tour_availability && `: ${rancher.ranch_tour_availability}`}
                              </p>
                            )}
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <select
                              value={rancher.status}
                              onChange={(e) => updateRancherStatus(rancher.id, e.target.value, rancher.certified)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <button
                              onClick={() => updateRancherStatus(rancher.id, rancher.status, !rancher.certified)}
                              className={`px-3 py-1 text-sm border ${
                                rancher.certified
                                  ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]'
                                  : 'bg-transparent text-[#0E0E0E] border-[#A7A29A]'
                              }`}
                            >
                              {rancher.certified ? 'CERTIFIED' : 'Not Certified'}
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 pt-2">
                          <p className="text-xs text-[#6B4F3F]">
                            Applied: {new Date(rancher.created_at).toLocaleDateString()}
                          </p>
                          {!(rancher as any).call_scheduled && (
                            <button
                              onClick={() => updateRancherStatus(rancher.id, rancher.status, rancher.certified, true)}
                              className="px-3 py-1 text-xs border bg-transparent text-[#0E0E0E] border-[#A7A29A] hover:bg-[#A7A29A]"
                            >
                              Mark Call Completed
                            </button>
                          )}
                        </div>
                      </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* BRANDS TAB */}
            {activeTab === 'brands' && (
              <div className="space-y-4">
                <h2 className="font-[family-name:var(--font-serif)] text-2xl">Brand Partnerships</h2>
                {brands.length === 0 ? (
                  <p className="text-[#6B4F3F]">No brand applications yet.</p>
                ) : (
                  <div className="space-y-4">
                    {brands.map((brand) => (
                      <div key={brand.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <h3 className="font-medium text-lg">{brand.brand_name}</h3>
                            <p className="text-sm text-[#6B4F3F]">Contact: {brand.contact_name}</p>
                            <p className="text-sm">{brand.email}</p>
                            <p className="text-sm">Product: {brand.product_type}</p>
                            <p className="text-sm">Discount: {brand.discount_offered}%</p>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <select
                              value={brand.status}
                              onChange={(e) => updateBrandStatus(brand.id, e.target.value, brand.active)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <button
                              onClick={() => updateBrandStatus(brand.id, brand.status, !brand.active)}
                              className={`px-3 py-1 text-sm border ${
                                brand.active
                                  ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]'
                                  : 'bg-transparent text-[#0E0E0E] border-[#A7A29A]'
                              }`}
                            >
                              {brand.active ? 'ACTIVE' : 'Inactive'}
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-[#6B4F3F]">
                          Applied: {new Date(brand.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* LAND DEALS TAB */}
            {activeTab === 'landDeals' && (
              <div className="space-y-4">
                <h2 className="font-[family-name:var(--font-serif)] text-2xl">Land Deal Submissions</h2>
                {landDeals.length === 0 ? (
                  <p className="text-[#6B4F3F]">No land deals submitted yet.</p>
                ) : (
                  <div className="space-y-4">
                    {landDeals.map((deal) => (
                      <div key={deal.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <h3 className="font-medium text-lg">
                              {deal.acreage} Acres — {deal.property_location}, {deal.state}
                            </h3>
                            <p className="text-sm text-[#6B4F3F]">Seller: {deal.seller_name}</p>
                            <p className="text-sm font-medium">{deal.asking_price}</p>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <select
                              value={deal.status}
                              onChange={(e) => updateLandDealStatus(deal.id, e.target.value, deal.visible_to_members)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <button
                              onClick={() => updateLandDealStatus(deal.id, deal.status, !deal.visible_to_members)}
                              className={`px-3 py-1 text-sm border ${
                                deal.visible_to_members
                                  ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]'
                                  : 'bg-transparent text-[#0E0E0E] border-[#A7A29A]'
                              }`}
                            >
                              {deal.visible_to_members ? 'VISIBLE' : 'Hidden'}
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-[#6B4F3F]">
                          Submitted: {new Date(deal.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Container>
    </main>
    </AdminAuthGuard>
  );
}

