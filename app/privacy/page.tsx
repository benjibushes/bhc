import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy — BuyHalfCow',
  description: 'Privacy Policy for BuyHalfCow private membership network',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-3xl mx-auto space-y-8">
          <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
            Privacy Policy
          </h1>
          
          <p className="text-sm text-[#6B4F3F]">
            Last Updated: January 27, 2026
          </p>

          <Divider />

          <div className="space-y-8 leading-relaxed">
            <p>
              At BuyHalfCow, we take your privacy seriously. This Privacy Policy explains how we collect, 
              use, disclose, and safeguard your information when you use our Platform.
            </p>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                1. Information We Collect
              </h2>
              <p>
                <strong>Personal Information:</strong> When you apply for access or partnership, we collect:
              </p>
              <ul className="list-disc list-inside space-y-2 ml-4">
                <li>Name and contact information (email, phone)</li>
                <li>State/location information</li>
                <li>Interest preferences</li>
                <li>Ranch/business details (for partners)</li>
              </ul>
              <p>
                <strong>Usage Data:</strong> We automatically collect certain information about your device 
                and how you interact with our Platform, including IP address, browser type, pages visited, 
                and time spent on pages.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                2. How We Use Your Information
              </h2>
              <p>We use the information we collect to:</p>
              <ul className="list-disc list-inside space-y-2 ml-4">
                <li>Process and manage your application</li>
                <li>Facilitate connections between members and partners</li>
                <li>Send important updates and notifications</li>
                <li>Improve our Platform and services</li>
                <li>Maintain security and prevent fraud</li>
                <li>Comply with legal obligations</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                3. Information Sharing
              </h2>
              <p>
                <strong>With Members:</strong> Approved ranchers and land sellers have their information 
                displayed to members. This includes business details, contact information, and property information.
              </p>
              <p>
                <strong>With Partners:</strong> Member contact information may be shared with ranchers and 
                partners to facilitate connections, with appropriate consent.
              </p>
              <p>
                <strong>With Service Providers:</strong> We may share your information with third-party 
                service providers who perform services on our behalf (e.g., email delivery, database hosting).
              </p>
              <p>
                <strong>For Legal Reasons:</strong> We may disclose your information if required by law or 
                in response to valid legal requests.
              </p>
              <p>
                <strong>We Do Not Sell Your Data:</strong> We never sell your personal information to third parties.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                4. Data Security
              </h2>
              <p>
                We implement appropriate technical and organizational security measures to protect your 
                personal information. However, no method of transmission over the Internet is 100% secure, 
                and we cannot guarantee absolute security.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                5. Your Rights
              </h2>
              <p>You have the right to:</p>
              <ul className="list-disc list-inside space-y-2 ml-4">
                <li>Access the personal information we hold about you</li>
                <li>Request correction of inaccurate information</li>
                <li>Request deletion of your information (subject to legal requirements)</li>
                <li>Opt-out of marketing communications</li>
                <li>Withdraw consent where we rely on consent to process your data</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                6. Cookies & Tracking
              </h2>
              <p>
                We use cookies and similar tracking technologies to improve your experience on our Platform. 
                You can control cookie preferences through your browser settings, but disabling cookies may 
                limit Platform functionality.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                7. Data Retention
              </h2>
              <p>
                We retain your personal information for as long as necessary to fulfill the purposes outlined 
                in this Privacy Policy, unless a longer retention period is required by law.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                8. Children's Privacy
              </h2>
              <p>
                Our Platform is not intended for individuals under 18 years of age. We do not knowingly 
                collect personal information from children.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                9. Changes to This Policy
              </h2>
              <p>
                We may update this Privacy Policy from time to time. We will notify you of material changes 
                via email or Platform notification. Continued use after changes constitutes acceptance.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                10. Contact Us
              </h2>
              <p>
                For questions about this Privacy Policy or to exercise your privacy rights, contact us at:
              </p>
              <p>
                <a href="mailto:privacy@buyhalfcow.com" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
                  privacy@buyhalfcow.com
                </a>
              </p>
            </section>
          </div>

          <Divider />

          <div className="text-center space-y-4">
            <Link href="/terms" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              Terms of Service →
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


