'use client';

export default function BrandPaymentSuccess() {
  return (
    <main className="min-h-screen bg-[#F4F1EC] flex items-center justify-center px-4">
      <div className="max-w-lg w-full bg-white border border-[#A7A29A] p-8 md:p-12 text-center">
        <div className="text-5xl mb-4">&#10003;</div>
        <h1 className="font-serif text-3xl mb-2">Payment Confirmed</h1>
        <p className="text-[#6B4F3F] mb-6">
          Your brand is now live on the BuyHalfCow network.
        </p>

        <div className="border border-[#A7A29A] p-6 mb-6 text-left">
          <h2 className="font-serif text-lg mb-3">What Happens Next</h2>
          <ol className="space-y-2 text-sm text-[#6B4F3F] list-decimal list-inside">
            <li>Your brand is now featured on the member dashboard</li>
            <li>Ranchers in our network can see your discount and promote it</li>
            <li>Members will see your offer alongside their beef orders</li>
          </ol>
        </div>

        <p className="text-sm text-[#6B4F3F] mb-6">
          A confirmation email has been sent with your receipt and listing details.
        </p>

        <a
          href="/"
          className="inline-block bg-[#0E0E0E] text-[#F4F1EC] py-3 px-8 font-bold uppercase tracking-widest text-sm hover:bg-[#2A2A2A] transition-colors"
        >
          Back to BuyHalfCow
        </a>

        <p className="text-xs text-[#A7A29A] mt-6">
          Questions about your listing? Email support@buyhalfcow.com
        </p>
      </div>
    </main>
  );
}
