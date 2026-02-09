'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';
import ContactRancherButton from '../components/ContactRancherButton';
import Link from 'next/link';

interface Rancher {
  id: string;
  ranch_name: string;
  operator_name: string;
  email: string;
  phone: string;
  state: string;
  beef_types: string;
  monthly_capacity: number;
  certifications: string;
  certified: boolean;
}

interface LandDeal {
  id: string;
  property_location: string;
  state: string;
  acreage: number;
  asking_price: string;
  property_type: string;
  description: string;
}

interface Brand {
  id: string;
  brand_name: string;
  product_type: string;
  website: string;
  promotion_details: string;
  discount_offered: number;
}

interface MemberData {
  isMember: boolean;
  userState?: string;
  ranchers: Rancher[];
  landDeals: LandDeal[];
  brands: Brand[];
}

export default function MemberPage() {
  const [memberData, setMemberData] = useState<MemberData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchMemberContent();
  }, []);

  const fetchMemberContent = async () => {
    try {
      const response = await fetch('/api/member/content');
      const data = await response.json();
      
      // Temporary test override: treat as member
      setMemberData({
        isMember: true,
        userState: 'TX',
        ranchers: data.ranchers || [],
        landDeals: data.landDeals || [],
        brands: data.brands || [],
      });
      setLoading(false);
    } catch (err) {
      setError('Failed to load member content');
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="text-center">
            <p className="text-lg text-[#6B4F3F]">Loading...</p>
          </div>
        </Container>
      </main>
    );
  }

  // PAYWALL - Show if not a member
  if (!memberData?.isMember) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-8">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              Members Only
            </h1>
            <Divider />
            <p className="text-xl leading-relaxed text-[#6B4F3F]">
              This area is reserved for verified BuyHalfCow members.
            </p>
            <div className="space-y-4 text-lg leading-relaxed">
              <p>As a member, you get exclusive access to:</p>
              <ul className="text-left max-w-md mx-auto space-y-2">
                <li>✓ Certified ranchers in your state</li>
                <li>✓ Private land deals</li>
                <li>✓ Exclusive brand promotions</li>
                <li>✓ Weekly member updates</li>
              </ul>
            </div>
            <Divider />
            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
              <Button href="/access">Apply for Access</Button>
              <Button href="/" variant="secondary">Back to Home</Button>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  // MEMBER DASHBOARD - Show if authenticated
  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="space-y-16">
          {/* Header */}
          <div className="text-center space-y-6">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              Member Dashboard
            </h1>
            <Divider />
            <p className="text-lg text-[#6B4F3F]">
              Your state: <span className="font-medium text-[#0E0E0E]">{memberData.userState || 'Not set'}</span>
            </p>
          </div>

          {/* Certified Ranchers in Your State */}
          <section className="space-y-8">
            <div className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                Certified Ranchers in {memberData.userState}
              </h2>
              <p className="text-[#6B4F3F] leading-relaxed">
                These ranchers have been verified and certified by BuyHalfCow.
              </p>
            </div>

            {memberData.ranchers.length === 0 ? (
              <div className="p-8 border border-[#A7A29A] text-center">
                <p className="text-[#6B4F3F]">
                  No certified ranchers in your state yet. Check back soon.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {memberData.ranchers.map((rancher) => (
                  <div key={rancher.id} className="p-6 border border-[#A7A29A] space-y-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-[family-name:var(--font-serif)] text-2xl">
                          {rancher.ranch_name}
                        </h3>
                        <p className="text-[#6B4F3F]">Operator: {rancher.operator_name}</p>
                      </div>
                      {rancher.certified && (
                        <span className="px-3 py-1 bg-[#0E0E0E] text-[#F4F1EC] text-sm">
                          CERTIFIED
                        </span>
                      )}
                    </div>
                    <Divider />
                    <div className="grid md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-[#6B4F3F]">Location:</span> {rancher.state}
                      </div>
                      <div>
                        <span className="text-[#6B4F3F]">Capacity:</span> {rancher.monthly_capacity} head/month
                      </div>
                      <div className="md:col-span-2">
                        <span className="text-[#6B4F3F]">Beef Types:</span> {rancher.beef_types}
                      </div>
                      {rancher.certifications && (
                        <div className="md:col-span-2">
                          <span className="text-[#6B4F3F]">Certifications:</span> {rancher.certifications}
                        </div>
                      )}
                    </div>
                    <div className="pt-4">
                      <ContactRancherButton rancher={rancher} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Divider />

          {/* Land Deals */}
          <section className="space-y-8">
            <div className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                Exclusive Land Deals
              </h2>
              <p className="text-[#6B4F3F] leading-relaxed">
                Private opportunities available only to BuyHalfCow members.
              </p>
            </div>

            {memberData.landDeals.length === 0 ? (
              <div className="p-8 border border-[#A7A29A] text-center">
                <p className="text-[#6B4F3F]">
                  No land deals available at this time. Check back soon.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {memberData.landDeals.map((deal) => (
                  <div key={deal.id} className="p-6 border border-[#A7A29A] space-y-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-[family-name:var(--font-serif)] text-2xl">
                          {deal.acreage} Acres — {deal.property_location}
                        </h3>
                        <p className="text-[#6B4F3F]">{deal.state}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-[family-name:var(--font-serif)] text-xl">
                          {deal.asking_price}
                        </p>
                      </div>
                    </div>
                    <Divider />
                    <div className="space-y-2">
                      <p className="text-sm">
                        <span className="text-[#6B4F3F]">Type:</span> {deal.property_type}
                      </p>
                      <p className="leading-relaxed">{deal.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Divider />

          {/* Brand Promotions */}
          <section className="space-y-8">
            <div className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                Member Promotions
              </h2>
              <p className="text-[#6B4F3F] leading-relaxed">
                Exclusive discounts from our trusted brand partners.
              </p>
            </div>

            {memberData.brands.length === 0 ? (
              <div className="p-8 border border-[#A7A29A] text-center">
                <p className="text-[#6B4F3F]">
                  No active promotions at this time. Check back soon.
                </p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-6">
                {memberData.brands.map((brand) => (
                  <div key={brand.id} className="p-6 border border-[#A7A29A] space-y-4">
                    <h3 className="font-[family-name:var(--font-serif)] text-2xl">
                      {brand.brand_name}
                    </h3>
                    <p className="text-sm text-[#6B4F3F]">{brand.product_type}</p>
                    <Divider />
                    <p className="leading-relaxed">{brand.promotion_details}</p>
                    <div className="pt-2">
                      <span className="inline-block px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] font-medium">
                        {brand.discount_offered}% OFF
                      </span>
                    </div>
                    {brand.website && (
                      <a
                        href={brand.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors text-sm"
                      >
                        Visit Website →
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <Divider />

          <div className="text-center">
            <Link href="/" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}

