import type { Metadata } from 'next';
import { getAllRecords, TABLES } from '@/lib/airtable';
import Container from '../components/Container';
import StickyMobileCTA from '../components/StickyMobileCTA';
import DiscoverMapClient from './components/DiscoverMapClient';

// Revalidate the public map every 30 minutes — fresh enough for new
// prospects + claimed flips, slow enough to keep Airtable load tame.
export const revalidate = 1800;

export const metadata: Metadata = {
  title: 'Discover Map — Direct-to-Consumer Ranchers Across America',
  description:
    'Every direct-to-consumer rancher in America we know about. Verified partners + prospects we are working to bring into the network.',
  openGraph: {
    title: 'BuyHalfCow Discover Map — Direct-to-Consumer Ranchers',
    description:
      'A live map of every direct-to-consumer rancher in America. Verified partners + prospects.',
  },
};

// MapPin shape passed from server → client. Keep it small; don't leak email,
// phone, or operator name on prospect pins (legal + spam concern).
export type MapPin = {
  id: string;
  ranchName: string;
  state: string;
  slug: string;
  // 'self-submitted' = added via /map/add-a-rancher (yellow pin). Distinct from
  // 'prospect' (grey, ranchers we discovered ourselves) and 'verified' (green,
  // signed partners). Yellow pins are NOT routed customers — see
  // isRancherOperationalForBuyers.
  status: 'verified' | 'prospect' | 'self-submitted';
  primaryProduct: string;
  lat: number;
  lng: number;
  city?: string;
};

async function fetchPins(): Promise<MapPin[]> {
  // Only show records that are either Verified or Prospect, AND not hidden,
  // AND have valid lat/lng coordinates. (No coords = nothing to plot.)
  const formula = `AND(
    OR({Verification Status} = "Verified", {Verification Status} = "Prospect"),
    NOT({Public Map Hidden} = 1),
    {Latitude} != BLANK(),
    {Longitude} != BLANK()
  )`.replace(/\s+/g, ' ');

  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.RANCHERS, formula)) as any[];
  } catch (e) {
    console.error('[/map] failed to fetch pins:', e);
    return [];
  }

  return rows
    .map((r) => {
      const lat = Number(r['Latitude']);
      const lng = Number(r['Longitude']);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      const verification = (r['Verification Status'] || '').toString();
      const selfSubmittedAt = (r['Self-Submitted At'] || '').toString();
      // Status priority: Verified always wins. Otherwise self-submitted
      // (yellow) takes precedence over generic prospect (grey) — yellow
      // pins are real humans who raised their hand or were flagged by a
      // fan, distinct from cold-discovered prospects.
      let status: MapPin['status'];
      if (verification === 'Verified') {
        status = 'verified';
      } else if (selfSubmittedAt) {
        status = 'self-submitted';
      } else {
        status = 'prospect';
      }
      const ranchName = (r['Ranch Name'] || r['Operator Name'] || 'Ranch').toString();
      return {
        id: r.id,
        ranchName,
        state: (r['State'] || '').toString(),
        slug: (r['Slug'] || '').toString(),
        status,
        primaryProduct: (r['Primary Product'] || 'Beef').toString(),
        lat,
        lng,
      };
    })
    .filter((x): x is MapPin => x !== null);
}

function deriveStats(pins: MapPin[]) {
  const verified = pins.filter((p) => p.status === 'verified').length;
  const selfSubmitted = pins.filter((p) => p.status === 'self-submitted').length;
  const prospects = pins.filter((p) => p.status === 'prospect').length;
  const states = new Set(pins.map((p) => p.state).filter(Boolean));
  return { verified, prospects, selfSubmitted, statesCovered: states.size };
}

export default async function MapPage() {
  const pins = await fetchPins();
  const stats = deriveStats(pins);

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <section className="py-16 md:py-20 border-b border-divider/10">
        <Container>
          <div className="max-w-3xl space-y-5">
            <p className="text-xs uppercase tracking-[0.2em] text-saddle">Discover Map</p>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight">
              Every direct-to-consumer rancher in America
            </h1>
            <p className="text-lg text-charcoal/80 leading-relaxed">
              We&rsquo;re building the public hit list. <strong>Green pins</strong> are
              verified BuyHalfCow partners shipping today. <strong>Yellow pins</strong>{' '}
              are ranchers who raised their hand or were flagged by a fan.{' '}
              <strong>Grey pins</strong> are prospects we found and are working to bring
              in.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-saddle pt-1">
              <span>
                <strong className="text-charcoal">{stats.verified}</strong> verified
              </span>
              <span aria-hidden className="text-dust">
                ·
              </span>
              <span>
                <strong className="text-charcoal">{stats.selfSubmitted}</strong>{' '}
                self-submitted
              </span>
              <span aria-hidden className="text-dust">
                ·
              </span>
              <span>
                <strong className="text-charcoal">{stats.prospects}</strong> working with us
              </span>
              <span aria-hidden className="text-dust">
                ·
              </span>
              <span>
                <strong className="text-charcoal">{stats.statesCovered}</strong> states
              </span>
            </div>
            <div className="pt-3">
              <a
                href="/map/add-a-rancher"
                className="inline-flex items-center gap-2 px-6 py-3 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
              >
                Add a rancher to the map
                <span aria-hidden>→</span>
              </a>
            </div>
          </div>
        </Container>
      </section>

      <section className="py-10 md:py-12">
        <Container>
          <DiscoverMapClient pins={pins} />
          <p className="mt-6 text-xs text-dust">
            Are you on this map and want it removed? Use the &ldquo;remove me&rdquo; link on
            your listing&rsquo;s page.
          </p>
        </Container>
      </section>

      <StickyMobileCTA
        href="/map/add-a-rancher"
        label="Add a rancher to the map"
        subLabel={`${stats.verified + stats.selfSubmitted + stats.prospects} pins · ${stats.statesCovered} states`}
      />
    </main>
  );
}
