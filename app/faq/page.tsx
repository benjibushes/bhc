'use client';

import { useState } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

// /faq — real questions buyers, ranchers, backers, and brand partners
// actually ask. Honest answers. Voice: lowercase, founder-direct, no
// banned hype words. Source-of-truth refs: docs/BHC-PROMISE.md (refunds),
// docs/BUSINESS-MODEL.md (payments + tiers + commissions), docs/VISION.md
// (give-back commitments).

interface QA {
  q: string;
  a: React.ReactNode;
}

interface Section {
  id: string;
  label: string;
  questions: QA[];
}

const sections: Section[] = [
  {
    id: 'buyers',
    label: 'For buyers',
    questions: [
      {
        q: 'How does matching work?',
        a: (
          <>
            <p className="mb-3">
              You apply for access (60 seconds). I review the application personally and approve serious buyers &mdash;
              usually same day, sometimes 24&ndash;48h during launch weeks. Once approved, you see verified
              ranchers in your state.
            </p>
            <p>
              Pick a rancher, reserve a quarter/half/whole with a deposit, and they take it from there.
              You can also message any rancher before reserving to ask questions about cuts, processing
              dates, or pickup.
            </p>
          </>
        ),
      },
      {
        q: 'Who handles shipping or pickup?',
        a: (
          <>
            <p className="mb-3">
              The rancher does, directly. Some deliver locally, some require pickup at the processing
              facility, some ship frozen. You&apos;ll see each rancher&apos;s fulfillment options on their
              deposit page before you commit.
            </p>
            <p className="text-saddle text-sm">
              Honest note: BHC does not run a cold-chain shipping operation. Logistics happen
              rancher-to-buyer. We do back you with the BHC Promise if cold-chain fails.
            </p>
          </>
        ),
      },
      {
        q: 'What if I don&rsquo;t like the beef?',
        a: (
          <>
            <p className="mb-3">
              Your deposit reserves your slot with the rancher. It&rsquo;s fully refundable
              until they accept it (usually within 24&ndash;48 hours). Once they commit your
              processing slot, it becomes non-refundable. Cold-chain guarantee + BHC
              mediation apply either way.
            </p>
            <ul className="list-disc list-outside ml-5 space-y-2 text-saddle">
              <li><strong className="text-charcoal">Refundable window:</strong> change your mind before your rancher accepts? Full refund.</li>
              <li><strong className="text-charcoal">Non-refundable once accepted:</strong> after they commit your slot, they&rsquo;ve set aside cuts and locked in processing. You&rsquo;ll get a &ldquo;slot locked&rdquo; email the moment that happens.</li>
              <li><strong className="text-charcoal">Cold-chain failure:</strong> if it arrives thawed or short, BHC makes you whole. Report within 24h of receipt with a photo.</li>
              <li><strong className="text-charcoal">Disputes:</strong> reply to your match thread or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> &mdash; we mediate.</li>
            </ul>
            <p className="mt-3 text-saddle text-sm">
              Full policy: <Link href="/promise" className="underline">/promise</Link>.
            </p>
          </>
        ),
      },
      {
        q: 'What comes in a quarter, half, or whole?',
        a: (
          <>
            <p className="mb-3">
              <strong>Quarter (~100&ndash;125 lbs):</strong> mix of steaks, roasts, ground. Feeds 2&ndash;3 people for 3&ndash;4 months. Needs 4&ndash;5 cu ft of freezer.
            </p>
            <p className="mb-3">
              <strong>Half (~200&ndash;250 lbs):</strong> full variety &mdash; ribeyes, T-bones, brisket, short ribs, ground. Feeds a family of 4 for 6&ndash;8 months. Needs 8&ndash;10 cu ft.
            </p>
            <p className="mb-3">
              <strong>Whole (~400&ndash;500 lbs):</strong> max variety + value. Big families or split with friends. Needs 15&ndash;20 cu ft.
            </p>
            <p className="text-saddle text-sm italic">
              Exact cuts vary by ranch and your conversations with the processor &mdash; discuss specifics
              with your rancher in the message thread.
            </p>
          </>
        ),
      },
      {
        q: 'How much does it cost?',
        a: (
          <>
            <p className="mb-3">
              Typically <strong>$1,200&ndash;$2,500</strong> for a half, depending on ranch location, beef type
              (grass-fed, grain-finished, wagyu), processing fees, and delivery method.
            </p>
            <p>
              Ranchers set their own pricing. You&apos;ll see exact prices per cut on each rancher&apos;s page
              before reserving. The deposit you pay at checkout goes to the rancher through Stripe &mdash;
              BHC takes its 10% commission off the top, so the rancher gets paid faster and you get
              fraud-protection through Stripe.
            </p>
          </>
        ),
      },
      {
        q: 'How does payment work?',
        a: (
          <>
            <p className="mb-3">
              You pay a deposit at reservation through Stripe. Stripe routes the money to the
              rancher&apos;s Connect account, BHC takes its commission automatically, and you get
              full card-fraud protection.
            </p>
            <p>
              Balance due at pickup or delivery is paid directly to the rancher in whatever method
              they prefer (check, cash, Venmo, Zelle &mdash; varies by rancher). The two of you sort
              that in your message thread before pickup.
            </p>
          </>
        ),
      },
      {
        q: 'Do I need a chest freezer?',
        a: (
          <p>
            For a half or whole, yes &mdash; 8&ndash;10+ cu ft minimum. A quarter can fit in a large upright
            freezer if you have space. Many buyers split a half with friends or family to share
            the freezer load.
          </p>
        ),
      },
    ],
  },
  {
    id: 'ranchers',
    label: 'For ranchers',
    questions: [
      {
        q: 'How does certification work?',
        a: (
          <>
            <p className="mb-3">
              Apply with your ranch details. I review the application, schedule a call. If it&apos;s
              a good fit, I drive to the ranch (or fly + drive) and verify the operation in person.
            </p>
            <p>
              Once certified, pre-screened buyers in your state get routed to you. You&apos;re visible
              on the verified-rancher map and on your own landing page at <code>buyhalfcow.com/ranchers/[your-slug]</code>.
            </p>
          </>
        ),
      },
      {
        q: 'How do I get paid?',
        a: (
          <>
            <p className="mb-3">
              Stripe Connect handles deposit payouts automatically when a buyer reserves. The
              deposit hits your bank within a day or two, minus the BHC commission and standard
              Stripe processing fees.
            </p>
            <p>
              Balance due at pickup/delivery is yours to collect direct &mdash; whatever method you
              already use (check, cash, Venmo, Zelle, wire). BHC doesn&apos;t touch that side.
            </p>
          </>
        ),
      },
      {
        q: 'What does it cost me?',
        a: (
          <>
            <p className="mb-3">
              Three tiers. Pick what fits your operation:
            </p>
            <ul className="list-disc list-outside ml-5 space-y-2 text-saddle">
              <li><strong className="text-charcoal">Pasture:</strong> $150/mo + 7% commission per closed deal.</li>
              <li><strong className="text-charcoal">Ranch:</strong> $350/mo + 3% commission. Priority routing + listing optimization.</li>
              <li><strong className="text-charcoal">Operator:</strong> $500/mo + 0% commission. Fully managed listing + content production.</li>
            </ul>
            <p className="mt-3 text-saddle text-sm">
              Legacy ranchers (pre&ndash;Stage 3) are on 10% flat commission with monthly invoicing &mdash;
              we&apos;ll migrate you when you&apos;re ready, no pressure.
            </p>
          </>
        ),
      },
      {
        q: 'Will I get tire-kickers?',
        a: (
          <>
            <p className="mb-3">
              No. Every buyer is vetted before they ever see your name. I personally review buyer
              applications and only approve serious sourcing intent.
            </p>
            <p>
              When a buyer requests an introduction, I review that too. You only see qualified
              inquiries from buyers in your state who are ready to commit.
            </p>
          </>
        ),
      },
      {
        q: 'Can I set my own pricing and terms?',
        a: (
          <p>
            Yes &mdash; entirely. You set per-cut pricing, processing dates, pickup/delivery options,
            refund policy. BHC enforces a platform-level trust floor (the BHC Promise) but
            otherwise you run your business.
          </p>
        ),
      },
    ],
  },
  {
    id: 'backers',
    label: 'For backers',
    questions: [
      {
        q: 'What&rsquo;s the Founding Herd?',
        a: (
          <>
            <p className="mb-3">
              Five-tier backer program for people who want to help build BuyHalfCow before it&apos;s
              easy to bet on. No equity, no SAFE, no securities &mdash; just perks, naming rights,
              and a permanent spot on the public Founders Wall.
            </p>
            <ul className="list-disc list-outside ml-5 space-y-2 text-saddle">
              <li><strong className="text-charcoal">Herd:</strong> $9/mo or $90/yr &mdash; monthly letter, patch, state heads-up.</li>
              <li><strong className="text-charcoal">Outlaw:</strong> $25/mo or $250/yr &mdash; Herd + public Wall + quarterly drops.</li>
              <li><strong className="text-charcoal">Steward:</strong> $75/mo or $750/yr &mdash; Outlaw + group call + direct email.</li>
              <li><strong className="text-charcoal">Founding 100:</strong> $1,000 lifetime, cap 100 &mdash; numbered Wall placement.</li>
              <li><strong className="text-charcoal">Title Founder:</strong> $15,000 lifetime, cap 10 &mdash; top of Wall + co-build access.</li>
            </ul>
            <p className="mt-3">
              Details and the live count at <Link href="/founders" className="underline">/founders</Link>.
            </p>
          </>
        ),
      },
      {
        q: 'How is BHC funded?',
        a: (
          <>
            <p className="mb-3">
              Founders-funded plus the Founding Herd capital raise (up to $250k cap from
              non-equity backers). No outside VC. No growth-at-all-costs pressure.
            </p>
            <p>
              When the company crosses sustained profitability, 15% of net annual profit
              gets distributed back to verified ranchers as a dividend pool. Full give-back
              commitments are published and locked in &mdash; see <Link href="/founders" className="underline">/founders</Link>.
            </p>
          </>
        ),
      },
      {
        q: 'Where&rsquo;s the open expense ledger?',
        a: (
          <p>
            We publish quarterly. First public ledger drops once we close the Founding 100 round.
            Backers get the ledger sent direct; it&apos;s also published on the Founders Wall.
          </p>
        ),
      },
    ],
  },
  {
    id: 'brands',
    label: 'For brand partners',
    questions: [
      {
        q: 'What are the brand partner tiers?',
        a: (
          <>
            <p className="mb-3">
              Three tiers for brands that want to reach D2C ranchers + the families who buy real beef:
            </p>
            <ul className="list-disc list-outside ml-5 space-y-2 text-saddle">
              <li><strong className="text-charcoal">$99/mo:</strong> directory listing + map pin.</li>
              <li><strong className="text-charcoal">$499/mo:</strong> directory + featured rotation + monthly newsletter inclusion.</li>
              <li><strong className="text-charcoal">$2,500/mo:</strong> everything above + custom landing page + co-branded content + sponsor placement on rancher pages.</li>
            </ul>
            <p className="mt-3">
              Apply at <Link href="/brand-partners" className="underline">/brand-partners</Link>.
            </p>
          </>
        ),
      },
      {
        q: 'Who are the buyers?',
        a: (
          <p>
            Families of 3&ndash;6, household income $80k+, freezer-equipped, fed up with grocery
            beef. Already willing to commit $1k&ndash;$3k to a beef share. Adjacent buyer
            categories: freezer brands, knife brands, cast-iron, preservation goods, ranch
            apparel, regenerative-ag tooling.
          </p>
        ),
      },
    ],
  },
  {
    id: 'about',
    label: 'About BHC',
    questions: [
      {
        q: 'Who runs this?',
        a: (
          <p>
            Ben Beauchman, based in Kalispell, Montana. Small team, founders-funded.
            Every email signed &mdash; Ben is from me directly. More on <Link href="/about" className="underline">/about</Link>.
          </p>
        ),
      },
      {
        q: 'What states are covered?',
        a: (
          <p>
            We have verified ranchers in multiple states and we&apos;re actively recruiting in
            every state with serious buyer demand. If your state isn&apos;t covered yet, apply
            anyway &mdash; I prioritize recruiting based on buyer demand.
          </p>
        ),
      },
      {
        q: 'Is the network really private?',
        a: (
          <p>
            Yes. Buyers and ranchers are both vetted. The verified-rancher map at <Link href="/map" className="underline">/map</Link>
            {' '}is the only public-facing rancher info; everything else &mdash; pricing detail, contact
            flow, the matching engine &mdash; lives behind member auth.
          </p>
        ),
      },
      {
        q: 'How do I cancel?',
        a: (
          <p>
            Email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> or
            unsubscribe from any email. No hard feelings, no retention scripts.
          </p>
        ),
      },
    ],
  },
];

