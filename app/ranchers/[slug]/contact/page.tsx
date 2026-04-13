'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import Container from '../../../components/Container';

interface RancherInfo {
  name: string;
  logoUrl: string;
  tagline: string;
  state: string;
}

export default function RancherContactPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [rancher, setRancher] = useState<RancherInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    message: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchRancher() {
      try {
        const res = await fetch(`/api/public/ranchers/${slug}`);
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = await res.json();
        const r = data.rancher || data;
        const rName = r.ranch_name || r.operator_name || 'Ranch';
        setRancher({
          name: rName,
          logoUrl: r.logo_url || '',
          tagline: r.tagline || '',
          state: r.state || '',
        });
        setForm(f => ({
          ...f,
          message: `Hi ${rName}, I'm interested in purchasing beef through BuyHalfCow.`,
        }));
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    }
    fetchRancher();
  }, [slug]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch(`/api/public/ranchers/${slug}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone,
          message: form.message,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }

      setSuccess(true);
    } catch {
      setError('Something went wrong. Please try again.');
    }

    setSubmitting(false);
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
        <section className="py-20">
          <Container>
            <div className="max-w-2xl mx-auto text-center">
              <p className="text-[#A7A29A]">Loading...</p>
            </div>
          </Container>
        </section>
      </main>
    );
  }

  if (notFound || !rancher) {
    return (
      <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
        <section className="py-20">
          <Container>
            <div className="max-w-2xl mx-auto text-center space-y-6">
              <h1 className="font-[family-name:var(--font-playfair)] text-3xl">
                Rancher Not Found
              </h1>
              <p className="text-[#6B4F3F]">
                This rancher page doesn&apos;t exist or is no longer active.
              </p>
              <Link
                href="/ranchers"
                className="inline-block px-8 py-3 border border-[#6B4F3F] text-[#6B4F3F] text-sm tracking-wide hover:bg-[#6B4F3F] hover:text-[#F4F1EC] transition-colors"
              >
                Browse All Ranchers
              </Link>
            </div>
          </Container>
        </section>
      </main>
    );
  }

  if (success) {
    return (
      <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
        <section className="py-20">
          <Container>
            <div className="max-w-2xl mx-auto text-center space-y-6">
              <div className="flex justify-center">
                {rancher.logoUrl ? (
                  <Image
                    src={rancher.logoUrl}
                    alt={`${rancher.name} logo`}
                    width={100}
                    height={100}
                    className="object-contain max-h-24"
                    unoptimized
                  />
                ) : (
                  <div className="w-20 h-20 border border-[#A7A29A] flex items-center justify-center">
                    <span className="font-[family-name:var(--font-playfair)] text-3xl text-[#A7A29A]">
                      {rancher.name.charAt(0)}
                    </span>
                  </div>
                )}
              </div>
              <h1 className="font-[family-name:var(--font-playfair)] text-3xl">
                Message Sent!
              </h1>
              <p className="text-[#6B4F3F] text-lg">
                {rancher.name} will get back to you shortly.
              </p>
              <p className="text-sm text-[#A7A29A]">
                We&apos;ve also sent a copy to BuyHalfCow so we can follow up if needed.
              </p>
              <Link
                href={`/ranchers/${slug}`}
                className="inline-block px-8 py-3 border border-[#6B4F3F] text-[#6B4F3F] text-sm tracking-wide hover:bg-[#6B4F3F] hover:text-[#F4F1EC] transition-colors"
              >
                Back to {rancher.name}
              </Link>
            </div>
          </Container>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">

      {/* Hero */}
      <section className="py-16 border-b border-[#2A2A2A]/10">
        <Container>
          <div className="max-w-2xl mx-auto flex flex-col items-center gap-6 text-center">
            {rancher.logoUrl ? (
              <Image
                src={rancher.logoUrl}
                alt={`${rancher.name} logo`}
                width={120}
                height={120}
                className="object-contain max-h-28"
                unoptimized
              />
            ) : (
              <div className="w-24 h-24 border border-[#A7A29A] flex items-center justify-center">
                <span className="font-[family-name:var(--font-playfair)] text-4xl text-[#A7A29A]">
                  {rancher.name.charAt(0)}
                </span>
              </div>
            )}
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
                Contact
              </p>
              <h1 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl">
                {rancher.name}
              </h1>
              {rancher.tagline && (
                <p className="text-[#6B4F3F]">{rancher.tagline}</p>
              )}
              {rancher.state && (
                <span className="inline-block text-xs border border-[#A7A29A] px-3 py-1 text-[#6B4F3F]">
                  {rancher.state}
                </span>
              )}
            </div>
          </div>
        </Container>
      </section>

      {/* Contact Form */}
      <section className="py-16">
        <Container>
          <div className="max-w-lg mx-auto space-y-8">
            <div className="text-center space-y-2">
              <h2 className="font-[family-name:var(--font-playfair)] text-2xl">
                Send a Message
              </h2>
              <p className="text-sm text-[#A7A29A]">
                Your message goes directly to {rancher.name}. They&apos;ll reply to your email.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Your Name <span className="text-[#8C2F2F]">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Full Name"
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm focus:outline-none focus:border-[#0E0E0E] transition-colors"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Email Address <span className="text-[#8C2F2F]">*</span>
                </label>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="you@example.com"
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm focus:outline-none focus:border-[#0E0E0E] transition-colors"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Phone <span className="text-[#A7A29A]">(optional)</span>
                </label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="(555) 555-5555"
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm focus:outline-none focus:border-[#0E0E0E] transition-colors"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Message <span className="text-[#8C2F2F]">*</span>
                </label>
                <textarea
                  required
                  rows={5}
                  value={form.message}
                  onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm focus:outline-none focus:border-[#0E0E0E] transition-colors resize-vertical"
                />
              </div>

              {error && (
                <div className="p-4 bg-[#8C2F2F]/10 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-4 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium tracking-wide hover:bg-[#6B4F3F] transition-colors disabled:opacity-50"
              >
                {submitting ? 'Sending...' : 'Send Message'}
              </button>

              <p className="text-xs text-[#A7A29A] text-center">
                Your contact information is shared with {rancher.name} so they can reply directly. BuyHalfCow receives a copy for quality assurance.
              </p>
            </form>
          </div>
        </Container>
      </section>

      {/* Footer Nav */}
      <div className="border-t border-[#2A2A2A]/10 py-10">
        <Container>
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-[#A7A29A]">
            <Link href={`/ranchers/${slug}`} className="hover:text-[#0E0E0E] transition-colors">
              &larr; Back to {rancher.name}
            </Link>
            <Link href="/" className="hover:text-[#0E0E0E] transition-colors">
              BuyHalfCow
            </Link>
          </div>
        </Container>
      </div>

    </main>
  );
}
