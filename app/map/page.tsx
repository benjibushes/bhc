import type { Metadata } from 'next';
import { getAllRecords, TABLES, mapPinsFormula } from '@/lib/airtable';
import { derivePinStatus, isPinDepositReady, type MapPinStatus } from '@/lib/mapPinStatus';
import { normalizeImageUrl } from '@/lib/imageUrl';
import Container from '../components/Container';
import StickyMobileCTA from '../components/StickyMobileCTA';
import DiscoverMapClient from './components/DiscoverMapClient';
import MapLegend from './components/MapLegend';
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
// onboarding pipeline, not just verified vs prospect). The bucketing itself
// lives in lib/mapPinStatus (derivePinStatus) so tests can pin it:
//   verified       → Verification=Verified + Onboarding Status=Live
//                    (green pin, public-routable, buyer can reach out)
//   represented    → Broker self-serve ranch (#628/#630): BuyHalfCow
//                    represents it and takes deposits for it TODAY. Never ran
//                    the wizard, never signed anything — all pipeline fields
//                    empty by construction (green pin, tallow center).
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
  status: MapPinStatus;
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
  // Reserve-ability — true only when the rancher's page will actually render
  // a deposit form: Connect rail (tier_v2 + ACTIVE Stripe Connect) OR broker
  // rail (isBrokerRoutable — self-serve + an eligible cut). Computed by
  // lib/mapPinStatus isPinDepositReady, the union of the exact gates each
  // checkout runs. The map must not paint "Reserve →" on a rancher who can't
  // take a deposit — that dead-ends the buyer at the checkout page. When
  // false the card shows "View ranch →" (they can still browse + contact on
  // the store).
  depositReady: boolean;
};

async function fetchPins(): Promise<MapPin[]> {
  // Pull every rancher we'd consider plottable: Verification not Removed,
  // not hidden, not paused/non-compliant, has lat/lng. Onboarding-stage
  // ranchers join the discovery surface so visitors see the network is
  // alive + filling out, not just "verified or nothing".
  //
  // BROKER RAIL (2026-07-31, relaxed Wave A 2026-08-17): a represented ranch
  // is excluded UNLESS Ben opted it in via `Broker Self Serve` — the shared
  // carve-out inside mapPinsFormula (lib/airtable). This is the loosest
  // public surface in the app — no {Page Live} gate, no operational gate, so
  // prospects and mid-onboarding rows plot — which makes it the one place a
  // rancher who never signed up for anything could otherwise appear. Their
  // `Active Status` is blank (passes both != checks), so the carve-out is the
  // ONLY thing keeping token-only represented ranches off the map. A
  // self-serve ranch plots because its page really resolves (the #617 slug
  // carve-out) — the pin links to something that renders.
  const formula = mapPinsFormula();

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
      // Status priority — most-progressed wins; a represented (broker
      // self-serve) ranch buckets 'represented', NOT 'prospect', even though
      // all its pipeline fields are empty. The full doctrine + ordering lives
      // with the shared bucketing in lib/mapPinStatus.
      const { status, stageLabel } = derivePinStatus(r);

      const ranchName = (r['Ranch Name'] || r['Operator Name'] || 'Ranch').toString();

      // Reserve-ability gate — a page only shows a deposit form on the
      // Connect rail (tier_v2 + ACTIVE Connect) or the broker rail
      // (isBrokerRoutable). isPinDepositReady is the union of the SAME
      // canonical gates each checkout runs, so the map CTA ("Reserve →" vs
      // "View ranch →") can never drift from what the rancher's page actually
      // offers. A verified pin without Connect is real + browsable but not
      // deposit-ready — sending a buyer to a deposit there is a dead-end.
      const depositReady = isPinDepositReady(r);

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
      // card can read "from $X/quarter". Only verified + represented pins
      // carry pricing on the card (other statuses haven't set/confirmed
      // prices — a represented ranch's prices are Ben-entered and are the
      // exact numbers its reserve page charges against), but we compute it
      // for all so the SSR list can show it where present.
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
        depositReady,
      };
    })
    .filter((x): x is MapPin => x !== null);
}

