// app/components/AffiliateDisclosure.tsx
//
// One honest FTC disclosure line, in BHC's plainspoken lowercase voice. The FTC
// requires a clear affiliate disclosure adjacent to affiliate links; this
// renders on EVERY gear placement (GearBlock + the /gear page mount it). No
// 'use client' — it's pure presentation, safe in server and client trees alike.

export default function AffiliateDisclosure({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-dust leading-relaxed ${className}`}>
      some links are affiliate links — if you buy, bhc may earn a small
      commission at no extra cost to you. we only recommend gear we&rsquo;d put
      in our own freezer.
    </p>
  );
}
