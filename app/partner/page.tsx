'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Input from '../components/Input';
import Select from '../components/Select';
import Checkbox from '../components/Checkbox';
import Textarea from '../components/Textarea';
import Button from '../components/Button';
import Link from 'next/link';
import { trackEvent } from '@/lib/analytics';

type PartnerType = 'rancher' | 'brand' | 'land' | '';

const US_STATES = [
  { value: '', label: 'Select state' },
  { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' }, { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' }, { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' }, { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' }, { value: 'HI', label: 'Hawaii' }, { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' }, { value: 'IN', label: 'Indiana' }, { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' }, { value: 'KY', label: 'Kentucky' }, { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' }, { value: 'MD', label: 'Maryland' }, { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' }, { value: 'MN', label: 'Minnesota' }, { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' }, { value: 'MT', label: 'Montana' }, { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' }, { value: 'NH', label: 'New Hampshire' }, { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' }, { value: 'NY', label: 'New York' }, { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' }, { value: 'OH', label: 'Ohio' }, { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' }, { value: 'PA', label: 'Pennsylvania' }, { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' }, { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' }, { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' }, { value: 'WA', label: 'Washington' }, { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' },
];

function PartnerPageContent() {
  const [partnerType, setPartnerType] = useState<PartnerType>('');
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [ref, setRef] = useState('');

  const searchParams = useSearchParams();
  // useSearchParams() returns a fresh object on every render — depending on
  // it + calling setRef(...) loops the renderer to a freeze. Use the
  // serialized string so the effect runs only on actual URL changes, and
  // skip the setState call when the value is unchanged.
  const searchParamsString = searchParams.toString();
  useEffect(() => {
    const refFromUrl = searchParams.get('ref') || searchParams.get('aff');
    if (refFromUrl) localStorage.setItem('bhc_ref', refFromUrl);
    const next = refFromUrl || localStorage.getItem('bhc_ref') || '';
    setRef((prev) => (prev === next ? prev : next));

    // Affiliate click ping (de-duped per browser session).
    if (refFromUrl) {
      const pingKey = `bhc_ref_pinged:${refFromUrl}`;
      if (typeof window !== 'undefined' && !window.sessionStorage.getItem(pingKey)) {
        window.sessionStorage.setItem(pingKey, '1');
        fetch(`/api/affiliates/track-click?ref=${encodeURIComponent(refFromUrl)}`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsString]);

  // Rancher form data
  const [rancherData, setRancherData] = useState({
    ranchName: '',
    operatorName: '',
    email: '',
    phone: '',
    state: '',
    acreage: '',
    beefTypes: '',
    monthlyCapacity: '',
    certifications: '',
    operationDetails: '',
    callScheduled: false,
    ranchTourInterested: false,
    ranchTourAvailability: '',
    commissionAgreed: false,
  });

  // Brand form data
  const [brandData, setBrandData] = useState({
    brandName: '',
    contactName: '',
    email: '',
    phone: '',
    website: '',
    productType: '',
    promotionDetails: '',
    discountOffered: '',
    exclusivityAgreed: false,
  });

  // Land deal form data
  const [landData, setLandData] = useState({
    sellerName: '',
    email: '',
    phone: '',
    propertyLocation: '',
    state: '',
    acreage: '',
    askingPrice: '',
    propertyType: '',
    zoning: '',
    utilities: '',
    description: '',
    exclusiveToMembers: false,
  });

  const handleRancherChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;
    setRancherData(prev => ({ 
      ...prev, 
      [name]: type === 'checkbox' ? checked : value 
    }));
  };

  const handleBrandChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;
    setBrandData(prev => ({ 
      ...prev, 
      [name]: type === 'checkbox' ? checked : value 
    }));
  };

  const handleLandChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;
    setLandData(prev => ({ 
      ...prev, 
      [name]: type === 'checkbox' ? checked : value 
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!partnerType) {
      setError('Please select a partner type.');
      return;
    }

    setIsSubmitting(true);

    try {
      let payload = {};
      
      if (partnerType === 'rancher') {
        if (!rancherData.commissionAgreed) {
          setError('You must agree to the commission terms.');
          setIsSubmitting(false);
          return;
        }
        payload = { partnerType: 'rancher', ...rancherData, ref: ref || undefined };
      } else if (partnerType === 'brand') {
        if (!brandData.exclusivityAgreed) {
          setError('You must agree to the exclusivity terms.');
          setIsSubmitting(false);
          return;
        }
        payload = { partnerType: 'brand', ...brandData, ref: ref || undefined };
      } else if (partnerType === 'land') {
        payload = { partnerType: 'land', ...landData, ref: ref || undefined };
      }

      const response = await fetch('/api/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Submission failed. Please try again.');
        setIsSubmitting(false);
        return;
      }

      setIsSubmitted(true);
      // Audit 6 P0 — paid-scale tracking gap: /partner had ZERO client
      // analytics. partner_submit_success → Meta Pixel Lead. Server CAPI
      // dedupes via event_id=record.id (see /api/partners route).
      try {
        trackEvent('partner_submit_success', {
          partnerType,
          ...(data?.partner?.id ? { event_id: data.partner.id } : {}),
        });
      } catch {}
    } catch (err) {
      setError('Network error — please check your connection and try again.');
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    return (
      <main className="min-h-screen py-20 md:py-24 bg-bone text-charcoal">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-8 px-1">
            <h1 className="font-serif text-3xl md:text-5xl lowercase">
              application received
            </h1>
            <Divider />

            {partnerType === 'rancher' && (
              <>
                <div className="bg-charcoal text-bone p-6 md:p-8 space-y-5 md:space-y-6 text-left">
                  <h2 className="font-serif text-2xl md:text-3xl">
                    Next step: book a 30-minute call
                  </h2>
                  <p className="text-base md:text-lg leading-relaxed text-bone/90">
                    Your application is in. Pick a time so we can talk through
                    your operation, walk through the agreement, and get you
                    set up to take orders.
                  </p>
                  <a
                    href={process.env.NEXT_PUBLIC_CALENDLY_LINK || 'https://cal.com/ben-beauchman-1itnsg/30min'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block w-full sm:w-auto px-8 py-4 bg-bone text-charcoal hover:bg-bone-warm transition-colors duration-300 font-medium tracking-wider uppercase text-sm"
                  >
                    Schedule your call →
                  </a>
                  <p className="text-sm text-bone/70">
                    Can't find a time? Email{' '}
                    <a href="mailto:support@buyhalfcow.com" className="underline underline-offset-2">
                      support@buyhalfcow.com
                    </a>
                  </p>
                </div>
              </>
            )}

            {partnerType !== 'rancher' && (
              <>
                <p className="text-base md:text-lg leading-relaxed text-saddle">
                  Thank you for your interest in partnering with BuyHalfCow.
                </p>
                <p className="text-base md:text-lg leading-relaxed">
                  Every application is reviewed by a human. We'll be in touch
                  once we've had a chance to read it.
                </p>
              </>
            )}

            <div className="pt-8">
              <Link href="/" className="text-charcoal hover:text-saddle transition-colors">
                ← Back to home
              </Link>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-20 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-2xl mx-auto space-y-10 md:space-y-12">
          {/* Header */}
          <div className="text-center space-y-5 md:space-y-6">
            <h1 className="font-serif text-3xl md:text-5xl lowercase">
              partner with buyhalfcow
            </h1>
            <Divider />
            <p className="text-base md:text-lg leading-relaxed text-saddle">
              Every application is read by a human. We pick partners we'd
              vouch for to our own families.
            </p>
          </div>

          {/* Partner Type Selection */}
          <div className="space-y-3">
            <label htmlFor="partnerType" className="block text-sm font-medium">
              I want to partner as a <span className="text-weathered" aria-label="required">*</span>
            </label>
            <select
              id="partnerType"
              name="partnerType"
              value={partnerType}
              onChange={(e) => setPartnerType(e.target.value as PartnerType)}
              required
              className="w-full px-4 py-3 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal transition-colors text-base"
            >
              <option value="">Select partnership type</option>
              <option value="rancher">Rancher — sell beef to members</option>
              <option value="brand">Brand — promote products / merch</option>
              <option value="land">Land seller — submit exclusive deals</option>
            </select>
          </div>

          {/* Dynamic Form Based on Selection */}
          {partnerType && (
            <form onSubmit={handleSubmit} className="space-y-8">
              <Divider />

              {/* RANCHER FORM */}
              {partnerType === 'rancher' && (
                <div className="space-y-6">
                  <h2 className="font-serif text-2xl md:text-3xl lowercase">
                    rancher application
                  </h2>

                  {/* Pricing transparency block. Ranchers were signing the
                      commission checkbox below with zero pricing context on
                      this page — fixing the biggest trust gap in the funnel. */}
                  <div className="bg-bone-warm border border-dust p-4 text-sm">
                    <p className="font-serif text-base text-charcoal mb-2">How it works</p>
                    <ul className="text-saddle space-y-1">
                      <li>· Monthly subscription: <strong>$150–$500</strong> based on tier (you pick at setup)</li>
                      <li>· Commission per closed deal: <strong>0–7%</strong> (lower commission on higher tiers)</li>
                      <li>· Cancel anytime. No setup fee. No listing fee.</li>
                    </ul>
                    <p className="text-xs text-dust mt-2">
                      Full breakdown shown at setup.{' '}
                      <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-charcoal">
                        See commission terms
                      </a>
                      .
                    </p>
                  </div>

                  <Input
                    label="Ranch Name"
                    name="ranchName"
                    value={rancherData.ranchName}
                    onChange={handleRancherChange}
                    required
                  />

                  <Input
                    label="Operator Name"
                    name="operatorName"
                    value={rancherData.operatorName}
                    onChange={handleRancherChange}
                    required
                  />

                  <Input
                    label="Email"
                    type="email"
                    name="email"
                    value={rancherData.email}
                    onChange={handleRancherChange}
                    required
                  />

                  <Input
                    label="Phone"
                    type="tel"
                    name="phone"
                    value={rancherData.phone}
                    onChange={handleRancherChange}
                    required
                  />

                  <Select
                    label="State"
                    name="state"
                    value={rancherData.state}
                    onChange={handleRancherChange}
                    required
                  >
                    {US_STATES.map(state => (
                      <option key={state.value} value={state.value}>{state.label}</option>
                    ))}
                  </Select>

                  <Input
                    label="Total Acreage"
                    type="number"
                    name="acreage"
                    value={rancherData.acreage}
                    onChange={handleRancherChange}
                    required
                  />

                  <Textarea
                    label="Beef Types (e.g., Grass-fed, Wagyu, Angus)"
                    name="beefTypes"
                    value={rancherData.beefTypes}
                    onChange={handleRancherChange}
                    rows={3}
                    required
                  />

                  <Input
                    label="Monthly Capacity (head of cattle)"
                    type="number"
                    name="monthlyCapacity"
                    value={rancherData.monthlyCapacity}
                    onChange={handleRancherChange}
                    required
                  />

                  <Textarea
                    label="Certifications (e.g., USDA Organic, Certified Humane)"
                    name="certifications"
                    value={rancherData.certifications}
                    onChange={handleRancherChange}
                    rows={3}
                    placeholder="Leave blank if none"
                  />

                  <Textarea
                    label="Operation Details"
                    name="operationDetails"
                    value={rancherData.operationDetails}
                    onChange={handleRancherChange}
                    rows={4}
                    placeholder="Tell us about your ranch operations, practices, and what makes your beef special"
                  />

                  <Divider />

                  <div className="space-y-4 p-5 md:p-6 bg-white border border-dust">
                    <h3 className="font-medium text-lg">Ranch tour & verification</h3>
                    <p className="text-sm text-saddle leading-relaxed">
                      We travel to verify ranches in person — walking the pasture,
                      meeting the herd, documenting the operation. Optional, but
                      it lets us tell your story honestly.
                    </p>

                    <Checkbox
                      label="I'd be open to an on-site verification visit"
                      name="ranchTourInterested"
                      checked={rancherData.ranchTourInterested}
                      onChange={handleRancherChange}
                    />

                    {rancherData.ranchTourInterested && (
                      <Textarea
                        label="Best times / dates for a visit (flexible)"
                        name="ranchTourAvailability"
                        value={rancherData.ranchTourAvailability}
                        onChange={handleRancherChange}
                        rows={3}
                        placeholder="e.g. 'Mornings work best' or 'Weekdays in March' or 'Flexible — give me 1 week notice'"
                      />
                    )}
                  </div>

                  <Divider />

                  <div className="space-y-1.5">
                    <Checkbox
                      label="I agree to the commission terms for sales facilitated through BuyHalfCow"
                      name="commissionAgreed"
                      checked={rancherData.commissionAgreed}
                      onChange={handleRancherChange}
                      required
                    />
                    <p className="text-xs text-saddle pl-7">
                      <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-charcoal">
                        Read the full commission terms
                      </a>
                      .
                    </p>
                  </div>
                </div>
              )}

              {/* BRAND FORM */}
              {partnerType === 'brand' && (
                <div className="space-y-6">
                  <h2 className="font-serif text-2xl md:text-3xl lowercase">
                    brand partnership application
                  </h2>

                  <Input
                    label="Brand Name"
                    name="brandName"
                    value={brandData.brandName}
                    onChange={handleBrandChange}
                    required
                  />

                  <Input
                    label="Contact Name"
                    name="contactName"
                    value={brandData.contactName}
                    onChange={handleBrandChange}
                    required
                  />

                  <Input
                    label="Email"
                    type="email"
                    name="email"
                    value={brandData.email}
                    onChange={handleBrandChange}
                    required
                  />

                  <Input
                    label="Phone"
                    type="tel"
                    name="phone"
                    value={brandData.phone}
                    onChange={handleBrandChange}
                    required
                  />

                  <Input
                    label="Website"
                    type="url"
                    name="website"
                    value={brandData.website}
                    onChange={handleBrandChange}
                    placeholder="https://yourbrand.com"
                    required
                  />

                  <Textarea
                    label="Product Type (e.g., Western apparel, ranch tools, leather goods)"
                    name="productType"
                    value={brandData.productType}
                    onChange={handleBrandChange}
                    rows={3}
                    required
                  />

                  <Textarea
                    label="Promotion Details (What you want to offer BHC members)"
                    name="promotionDetails"
                    value={brandData.promotionDetails}
                    onChange={handleBrandChange}
                    rows={4}
                    required
                  />

                  <Input
                    label="Discount Offered to Members (%)"
                    type="number"
                    name="discountOffered"
                    value={brandData.discountOffered}
                    onChange={handleBrandChange}
                    placeholder="e.g., 15"
                    required
                  />

                  <Checkbox
                    label="I agree this promotion will be exclusive to BuyHalfCow members"
                    name="exclusivityAgreed"
                    checked={brandData.exclusivityAgreed}
                    onChange={handleBrandChange}
                    required
                  />
                </div>
              )}

              {/* LAND DEAL FORM */}
              {partnerType === 'land' && (
                <div className="space-y-6">
                  <h2 className="font-serif text-2xl md:text-3xl lowercase">
                    land deal submission
                  </h2>

                  <Input
                    label="Seller Name / Entity"
                    name="sellerName"
                    value={landData.sellerName}
                    onChange={handleLandChange}
                    required
                  />

                  <Input
                    label="Email"
                    type="email"
                    name="email"
                    value={landData.email}
                    onChange={handleLandChange}
                    required
                  />

                  <Input
                    label="Phone"
                    type="tel"
                    name="phone"
                    value={landData.phone}
                    onChange={handleLandChange}
                    required
                  />

                  <Input
                    label="Property Location (City, County)"
                    name="propertyLocation"
                    value={landData.propertyLocation}
                    onChange={handleLandChange}
                    placeholder="e.g., Marfa, Presidio County"
                    required
                  />

                  <Select
                    label="State"
                    name="state"
                    value={landData.state}
                    onChange={handleLandChange}
                    required
                  >
                    {US_STATES.map(state => (
                      <option key={state.value} value={state.value}>{state.label}</option>
                    ))}
                  </Select>

                  <Input
                    label="Total Acreage"
                    type="number"
                    name="acreage"
                    value={landData.acreage}
                    onChange={handleLandChange}
                    required
                  />

                  <Input
                    label="Asking Price"
                    type="text"
                    name="askingPrice"
                    value={landData.askingPrice}
                    onChange={handleLandChange}
                    placeholder="e.g., $450,000"
                    required
                  />

                  <Input
                    label="Property Type"
                    name="propertyType"
                    value={landData.propertyType}
                    onChange={handleLandChange}
                    placeholder="e.g., Ranch, Hunting Land, Agricultural"
                    required
                  />

                  <Input
                    label="Zoning"
                    name="zoning"
                    value={landData.zoning}
                    onChange={handleLandChange}
                    placeholder="e.g., Agricultural, Residential"
                    required
                  />

                  <Textarea
                    label="Utilities Available"
                    name="utilities"
                    value={landData.utilities}
                    onChange={handleLandChange}
                    rows={2}
                    placeholder="e.g., Well water, Electric nearby, Septic"
                    required
                  />

                  <Textarea
                    label="Property Description"
                    name="description"
                    value={landData.description}
                    onChange={handleLandChange}
                    rows={5}
                    placeholder="Describe the property, terrain, features, etc."
                    required
                  />

                  <Checkbox
                    label="I agree to list this deal exclusively to BuyHalfCow members for 30 days"
                    name="exclusiveToMembers"
                    checked={landData.exclusiveToMembers}
                    onChange={handleLandChange}
                    required
                  />
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="p-4 border border-weathered bg-transparent text-weathered text-sm"
                >
                  {error}
                </div>
              )}

              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Submitting…' : 'Submit application'}
              </Button>
            </form>
          )}

          <div className="text-center pt-8">
            <Link href="/" className="text-charcoal hover:text-saddle transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}

export default function PartnerPage() {
  return (
    <Suspense fallback={<main className="min-h-screen py-24 bg-bone flex items-center justify-center"><p className="text-saddle">Loading...</p></main>}>
      <PartnerPageContent />
    </Suspense>
  );
}

