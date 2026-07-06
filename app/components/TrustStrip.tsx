// TrustStrip — the one canonical commerce trust line. Was retyped inline with
// slightly drifting wording on /shop, the PDP, and the low-ticket checkout;
// centralizing it means the trust promise reads identically everywhere it
// appears (and there's exactly one place to edit it).
//
// Copy rules (docs/BHC.md): lowercase, honest, no fake scarcity, "— ben"
// signature. "shipping included" is the all-in pricing model Ben chose —
// every marketplace product's display price covers shipping.

export default function TrustStrip({ className = '' }: { className?: string }) {
  return (
    <p className={`text-sm text-saddle ${className}`}>
      <span className="text-sage">verified ranch</span> · shipping included · secured by stripe ·
      a real person answers your receipt — ben
    </p>
  );
}
