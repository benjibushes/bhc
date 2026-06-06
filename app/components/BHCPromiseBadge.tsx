export default function BHCPromiseBadge() {
  return (
    <div className="border-l-4 border-sage-dark bg-white p-6">
      <h2 className="font-serif text-lg uppercase tracking-widest text-sage-dark mb-3">
        <span aria-hidden="true">🛡️</span> BHC Promise
      </h2>
      <p className="text-sm text-charcoal leading-relaxed mb-4">
        Your deposit reserves your slot. It&rsquo;s fully refundable until your
        rancher accepts it (usually within 24&ndash;48 hours). Once they commit
        your processing slot, it becomes non-refundable. Cold-chain guarantee
        and BHC mediation apply either way.
      </p>
      <ul className="text-sm text-charcoal leading-relaxed space-y-2">
        <li className="flex gap-2">
          <span className="text-sage-dark" aria-hidden="true">•</span>
          <span><strong>Refundable window:</strong> change your mind before your rancher accepts? Full refund.</span>
        </li>
        <li className="flex gap-2">
          <span className="text-sage-dark" aria-hidden="true">•</span>
          <span><strong>Non-refundable once accepted:</strong> after they commit your slot, they&rsquo;ve set aside cuts of meat and locked in processing. You&rsquo;ll get a &ldquo;slot locked&rdquo; email the moment that happens.</span>
        </li>
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