function FAQItem({ qa, defaultOpen = false }: { qa: QA; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-dust last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-start justify-between gap-4 py-4 md:py-5 min-h-[48px]"
        aria-expanded={open}
      >
        <h3 className="font-medium text-base md:text-lg leading-snug">{qa.q}</h3>
        <span className="text-saddle text-xl flex-shrink-0 leading-none mt-1" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div className="pb-5 pr-8 text-saddle leading-relaxed text-sm md:text-base">
          {qa.a}
        </div>
      )}
    </div>
  );
}

export default function FAQPage() {
  return (
    <main className="min-h-screen py-16 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto space-y-12">
          <div className="text-center space-y-6">
            <h1 className="font-serif text-4xl md:text-5xl">
              Frequently asked
            </h1>
            <Divider />
            <p className="text-base md:text-lg text-saddle">
              Real questions from buyers, ranchers, backers, and brand partners. Honest answers.
            </p>
          </div>

          {sections.map((section) => (
            <section key={section.id} className="space-y-2">
              <h2 className="font-serif text-2xl md:text-3xl border-b border-divider pb-3 mb-2">
                {section.label}
              </h2>
              <div>
                {section.questions.map((qa, idx) => (
                  <FAQItem key={qa.q} qa={qa} defaultOpen={section.id === 'buyers' && idx === 0} />
                ))}
              </div>
            </section>
          ))}

          <Divider />

          <div className="text-center space-y-5 py-8">
            <h2 className="font-serif text-xl md:text-2xl">
              Didn&apos;t find your answer?
            </h2>
            <p className="text-saddle">
              Email me direct: <a href="mailto:ben@buyhalfcow.com" className="text-charcoal underline">ben@buyhalfcow.com</a>.
              <br />
              I read every message.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
              <Link
                href="/access"
                className="inline-block px-6 py-3 min-h-[48px] flex items-center justify-center bg-charcoal text-bone hover:bg-saddle transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-charcoal text-center"
              >
                Apply for access
              </Link>
              <Link
                href="/partner"
                className="inline-block px-6 py-3 min-h-[48px] flex items-center justify-center bg-bone text-charcoal hover:bg-charcoal hover:text-bone transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-charcoal text-center"
              >
                Rancher? Apply here
              </Link>
            </div>
          </div>
        </div>
      </Container>
    </main>
  );
}
