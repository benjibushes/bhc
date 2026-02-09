'use client';

import { useState } from 'react';
import Input from './Input';
import Textarea from './Textarea';

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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send inquiry');
      }

      setIsSuccess(true);
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err) {
      setError('Failed to send inquiry. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-[#F4F1EC] p-8 max-w-md w-full">
          <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-4">Inquiry Sent!</h2>
          <p className="text-[#6B4F3F]">
            Your inquiry has been sent to {rancher.ranch_name}. They'll reply directly to your email.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#F4F1EC] p-8 max-w-2xl w-full my-8">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="font-[family-name:var(--font-serif)] text-2xl mb-2">
              Contact {rancher.ranch_name}
            </h2>
            <p className="text-sm text-[#6B4F3F]">
              Operator: {rancher.operator_name} • {rancher.state}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-2xl leading-none hover:text-[#6B4F3F] transition-colors"
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
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />

          <Input
            label="Your Email"
            name="email"
            type="email"
            required
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          />

          <Input
            label="Your Phone"
            name="phone"
            type="tel"
            required
            value={formData.phone}
            onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
          />

          <div className="space-y-2">
            <label className="block text-sm font-medium">
              What are you interested in? <span className="text-[#8C2F2F]">*</span>
            </label>
            <select
              value={formData.interestType}
              onChange={(e) => setFormData({ ...formData, interestType: e.target.value })}
              className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-[#0E0E0E] focus:outline-none focus:border-[#0E0E0E] transition-colors"
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
            onChange={(e) => setFormData({ ...formData, message: e.target.value })}
            placeholder="Tell the rancher what you're looking for, when you need it, and any questions you have..."
          />

          {error && (
            <div className="p-4 bg-[#8C2F2F] bg-opacity-10 border border-[#8C2F2F] text-[#8C2F2F]">
              {error}
            </div>
          )}

          <div className="flex gap-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-6 py-3 border border-[#0E0E0E] text-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors duration-300 font-medium tracking-wide uppercase text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 px-6 py-3 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-[#0E0E0E] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Sending...' : 'Send Inquiry'}
            </button>
          </div>

          <p className="text-xs text-[#6B4F3F] text-center">
            The rancher will receive your contact information and reply directly to your email.
          </p>
        </form>
      </div>
    </div>
  );
}


