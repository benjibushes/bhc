import type { Metadata } from 'next';
import Container from '../components/Container';
import Pill from '../components/Pill';
import Card from '../components/Card';
import StickyMobileCTA from '../components/StickyMobileCTA';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { normalizeImageUrl } from '@/lib/imageUrl';

// Public case-study wall. Pulls every Closed Won referral from Airtable,
// renders each as a card. Aggregate stats at top. Updates automatically as
// ranchers close — no CMS, no manual upkeep.
//
// Privacy: we show rancher name + state + sale amount + buyer FIRST initial
// only ("J.K., Bozeman MT"). Buyer first names + locations only — never
// emails, phones, last names. Anything that feels exposing gets stripped.
//
// 30-min cache. Recomputed when traffic comes in. Acceptable freshness for
// a marketing page; Telegram alert + monthly digest cover real-time needs.

export const revalidate = 1800;

export const metadata: Metadata = {
  title: 'Wins — Real deals closed',
  description:
    'Every closed deal on the BuyHalfCow network. Real ranchers, real families, real beef in freezers. The proof.',
  openGraph: {
    title: 'BuyHalfCow Wins — Real deals on the network',
    description:
      'Every closed deal — real ranchers, real families, real beef.',
  },
};

type Win = {
  id: string;
  rancherName: string;
  rancherSlug: string;
  rancherState: string;
  buyerInitial: string;
  buyerCity: string;
  buyerState: string;
  saleAmount: number;
  orderType: string;
  closedAt: string;
  rancherLogo?: string;
};

async function fetchWins(): Promise<{
  wins: Win[];
  totalGmv: number;
  totalDeals: number;
  rancherCount: number;
  stateCount: number;
}> {
  let refs: any[] = [];
  let ranchers: any[] = [];
  try {
    [refs, ranchers] = (await Promise.all([
      getAllRecords(TABLES.REFERRALS, '{Status} = "Closed Won"'),
      getAllRecords(TABLES.RANCHERS),
    ])) as [any[], any[]];
  } catch (e) {
    console.error('[/wins] fetch failed:', e);
    return { wins: [], totalGmv: 0, totalDeals: 0, rancherCount: 0, stateCount: 0 };
  }

  // Map rancher id → minimal info for hydrating wins.
  const rancherMap = new Map<string, any>();
  for (const r of ranchers) rancherMap.set(r.id, r);

  const wins: Win[] = refs
    .map((ref) => {
      const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
      const rancher = rancherMap.get(rancherIds[0]);
      if (!rancher) return null;
      // Buyer privacy — first initial of name only.
      const buyerName = (ref['Buyer Name'] || '').toString().trim();
      const initial = buyerName ? `${buyerName[0]}.${buyerName.split(' ')[1]?.[0] || ''}` : '?';
      return {
        id: ref.id,
        rancherName: rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch',
        rancherSlug: (rancher['Slug'] || '').toString(),
        rancherState: (rancher['State'] || '').toString(),
        buyerInitial: initial,
        buyerCity: '', // we don't store buyer city; left blank for safety
        buyerState: (ref['Buyer State'] || '').toString(),
        saleAmount: Number(ref['Sale Amount']) || 0,
        orderType: (ref['Order Type'] || 'Beef').toString(),
        closedAt: (ref['Closed At'] || '').toString(),
        rancherLogo: normalizeImageUrl((rancher['Logo URL'] || '').toString()),
      } as Win;
    })
    .filter((w): w is Win => w !== null && w.saleAmount > 0)
    .sort((a, b) => (b.closedAt > a.closedAt ? 1 : -1));

  const totalGmv = wins.reduce((s, w) => s + w.saleAmount, 0);
  const rancherSet = new Set(wins.map((w) => w.rancherSlug).filter(Boolean));
  const stateSet = new Set(wins.map((w) => w.rancherState).filter(Boolean));

  return {
    wins,
    totalGmv,
    totalDeals: wins.length,
    rancherCount: rancherSet.size,
    stateCount: stateSet.size,
  };
}

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

