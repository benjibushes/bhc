import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';

export const metadata = {
  title: 'About',
  description: 'Why BuyHalfCow exists. Ben Beauchman, Kalispell MT. Built for ranchers and the families who buy from them.',
  openGraph: {
    title: 'About',
    description: 'Why BuyHalfCow exists. Ben Beauchman, Kalispell MT. Built for ranchers and the families who buy from them.',
    url: 'https://buyhalfcow.com/about',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image' as const,
    title: 'About',
    description: 'Why BuyHalfCow exists. Ben Beauchman, Kalispell MT.',
    images: ['/og-image.png'],
  },
};

export default function AboutPage() {
  return (
    <main className="min-h-screen py-16 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto space-y-12">
          <div className="text-center space-y-6">
            <h1 className="font-serif text-4xl md:text-5xl">
              About BuyHalfCow
            </h1>
            <Divider />
            <p className="text-lg md:text-xl leading-relaxed text-saddle">
              Built in Kalispell, Montana. One family, one rancher, one freezer at a time.
            </p>
          </div>

          <div className="space-y-10 leading-relaxed text-base md:text-lg">
            <section className="space-y-4">
              <h2 className="font-serif text-2xl md:text-3xl">
                Why this exists
              </h2>
              <p>
                Grocery-store beef is a black box. You don&apos;t know the ranch, the
                processor, what the animal ate, or what got pumped into the meat
                after slaughter. Meanwhile, real American ranchers are getting
                squeezed out by feedlot commodity pricing.
              </p>
              <p>
                BuyHalfCow exists to fix both halves of that. Families get direct
                access to verified ranchers in their state. Ranchers get
                pre-screened buyers ready to commit to a quarter, half, or whole.
                We take 10% on closed deals &mdash; nothing else.
              </p>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-serif text-2xl md:text-3xl">
                The founder
              </h2>
              <p>
                I&apos;m Ben Beauchman. I live in Kalispell, Montana &mdash; cattle
                country &mdash; and I started BuyHalfCow after watching too many
                families I know give up on finding a real beef source.
                Farmers markets are seasonal. Ranchers don&apos;t always answer the
                phone. And the existing online options are either dropship outfits
                with no ranch attached or marketplaces that mark beef up 40%.
              </p>
              <p>
                I drive to ranches. I verify operations in person. I work both
                sides of every match so ranchers don&apos;t deal with tire-kickers
                and buyers don&apos;t get scammed. Every email signed &mdash; Ben is
                actually from me.
              </p>
              <p className="text-saddle text-sm italic">
                BuyHalfCow is small and founders-funded. No VC, no growth-at-all-costs
                pressure. Just a network getting wider, one verified rancher at a time.
              </p>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-serif text-2xl md:text-3xl">
                How it works
              </h2>
              <div className="space-y-6">
                <div>
                  <h3 className="font-medium text-lg mb-2">For buyers</h3>
                  <ol className="list-decimal list-outside space-y-2 ml-5 text-saddle">
                    <li>Apply for access &mdash; takes 60 seconds.</li>
                    <li>Get approved (I review every application manually).</li>
                    <li>See verified ranchers in your state.</li>
                    <li>Reserve a quarter, half, or whole with a deposit. The rancher takes it from there.</li>
                  </ol>
                </div>
                <div>
                  <h3 className="font-medium text-lg mb-2">For ranchers</h3>
                  <ol className="list-decimal list-outside space-y-2 ml-5 text-saddle">
                    <li>Apply with ranch details.</li>
                    <li>I visit the ranch, verify the operation.</li>
                    <li>Once certified, pre-screened buyers in your state get routed to you.</li>
                    <li>You close the deal direct. We take 10% on closed sales.</li>
                  </ol>
                </div>
              </div>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-serif text-2xl md:text-3xl">
                The BHC Promise
              </h2>
              <p>
                Beef arrives frozen and on time, or BHC refunds your deposit within
                7 days &mdash; no questions asked, paid by BuyHalfCow. Cold-chain
                failure, satisfaction issues, anything in that window: we mediate
                from your match thread.
              </p>
              <p className="text-saddle text-sm">
                Read the full policy at <a href="/promise" className="underline hover:text-charcoal transition-colors">/promise</a>.
              </p>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-serif text-2xl md:text-3xl">
                What we&apos;re not
              </h2>
              <ul className="space-y-3">
                <li className="flex items-start">
                  <span className="mr-3 text-weathered" aria-hidden="true">&times;</span>
                  <span>Not a marketplace that takes a cut of every transaction. We take 10% on closed deals, that&apos;s it.</span>
                </li>
                <li className="flex items-start">
                  <span className="mr-3 text-weathered" aria-hidden="true">&times;</span>
                  <span>Not an algorithm. Every match is hand-reviewed.</span>
                </li>
                <li className="flex items-start">
                  <span className="mr-3 text-weathered" aria-hidden="true">&times;</span>
                  <span>Not a dropship outfit. Every rancher is a real verified operation.</span>
                </li>
                <li className="flex items-start">
                  <span className="mr-3 text-weathered" aria-hidden="true">&times;</span>
                  <span>Not open to everyone. Buyers and ranchers both vetted &mdash; that&apos;s the point.</span>
                </li>
              </ul>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-serif text-2xl md:text-3xl">
                What we believe
              </h2>
              <div className="space-y-3">
                <p><strong>Ranchers first.</strong> Without good ranchers, there&apos;s no business. They get paid back &mdash; see our <a href="/founders" className="underline">give-back commitments</a>.</p>
                <p><strong>Quality over scale.</strong> Better to stay small and honest than big and mediocre.</p>
                <p><strong>Real relationships.</strong> Direct rancher-to-family connection. No middleman markups, no anonymized branding.</p>
                <p><strong>Honest about what we are.</strong> We&apos;re small, founders-funded, building this in public. You can read every commitment we&apos;ve made.</p>
              </div>
            </section>

            <Divider />

            <div className="text-center space-y-6 pt-4">
              <p className="text-lg md:text-xl">
                Ready to find your rancher?
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button href="/access">Apply for access</Button>
                <Button href="/partner" variant="secondary">Rancher? Apply here</Button>
              </div>
              <p className="text-saddle text-sm pt-4">
                Questions? <a href="mailto:ben@buyhalfcow.com" className="underline">ben@buyhalfcow.com</a> &mdash; I read every email.
              </p>
            </div>
          </div>
        </div>
      </Container>
    </main>
  );
}
