// TrustStrip — the one canonical commerce trust line. Was retyped inline with
// slightly drifting wording on /shop, the PDP, and the low-ticket checkout;
// centralizing it means the trust promise reads identically everywhere it
// appears (and there's exactly one place to edit it).
//
// Copy rules (docs/BHC.md): lowercase, honest, no fake scarcity, "— ben"
// signature. Shipping: most products bake it into the display price; a
// product with a 'Shipping Cost' shows "+ $X shipping" on its own card/PDP,
// so this strip says the always-true thing (no surprise at checkout) instead
// of a blanket "shipping included" that a priced-shipping product would break.

export default function TrustStrip({ className = '' }: { className?: string }) {
  return (
    <p className={`text-sm text-saddle ${className}`}>
      <span className="text-sage">verified ranch</span> · full cost shown up front · secured by
      stripe · a real person answers your receipt — ben
    </p>
  );
}
