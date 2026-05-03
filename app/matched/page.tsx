// Ceremonial handoff page — fires after a buyer clicks YES on a warmup email
// and matching/suggest successfully creates a referral. Replaces the prior
// drop-the-buyer-on-the-dashboard experience that gave them nothing visible
// to confirm the YES click did anything.
//
// Pattern from research (Crowd Cow early days + Superhuman onboarding): the
// moment between "I asked for a match" and "the rancher emails me" is the
// highest-anxiety point in the funnel. Show the buyer something real (rancher
// name + bio + what to expect) so they don't bounce thinking the form broke.
//
// Query params:
//   ?rancher={name}
//   &state={2-letter}
//   &pending={true}   ← Project 2 onboarding-throttle gate. When set, render
//                       the founder-vetting variant: rancher just went live,
//                       Ben is personally vetting the match before letting
//                       the rancher reach out. Sets 24-48h expectation.
// Public page — no auth required. The buyer is already logged in via the
// session cookie /api/warmup/engage set, but this page renders even without it.

import Link from 'next/link';
import Container from '../components/Container';
import Divider from '../components/Divider';

export const dynamic = 'force-dynamic'; // query params change per visit

type Props = {
  searchParams: Promise<{ rancher?: string; state?: string; pending?: string }>;
};

export default async function MatchedPage({ searchParams }: Props) {
  const params = await searchParams;
  const rancherName = (params.rancher || 'your rancher').trim() || 'your rancher';
  const stateLabel = (params.state || '').trim().toUpperCase() || 'your state';
  const isPending = (params.pending || '').toLowerCase() === 'true';

  if (isPending) {
    return (
      <main className="min-h-screen bg-[#F4F1EC] py-16 md:py-24">
        <Container>
          <div className="max-w-2xl mx-auto bg-white border border-[#A7A29A] p-10 md:p-14 text-center">
            <div className="text-6xl mb-6">🤝</div>
            <h1 className="font-serif text-3xl md:text-4xl mb-4 text-[#0E0E0E]">
              You&rsquo;re in.
            </h1>
            <p className="text-base text-[#6B4F3F] mb-8">
              I&rsquo;m personally vetting your match with {rancherName} before
              they reach out — expect 24&ndash;48h.
            </p>

            <Divider />

            <div className="text-left bg-[#FAF8F4] border-l-4 border-[#0E0E0E] p-6 my-8 space-y-3">
              <p className="text-sm text-[#2A2A2A]">
                <strong>Why the pause?</strong> {rancherName} is new to the
                network and I&rsquo;m hand-checking every intro for the first
                week. It&rsquo;s how I keep the bar high — for you and for them.
              </p>
              <p className="text-sm text-[#2A2A2A]">
                <strong>What happens next:</strong> within 24&ndash;48 hours
                you&rsquo;ll hear from {rancherName} directly. Same flow as a
                regular match — they&rsquo;ll cover pricing, the next
                processing date, and how delivery works.
              </p>
              <p className="text-sm text-[#2A2A2A]">
                <strong>Heads up:</strong> the call usually comes from a
                {' '}{stateLabel} area code on the rancher&rsquo;s personal phone,
                not an 800 number. Don&rsquo;t miss it.
              </p>
            </div>

            <Divider />

            <p className="text-xs text-[#A7A29A] mt-10">
              Reply to my last email if you have questions. I&rsquo;ll personally
              respond.
            </p>

            <p className="text-xs text-[#A7A29A] mt-2">— Benjamin</p>

            <div className="mt-10">
              <Link href="/member" className="text-sm underline text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
                Or go to your member dashboard →
              </Link>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#F4F1EC] py-16 md:py-24">
      <Container>
        <div className="max-w-2xl mx-auto bg-white border border-[#A7A29A] p-10 md:p-14 text-center">
          <div className="text-6xl mb-6">🤝</div>
          <h1 className="font-serif text-3xl md:text-4xl mb-4 text-[#0E0E0E]">
            You're being matched with {rancherName}.
          </h1>
          <p className="text-base text-[#6B4F3F] mb-8">
            Your YES click went through. {rancherName} just got an email with
            your name, state, and what you're looking for.
          </p>

          <Divider />

          <div className="text-left bg-[#FAF8F4] border-l-4 border-[#0E0E0E] p-6 my-8 space-y-3">
            <p className="text-sm text-[#2A2A2A]">
              <strong>Within the next 24–48 hours:</strong> {rancherName} will reach
              out via email or phone. They have your contact info, your
              preferred order size, and your state.
            </p>
            <p className="text-sm text-[#2A2A2A]">
              <strong>What they&rsquo;ll cover on the call:</strong> current pricing
              for the cut you want, the next processing date, how delivery
              works, and any questions you have.
            </p>
            <p className="text-sm text-[#2A2A2A]">
              <strong>Pickup or delivery</strong> usually happens 2–4 weeks after
              you confirm — that&rsquo;s the time the rancher needs to process and
              age the beef properly.
            </p>
          </div>

          <Divider />

          <p className="text-sm text-[#6B4F3F] mt-8">
            Heads up: the call usually comes from the rancher&rsquo;s personal phone, not
            an 800 number. If you don&rsquo;t recognize a {stateLabel} area code in the
            next few days, that&rsquo;s probably them.
          </p>

          <p className="text-xs text-[#A7A29A] mt-10">
            Reply to my last email if you don&rsquo;t hear from them within 48 hours.
            I&rsquo;ll personally make sure the connection happens.
          </p>

          <p className="text-xs text-[#A7A29A] mt-2">— Benjamin</p>

          <div className="mt-10">
            <Link href="/member" className="text-sm underline text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              Or go to your member dashboard →
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}
