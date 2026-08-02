'use client';

import { useState } from 'react';
import Input from './Input';
import Textarea from './Textarea';
import SmsConsentCheckbox, { TermsNotice } from './SmsConsentCheckbox';
import {
  emailFieldError,
  minLengthFieldError,
  phoneFieldError,
  requiredFieldError,
} from '@/lib/buyerFieldValidation';

interface InquiryModalProps {
  rancher: {
    id: string;
    ranch_name: string;
    operator_name: string;
    email: string;
    state: string;
  };
  onClose: () => void;
}

export default function InquiryModal({ rancher, onClose }: InquiryModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    message: '',
    interestType: 'half_cow',
  });
  // TCPA SMS consent — UNCHECKED by default, never gates the inquiry.
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');
  // Per-field inline validation — set on blur, cleared on change.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validators: Record<string, (v: string) => string> = {
    name: (v) => requiredFieldError(v, 'Your name'),
    email: emailFieldError,
    phone: phoneFieldError,
    message: (v) => minLengthFieldError(v, 10, 'Your message'),
  };

  const validateField = (name: string, value: string) => {
    const err = validators[name] ? validators[name](value) : '';
    setFieldErrors((f) => ({ ...f, [name]: err }));
    return err;
  };

  const setField = (name: string, value: string) => {
    setFormData((f) => ({ ...f, [name]: value }));
    if (fieldErrors[name]) setFieldErrors((f) => ({ ...f, [name]: '' }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = Object.keys(validators).map((k) =>
      validateField(k, (formData as Record<string, string>)[k] || ''),
    );
    if (errs.some(Boolean)) return;
    setIsSubmitting(true);
    setError('');

    try {
      const response = await fetch('/api/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rancherId: rancher.id,
          consumerName: formData.name,
          consumerEmail: formData.email,
          consumerPhone: formData.phone,
          message: formData.message,
          interestType: formData.interestType,
          // Funnel payload convention → Consumers `SMS Opt-In` server-side.
          smsOptIn,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send inquiry');
      }

      setIsSuccess(true);
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch {
      setError('Failed to send inquiry. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-bone p-8 max-w-md w-full">
          <h2 className="font-serif text-2xl mb-4">Inquiry Received!</h2>
          <p className="text-saddle">
            Your inquiry about {rancher.ranch_name} has been received. We&apos;ll review it and connect you with the rancher shortly.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-bone p-8 max-w-2xl w-full my-8">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="font-serif text-2xl mb-2">
              Contact {rancher.ranch_name}
            </h2>
            <p className="text-sm text-saddle">
              Operator: {rancher.operator_name} • {rancher.state}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-11 h-11 -mt-2 -mr-2 flex items-center justify-center text-2xl leading-none hover:text-saddle transition-colors"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <Input
            label="Your Name"
            name="name"
            type="text"
            required
            autoComplete="name"
            value={formData.name}
            onChange={(e) => setField('name', e.target.value)}
            onBlur={(e) => { if (e.target.value.trim()) validateField('name', e.target.value); }}
            error={fieldErrors.name}
          />

          <Input
            label="Your Email"
            name="email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={formData.email}
            onChange={(e) => setField('email', e.target.value)}
            onBlur={(e) => { if (e.target.value.trim()) validateField('email', e.target.value); }}
            error={fieldErrors.email}
          />

          <Input
            label="Your Phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            inputMode="tel"
            value={formData.phone}
            onChange={(e) => setField('phone', e.target.value)}
            onBlur={(e) => { if (e.target.value.trim()) validateField('phone', e.target.value); }}
            error={fieldErrors.phone}
          />

          <SmsConsentCheckbox
            checked={smsOptIn}
            onChange={setSmsOptIn}
            leadIn="Text me updates."
          />

          <div className="space-y-2">
            <label htmlFor="inquiry-interest-type" className="block text-sm font-medium">
              What are you interested in? <span className="text-weathered">*</span>
            </label>
            <select
              id="inquiry-interest-type"
              name="interestType"
              value={formData.interestType}
              onChange={(e) => setFormData({ ...formData, interestType: e.target.value })}
              className="w-full px-4 py-3 border border-dust bg-bone text-charcoal focus:border-charcoal transition-colors"
              required
            >
              <option value="half_cow">Half Cow</option>
              <option value="quarter_cow">Quarter Cow</option>
              <option value="whole_cow">Whole Cow</option>
              <option value="custom">Custom Order</option>
            </select>
          </div>

          <Textarea
            label="Your Message"
            name="message"
            required
            rows={6}
            value={formData.message}
            onChange={(e) => setField('message', e.target.value)}
            onBlur={(e) => { if (e.target.value.trim()) validateField('message', e.target.value); }}
            error={fieldErrors.message}
            placeholder="Tell the rancher what you're looking for, when you need it, and any questions you have..."
          />

          {error && (
            <div role="alert" className="p-4 bg-weathered/10 border border-weathered text-weathered">
              {error}
            </div>
          )}

          <div className="flex gap-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-6 py-3 border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone transition-colors duration-300 font-medium tracking-wide uppercase text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 px-6 py-3 bg-charcoal text-bone hover:bg-divider transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-charcoal disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Sending...' : 'Send Inquiry'}
            </button>
          </div>

          <p className="text-xs text-saddle text-center">
            The rancher will receive your contact information and reply directly to your email.
          </p>

          <TermsNotice />
        </form>
      </div>
    </div>
  );
}


