import type { Metadata } from 'next';
import Link from 'next/link';
import ReviewSubmitForm from './ReviewSubmitForm';

// /reviews/submit?token=<jwt>
//
// Landing page for the magic-link CTA in sendTestimonialAsk. Buyer arrives
// from the post-fulfillment email, sees a 5-star + textarea form, submits
// once → /api/reviews/submit writes Buyer Rating + Buyer Review onto the
// Referrals row.
//
// Server component just renders shell + nests the interactive form as a
// client component. Token validation happens on the API side (here we just
// render the form regardless — bad tokens fail at submit time with a
// readable error). No noindex needed; URLs are token-gated.

export const metadata: Metadata = {
  title: 'Leave a review — BuyHalfCow',
  description: 'Quick review for your beef share.',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function ReviewSubmitPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = (params?.token || '').toString();

  if (!token) {
    return (
      <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4 py-12">
        <div className="max-w-md w-full bg-white border border-dust p-6 md:p-10">
          <h1 className="font-serif text-2xl mb-3">Missing link token</h1>
          <p className="text-saddle mb-6 leading-relaxed">
            This page needs the magic link from your email. If you got an email asking for a
            quick review, click the link there to come back here.
          </p>
          <Link href="/" className="text-charcoal underline">
            Back to BuyHalfCow
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4 py-12">
      <div className="max-w-md w-full bg-white border border-dust p-6 md:p-10">
        <h1 className="font-serif text-2xl mb-2">Quick favor.</h1>
        <p className="text-saddle mb-6 leading-relaxed">
          One rating + one sentence about your beef share. Real words, your voice. Takes 30 seconds &mdash;
          your review helps the next family find verified beef.
        </p>
        <ReviewSubmitForm token={token} />
        <p className="mt-8 text-xs text-saddle leading-relaxed">
          We share first name + state only &mdash; never your last name or email.
        </p>
      </div>
    </main>
  );
}
