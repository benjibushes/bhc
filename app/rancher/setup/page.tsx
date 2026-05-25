import type { Metadata } from 'next';
import { Suspense } from 'react';
import Container from '../../components/Container';
import RancherSetupWizard from './RancherSetupWizard';

// Self-serve rancher onboarding wizard. Magic link in welcome email lands here.
// Replaces the prior manual flow:
//   submit → welcome → Calendly call → Ben sends docs → sign → live
// With:
//   submit → welcome → /rancher/setup/[token] → 4-step wizard → sign → live
//
// Optional Calendly call still available — wizard offers "talk to Ben"
// escape hatch on every step. But the default is self-serve.

export const metadata: Metadata = {
  title: 'Set up your ranch',
  description:
    'Confirm your details, set your prices, sign the agreement. Self-serve in under 10 minutes.',
};

export default function RancherSetupPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <Suspense
        fallback={
          <Container>
            <div className="py-24 text-center text-saddle">Loading your page…</div>
          </Container>
        }
      >
        <RancherSetupWizard />
      </Suspense>
    </main>
  );
}
