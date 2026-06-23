import React from 'react';

// ── Certifications as styled badge chips ─────────────────────────────────
// P1 #4: the existing single plain pill dumped the whole comma-string into
// one chip ("Grass-Fed, USDA, Regenerative"). Here we split on commas, map
// known terms to a styled chip with a small inline-SVG icon, and render any
// unknown term as a plain chip. Server component — pure render, no client JS.
//
// Matching is normalized (lowercase, trimmed, hyphen/space-insensitive) so
// "grass-fed", "Grass Fed", and "GRASSFED" all map to the same badge. We
// also de-dupe so a record that lists "Grass-Fed" and "grass fed" shows one
// chip. Unknown terms (e.g. a specific local cert) still surface verbatim so
// the rancher never loses information they entered.

type IconKey =
  | 'leaf'
  | 'shield'
  | 'cycle'
  | 'sun'
  | 'droplet'
  | 'pill';

interface KnownCert {
  // canonical label shown on the chip
  label: string;
  icon: IconKey;
}

// Normalize a raw token for matching: lowercase, collapse whitespace, drop
// hyphens so "grass-fed" === "grass fed" === "grassfed".
function normalize(term: string): string {
  return term.toLowerCase().replace(/[-\s]+/g, ' ').trim();
}
function matchKey(term: string): string {
  return normalize(term).replace(/\s+/g, '');
}

// Known terms → canonical label + icon. Keys are match-normalized (no spaces).
const KNOWN: Record<string, KnownCert> = {
  grassfed: { label: 'Grass-Fed', icon: 'leaf' },
  grassfinished: { label: 'Grass-Finished', icon: 'leaf' },
  '100grassfed': { label: '100% Grass-Fed', icon: 'leaf' },
  usda: { label: 'USDA', icon: 'shield' },
  usdainspected: { label: 'USDA Inspected', icon: 'shield' },
  usdacertified: { label: 'USDA Certified', icon: 'shield' },
  organic: { label: 'Organic', icon: 'sun' },
  certifiedorganic: { label: 'Certified Organic', icon: 'sun' },
  regenerative: { label: 'Regenerative', icon: 'cycle' },
  pastureraised: { label: 'Pasture-Raised', icon: 'sun' },
  hormonefree: { label: 'Hormone-Free', icon: 'droplet' },
  nohormones: { label: 'No Added Hormones', icon: 'droplet' },
  antibioticfree: { label: 'Antibiotic-Free', icon: 'pill' },
  noantibiotics: { label: 'No Antibiotics', icon: 'pill' },
};

function Icon({ name }: { name: IconKey }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'shrink-0',
  };
  switch (name) {
    case 'leaf':
      return (
        <svg {...common}>
          <path d="M11 20A7 7 0 0 1 4 13c0-4 3-8 9-9 1 6-1 11-2 13" />
          <path d="M4 21c2-3 5-5 9-6" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case 'cycle':
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 4v4h-4" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 20v-4h4" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      );
    case 'droplet':
      return (
        <svg {...common}>
          <path d="M12 3s6 6 6 10a6 6 0 0 1-12 0c0-4 6-10 6-10z" />
        </svg>
      );
    case 'pill':
      return (
        <svg {...common}>
          <rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" />
          <path d="M9 9l6 6" />
        </svg>
      );
  }
}

export default function CertificationBadges({
  raw,
  className = '',
}: {
  raw: string;
  className?: string;
}) {
  // Split on commas, slashes, or pipes — ranchers enter certs inconsistently.
  const tokens = (raw || '')
    .split(/[,/|]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return null;

  // Build display list, de-duping by canonical label (known) or normalized
  // text (unknown).
  const seen = new Set<string>();
  const chips: { label: string; icon: IconKey | null }[] = [];
  for (const token of tokens) {
    const known = KNOWN[matchKey(token)];
    const dedupeKey = known ? `k:${known.label}` : `u:${normalize(token)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    chips.push(known ? { label: known.label, icon: known.icon } : { label: token, icon: null });
  }

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {chips.map((chip, i) =>
        chip.icon ? (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide bg-sage/12 text-sage-dark border border-sage/30"
          >
            <Icon name={chip.icon} />
            {chip.label}
          </span>
        ) : (
          <span
            key={i}
            className="inline-flex items-center px-3 py-1.5 text-xs font-semibold uppercase tracking-wide bg-bone-deep text-charcoal border border-dust"
          >
            {chip.label}
          </span>
        ),
      )}
    </div>
  );
}
