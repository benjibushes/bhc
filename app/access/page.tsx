'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Input from '../components/Input';
import Select from '../components/Select';
import Checkbox from '../components/Checkbox';
import Textarea from '../components/Textarea';
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

const ORDER_TYPE_OPTIONS = [
  { value: '', label: 'Select order type' },
  { value: 'Quarter', label: 'Quarter Cow' },
  { value: 'Half', label: 'Half Cow' },
  { value: 'Whole', label: 'Whole Cow' },
  { value: 'Not Sure', label: 'Not Sure Yet' },
];

const BUDGET_OPTIONS = [
  { value: '', label: 'Select your budget range' },
  { value: '<$500', label: 'Under $500' },
  { value: '$500-$1000', label: '$500 - $1,000' },
  { value: '$1000-$2000', label: '$1,000 - $2,000' },
  { value: '$2000+', label: '$2,000+' },
  { value: 'Unsure', label: 'Unsure' },
];

function calculateIntentScore(data: {
  orderType: string;
  budgetRange: string;
  notes: string;
  phone: string;
  email: string;
  interestBeef: boolean;
  interestMerch: boolean;
  interestAll: boolean;
}) {
  let score = 0;

  if (data.interestBeef) score += 30;
  if (data.interestAll) score += 15;
  if (data.interestMerch && !data.interestBeef && !data.interestAll) score -= 10;

  if (data.orderType === 'Whole') score += 30;
  else if (data.orderType === 'Half') score += 20;
  else if (data.orderType === 'Quarter') score += 10;

  if (data.budgetRange === '$2000+') score += 25;
  else if (data.budgetRange === '$1000-$2000') score += 20;
  else if (data.budgetRange === '$500-$1000') score += 10;

  if (data.notes && data.notes.length > 20) score += 15;
  if (data.phone && data.email) score += 10;

  return Math.max(score, 0);
}

function classifyIntent(score: number): string {
  if (score >= 60) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

function deriveSegment(interestBeef: boolean, interestAll: boolean): string {
  return (interestBeef || interestAll) ? 'Beef Buyer' : 'Community';
}

function validateEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com', '10minutemail.com', 'trashmail.com'];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

function validatePhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function validateName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/[<>{}()\[\]\\\/]/.test(trimmed)) return false;
  return true;
}

export default function AccessPage() {
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    state: '',
    orderType: '',
    budgetRange: '',
    notes: '',
    interestBeef: false,
    interestLand: false,
    interestMerch: false,
    interestAll: false,
    website: '', // honeypot
  });

  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submittedSegment, setSubmittedSegment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [formLoadedAt] = useState(Date.now());
  const [campaignData, setCampaignData] = useState({
    campaign: '',
    source: 'organic',
    utmParams: '',
  });

  useEffect(() => {
    const campaign = localStorage.getItem('bhc_campaign') || '';
    const source = localStorage.getItem('bhc_source') || 'organic';
    const utmParams = localStorage.getItem('bhc_utm_params') || '';
    setCampaignData({ campaign, source, utmParams });
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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

    // Honeypot check
    if (formData.website) return;

    // Time-based bot check: form filled in under 3 seconds is suspicious
    if (Date.now() - formLoadedAt < 3000) {
      setError('Please take a moment to fill out the form completely.');
      return;
    }

    if (!validateName(formData.fullName)) {
      setError('Please enter a valid full name.');
      return;
    }

    if (!validateEmail(formData.email)) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!validatePhone(formData.phone)) {
      setError('Please enter a valid phone number.');
      return;
    }

    if (!formData.interestBeef && !formData.interestLand && !formData.interestMerch && !formData.interestAll) {
      setError('Please select at least one interest.');
      return;
    }

    const intentScore = calculateIntentScore({
      orderType: formData.orderType,
      budgetRange: formData.budgetRange,
      notes: formData.notes,
      phone: formData.phone,
      email: formData.email,
      interestBeef: formData.interestBeef,
      interestMerch: formData.interestMerch,
      interestAll: formData.interestAll,
    });
    const intentClassification = classifyIntent(intentScore);
    const segment = deriveSegment(formData.interestBeef, formData.interestAll);

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/consumers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: formData.fullName.trim(),
          email: formData.email.trim().toLowerCase(),
          phone: formData.phone.trim(),
          state: formData.state,
          orderType: formData.orderType,
          budgetRange: formData.budgetRange,
          notes: formData.notes.trim(),
          interestBeef: formData.interestBeef,
          interestLand: formData.interestLand,
          interestMerch: formData.interestMerch,
          interestAll: formData.interestAll,
          intentScore,
          intentClassification,
          segment,
          source: campaignData.source,
          campaign: campaignData.campaign,
          utmParams: campaignData.utmParams,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Submission failed');
      }

      setSubmittedSegment(segment);
      setIsSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    const isBeef = submittedSegment === 'Beef Buyer';
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-8">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              You&apos;re In
            </h1>
            <Divider />
            <p className="text-xl leading-relaxed">
              {isBeef
                ? "Check your email — you'll find your login link and next steps for getting matched with a verified rancher in your area."
                : "Check your email — you'll find your login link and access to the BuyHalfCow network, including merch, brand deals, and community events."
              }
            </p>
            <div className="space-y-3 text-left max-w-md mx-auto pt-4">
              <div className="flex items-center gap-3 text-base">
                <span className="w-6 h-6 bg-[#0E0E0E] text-[#F4F1EC] rounded-full flex items-center justify-center text-xs font-bold">1</span>
                <span>Application approved</span>
              </div>
              <div className="flex items-center gap-3 text-base text-[#6B4F3F]">
                <span className="w-6 h-6 border border-[#A7A29A] rounded-full flex items-center justify-center text-xs font-bold">2</span>
                <span>{isBeef ? 'Matching you with a rancher...' : 'Explore the network'}</span>
              </div>
              <div className="flex items-center gap-3 text-base text-[#A7A29A]">
                <span className="w-6 h-6 border border-[#A7A29A] rounded-full flex items-center justify-center text-xs font-bold">3</span>
                <span>{isBeef ? 'Personal introduction via email' : 'Access member-only perks'}</span>
              </div>
            </div>
            <div className="pt-8">
              <Link href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors">
                &larr; Back to home
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
              Apply to get matched with a verified rancher in your state. We review every application and personally introduce you.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Honeypot - hidden from real users */}
            <div className="absolute opacity-0 h-0 overflow-hidden" aria-hidden="true" tabIndex={-1}>
              <input
                type="text"
                name="website"
                value={formData.website}
                onChange={handleInputChange}
                tabIndex={-1}
                autoComplete="off"
              />
            </div>

            <Input
              label="Full Name"
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

            <Divider />

            <div className="space-y-2">
              <p className="text-sm font-medium text-[#6B4F3F] uppercase tracking-wider">
                Help us match you with the right rancher
              </p>
            </div>

            <Select
              label="What are you looking for?"
              name="orderType"
              value={formData.orderType}
              onChange={handleInputChange}
              options={ORDER_TYPE_OPTIONS}
            />

            <Select
              label="Budget Range"
              name="budgetRange"
              value={formData.budgetRange}
              onChange={handleInputChange}
              options={BUDGET_OPTIONS}
            />

            <Textarea
              label="Anything else we should know?"
              name="notes"
              value={formData.notes}
              onChange={handleTextareaChange}
              placeholder="Specific preferences, dietary needs, timeline, etc."
              rows={3}
            />

            <Divider />

            <div className="space-y-4">
              <p className="text-sm font-medium">
                I&apos;m interested in: <span className="text-[#8C2F2F]">*</span>
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
              &larr; Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}
