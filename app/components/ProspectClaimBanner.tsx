import Link from 'next/link';

// Banner that renders at the top of any rancher landing page where
// `Verification Status === 'Prospect'`. Two purposes:
//   1. Tell visitors this is an unclaimed listing built from public info
//      (sets honest expectations — not a verified shipping partner).
//   2. Give the operator (or someone who knows them) a one-click path to
//      claim the listing.
export default function ProspectClaimBanner({
  ranchName,
  slug,
  state,
}: {
  ranchName: string;
  slug: string;
  state?: string;
}) {
  return (
    <div className="bg-[#FAF8F4] border-b border-dust">
      <div className="mx-auto max-w-[1100px] px-6 py-5 flex flex-col md:flex-row md:items-center gap-4 justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-widest text-saddle">
            Unclaimed listing
          </p>
          <p className="text-sm text-charcoal/80 leading-relaxed">
            This page was built from public information about {ranchName}
            {state ? ` (${state})` : ''}. We haven&rsquo;t verified the operator yet
            and we don&rsquo;t handle ordering for them.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 shrink-0">
          <Link
            href={`/ranchers/${slug}/claim`}
            className="inline-block px-5 py-2 border border-charcoal text-sm tracking-wide hover:bg-charcoal hover:text-bone transition-colors whitespace-nowrap"
          >
            Are you {ranchName}? Claim your listing →
          </Link>
          <Link
            href={`/ranchers/${slug}/remove`}
            className="text-xs text-dust hover:text-charcoal underline self-center whitespace-nowrap"
          >
            Remove me
          </Link>
        </div>
      </div>
    </div>
  );
}
