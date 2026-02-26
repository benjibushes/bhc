'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';

export default function SignAgreementPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
        <Container><p className="text-center text-saddle-brown">Loading agreement...</p></Container>
      </main>
    }>
      <SignAgreementInner />
    </Suspense>
  );
}

function SignAgreementInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rancherData, setRancherData] = useState<any>(null);
  const [alreadySigned, setAlreadySigned] = useState(false);
  const [signedAt, setSignedAt] = useState('');

  const [signatureName, setSignatureName] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('No signing token provided. Please use the link from your onboarding email.');
      setLoading(false);
      return;
    }
    fetchAgreementData();
  }, []);

  const fetchAgreementData = async () => {
    try {
      const res = await fetch(`/api/ranchers/sign-agreement?token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load agreement');
        setLoading(false);
        return;
      }
      if (data.already_signed) {
        setAlreadySigned(true);
        setSignedAt(data.signed_at);
        setRancherData(data);
      } else {
        setRancherData(data);
      }
    } catch {
      setError('Failed to load agreement. Please try again.');
    }
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreedToTerms || !signatureName.trim()) return;

    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/ranchers/sign-agreement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, signatureName: signatureName.trim(), agreedToTerms }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.already_signed) {
          setAlreadySigned(true);
          return;
        }
        throw new Error(data.error || 'Failed to submit');
      }
      setSuccess(true);
      setSignedAt(data.signed_at);
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
        <Container>
          <div className="max-w-2xl mx-auto text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal-black border-t-transparent rounded-full animate-spin" />
            <p className="mt-4 text-saddle-brown">Loading agreement...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (error && !rancherData) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-6">
            <h1 className="font-serif text-3xl">Unable to Load Agreement</h1>
            <p className="text-saddle-brown">{error}</p>
            <Link href="/" className="inline-block px-6 py-3 border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors">
              Go to Homepage
            </Link>
          </div>
        </Container>
      </main>
    );
  }

  if (alreadySigned) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-6">
            <div className="text-6xl">&#10003;</div>
            <h1 className="font-serif text-3xl">Agreement Already Signed</h1>
            <p className="text-saddle-brown">
              This agreement was signed{signedAt ? ` on ${new Date(signedAt).toLocaleDateString()}` : ''}.
              Your onboarding is in progress.
            </p>
            <p className="text-sm text-dust-gray">
              Questions? Email <a href="mailto:support@buyhalfcow.com" className="underline">support@buyhalfcow.com</a>
            </p>
          </div>
        </Container>
      </main>
    );
  }

  if (success) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-6">
            <div className="text-6xl">&#10003;</div>
            <h1 className="font-serif text-3xl">Agreement Signed</h1>
            <p className="text-lg text-saddle-brown">
              Thank you, {signatureName}. Your BuyHalfCow Commission Agreement has been accepted.
            </p>
            <div className="p-6 border border-dust-gray bg-white text-left space-y-2 text-sm">
              <p><strong>Signed by:</strong> {signatureName}</p>
              <p><strong>Date:</strong> {new Date(signedAt).toLocaleString()}</p>
              <p><strong>Status:</strong> Agreement Signed — Verification is next</p>
            </div>
            <p className="text-sm text-saddle-brown">
              We&apos;ll be in touch about the verification process. If you have questions, reply to your onboarding email or reach out to <a href="mailto:support@buyhalfcow.com" className="underline">support@buyhalfcow.com</a>.
            </p>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-12 bg-bone-white text-charcoal-black">
      <Container>
        <div className="max-w-3xl mx-auto space-y-8">
          <div className="text-center space-y-2">
            <h1 className="font-serif text-3xl md:text-4xl">
              BuyHalfCow Commission Agreement
            </h1>
            <p className="text-saddle-brown">
              {rancherData?.rancher_name && `Prepared for ${rancherData.rancher_name}`}
              {rancherData?.ranch_name && rancherData.ranch_name !== rancherData.rancher_name && ` — ${rancherData.ranch_name}`}
            </p>
          </div>

          <Divider />

          {/* Agreement Terms */}
          <div className="space-y-8 text-sm leading-relaxed">
            <section className="space-y-3">
              <h2 className="font-serif text-xl">1. Platform Overview</h2>
              <p>
                BuyHalfCow is a direct-to-consumer customer acquisition and media platform built to connect
                independent ranchers with qualified buyers. BuyHalfCow generates buyers, builds demand,
                and introduces verified leads directly to you.
              </p>
              <p>
                BuyHalfCow does not process meat, handle inventory, or take custody of product.
                All fulfillment, compliance, and product liability remain with the rancher.
              </p>
            </section>

            <section className="space-y-3">
              <h2 className="font-serif text-xl">2. Commission Structure</h2>
              <p>BuyHalfCow earns a <strong>10% commission</strong> on all verified referred sales. This applies to:</p>
              <ul className="list-disc pl-6 space-y-1 text-saddle-brown">
                <li>One-time bulk purchases</li>
                <li>Repeat purchases from referred buyers</li>
                <li>Subscription-based agreements from referred buyers</li>
              </ul>
              <p><strong>Commission term:</strong> 24 months from the date of first referral introduction.</p>
              <p><strong>No upfront fees.</strong> Buyers pay you directly — you control your own pricing.</p>
              <p>BuyHalfCow invoices monthly for commission on closed, referred sales.</p>
            </section>

            <section className="space-y-3">
              <h2 className="font-serif text-xl">3. How It Works</h2>
              <ol className="list-decimal pl-6 space-y-1 text-saddle-brown">
                <li>Alignment call to confirm production capacity, goals, and standards</li>
                <li>Commission Agreement signed (this document)</li>
                <li>Verification via product sample or in-person ranch visit</li>
                <li>Ranch profile created and buyer matching begins</li>
                <li>Qualified buyer introductions sent directly to you</li>
                <li>You complete the sale and control pricing</li>
                <li>10% commission settled monthly on referred sales</li>
              </ol>
            </section>

            <section className="space-y-3">
              <h2 className="font-serif text-xl">4. Rancher Expectations</h2>
              <ul className="list-disc pl-6 space-y-1 text-saddle-brown">
                <li>Honest inventory reporting</li>
                <li>Clear pricing to referred buyers</li>
                <li>Professional communication with introduced customers</li>
                <li>Fulfillment responsibility for all orders</li>
                <li>Transparent reporting of referred sales for commission calculation</li>
              </ul>
            </section>

            <section className="space-y-3">
              <h2 className="font-serif text-xl">5. Verification Requirement</h2>
              <p>
                Before listing, ranchers must complete verification through either a product sample
                shipment (shipped to BuyHalfCow for quality review) or an in-person ranch visit.
                Approval is at BuyHalfCow&apos;s discretion.
              </p>
            </section>

            <section className="space-y-3">
              <h2 className="font-serif text-xl">6. Media Agreement</h2>
              <p>
                A separate Media Agreement governs the use of ranch photos, descriptions, and marketing
                content created during the partnership. Review the attached Media Agreement document
                for full terms.
              </p>
            </section>
          </div>

          <Divider />

          {/* Download Links */}
          <div className="p-4 bg-white border border-dust-gray space-y-2">
            <p className="text-sm font-medium">Full documents for your records:</p>
            <div className="flex flex-wrap gap-3">
              <a href="/docs/BHC_Commission_Agreement.docx" download className="text-sm underline text-saddle-brown hover:text-charcoal-black">
                Commission Agreement (DOCX)
              </a>
              <a href="/docs/BHC_Media_Agreement.docx" download className="text-sm underline text-saddle-brown hover:text-charcoal-black">
                Media Agreement (DOCX)
              </a>
              <a href="/docs/BHC_Rancher_Info_Packet.pdf" download className="text-sm underline text-saddle-brown hover:text-charcoal-black">
                Rancher Info Packet (PDF)
              </a>
            </div>
          </div>

          <Divider />

          {/* Signature Form */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="p-6 border-2 border-charcoal-black bg-white space-y-6">
              <h2 className="font-serif text-xl">Accept Agreement</h2>

              <div className="space-y-2">
                <label className="block text-sm font-medium">
                  Full Legal Name <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={signatureName}
                  onChange={(e) => setSignatureName(e.target.value)}
                  placeholder="Type your full legal name"
                  required
                  className="w-full px-4 py-3 border border-dust-gray bg-bone-white text-lg focus:outline-none focus:border-charcoal-black"
                  style={{ fontFamily: 'cursive, Georgia, serif' }}
                />
                <p className="text-xs text-dust-gray">
                  By typing your name above, you are providing a legally binding electronic signature.
                </p>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  required
                  className="w-5 h-5 mt-0.5 flex-shrink-0"
                />
                <span className="text-sm">
                  I have read and agree to the BuyHalfCow Commission Agreement terms outlined above,
                  including the 10% commission on referred sales for a 24-month term, verification requirements,
                  and rancher expectations. I understand that all fulfillment and product liability remain my responsibility.
                </span>
              </label>

              {error && (
                <div className="p-3 border border-red-400 text-red-700 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !agreedToTerms || !signatureName.trim()}
                className="w-full px-6 py-4 bg-charcoal-black text-bone-white text-sm font-semibold uppercase tracking-wider hover:bg-saddle-brown transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Submitting...' : 'Sign & Accept Agreement'}
              </button>
            </div>
          </form>

          <p className="text-center text-xs text-dust-gray">
            Questions before signing? Email <a href="mailto:support@buyhalfcow.com" className="underline">support@buyhalfcow.com</a> or reply to your onboarding email.
          </p>
        </div>
      </Container>
    </main>
  );
}
