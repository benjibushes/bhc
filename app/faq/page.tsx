'use client';

import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

export default function FAQPage() {
  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-3xl mx-auto space-y-16">
          {/* Header */}
          <div className="text-center space-y-6">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              Frequently Asked Questions
            </h1>
            <Divider />
            <p className="text-lg text-[#6B4F3F]">
              Everything you need to know about The HERD
            </p>
          </div>

          {/* How It Works Section */}
          <section className="space-y-8">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl border-b border-[#A7A29A] pb-4">
              How It Works
            </h2>

            <div className="space-y-8">
              <div className="space-y-4">
                <h3 className="font-medium text-xl">How does BuyHalfCow work?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  BuyHalfCow is a private network connecting serious buyers with verified American ranchers. 
                  Think of it like working with a trusted advisor who connects buyers and sellers in a private network.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  We personally verify every rancher through in-person ranch tours and documentation reviews. 
                  We verify every member application to ensure ranchers only deal with serious buyers.
                  Then we facilitate the introduction. The relationship is direct between you and the rancher.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">How do I get connected with a rancher?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Once you're approved as a member, you browse verified ranchers in your state. 
                  When you find one you like, you request an introduction through the platform.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  I review each request personally to ensure it's a good fit, then facilitate the introduction via email. 
                  From there, you and the rancher connect directly to discuss pricing, timing, delivery, and finalize the transaction.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  It's personal, relationship-based, and built on trust. I work both sides to ensure good matches.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">What do you actually do?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Three things:
                </p>
                <ol className="list-decimal list-inside space-y-2 text-[#6B4F3F] leading-relaxed pl-4">
                  <li><strong className="text-[#0E0E0E]">Verify ranchers</strong> — I visit ranches in person, document operations, ensure quality and legitimacy. Every rancher is personally certified.</li>
                  <li><strong className="text-[#0E0E0E]">Vet buyers</strong> — I review member applications to protect ranchers from tire-kickers and ensure serious intent.</li>
                  <li><strong className="text-[#0E0E0E]">Facilitate introductions</strong> — I match members with ranchers in their state and facilitate the introduction. You handle the transaction directly.</li>
                </ol>
                <p className="text-[#6B4F3F] leading-relaxed">
                  I'm the gatekeeper that ensures both sides are legit, then I get out of the way and let you build the relationship.
                </p>
              </div>
            </div>
          </section>

          <Divider />

          {/* Beef Details Section */}
          <section className="space-y-8">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl border-b border-[#A7A29A] pb-4">
              About Beef Orders
            </h2>

            <div className="space-y-8">
              <div className="space-y-4">
                <h3 className="font-medium text-xl">What comes in a quarter, half, or full cow?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  <strong className="text-[#0E0E0E]">Quarter Cow (~100-125 lbs):</strong> Mix of cuts including steaks, roasts, and ground beef. 
                  Feeds a family of 2-3 for 3-4 months. Requires about 4-5 cubic feet of freezer space.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  <strong className="text-[#0E0E0E]">Half Cow (~200-250 lbs):</strong> Full variety of cuts — ribeyes, T-bones, chuck roasts, brisket, short ribs, ground beef. 
                  Feeds a family of 4 for 6-8 months. Requires about 8-10 cubic feet of freezer space.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  <strong className="text-[#0E0E0E]">Whole Cow (~400-500 lbs):</strong> Complete animal, maximum variety and value. 
                  Best for large families, multiple households sharing, or if you have a chest freezer. Requires 15-20 cubic feet.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  <em>Note: Final weights and cuts vary by ranch processing methods. Discuss specific cuts with your rancher.</em>
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">How much does a half cow cost?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Typically <strong className="text-[#0E0E0E]">$1,200-$2,500</strong> depending on:
                </p>
                <ul className="list-disc list-inside space-y-2 text-[#6B4F3F] leading-relaxed pl-4">
                  <li>Ranch location and practices</li>
                  <li>Beef type (grass-fed, grain-finished, wagyu, etc.)</li>
                  <li>Processing fees and cutting preferences</li>
                  <li>Delivery vs. pickup</li>
                </ul>
                <p className="text-[#6B4F3F] leading-relaxed">
                  You pay the rancher directly. BuyHalfCow only facilitates the connection.
                  Ranchers set their own pricing and terms.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">How do I pay? How do I get my beef?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  You work directly with the rancher on payment (check, Venmo, Zelle, bank transfer — their preference).
                  Delivery/pickup is arranged directly with the rancher based on their operation.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Some ranchers deliver within their region. Some require pickup at the processing facility. 
                  Some ship frozen. You'll discuss all this during your direct conversation.
                </p>
              </div>
            </div>
          </section>

          <Divider />

          {/* Membership Section */}
          <section className="space-y-8">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl border-b border-[#A7A29A] pb-4">
              Membership
            </h2>

            <div className="space-y-8">
              <div className="space-y-4">
                <h3 className="font-medium text-xl">How long until I'm approved?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  <strong className="text-[#0E0E0E]">Launch week:</strong> 24-48 hours (high volume, please be patient)
                  <br />
                  <strong className="text-[#0E0E0E]">Normal:</strong> Same day, typically within 6-12 hours
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">Why do you review applications?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Two reasons:
                </p>
                <ol className="list-decimal list-inside space-y-2 text-[#6B4F3F] leading-relaxed pl-4">
                  <li><strong className="text-[#0E0E0E]">Protect ranchers</strong> — Ranchers get bombarded by tire-kickers and time-wasters. I filter out non-serious buyers so ranchers only spend time on real opportunities.</li>
                  <li><strong className="text-[#0E0E0E]">Maintain quality</strong> — This is a private community, not a public marketplace. Vetting ensures The HERD stays focused on real sourcing and quality relationships.</li>
                </ol>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">Is there a membership fee?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Not yet. Currently free while we grow The HERD.
                  We may introduce a small annual fee ($20-50/year) in the future to ensure serious members only.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">Can I cancel my membership?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Email me anytime. No hard feelings. No recurring fees (yet).
                </p>
              </div>
            </div>
          </section>

          <Divider />

          {/* Trust & Quality Section */}
          <section className="space-y-8">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl border-b border-[#A7A29A] pb-4">
              Trust & Quality
            </h2>

            <div className="space-y-8">
              <div className="space-y-4">
                <h3 className="font-medium text-xl">How do I know ranchers are legit?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Every rancher is personally verified through:
                </p>
                <ul className="list-disc list-inside space-y-2 text-[#6B4F3F] leading-relaxed pl-4">
                  <li><strong className="text-[#0E0E0E]">In-person ranch tours</strong> — I visit operations, document practices, meet the ranchers</li>
                  <li><strong className="text-[#0E0E0E]">Documentation review</strong> — Business licenses, certifications, operation history</li>
                  <li><strong className="text-[#0E0E0E]">Reference checks</strong> — Past customers, industry connections</li>
                </ul>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Only certified ranchers appear in The HERD's member network. I stake my reputation on every ranch.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">Can I source from any state?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  You see ranchers in YOUR state only. Local sourcing keeps things simple — 
                  easier pickup/delivery, support local ranching in your state, build regional relationships.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">What if there's no ranchers in my state?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Email me. I'm actively recruiting ranchers nationwide and traveling for ranch tours.
                  Know a good rancher? Refer them. I'll visit and certify if they meet standards.
                </p>
              </div>
            </div>
          </section>

          <Divider />

          {/* For Ranchers Section */}
          <section className="space-y-8">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl border-b border-[#A7A29A] pb-4">
              For Ranchers
            </h2>

            <div className="space-y-8">
              <div className="space-y-4">
                <h3 className="font-medium text-xl">How does the certification process work?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  After you apply, I review your application and schedule a call. 
                  If it's a good fit, I schedule an in-person ranch tour (traveling through different states certifying ranchers).
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  During the tour, I document your operation, verify practices, and ensure everything checks out.
                  Once certified, your listing goes live and HERD members in your state can request introductions.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">How do I get paid?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Buyers pay you directly using your preferred method (check, Venmo, Zelle, bank transfer, etc.).
                  You set your terms. You control the transaction.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  When a sale closes through a BuyHalfCow introduction, you report it to me and handle the commission separately.
                  Simple, transparent, no payment processing involved.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">What if I get tire-kickers?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  You won't. That's the whole point.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Every member is vetted. Every inquiry is reviewed by me before it reaches you.
                  You only receive introductions from serious buyers who have been verified and approved.
                  No random browsers. No time-wasters. Just qualified buyers ready to source.
                </p>
              </div>
            </div>
          </section>

          <Divider />

          {/* Logistics Section */}
          <section className="space-y-8">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl border-b border-[#A7A29A] pb-4">
              Logistics
            </h2>

            <div className="space-y-8">
              <div className="space-y-4">
                <h3 className="font-medium text-xl">How long does the whole process take?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  <strong className="text-[#0E0E0E]">Application to approval:</strong> 24-48 hours (launch week), usually same day
                  <br />
                  <strong className="text-[#0E0E0E]">Finding a rancher:</strong> Immediate once approved (browse your state's ranchers)
                  <br />
                  <strong className="text-[#0E0E0E]">Introduction facilitation:</strong> 12-24 hours (I review and approve inquiries)
                  <br />
                  <strong className="text-[#0E0E0E]">Transaction with rancher:</strong> Varies — some have beef ready now, some take custom orders (4-6 months)
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">Do I need a chest freezer?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  For a half cow or more, yes. You'll need 8-10 cubic feet minimum.
                  A standard chest freezer (10-15 cubic feet) works great for a half cow.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  Quarter cow might fit in a large upright freezer if you have space.
                  Many members split a half or full cow with friends/family.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-medium text-xl">What states do you cover?</h3>
                <p className="text-[#6B4F3F] leading-relaxed">
                  We have verified ranchers in <strong className="text-[#0E0E0E]">30+ states</strong> and expanding weekly.
                  Once you're approved, you'll see ranchers specifically in your state.
                </p>
                <p className="text-[#6B4F3F] leading-relaxed">
                  If your state isn't covered yet, join anyway — I'm actively recruiting and touring ranches nationwide.
                </p>
              </div>
            </div>
          </section>

          <Divider />

          {/* Still Have Questions */}
          <div className="text-center space-y-6 py-12">
            <h2 className="font-[family-name:var(--font-serif)] text-2xl">
              Still Have Questions?
            </h2>
            <p className="text-[#6B4F3F] leading-relaxed">
              Email me directly: <a href="mailto:support@buyhalfcow.com" className="text-[#0E0E0E] underline">support@buyhalfcow.com</a>
              <br />
              I read and respond to every message personally.
            </p>
            <Divider />
            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
              <Link 
                href="/access"
                className="inline-block px-8 py-4 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-[#0E0E0E] text-center"
              >
                Join The HERD
              </Link>
              <Link 
                href="/"
                className="inline-block px-8 py-4 bg-transparent text-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-[#0E0E0E] text-center"
              >
                Back to Home
              </Link>
            </div>
          </div>
        </div>
      </Container>
    </main>
  );
}