function deriveStats(pins: MapPin[]) {
  const verified = pins.filter((p) => p.status === 'verified').length;
  const represented = pins.filter((p) => p.status === 'represented').length;
  const onboarding = pins.filter((p) => p.status === 'onboarding').length;
  const selfSubmitted = pins.filter((p) => p.status === 'self-submitted').length;
  const prospects = pins.filter((p) => p.status === 'prospect').length;
  const states = new Set(pins.map((p) => p.state).filter(Boolean));
  return {
    verified,
    represented,
    // The number every "shipping today" label uses. Represented ranches
    // COUNT — a buyer can open the page and put a deposit down right now,
    // which is exactly what that label promises. No surface labels this
    // number "verified" (the copy everywhere says "shipping today" /
    // "taking reservations"); `verified` above stays pure for anything that
    // ever needs the strict count.
    shippingToday: verified + represented,
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
      {/* ── Immersive map hero ─────────────────────────────────────────────
          Full-bleed, viewport-filling map with a slim on-map title bar (the
          h1 lives inside DiscoverMapClient — a client component still SSRs
          its initial HTML). The map module itself is ssr:false (Leaflet
          touches `window`), so Google would otherwise index an empty <div>;
          we pass a fully server-rendered, crawlable <ul> of ranchers
          (name · City, ST · from $X · link) as `listSlot`. It renders inside
          the hero's slide-in list panel, but the markup is always in the
          initial HTML for SEO. */}
      <section className="relative">
        <DiscoverMapClient
          pins={pins}
          shippingTodayCount={stats.shippingToday}
          statesCovered={stats.statesCovered}
          listSlot={<RancherList pins={pins} />}
        />
      </section>

      {/* ── Below the fold: the story + how to read the map ──────────────── */}
      <section className="py-12 md:py-16 border-t border-divider/10">
        <Container>
          <div className="grid md:grid-cols-2 gap-10 md:gap-14 items-start">
            <div className="space-y-5">
              <p className="text-xs uppercase tracking-[0.2em] text-saddle">
                find a rancher near you
              </p>
              <h2 className="font-serif text-3xl md:text-4xl leading-tight lowercase">
                a live map of the network
              </h2>
              <p className="text-charcoal/80 leading-relaxed">
                Drop a pin in your state and reserve a quarter, half, or whole direct
                from the rancher who raised it. Green pins are taking reservations
                right now — verified partners and ranches we represent — amber and
                grey show who&rsquo;s coming next.
              </p>
              {/* Lead with what a buyer can act on TODAY (verified + states).
                  Pipeline-vanity counts (onboarding/self-submitted/prospect) are
                  demoted to a quieter second line so the page sells availability,
                  not a CRM funnel. */}
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 pt-1">
                <span className="text-saddle text-sm">
                  <strong className="text-charcoal text-xl align-baseline">{stats.shippingToday}</strong>{' '}
                  shipping today
                </span>
                <span className="text-saddle text-sm">
                  <strong className="text-charcoal text-xl align-baseline">{stats.statesCovered}</strong>{' '}
                  states on the map
                </span>
              </div>
              <p className="text-xs text-muted">
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

            <div className="space-y-6">
              <div className="space-y-4">
                <h3 className="font-serif text-xl lowercase">what the pins mean</h3>
                <MapLegend />
              </div>
              <p className="text-xs text-muted">
                Are you on this map and want it removed? Use the &ldquo;remove me&rdquo; link on
                your listing&rsquo;s page.
              </p>
            </div>
          </div>
        </Container>
      </section>

      <StickyMobileCTA
        href="/access"
        label="Find a rancher near you"
        subLabel={`${stats.shippingToday} shipping today · ${stats.statesCovered} states`}
      />
    </main>
  );
}
