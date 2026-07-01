import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';
import { REFUND_POLICY_SHORT, REFUND_POLICY_LONG } from '@/lib/refundPolicy';

// /terms — rewritten 2026-07-01 to match the real product. The prior version
// said "BuyHalfCow does not process transactions … we are not party to any
// transaction" while the app takes deposits (with a BHC application fee) via
// Stripe Connect — language a card network would read AGAINST us in a
// chargeback. This version states the marketplace role accurately, quotes the
// refund policy from its single source (lib/refundPolicy.ts), and adds the
// deposit, dispute-resolution, food-safety, and consent-record clauses that
// were missing. Governing law moved TX → MT (BHC operates from Kalispell,
// Montana; the Texas reference was a leftover with no basis anywhere else in
// the codebase). DRAFT for founder + counsel review — sections marked
// "LEGAL REVIEW" are standard template language that counsel must confirm.

export const metadata = {
  title: 'Terms of Service',
  description: 'Terms of Service for BuyHalfCow — the network connecting families directly to verified ranchers',
  openGraph: {
    title: 'Terms of Service',
    description: 'Terms of Service for BuyHalfCow — the network connecting families directly to verified ranchers',
    url: 'https://www.buyhalfcow.com/terms',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image' as const,
    title: 'Terms of Service',
    description: 'Terms of Service for BuyHalfCow — the network connecting families directly to verified ranchers',
    images: ['/og-image.png'],
  },
};

