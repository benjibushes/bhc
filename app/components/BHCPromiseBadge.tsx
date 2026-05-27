export default function BHCPromiseBadge() {
  return (
    <div className="border-l-4 border-sage-dark bg-white p-6">
      <h2 className="font-serif text-lg uppercase tracking-widest text-sage-dark mb-3">
        <span aria-hidden="true">🛡️</span> BHC Promise
      </h2>
      <p className="text-sm text-charcoal leading-relaxed mb-4">
        Beef arrives frozen and on time, or BHC refunds your deposit within 7 days — no questions asked, paid by BuyHalfCow.
      </p>
      <ul className="text-sm text-charcoal leading-relaxed space-y-2">
        <li className="flex gap-2">
          <span className="text-sage-dark" aria-hidden="true">•</span>
          <span><strong>Cold-chain guarantee:</strong> if your beef arrives thawed, it&apos;s free.</span>
        </li>
        <li className="flex gap-2">
          <span className="text-sage-dark" aria-hidden="true">•</span>
          <span><strong>7-day satisfaction:</strong> not what you expected? Full deposit refund.</span>
        </li>
        <li className="flex gap-2">
          <span className="text-sage-dark" aria-hidden="true">•</span>
          <span><strong>We mediate:</strong> any dispute, reply to your match thread or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> and we step in.</span>
        </li>
      </ul>
    </div>
  );
}
