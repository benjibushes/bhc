'use client';

// Live preview — mini render of what /ranchers/[slug] will look like with
// the rancher's wizard data. Updates on every keystroke. Sticky on desktop
// (sits beside the form), accordion on mobile (collapsed by default).
//
// Goal: rancher SEES their public listing build. The visceral upgrade —
// not just trust signals, but proof of the product they're getting.

type PreviewProps = {
  ranchName: string;
  operatorName: string;
  city: string;
  state: string;
  shipsTo?: string;
  beefTypes?: string;
  logoUrl?: string;
  tagline?: string;
  aboutText?: string;
  videoUrl?: string;
  quarterPrice?: any;
  quarterLbs?: string;
  halfPrice?: any;
  halfLbs?: string;
  wholePrice?: any;
  wholeLbs?: string;
  tierSpecialty?: string[];
  isLive?: boolean; // true after sign-agreement; flips Verified badge → green
};

export default function LivePreview(props: PreviewProps) {
  const {
    ranchName,
    operatorName,
    city,
    state,
    shipsTo,
    beefTypes,
    logoUrl,
    tagline,
    aboutText,
    quarterPrice,
    quarterLbs,
    halfPrice,
    halfLbs,
    wholePrice,
    wholeLbs,
    tierSpecialty = [],
    isLive,
  } = props;

  const locationLine = [city, state].filter(Boolean).join(', ');

  return (
    <div className="border border-dust bg-bone overflow-hidden">
      {/* Browser chrome — signals "this is what families see" */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-dust bg-bone-deep">
        <span className="w-2.5 h-2.5 rounded-full bg-dust/70" aria-hidden />
        <span className="w-2.5 h-2.5 rounded-full bg-dust/70" aria-hidden />
        <span className="w-2.5 h-2.5 rounded-full bg-dust/70" aria-hidden />
        <span className="ml-3 text-[11px] text-saddle font-mono truncate">
          buyhalfcow.com/ranchers/{slugify(ranchName)}
        </span>
      </div>

      {/* Cinematic hero — gradient fallback for now (no cover photo in wizard);
          real /ranchers/[slug] uses a gallery photo. */}
      <div className="relative bg-gradient-to-br from-charcoal via-divider to-saddle text-bone p-5 md:p-6 min-h-[180px]">
        <div className="space-y-3">
          {/* Status pills */}
          <div className="flex flex-wrap gap-1.5">
            {isLive ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold bg-sage/20 border border-sage/40 text-sage">
                <span aria-hidden>✓</span> Verified partner
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold bg-amber/20 border border-amber/40 text-amber-dark">
                Preview · not live yet
              </span>
            )}
            {locationLine && (
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest font-semibold bg-bone/15 text-bone">
                {locationLine}
              </span>
            )}
            {beefTypes && (
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest font-semibold bg-bone/15 text-bone">
                {beefTypes.length > 22 ? beefTypes.slice(0, 22) + '…' : beefTypes}
              </span>
            )}
          </div>

          {/* Logo + name */}
          <div className="flex items-center gap-3">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={ranchName ? `${ranchName} logo` : 'Logo'}
                className="h-12 w-12 object-contain bg-bone p-1 border border-bone/40"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : null}
            <h3 className="font-serif text-xl md:text-2xl text-bone leading-tight">
              {ranchName || 'Your Ranch'}
            </h3>
          </div>

          {tagline ? (
            <p className="text-sm text-bone/85 leading-relaxed line-clamp-2">{tagline}</p>
          ) : (
            <p className="text-sm text-bone/40 italic">Tagline appears here…</p>
          )}
        </div>
      </div>

      {/* Quick fact strip */}
      {(shipsTo || operatorName) && (
        <div className="bg-bone-warm border-b border-dust px-4 py-2.5 text-[11px] flex flex-wrap gap-x-4 gap-y-1 text-charcoal/85">
          {operatorName && (
            <span>
              <span className="text-saddle">Operator</span>{' '}
              <strong>{operatorName}</strong>
            </span>
          )}
          {shipsTo && (
            <span>
              <span className="text-saddle">Ships to</span>{' '}
              <strong>{shipsTo}</strong>
            </span>
          )}
        </div>
      )}

      {/* Pricing section — only renders if anything set */}
      {(quarterPrice || halfPrice || wholePrice) && (
        <div className="p-4 md:p-5 space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-saddle font-semibold">
            Available shares
          </p>
          <div className="grid grid-cols-3 gap-2">
            <PriceTile
              label="Quarter"
              price={quarterPrice}
              lbs={quarterLbs}
              dimmed={tierSpecialty.length > 0 && !tierSpecialty.includes('Quarter')}
            />
            <PriceTile
              label="Half"
              price={halfPrice}
              lbs={halfLbs}
              dimmed={tierSpecialty.length > 0 && !tierSpecialty.includes('Half')}
            />
            <PriceTile
              label="Whole"
              price={wholePrice}
              lbs={wholeLbs}
              dimmed={tierSpecialty.length > 0 && !tierSpecialty.includes('Whole')}
            />
          </div>
        </div>
      )}

      {/* About text — collapsed preview */}
      {aboutText && (
        <div className="p-4 md:p-5 border-t border-dust">
          <p className="text-[10px] uppercase tracking-widest text-saddle font-semibold mb-1.5">
            About {operatorName ? operatorName.split(' ')[0] : ranchName || 'the ranch'}
          </p>
          <p className="text-xs text-charcoal/80 leading-relaxed line-clamp-4 whitespace-pre-line">
            {aboutText}
          </p>
        </div>
      )}

      {/* Empty hint when nothing's been filled yet */}
      {!aboutText && !quarterPrice && !halfPrice && !wholePrice && !beefTypes && (
        <div className="p-5 text-xs text-dust italic text-center">
          Fill in details to see your listing build…
        </div>
      )}
    </div>
  );
}

function PriceTile({
  label,
  price,
  lbs,
  dimmed,
}: {
  label: string;
  price: any;
  lbs?: string;
  dimmed?: boolean;
}) {
  if (!price) {
    return (
      <div className={`border border-dust p-2 text-center ${dimmed ? 'opacity-30' : ''}`}>
        <p className="text-[10px] uppercase tracking-widest text-saddle">{label}</p>
        <p className="text-xs text-dust mt-0.5">—</p>
      </div>
    );
  }
  return (
    <div className={`border border-charcoal p-2 text-center ${dimmed ? 'opacity-50' : ''}`}>
      <p className="text-[10px] uppercase tracking-widest text-saddle">{label}</p>
      <p className="font-serif text-base text-charcoal mt-0.5">${price}</p>
      {lbs && <p className="text-[10px] text-saddle mt-0.5">{lbs}</p>}
    </div>
  );
}

function slugify(s: string): string {
  return (s || 'your-ranch')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
