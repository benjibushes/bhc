import Container from './components/Container';
import Pill from './components/Pill';

// 404 → conversion page. Don't waste the impression. Every 404 visitor is a
// human in our funnel — give them three exits to the surfaces that actually
// convert (buyer / map / founder).

export default function NotFound() {
  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center">
      <Container>
        <div className="max-w-3xl mx-auto text-center space-y-8">
          <Pill tone="amber" className="mx-auto">404 · page not found</Pill>
          <h1 className="font-serif text-5xl md:text-7xl leading-tight">
            That trail&rsquo;s gone cold.
          </h1>
          <p className="text-lg text-saddle leading-relaxed max-w-xl mx-auto">
            Either you typed the URL wrong or we moved the page. Either way,
            here&rsquo;s where you probably wanted to go:
          </p>

          <div className="grid md:grid-cols-3 gap-4 max-w-3xl mx-auto pt-4">
            <a
              href="/access"
              className="group block p-6 border border-charcoal text-left transition-base hover:bg-charcoal hover:text-bone"
            >
              <p className="text-[11px] uppercase tracking-widest text-saddle group-hover:text-bone/70 font-semibold mb-2">
                I want beef
              </p>
              <p className="font-serif text-xl mb-2">Take the quiz</p>
              <p className="text-xs text-saddle group-hover:text-bone/70 leading-relaxed">
                90 seconds. We match you to a verified rancher in your state.
              </p>
            </a>
            <a
              href="/map"
              className="group block p-6 border border-charcoal text-left transition-base hover:bg-charcoal hover:text-bone"
            >
              <p className="text-[11px] uppercase tracking-widest text-saddle group-hover:text-bone/70 font-semibold mb-2">
                I&rsquo;m exploring
              </p>
              <p className="font-serif text-xl mb-2">See the map</p>
              <p className="text-xs text-saddle group-hover:text-bone/70 leading-relaxed">
                Every D2C rancher in America. Pin in your state? Pick one.
              </p>
            </a>
            <a
              href="/founders"
              className="group block p-6 border border-charcoal text-left transition-base hover:bg-charcoal hover:text-bone"
            >
              <p className="text-[11px] uppercase tracking-widest text-saddle group-hover:text-bone/70 font-semibold mb-2">
                I want to back the build
              </p>
              <p className="font-serif text-xl mb-2">Founding Herd</p>
              <p className="text-xs text-saddle group-hover:text-bone/70 leading-relaxed">
                100 spots, $1,000. Or $9/mo. Names on the wall.
              </p>
            </a>
          </div>

          <p className="text-sm text-dust pt-6">
            Lost? Email{' '}
            <a href="mailto:ben@buyhalfcow.com" className="underline underline-offset-2 hover:text-charcoal">
              ben@buyhalfcow.com
            </a>
            {' '}— I read everything.
          </p>
        </div>
      </Container>
    </main>
  );
}
