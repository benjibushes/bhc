import type { Metadata } from 'next';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { isRancherOnConnect } from '@/lib/rancherEligibility';
import { normalizeImageUrl } from '@/lib/imageUrl';
import Container from '../components/Container';
import StickyMobileCTA from '../components/StickyMobileCTA';
import DiscoverMapClient from './components/DiscoverMapClient';
import RancherList from './components/RancherList';

// Revalidate the public map every 30 minutes — fresh enough for new
// prospects + claimed flips, slow enough to keep Airtable load tame.
export const revalidate = 1800;

export const metadata: Metadata = {
  title: 'Discover Map — Direct-to-Consumer Ranchers Across America',
  description:
    'Every direct-to-consumer rancher in America we know about. Verified partners + prospects we are working to bring into the network. Add a rancher you know — buyers find the nearest one in their state.',
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
// onboarding pipeline, not just verified vs prospect):
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
  // City — surfaced in popups + the SSR list so two ranchers in the same
  // state are distinguishable ("Weatherford, TX" vs "Lubbock, TX").
  city: string;
  // Conversion fields (mirror app/api/public/ranchers/route.ts). Only the
  // pin card needs these — a logo + a "from $X" hook + a Reserve button turn
  // the popup from a label into a storefront. Prices are raw numbers or null.
  logoUrl: string;
  quarterPrice: number | null;
  halfPrice: number | null;
  wholePrice: number | null;
  // Lowest available tier price — the "from $X" anchor. The label tracks which
  // tier that price is (half/quarter/whole) so the card reads "from $X/half".
  fromPrice: number | null;
  fromLabel: 'half' | 'quarter' | 'whole' | '';
  // Reserve-ability — true only when the storefront will actually render a
  // deposit form for this rancher: tier_v2 pricing model + an ACTIVE Stripe
  // Connect account (mirrors isRancherOnConnect / isRancherOperationalForBuyers).
  // The map must not paint "Reserve →" on a verified rancher who can't take a
  // deposit — that dead-ends the buyer at the checkout page. When false the
  // card shows "View ranch →" (they can still browse + contact on the store).
  onConnect: boolean;
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

      // Reserve-ability gate — the storefront only shows a deposit form for
      // tier_v2 ranchers with an ACTIVE Stripe Connect account. Use the SAME
      // canonical helper the deposit path uses so the map CTA ("Reserve →" vs
      // "View ranch →") can never drift from what the rancher's page actually
      // offers. A verified pin without Connect is real + browsable but not
      // deposit-ready — sending a buyer to a deposit there is a dead-end.
      const onConnect = isRancherOnConnect(r);

      // Prices — Airtable stores these as numbers. Coerce defensively (a
      // stray "$1,800" string or empty cell must become null, never NaN).
      const toPrice = (v: unknown): number | null => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(typeof v === 'string' ? v.replace(/[^0-9.]/g, '') : v);
        return isFinite(n) && n > 0 ? n : null;
      };
      const quarterPrice = toPrice(r['Quarter Price']);
      const halfPrice = toPrice(r['Half Price']);
      const wholePrice = toPrice(r['Whole Price']);

      // "from $X" anchor — cheapest entry point wins (almost always the
      // quarter, then half, then whole). The label tracks the tier so the
      // card can read "from $X/quarter". Only verified pins carry pricing on
      // the card (non-verified ranchers haven't set/confirmed prices), but we
      // compute it for all so the SSR list can show it where present.
      let fromPrice: number | null = null;
      let fromLabel: MapPin['fromLabel'] = '';
      if (quarterPrice) { fromPrice = quarterPrice; fromLabel = 'quarter'; }
      else if (halfPrice) { fromPrice = halfPrice; fromLabel = 'half'; }
      else if (wholePrice) { fromPrice = wholePrice; fromLabel = 'whole'; }

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
        city: (r['City'] || '').toString(),
        // Same normalize the public API applies — rewrites Dropbox/Drive
        // sharing URLs to raw image bytes so <img src> renders the logo.
        logoUrl: normalizeImageUrl((r['Logo URL'] || '').toString()),
        quarterPrice,
        halfPrice,
        wholePrice,
        fromPrice,
        fromLabel,
        onConnect,
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
            <p className="text-xs uppercase tracking-[0.2em] text-saddle">find a rancher near you</p>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight lowercase">
              {stats.verified > 0 ? (
                <>
                  {stats.verified} rancher{stats.verified === 1 ? '' : 's'} shipping
                  beef today
                </>
              ) : (
                <>every direct-to-consumer rancher in america</>
              )}
            </h1>
            <p className="text-lg text-charcoal/80 leading-relaxed">
              Drop a pin in your state and reserve a quarter, half, or whole direct
              from the rancher who raised it. Green pins are verified partners
              shipping right now — orange and grey show who&rsquo;s coming next.
            </p>
            {/* Lead with what a buyer can act on TODAY (verified + states).
                Pipeline-vanity counts (onboarding/self-submitted/prospect) are
                demoted to a quieter second line so the hero sells availability,
                not a CRM funnel. */}
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 pt-1">
              <span className="text-saddle text-sm">
                <strong className="text-charcoal text-xl align-baseline">{stats.verified}</strong>{' '}
                shipping today
              </span>
              <span className="text-saddle text-sm">
                <strong className="text-charcoal text-xl align-baseline">{stats.statesCovered}</strong>{' '}
                states on the map
              </span>
            </div>
            <p className="text-xs text-dust">
              Pipeline: {stats.onboarding} onboarding · {stats.selfSubmitted} self-submitted ·{' '}
              {stats.prospects} prospects we&rsquo;re working to bring in.
            </p>
            <div className="flex flex-wrap gap-3 pt-3">
              <a
                href="/access"
                className="inline-flex items-center gap-2 px-6 py-3 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
              >
                Find a rancher near you
                <span aria-hidden>→</span>
              </a>
              <a
                href="/map/add-a-rancher"
                className="inline-flex items-center gap-2 px-6 py-3 border-2 border-charcoal text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-charcoal hover:text-bone"
              >
                Add a rancher
                <span aria-hidden>→</span>
              </a>
            </div>
          </div>
        </Container>
      </section>

      <section className="py-10 md:py-12">
        <Container>
          {/* The map module is ssr:false (Leaflet touches `window`), so Google
              would otherwise index an empty <div>. We pass a fully server-
              rendered, crawlable <ul> of ranchers (name · City, ST · from $X ·
              link) as `listSlot`; the client wrapper toggles list/map view but
              the list markup is always in the initial HTML for SEO. */}
          <DiscoverMapClient
            pins={pins}
            listSlot={<RancherList pins={pins} />}
          />
          <p className="mt-6 text-xs text-dust">
            Are you on this map and want it removed? Use the &ldquo;remove me&rdquo; link on
            your listing&rsquo;s page.
          </p>
        </Container>
      </section>

      <StickyMobileCTA
        href="/access"
        label="Find a rancher near you"
        subLabel={`${stats.verified} shipping today · ${stats.statesCovered} states`}
      />
    </main>
  );
}
