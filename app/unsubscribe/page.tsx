'use client';

import { useSearchParams } from 'next/navigation';
import { useState, Suspense } from 'react';

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';
  const emailParam = searchParams.get('email') || '';
  const [email, setEmail] = useState(emailParam);
  const [submitted, setSubmitted] = useState(success);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/unsubscribe?email=${encodeURIComponent(email)}`, {
        method: 'POST',
      });
      if (res.ok) {
        setSubmitted(true);
      }
    } catch {
      alert('Something went wrong. Please try again or email support@buyhalfcow.com');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: '#fafaf8',
      padding: '20px',
    }}>
      <div style={{
        maxWidth: '480px',
        width: '100%',
        textAlign: 'center',
        padding: '40px',
        backgroundColor: '#fff',
        borderRadius: '12px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      }}>
        {submitted ? (
          <>
            <h1 style={{ fontSize: '24px', marginBottom: '12px', color: '#1a1a1a' }}>
              You&apos;ve been unsubscribed
            </h1>
            <p style={{ color: '#666', lineHeight: 1.6, marginBottom: '24px' }}>
              We&apos;ve removed <strong>{email}</strong> from our mailing list.
              You won&apos;t receive any more emails from us.
            </p>
            <p style={{ color: '#999', fontSize: '14px' }}>
              Changed your mind? Email{' '}
              <a href="mailto:support@buyhalfcow.com" style={{ color: '#8B4513' }}>
                support@buyhalfcow.com
              </a>{' '}
              and we&apos;ll add you back.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: '24px', marginBottom: '12px', color: '#1a1a1a' }}>
              Unsubscribe
            </h1>
            <p style={{ color: '#666', lineHeight: 1.6, marginBottom: '24px' }}>
              Enter your email to unsubscribe from BuyHalfCow emails.
            </p>
            <form onSubmit={handleSubmit}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  fontSize: '16px',
                  border: '1px solid #ddd',
                  borderRadius: '8px',
                  marginBottom: '16px',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '12px',
                  fontSize: '16px',
                  backgroundColor: '#8B4513',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.7 : 1,
                }}
              >
                {loading ? 'Unsubscribing...' : 'Unsubscribe'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}>
        <p>Loading...</p>
      </div>
    }>
      <UnsubscribeContent />
    </Suspense>
  );
}
