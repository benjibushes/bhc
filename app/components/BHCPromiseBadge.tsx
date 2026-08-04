// BHC Promise trust block — rendered on the money pages.
//
// TWO VARIANTS (RAIL-MATRIX 2026-08-04). The default 'connect' copy describes
// the Connect deposit mechanics: refundable until the rancher taps Accept in
// their dashboard (Rancher Accepted At), with a slot-locked email at that
// moment. On the BROKER rail none of that machinery exists — the represented
// ranch has no dashboard and never "accepts a slot" in the system, and the
// deposit sits in BuyHalfCow's own Stripe balance, so a refund comes from
// BuyHalfCow. Rendering the Connect story on the broker checkout promised the
// buyer an email that can never arrive and a refund flow that isn't real.
// The 'broker' variant states the actual mechanics; cold-chain + mediation are
// rail-independent and stay in both.

export default function BHCPromiseBadge({
  variant = 'connect',
}: {
  variant?: 'connect' | 'broker';
}) {
  const broker = variant === 'broker';
  return (
    <div className="border-l-4 border-sage-dark bg-white p-6">
      <h2 className="font-serif text-lg uppercase tracking-widest text-sage-dark mb-3">
        <span aria-hidden="true">🛡️</span> BHC Promise
      </h2>
      <p className="text-sm text-charcoal leading-relaxed mb-4">
        {broker ? (
          <>
            Your deposit reserves your share. It&rsquo;s fully refundable until the
            ranch confirms your animal &mdash; and any refund comes straight back
            from BuyHalfCow. Cold-chain guarantee and BHC mediation apply either
            way.
          </>
        ) : (
          <>
            Your deposit reserves your slot. It&rsquo;s fully refundable until your
            rancher accepts it (usually within 24&ndash;48 hours). Once they commit
            your processing slot, it becomes non-refundable. Cold-chain guarantee
            and BHC mediation apply either way.
          </>
        )}
      </p>
      <ul className="text-sm text-charcoal leading-relaxed space-y-2">
        {broker ? (
          <>
            <li className="flex gap-2">
              <span className="text-sage-dark" aria-hidden="true">•</span>
              <span><strong>Refundable window:</strong> change your mind before the ranch confirms your animal? Email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> and BuyHalfCow refunds your deposit in full.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-sage-dark" aria-hidden="true">•</span>
              <span><strong>Non-refundable once confirmed:</strong> when the ranch confirms your animal, they&rsquo;ve set aside your share and locked in processing.</span>
            </li>
          </>
        ) : (
          <>
            <li className="flex gap-2">
              <span className="text-sage-dark" aria-hidden="true">•</span>
              <span><strong>Refundable window:</strong> change your mind before your rancher accepts? Full refund.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-sage-dark" aria-hidden="true">•</span>
              <span><strong>Non-refundable once accepted:</strong> after they commit your slot, they&rsquo;ve set aside cuts of meat and locked in processing. You&rsquo;ll get a &ldquo;slot locked&rdquo; email the moment that happens.</span>
            </li>
          </>
        )}
        <li className="flex gap-2">
          <span className="text-sage-dark" aria-hidden="true">•</span>
          <span><strong>Cold-chain guarantee:</strong> if your beef arrives thawed or short, BHC makes you whole &mdash; even after acceptance.</span>
        </li>
        <li className="flex gap-2">
          <span className="text-sage-dark" aria-hidden="true">•</span>
          <span><strong>We mediate:</strong> any dispute, reply to your match thread or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> and we step in.</span>
        </li>
      </ul>
    </div>
  );
}