export default async function WinsPage() {
  const { wins, totalGmv, totalDeals, rancherCount, stateCount } = await fetchWins();

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <section className="py-16 md:py-24 border-b border-divider/10">
        <Container>
          <div className="max-w-3xl space-y-5">
            <Pill tone="positive">Real deals · real ranchers</Pill>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight">
              The proof, on a wall.
            </h1>
            <p className="text-lg text-charcoal/80 leading-relaxed">
              Every closed deal on the BuyHalfCow network &mdash; updated live as
              ranchers mark wins. No vanity metrics. No "thousands of customers"
              fluff. Just the actual list of families who bought real beef from
              real ranchers because we connected them.
            </p>

            {/* Aggregate stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-dust/60">
              <Stat
                value={`$${totalGmv.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
                label="Total GMV"
              />
              <Stat value={String(totalDeals)} label={totalDeals === 1 ? 'Deal closed' : 'Deals closed'} />
              <Stat value={String(rancherCount)} label={rancherCount === 1 ? 'Rancher' : 'Ranchers'} />
              <Stat value={String(stateCount)} label={stateCount === 1 ? 'State' : 'States'} />
            </div>
          </div>
        </Container>
      </section>

      {/* Wins grid */}
      <section className="py-14 md:py-16">
        <Container>
          {wins.length === 0 ? (
            <div className="max-w-3xl mx-auto space-y-8">
              <div className="text-center space-y-3">
                <Pill tone="amber" className="mx-auto">Coming soon</Pill>
                <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
                  First deal posts here the moment it closes.
                </h2>
                <p className="text-saddle max-w-xl mx-auto leading-relaxed">
                  No vanity placeholders. When a real rancher closes a real deal
                  with a real family, it goes here automatically. Until then,
                  here&rsquo;s what these will look like.
                </p>
              </div>

              {/* Preview cards — show ranchers already on the network so the page
                  feels populated. Renders examples even before any closes. */}
              <div className="grid md:grid-cols-2 gap-5">
                <Card variant="default" padding="lg" className="space-y-4 opacity-70 border-dashed">
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 bg-bone-deep border border-dust flex items-center justify-center shrink-0">
                      <span className="font-serif text-xl text-saddle">A</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                        Example
                      </p>
                      <p className="font-serif text-lg text-charcoal leading-tight">
                        A verified ranch in your state
                      </p>
                      <p className="text-xs text-saddle">XX</p>
                    </div>
                  </div>
                  <div className="border-t border-dust/60 pt-3 space-y-1.5">
                    <p className="text-2xl font-serif text-charcoal">$1,200</p>
                    <p className="text-sm text-charcoal/85">
                      Half cow · sold to S.K., MT
                    </p>
                  </div>
                </Card>
                <Card variant="default" padding="lg" className="space-y-4 opacity-70 border-dashed">
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 bg-bone-deep border border-dust flex items-center justify-center shrink-0">
                      <span className="font-serif text-xl text-saddle">B</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                        Example
                      </p>
                      <p className="font-serif text-lg text-charcoal leading-tight">
                        Another verified ranch
                      </p>
                      <p className="text-xs text-saddle">XX</p>
                    </div>
                  </div>
                  <div className="border-t border-dust/60 pt-3 space-y-1.5">
                    <p className="text-2xl font-serif text-charcoal">$2,400</p>
                    <p className="text-sm text-charcoal/85">
                      Whole cow · sold to J.R., CO
                    </p>
                  </div>
                </Card>
              </div>

              <p className="text-center text-sm text-saddle">
                Want yours up here?{' '}
                <a href="/access" className="underline underline-offset-2 hover:text-charcoal">Take the quiz</a>
                {' · '}
                <a href="/map/add-a-rancher" className="underline underline-offset-2 hover:text-charcoal">Or add a rancher</a>
              </p>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 max-w-6xl mx-auto">
              {wins.map((w) => (
                <Card key={w.id} variant="default" padding="lg" className="space-y-4">
                  <div className="flex items-start gap-3">
                    {w.rancherLogo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={w.rancherLogo}
                        alt={`${w.rancherName} logo`}
                        className="w-12 h-12 object-contain bg-bone-warm border border-dust p-1 shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 bg-bone-deep border border-dust flex items-center justify-center shrink-0">
                        <span className="font-serif text-xl text-saddle">
                          {w.rancherName.charAt(0)}
                        </span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                        {formatDate(w.closedAt)}
                      </p>
                      <p className="font-serif text-lg text-charcoal leading-tight truncate">
                        {w.rancherName}
                      </p>
                      <p className="text-xs text-saddle">{w.rancherState}</p>
                    </div>
                  </div>
                  <div className="border-t border-dust/60 pt-3 space-y-1.5">
                    <p className="text-2xl font-serif text-charcoal">
                      ${w.saleAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </p>
                    <p className="text-sm text-charcoal/85">
                      {w.orderType} · sold to {w.buyerInitial}
                      {w.buyerState ? `, ${w.buyerState}` : ''}
                    </p>
                  </div>
                  {w.rancherSlug && (
                    <a
                      href={`/ranchers/${w.rancherSlug}`}
                      className="inline-flex items-center gap-1 text-xs uppercase tracking-widest font-semibold text-saddle hover:text-charcoal underline underline-offset-2"
                    >
                      Visit {w.rancherName}
                      <span aria-hidden>→</span>
                    </a>
                  )}
                </Card>
              ))}
            </div>
          )}
        </Container>
      </section>

      {/* Bottom CTAs */}
      <section className="py-14 border-t border-dust/40">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-4">
            <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
              Want to be on this list?
            </h2>
            <p className="text-saddle leading-relaxed">
              Whether you&rsquo;re a rancher with beef to sell or a family
              looking for it &mdash; we&rsquo;ll match you in your state.
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-2">
              <a
                href="/access"
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
              >
                I want beef →
              </a>
              <a
                href="/map/add-a-rancher"
                className="inline-flex items-center gap-2 px-7 py-3.5 border border-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-charcoal hover:text-bone"
              >
                I&rsquo;m a rancher →
              </a>
            </div>
          </div>
        </Container>
      </section>

      <StickyMobileCTA
        href="/access"
        label="Take the 90-second quiz"
        subLabel={totalDeals > 0 ? `${totalDeals} deals · $${Math.round(totalGmv / 1000)}k GMV` : undefined}
      />
    </main>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-l-2 border-charcoal pl-3">
      <p className="font-serif text-2xl md:text-3xl text-charcoal leading-tight">
        {value}
      </p>
      <p className="text-[11px] uppercase tracking-widest text-saddle mt-1">
        {label}
      </p>
    </div>
  );
}
