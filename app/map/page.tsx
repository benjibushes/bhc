import type { Metadata } from 'next';
import { getAllRecords, TABLES } from '@/lib/airtable';
import Container from '../components/Container';
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
  status: 'verified' | 'prospect';
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
      const status: 'verified' | 'prospect' =
        verification === 'Verified' ? 'verified' : 'prospect';
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
  const prospects = pins.filter((p) => p.status === 'prospect').length;
  const states = new Set(pins.map((p) => p.state).filter(Boolean));
  return { verified, prospects, statesCovered: states.size };
}

export default async function MapPage() {
  const pins = await fetchPins();
  const stats = deriveStats(pins);

  return (
    <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
      <section className="py-12 border-b border-[#2A2A2A]/10">
        <Container>
          <div className="max-w-3xl space-y-3">
            <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
              Discover Map
            </p>
            <h1 className="font-[family-name:var(--font-playfair)] text-4xl md:text-5xl">
              Every direct-to-consumer rancher in America
            </h1>
            <p className="text-[#0E0E0E]/80 leading-relaxed">
              We&rsquo;re building the public hit list. Green pins are verified BuyHalfCow
              partners shipping today. Grey pins are ranchers we found and are
              working to bring into the network.
            </p>
            <p className="text-sm text-[#6B4F3F]">
              <strong>{stats.verified}</strong> verified ·{' '}
              <strong>{stats.prospects}</strong> working with us ·{' '}
              <strong>{stats.statesCovered}</strong> states covered
            </p>
          </div>
        </Container>
      </section>

      <section className="py-8">
        <Container>
          <DiscoverMapClient pins={pins} />
          <p className="mt-4 text-xs text-[#A7A29A]">
            Are you on this map and want it removed? Use the &ldquo;remove me&rdquo; link on
            your listing&rsquo;s page.
          </p>
        </Container>
      </section>
    </main>
  );
}
