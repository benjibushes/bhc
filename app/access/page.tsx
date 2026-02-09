'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Input from '../components/Input';
import Select from '../components/Select';
import Checkbox from '../components/Checkbox';
import Button from '../components/Button';
import Link from 'next/link';

const US_STATES = [
  { value: '', label: 'Select your state' },
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' },
];

export default function AccessPage() {
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    state: '',
    interestBeef: false,
    interestLand: false,
    interestMerch: false,
    interestAll: false,
  });

  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [campaignData, setCampaignData] = useState({
    campaign: '',
    source: 'organic',
    utmParams: '',
  });

  useEffect(() => {
    // Read campaign tracking data from localStorage
    const campaign = localStorage.getItem('bhc_campaign') || '';
    const source = localStorage.getItem('bhc_source') || 'organic';
    const utmParams = localStorage.getItem('bhc_utm_params') || '';
    
    setCampaignData({ campaign, source, utmParams });
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: checked }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validate at least one interest is selected
    if (!formData.interestBeef && !formData.interestLand && !formData.interestMerch && !formData.interestAll) {
      setError('Please select at least one interest.');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/consumers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          source: campaignData.source,
          campaign: campaignData.campaign,
          utmParams: campaignData.utmParams,
        }),
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
            <p className="text-xl leading-relaxed">
              We review all applications manually. You'll receive an email within 3-5 business days with your membership status and access instructions.
            </p>
            <div className="pt-8">
              <Link href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors">
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
        <div className="max-w-2xl mx-auto">
          <div className="text-center space-y-6 mb-12">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              Get Private Access
            </h1>
            <Divider />
            <p className="text-lg text-[#6B4F3F]">
              Apply for membership to access verified ranchers, land deals, and exclusive member benefits by state.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <Input
              label="First Name"
              name="fullName"
              required
              value={formData.fullName}
              onChange={handleInputChange}
            />

            <Input
              label="Email"
              name="email"
              type="email"
              required
              value={formData.email}
              onChange={handleInputChange}
            />

            <Input
              label="Phone"
              name="phone"
              type="tel"
              required
              value={formData.phone}
              onChange={handleInputChange}
            />

            <Select
              label="State"
              name="state"
              required
              value={formData.state}
              onChange={handleInputChange}
              options={US_STATES}
            />

            <div className="space-y-4">
              <p className="text-sm font-medium">
                I'm interested in: <span className="text-[#8C2F2F]">*</span>
              </p>
              <Checkbox
                label="Beef"
                name="interestBeef"
                checked={formData.interestBeef}
                onChange={handleCheckboxChange}
              />
              <Checkbox
                label="Land"
                name="interestLand"
                checked={formData.interestLand}
                onChange={handleCheckboxChange}
              />
              <Checkbox
                label="Merch"
                name="interestMerch"
                checked={formData.interestMerch}
                onChange={handleCheckboxChange}
              />
              <Checkbox
                label="All"
                name="interestAll"
                checked={formData.interestAll}
                onChange={handleCheckboxChange}
              />
            </div>

            {error && (
              <div className="p-4 border border-[#8C2F2F] bg-transparent text-[#8C2F2F] text-sm">
                {error}
              </div>
            )}

            <div className="pt-6">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Submitting...' : 'Apply for Access'}
              </Button>
            </div>
          </form>

          <div className="mt-12 text-center">
            <Link href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}

