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
// phone, or operator name on non-verified pins (legal + spam concern).
//
// Pipeline-aligned status (added so the public map reflects the full
// onboarding journey, not just verified vs prospect):
//   verified       → Verification=Verified + Onboarding Status=Live
//                    (green pin, public-routable, buyer can reach out)
//   onboarding     → Onboarding Status set + not yet Live
//                    (orange pin — actively being onboarded; visible but not
//                    yet routable). Covers Call Scheduled / Call Complete /
//                    Docs Sent / Agreement Signed / Verification Pending /
//                    Verification Complete.
//   self-submitted → Self-Submitted At set, no onboarding progress yet
//                    (yellow pin — raised hand or fan-flagged)
//   prospect       → cold-discovered, no progress (grey-dashed pin)
//
// Excluded at fetch time:
//   - Verification Status = "Removed" (legal opt-out)
//   - Public Map Hidden = true (admin/blocked)
//   - Active Status = "Paused" or "Non-Compliant" (don't show flagged
//     ranchers on a public discovery surface)
//   - No coordinates (can't plot)
export type MapPin = {
  id: string;
  ranchName: string;
  state: string;
  slug: string;
  status: 'verified' | 'onboarding' | 'self-submitted' | 'prospect';
  // Sub-stage label for onboarding pins — surfaced in the popup so visitors
  // see "Pending verification" / "Docs signed" etc. instead of a generic
  // orange pin. Empty string for non-onboarding statuses.
  stageLabel: string;
  primaryProduct: string;
  lat: number;
  lng: number;
  city?: string;
};

const ONBOARDING_STAGES = [
  'Call Scheduled',
  'Call Complete',
  'Docs Sent',
  'Agreement Signed',
  'Verification Pending',
  'Verification Complete',
];

async function fetchPins(): Promise<MapPin[]> {
  // Pull every rancher we'd consider plottable: Verification not Removed,
  // not hidden, not paused/non-compliant, has lat/lng. Onboarding-stage
  // ranchers join the discovery surface so visitors see the network is
  // alive + filling out, not just "verified or nothing".
  const formula = `AND(
    {Verification Status} != "Removed",
    NOT({Public Map Hidden} = 1),
    {Active Status} != "Paused",
    {Active Status} != "Non-Compliant",
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
      const onboarding = (r['Onboarding Status'] || '').toString();
      const selfSubmittedAt = (r['Self-Submitted At'] || '').toString();

      // Status priority — most-progressed wins.
      //
      // Onboarding="Live" is the canonical terminal state — by the time a
      // rancher reaches Live, they've cleared agreement + verification and
      // are routable. Verification Status is a legacy/duplicate gate; some
      // ranchers reach Live without it ever being flipped to "Verified"
      // (Self-Submit drip path skips that field). Treat Live as verified
      // regardless of Verification Status (Removed is already excluded at
      // fetch time via filterByFormula).
      //
      // Onboarding stages between Call Scheduled and Verification Complete
      // are visible but not yet routable (orange pin). Self-submitted vs
      // cold prospect differentiates raised-hand vs discovered.
      let status: MapPin['status'];
      let stageLabel = '';
      if (onboarding === 'Live') {
        status = 'verified';
      } else if (verification === 'Verified') {
        // Verified field set but Onboarding not yet Live — still treat as
        // verified for the public map (they cleared the verification gate).
        status = 'verified';
      } else if (ONBOARDING_STAGES.includes(onboarding)) {
        status = 'onboarding';
        stageLabel = onboarding;
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
        stageLabel,
        primaryProduct: (r['Primary Product'] || 'Beef').toString(),
        lat,
        lng,
      };
    })
    .filter((x): x is MapPin => x !== null);
}

function deriveStats(pins: MapPin[]) {
  const verified = pins.filter((p) => p.status === 'verified').length;
  const onboarding = pins.filter((p) => p.status === 'onboarding').length;
  const selfSubmitted = pins.filter((p) => p.status === 'self-submitted').length;
  const prospects = pins.filter((p) => p.status === 'prospect').length;
  const states = new Set(pins.map((p) => p.state).filter(Boolean));
  return {
    verified,
    onboarding,
    prospects,
    selfSubmitted,
    statesCovered: states.size,
  };
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
              We&rsquo;re building the public hit list. Pin colors reflect each
              rancher&rsquo;s spot in the pipeline.
            </p>
            <ul className="text-sm text-charcoal/85 leading-relaxed pt-1 space-y-1">
              <li>
                <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-full bg-sage mr-2 align-middle" />
                <strong>Green</strong> — verified partner shipping today
              </li>
              <li>
                <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle" style={{ backgroundColor: '#D97757' }} />
                <strong>Orange</strong> — being onboarded right now (call · docs · agreement · verification)
              </li>
              <li>
                <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-full bg-amber mr-2 align-middle" />
                <strong>Yellow</strong> — raised their hand or flagged by a fan
              </li>
              <li>
                <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-full bg-dust mr-2 align-middle" />
                <strong>Grey</strong> — discovered, not yet engaged
              </li>
            </ul>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-saddle pt-1">
              <span>
                <strong className="text-charcoal">{stats.verified}</strong> verified
              </span>
              <span aria-hidden className="text-dust">·</span>
              <span>
                <strong className="text-charcoal">{stats.onboarding}</strong> onboarding
              </span>
              <span aria-hidden className="text-dust">·</span>
              <span>
                <strong className="text-charcoal">{stats.selfSubmitted}</strong> self-submitted
              </span>
              <span aria-hidden className="text-dust">·</span>
              <span>
                <strong className="text-charcoal">{stats.prospects}</strong> prospects
              </span>
              <span aria-hidden className="text-dust">·</span>
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
        subLabel={`${stats.verified + stats.onboarding + stats.selfSubmitted + stats.prospects} pins · ${stats.statesCovered} states`}
      />
    </main>
  );
}
