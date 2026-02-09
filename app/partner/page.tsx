'use client';

import { useState } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Input from '../components/Input';
import Select from '../components/Select';
import Checkbox from '../components/Checkbox';
import Textarea from '../components/Textarea';
import Button from '../components/Button';
import Link from 'next/link';

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

export default function PartnerPage() {
  const [partnerType, setPartnerType] = useState<PartnerType>('');
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

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
        payload = { partnerType: 'rancher', ...rancherData };
      } else if (partnerType === 'brand') {
        if (!brandData.exclusivityAgreed) {
          setError('You must agree to the exclusivity terms.');
          setIsSubmitting(false);
          return;
        }
        payload = { partnerType: 'brand', ...brandData };
      } else if (partnerType === 'land') {
        payload = { partnerType: 'land', ...landData };
      }

      const response = await fetch('/api/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Submission failed');
      }

      setIsSubmitted(true);
    } catch (err) {
      setError('Something went wrong. Please try again.');
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-8">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              Application Received
            </h1>
            <Divider />
            <p className="text-lg leading-relaxed text-[#6B4F3F]">
              Thank you for your interest in partnering with BuyHalfCow.
            </p>
            <p className="text-lg leading-relaxed">
              We manually review every application. You'll hear from us within 3-5 business days.
            </p>
            <div className="pt-8">
              <Link href="/" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
                ← Back to home
              </Link>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-2xl mx-auto space-y-12">
          {/* Header */}
          <div className="text-center space-y-6">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              Partner With BuyHalfCow
            </h1>
            <Divider />
            <p className="text-lg leading-relaxed text-[#6B4F3F]">
              All partnerships are manually reviewed to ensure quality and trust.
            </p>
          </div>

          {/* Partner Type Selection */}
          <div className="space-y-4">
            <label htmlFor="partnerType" className="block text-sm font-medium mb-2">
              I want to partner as a: <span className="text-[#8C2F2F]">*</span>
            </label>
            <select
              id="partnerType"
              name="partnerType"
              value={partnerType}
              onChange={(e) => setPartnerType(e.target.value as PartnerType)}
              required
              className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-[#0E0E0E] focus:outline-none focus:border-[#0E0E0E] transition-colors"
            >
              <option value="">Select partnership type</option>
              <option value="rancher">Rancher — Sell Beef to Members</option>
              <option value="brand">Brand — Promote Products/Merch</option>
              <option value="land">Land Seller — Submit Exclusive Deals</option>
            </select>
          </div>

          {/* Dynamic Form Based on Selection */}
          {partnerType && (
            <form onSubmit={handleSubmit} className="space-y-8">
              <Divider />

              {/* RANCHER FORM */}
              {partnerType === 'rancher' && (
                <div className="space-y-6">
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                    Rancher Application
                  </h2>
                  
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

                  <div className="space-y-4 p-6 bg-[#F4F1EC] border-2 border-[#0E0E0E]">
                    <h3 className="font-medium text-lg">📞 Required: Schedule Your Onboarding Call</h3>
                    <p className="text-sm text-[#6B4F3F] leading-relaxed">
                      Before we can approve your application, you need to schedule a 30-minute onboarding call. 
                      We'll discuss your operation, answer questions, and walk through how The HERD network works.
                    </p>
                    
                    <div className="bg-white p-4 border border-[#A7A29A]">
                      <p className="text-sm font-medium mb-3">
                        Click below to see my available times and book your call:
                      </p>
                      <a
                        href={process.env.NEXT_PUBLIC_CALENDLY_LINK || 'https://calendly.com'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block w-full px-6 py-4 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors duration-300 font-medium tracking-wide uppercase text-sm text-center border border-[#0E0E0E]"
                      >
                        📅 View Available Times & Schedule Call
                      </a>
                      <p className="text-xs text-[#6B4F3F] mt-3">
                        Can't find a time that works? Email <a href="mailto:support@buyhalfcow.com" className="underline">support@buyhalfcow.com</a>
                      </p>
                    </div>

                    <Checkbox
                      label="I have scheduled (or will schedule immediately after submitting) my onboarding call"
                      name="callScheduled"
                      checked={rancherData.callScheduled || false}
                      onChange={handleRancherChange}
                      required
                    />
                  </div>

                  <Divider />

                  <div className="space-y-4 p-6 bg-white border border-[#A7A29A]">
                    <h3 className="font-medium text-lg">Ranch Tour & Verification</h3>
                    <p className="text-sm text-[#6B4F3F] leading-relaxed">
                      Part of our verification process includes in-person ranch tours. 
                      I travel through different states certifying ranchers and documenting operations.
                    </p>
                    
                    <Checkbox
                      label="I'm interested in having you visit my ranch for verification"
                      name="ranchTourInterested"
                      checked={rancherData.ranchTourInterested}
                      onChange={handleRancherChange}
                    />

                    {rancherData.ranchTourInterested && (
                      <Textarea
                        label="Best times/dates for a visit (flexible)"
                        name="ranchTourAvailability"
                        value={rancherData.ranchTourAvailability}
                        onChange={handleRancherChange}
                        rows={3}
                        placeholder="e.g., 'Mornings work best' or 'Weekdays in March' or 'Flexible - give me 1 week notice'"
                      />
                    )}
                  </div>

                  <Divider />

                  <Checkbox
                    label="I agree to the commission terms for sales facilitated through BuyHalfCow"
                    name="commissionAgreed"
                    checked={rancherData.commissionAgreed}
                    onChange={handleRancherChange}
                    required
                  />
                </div>
              )}

              {/* BRAND FORM */}
              {partnerType === 'brand' && (
                <div className="space-y-6">
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                    Brand Partnership Application
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
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                    Land Deal Submission
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
                <div className="p-4 border border-[#8C2F2F] bg-transparent text-[#8C2F2F] text-sm">
                  {error}
                </div>
              )}

              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Submitting...' : 'Submit Application'}
              </Button>
            </form>
          )}

          <div className="text-center pt-8">
            <Link href="/" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}

