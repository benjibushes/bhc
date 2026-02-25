'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Select from '../components/Select';
import Textarea from '../components/Textarea';
import Button from '../components/Button';
import Link from 'next/link';

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

export default function UpdateProfilePage() {
  const [token, setToken] = useState('');
  const [formData, setFormData] = useState({
    orderType: '',
    budgetRange: '',
    notes: '',
  });
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [consumerName, setConsumerName] = useState('');
  const [validating, setValidating] = useState(true);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token') || '';
    setToken(t);

    if (!t) {
      setInvalid(true);
      setValidating(false);
      return;
    }

    // Validate token
    fetch('/api/backfill/validate-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.valid) {
          setConsumerName(data.name || '');
          setValidating(false);
        } else {
          setInvalid(true);
          setValidating(false);
        }
      })
      .catch(() => {
        setInvalid(true);
        setValidating(false);
      });
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!formData.orderType) {
      setError('Please select what you\'re looking for.');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/backfill/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...formData }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Update failed');
      }

      setIsSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
      setIsSubmitting(false);
    }
  };

  if (validating) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-md mx-auto text-center">
            <p className="text-lg text-[#6B4F3F]">Loading...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (invalid) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-[family-name:var(--font-serif)] text-3xl">Link Expired</h1>
            <p className="text-[#6B4F3F]">
              This link has expired or is invalid. Please contact{' '}
              <a href="mailto:support@buyhalfcow.com" className="underline">support@buyhalfcow.com</a>{' '}
              for a new link.
            </p>
            <Link href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors">
              &larr; Back to home
            </Link>
          </div>
        </Container>
      </main>
    );
  }

  if (isSubmitted) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-[family-name:var(--font-serif)] text-3xl">Thanks{consumerName ? `, ${consumerName.split(' ')[0]}` : ''}!</h1>
            <Divider />
            <p className="text-lg text-[#6B4F3F]">
              Your preferences have been updated. We&apos;ll match you with a rancher in your area and be in touch within 48 hours.
            </p>
            <Link href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors">
              &larr; Back to BuyHalfCow
            </Link>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-md mx-auto">
          <div className="text-center space-y-4 mb-8">
            <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
              Update Your Preferences
            </h1>
            <Divider />
            {consumerName && (
              <p className="text-lg text-[#6B4F3F]">
                Hi {consumerName.split(' ')[0]}, help us match you with the right rancher!
              </p>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <Select
              label="What are you looking for?"
              name="orderType"
              required
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
              label="Any specific requirements?"
              name="notes"
              value={formData.notes}
              onChange={handleTextareaChange}
              placeholder="Preferences, dietary needs, timeline, etc."
              rows={3}
            />

            {error && (
              <div className="p-4 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
                {error}
              </div>
            )}

            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Updating...' : 'Update & Match Me'}
            </Button>
          </form>

          <p className="text-center text-xs text-[#A7A29A] mt-8">
            Takes 30 seconds. You&apos;ll hear from us within 48 hours.
          </p>
        </div>
      </Container>
    </main>
  );
}
