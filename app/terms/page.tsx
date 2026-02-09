import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

export const metadata = {
  title: 'Terms of Service — BuyHalfCow',
  description: 'Terms of Service for BuyHalfCow private membership network',
};

export default function TermsPage() {
  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-3xl mx-auto space-y-8">
          <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
            Terms of Service
          </h1>
          
          <p className="text-sm text-[#6B4F3F]">
            Last Updated: January 27, 2026
          </p>

          <Divider />

          <div className="space-y-8 leading-relaxed">
            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                1. Acceptance of Terms
              </h2>
              <p>
                By accessing or using BuyHalfCow ("the Platform"), you agree to be bound by these Terms of Service. 
                If you do not agree to these terms, you may not use the Platform.
              </p>
              <p>
                BuyHalfCow is a private membership network, not a marketplace or e-commerce platform. 
                We facilitate connections between verified ranchers, serious buyers, and trusted partners.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                2. Membership & Access
              </h2>
              <p>
                <strong>2.1 Application Process:</strong> All access requires application and approval. 
                We reserve the right to approve or reject any application at our sole discretion.
              </p>
              <p>
                <strong>2.2 Membership Status:</strong> Approved members gain access to certified ranchers, 
                land deals, and brand promotions. Membership can be revoked at any time for violation of these terms.
              </p>
              <p>
                <strong>2.3 Account Security:</strong> You are responsible for maintaining the confidentiality 
                of your account credentials and for all activities under your account.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                3. Partner Requirements
              </h2>
              <p>
                <strong>3.1 Ranchers:</strong> Must provide accurate information about ranch operations, 
                beef types, and certifications. All ranchers are subject to verification and certification.
              </p>
              <p>
                <strong>3.2 Brands:</strong> Must honor all promotions and discount codes provided to members. 
                Promotions must be exclusive to BuyHalfCow members as agreed.
              </p>
              <p>
                <strong>3.3 Land Sellers:</strong> Must provide accurate property information and maintain 
                exclusive listing terms if agreed upon.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                4. Transactions & Commissions
              </h2>
              <p>
                <strong>4.1 No Marketplace:</strong> BuyHalfCow does not process transactions. All sales occur 
                directly between members and ranchers/partners.
              </p>
              <p>
                <strong>4.2 Commission Agreement:</strong> Ranchers agree to a 10% commission on sales facilitated 
                through the Platform. Commission tracking and payment terms are agreed upon separately.
              </p>
              <p>
                <strong>4.3 Independent Relationships:</strong> BuyHalfCow acts only as a connection facilitator. 
                We are not party to any transaction between members and partners.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                5. Content & Conduct
              </h2>
              <p>
                <strong>5.1 Accuracy:</strong> All information provided must be accurate and up-to-date. 
                Misrepresentation may result in immediate account termination.
              </p>
              <p>
                <strong>5.2 Prohibited Conduct:</strong> Members may not use the Platform to engage in fraudulent, 
                abusive, or illegal activities. This includes but is not limited to: harassment, spam, 
                unauthorized data collection, or violation of any applicable laws.
              </p>
              <p>
                <strong>5.3 Content Ownership:</strong> Partners retain ownership of content they submit but grant 
                BuyHalfCow a license to display and distribute such content on the Platform.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                6. Disclaimers & Limitation of Liability
              </h2>
              <p>
                <strong>6.1 No Warranties:</strong> The Platform is provided "as is" without warranties of any kind. 
                We do not guarantee the accuracy, completeness, or reliability of any content.
              </p>
              <p>
                <strong>6.2 Third-Party Actions:</strong> We are not responsible for the actions, products, 
                or services of ranchers, brands, or land sellers on the Platform.
              </p>
              <p>
                <strong>6.3 Limitation of Liability:</strong> To the maximum extent permitted by law, 
                BuyHalfCow shall not be liable for any indirect, incidental, special, or consequential damages 
                arising from your use of the Platform.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                7. Termination
              </h2>
              <p>
                We reserve the right to suspend or terminate your access to the Platform at any time, 
                with or without cause, with or without notice. Upon termination, your right to use the 
                Platform immediately ceases.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                8. Changes to Terms
              </h2>
              <p>
                We may modify these Terms of Service at any time. Continued use of the Platform after 
                changes constitutes acceptance of the new terms. We will notify members of material changes 
                via email or Platform notification.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                9. Governing Law
              </h2>
              <p>
                These Terms shall be governed by and construed in accordance with the laws of the 
                State of Texas, United States, without regard to its conflict of law provisions.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                10. Contact
              </h2>
              <p>
                For questions about these Terms of Service, please contact us at:
              </p>
              <p>
                <a href="mailto:legal@buyhalfcow.com" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
                  legal@buyhalfcow.com
                </a>
              </p>
            </section>
          </div>

          <Divider />

          <div className="text-center space-y-4">
            <Link href="/privacy" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              Privacy Policy →
            </Link>
            <br />
            <Link href="/" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}


