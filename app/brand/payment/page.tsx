'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function BrandPaymentContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const cancelled = searchParams.get('cancelled');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) setError('Invalid payment link. Please contact support@buyhalfcow.com');
  }, [token]);

  async function handlePayment() {
    if (!token) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/brands/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Payment error');
        setLoading(false);
        return;
      }

      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="max-w-lg w-full bg-white border border-[#A7A29A] p-8 md:p-12">
      <h1 className="font-serif text-3xl mb-2">Brand Partnership Listing</h1>
      <p className="text-[#6B4F3F] mb-6">BuyHalfCow — Private Network</p>

      {cancelled && (
        <div className="bg-yellow-50 border border-yellow-200 p-4 mb-6 text-sm text-yellow-800">
          Payment was cancelled. You can try again below.
        </div>
      )}

      {error ? (
        <div className="bg-red-50 border border-red-200 p-4 mb-6 text-sm text-red-800">
          {error}
        </div>
      ) : (
        <>
          <div className="border border-[#A7A29A] p-6 mb-6">
            <h2 className="font-serif text-xl mb-4">What You Get</h2>
            <ul className="space-y-3 text-[#6B4F3F] text-sm">
              <li className="flex items-start gap-2">
                <span className="text-green-600 mt-0.5">&#10003;</span>
                <span>Featured placement on the BuyHalfCow member dashboard</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-green-600 mt-0.5">&#10003;</span>
                <span>Direct exposure to verified beef buyers and ranch families</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-green-600 mt-0.5">&#10003;</span>
                <span>Listed in the rancher network benefits section</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-green-600 mt-0.5">&#10003;</span>
                <span>Your exclusive discount displayed to all active members</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-green-600 mt-0.5">&#10003;</span>
                <span>Website link and brand profile visible network-wide</span>
              </li>
            </ul>
          </div>

          <div className="bg-[#0E0E0E] text-[#F4F1EC] p-6 mb-6 text-center">
            <p className="text-sm uppercase tracking-widest mb-1">Annual Listing Fee</p>
            <p className="font-serif text-4xl mb-1">$299</p>
            <p className="text-xs text-[#A7A29A]">One-time annual payment</p>
          </div>

          <button
            onClick={handlePayment}
            disabled={loading || !token}
            className="w-full bg-[#0E0E0E] text-[#F4F1EC] py-4 px-6 font-bold uppercase tracking-widest text-sm hover:bg-[#2A2A2A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Redirecting to checkout...' : 'Complete Payment'}
          </button>

          <p className="text-xs text-[#A7A29A] text-center mt-4">
            Secure payment powered by Stripe. Questions? Email support@buyhalfcow.com
          </p>
        </>
      )}
    </div>
  );
}

export default function BrandPaymentPage() {
  return (
    <main className="min-h-screen bg-[#F4F1EC] flex items-center justify-center px-4">
      <Suspense fallback={
        <div className="max-w-lg w-full bg-white border border-[#A7A29A] p-8 md:p-12 text-center">
          <p className="text-[#6B4F3F]">Loading payment details...</p>
        </div>
      }>
        <BrandPaymentContent />
      </Suspense>
    </main>
  );
}
