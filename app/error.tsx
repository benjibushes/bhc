'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen py-24 bg-bone-white text-charcoal-black flex items-center justify-center">
      <div className="max-w-md mx-auto text-center space-y-6 px-6">
        <h1 className="font-serif text-4xl">Something went wrong</h1>
        <p className="text-saddle-brown">
          We hit an unexpected error. Please try again or contact support if it persists.
        </p>
        <div className="flex gap-4 justify-center pt-4">
          <button
            onClick={reset}
            className="px-6 py-3 bg-charcoal-black text-bone-white hover:bg-divider transition-colors uppercase font-semibold tracking-wider text-sm"
          >
            Try Again
          </button>
          <a
            href="/"
            className="px-6 py-3 border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors uppercase font-semibold tracking-wider text-sm"
          >
            Go Home
          </a>
        </div>
      </div>
    </main>
  );
}