export default function TermsPage() {
  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto space-y-8">
          <h1 className="font-serif text-4xl md:text-5xl">
            Terms of Service
          </h1>

          <p className="text-sm text-saddle">
            Effective Date: July 1, 2026
          </p>

          {/* LEGAL REVIEW: the downloadable DOCX (/docs/BHC_Customer_TOS.docx)
              predates this rewrite and no longer matches the terms on this
              page. Two conflicting versions of the Terms is exactly the
              exposure this rewrite removes — regenerate the DOCX from this
              page (or drop the download) before publishing, then restore the
              button below.
          <a
            href="/docs/BHC_Customer_TOS.docx"
            download
            className="inline-block px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
          >
            Download Full Terms (DOCX)
          </a>
          */}

          <Divider />

          <div className="space-y-8 leading-relaxed">
            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                1. Acceptance of Terms
              </h2>
              <p>
                By accessing or using BuyHalfCow (&ldquo;the Platform&rdquo;), you agree to be bound by these
                Terms of Service. If you do not agree to these terms, you may not use the Platform.
              </p>
              <p>
                <strong>1.1 How acceptance is recorded:</strong> When you submit a reservation, deposit,
                or contact form on the Platform, the form states that submitting constitutes agreement to
                these Terms, and we record that acceptance together with your reservation. Continued use
                of the Platform also constitutes acceptance.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                2. What BuyHalfCow Is
              </h2>
              <p>
                <strong>2.1 The marketplace:</strong> BuyHalfCow connects buyers with independent,
                verified ranchers who raise and sell beef directly. Each rancher is an independent
                business. The rancher &mdash; not BuyHalfCow &mdash; is the seller of the beef and is
                responsible for raising, processing, fulfilling, and delivering your order and for the
                quality of the product.
              </p>
              <p>
                <strong>2.2 Payment facilitation:</strong> For ranchers on our current payment rails,
                BuyHalfCow facilitates deposit payments through Stripe. Your deposit is charged to the
                rancher&rsquo;s Stripe account, and BuyHalfCow collects its platform commission from that
                deposit as an application fee. For this purpose BuyHalfCow acts as a limited payments
                agent of the rancher: payment of your deposit through the Platform satisfies your deposit
                obligation to the rancher. For some legacy ranchers, payment is arranged directly between
                you and the rancher and BuyHalfCow does not handle the funds.
              </p>
              <p>
                <strong>2.3 What we provide:</strong> the Platform, rancher verification, buyer-rancher
                matching, deposit processing as described above, and the protections described in{' '}
                <Link href="/promise" className="underline">the BHC Promise</Link> &mdash; including the
                cold-chain guarantee and direct mediation if something goes wrong. We do not take custody
                of the beef, warehouse it, or run the cold chain ourselves.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                3. Membership &amp; Access
              </h2>
              <p>
                <strong>3.1 Application Process:</strong> Access requires application and approval.
                We reserve the right to approve or reject any application at our sole discretion.
              </p>
              <p>
                <strong>3.2 Membership Status:</strong> Approved members gain access to verified ranchers,
                land deals, and brand promotions. Membership can be revoked at any time for violation of
                these terms.
              </p>
              <p>
                <strong>3.3 Account Security:</strong> You are responsible for maintaining the
                confidentiality of your account credentials and for all activities under your account.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                4. Partner Requirements
              </h2>
              <p>
                <strong>4.1 Ranchers:</strong> Must provide accurate information about ranch operations,
                beef types, and certifications. All ranchers are subject to verification and
                certification.
              </p>
              <p>
                <strong>4.2 Brands:</strong> Must honor all promotions and discount codes provided to
                members. Promotions must be exclusive to BuyHalfCow members as agreed.
              </p>
              <p>
                <strong>4.3 Land Sellers:</strong> Must provide accurate property information and maintain
                exclusive listing terms if agreed upon.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                5. Deposits, Refunds &amp; Final Balances
              </h2>
              <p>
                <strong>5.1 The deposit:</strong> Reserving a quarter, half, or whole share requires a
                deposit, paid through Stripe at checkout. The deposit reserves your slot with the rancher
                you selected.
              </p>
              <p>
                <strong>5.2 Refund policy:</strong> Your deposit is {REFUND_POLICY_SHORT}.{' '}
                {REFUND_POLICY_LONG} The rancher&rsquo;s acceptance is the moment they commit real,
                unrecoverable work to your order &mdash; reserving a processing slot, setting aside cuts
                from a specific animal, and locking in logistics. You will receive a confirmation email
                the moment your rancher accepts.
              </p>
              <p>
                <strong>5.3 Protections that survive acceptance:</strong> The non-refundable status of an
                accepted deposit does not limit the BHC Promise. If your beef arrives thawed, short, or
                mishandled in transit, BuyHalfCow makes you whole regardless of where you are in the
                process &mdash; report it with a photo within 24 hours of receipt. If a rancher cancels or
                fails to fulfill an accepted order, BuyHalfCow mediates directly. See{' '}
                <Link href="/promise" className="underline">the BHC Promise</Link> for the full policy.
              </p>
              <p>
                <strong>5.4 Final balance:</strong> The remaining balance for your share is paid directly
                to the rancher at pickup or delivery, by whatever method the rancher accepts. BuyHalfCow
                is not a party to the final-balance payment and does not process it.
              </p>
              <p>
                <strong>5.5 Rancher commissions:</strong> Ranchers agree to platform commission based on
                their subscription tier: Pasture ($150/mo) + 7% commission, Ranch ($350/mo) + 3%
                commission, Operator ($500/mo) + 0% commission. For tier ranchers, commission is
                collected from the buyer&rsquo;s deposit as a Stripe application fee. Legacy ranchers
                (pre-Stage-3): 10% commission invoiced post-close. See /founders or your /rancher/billing
                dashboard for current rates.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                6. Perishable Goods &amp; Food Safety
              </h2>
              <p>
                <strong>6.1 Seller of record:</strong> The rancher is the seller and producer of record
                for all beef purchased through the Platform. Ranchers process through USDA-inspected
                facilities and are responsible for compliance with all applicable food-safety laws.
              </p>
              <p>
                <strong>6.2 Inspection on delivery:</strong> Beef is a perishable good. You must inspect
                your order at pickup or delivery. If it arrives thawed, short, or mishandled in transit,
                report it with a photo within 24 hours of receipt, per the cold-chain guarantee in{' '}
                <Link href="/promise" className="underline">the BHC Promise</Link>.
              </p>
              <p>
                <strong>6.3 Storage after delivery:</strong> Once your order is delivered or picked up in
                good condition, proper frozen storage and safe handling are your responsibility.
              </p>
              {/* LEGAL REVIEW: perishable-goods / food-safety disclaimer — standard
                  template language; confirm with counsel, including state-law
                  requirements for direct meat sales. */}
              <p>
                <strong>6.4 Disclaimer:</strong> To the extent permitted by law, BuyHalfCow disclaims
                liability for illness, injury, or loss arising from the condition, handling, or
                consumption of products sold by ranchers, except as expressly provided in the BHC
                Promise.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                7. Dispute Resolution
              </h2>
              <p>
                <strong>7.1 Talk to us first:</strong> If something goes wrong, start at{' '}
                <Link href="/support" className="underline">/support</Link> or reply to any email from
                us. A real person mediates every dispute directly. Most issues get resolved this way,
                fast.
              </p>
              <p>
                <strong>7.2 Informal resolution period:</strong> Before filing any formal claim, you
                agree to give us written notice of the dispute and 30 days to resolve it informally.
              </p>
              {/* LEGAL REVIEW: arbitration clause template — confirm with counsel.
                  Standard JAMS/AAA-style binding arbitration with small-claims
                  carve-out and class-action waiver; counsel must confirm the
                  arbitration provider, seat, fee allocation, and enforceability
                  (including the class-waiver) before this ships. */}
              <p>
                <strong>7.3 Binding arbitration:</strong> Any dispute not resolved informally shall be
                resolved by binding arbitration administered by JAMS (or, if JAMS is unavailable, the
                American Arbitration Association) under its applicable consumer arbitration rules, rather
                than in court. The arbitration will be conducted in Montana or, at your election, by
                remote means. Either party may instead bring an individual claim in small-claims court if
                it qualifies.
              </p>
              <p>
                <strong>7.4 Class-action waiver:</strong> Disputes must be brought on an individual
                basis. Neither party may participate in a class, consolidated, or representative action,
                and the arbitrator may not consolidate claims of more than one person.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                8. Content &amp; Conduct
              </h2>
              <p>
                <strong>8.1 Accuracy:</strong> All information provided must be accurate and up-to-date.
                Misrepresentation may result in immediate account termination.
              </p>
              <p>
                <strong>8.2 Prohibited Conduct:</strong> Members may not use the Platform to engage in
                fraudulent, abusive, or illegal activities. This includes but is not limited to:
                harassment, spam, unauthorized data collection, or violation of any applicable laws.
              </p>
              <p>
                <strong>8.3 Content Ownership:</strong> Partners retain ownership of content they submit
                but grant BuyHalfCow a license to display and distribute such content on the Platform.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                9. Communications
              </h2>
              <p>
                <strong>9.1 Transactional email:</strong> By using the Platform you agree to receive
                transactional email about your reservations, deposits, and account.
              </p>
              <p>
                <strong>9.2 Text messages:</strong> SMS is opt-in only, via the consent checkbox at the
                point of phone collection. Checking it is never a condition of purchase. Message and data
                rates may apply; reply STOP to cancel, HELP for help. Full details in our{' '}
                <Link href="/privacy" className="underline">Privacy Policy</Link>.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                10. Disclaimers &amp; Limitation of Liability
              </h2>
              {/* LEGAL REVIEW: warranty disclaimer + liability cap — standard
                  template language carried over at the same scale as the prior
                  version; confirm with counsel. */}
              <p>
                <strong>10.1 No Warranties:</strong> The Platform is provided &ldquo;as is&rdquo; without
                warranties of any kind. We do not guarantee the accuracy, completeness, or reliability of
                any content, nor delivery dates, processing timelines, or outcomes that are within the
                rancher&rsquo;s control.
              </p>
              <p>
                <strong>10.2 Third-Party Actions:</strong> Except as expressly provided in these Terms
                and the BHC Promise, we are not responsible for the actions, products, or services of
                ranchers, brands, or land sellers on the Platform.
              </p>
              <p>
                <strong>10.3 Limitation of Liability:</strong> To the maximum extent permitted by law,
                BuyHalfCow shall not be liable for any indirect, incidental, special, or consequential
                damages arising from your use of the Platform.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                11. Termination
              </h2>
              <p>
                We reserve the right to suspend or terminate your access to the Platform at any time,
                with or without cause, with or without notice. Upon termination, your right to use the
                Platform immediately ceases. Termination does not affect refund rights that accrued
                before termination or the protections of the BHC Promise for deposits already placed.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                12. Changes to Terms
              </h2>
              <p>
                We may modify these Terms of Service at any time. We will notify members of material
                changes via email or Platform notification before they take effect. Continued use of the
                Platform after changes constitutes acceptance of the new terms; the version in effect
                when you placed a deposit governs that deposit.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                13. Governing Law
              </h2>
              {/* LEGAL REVIEW: governing law changed from Texas to Montana —
                  BuyHalfCow operates from Kalispell, Montana, and no other part
                  of the product references Texas. The prior TX clause appears to
                  have been boilerplate. Counsel to confirm MT is the right seat. */}
              <p>
                These Terms shall be governed by and construed in accordance with the laws of the State
                of Montana, United States, without regard to its conflict of law provisions.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-serif text-2xl">
                14. Contact
              </h2>
              <p>
                For questions about these Terms of Service, please contact us at:
              </p>
              <p>
                <a href="mailto:legal@buyhalfcow.com" className="text-charcoal hover:text-saddle transition-colors">
                  legal@buyhalfcow.com
                </a>
              </p>
              <p>
                For help with an order or a dispute, start at{' '}
                <Link href="/support" className="underline">/support</Link>.
              </p>
            </section>
          </div>

          <Divider />

          <div className="text-center space-y-4">
            <Link href="/privacy" className="text-charcoal hover:text-saddle transition-colors">
              Privacy Policy →
            </Link>
            <br />
            <Link href="/promise" className="text-charcoal hover:text-saddle transition-colors">
              The BHC Promise →
            </Link>
            <br />
            <Link href="/" className="text-charcoal hover:text-saddle transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}
