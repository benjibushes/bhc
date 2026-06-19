// app/qualify/[consumerId]/page.tsx
//
// RESUME entry for the unified buyer funnel (2026-06-18).
//
// The quiz-drip emails link here (/qualify/<consumerId>?token=<jwt>) for an
// existing WAITING lead that gave size/timing/contact but bailed before
// finalizing. The wizard (BuyerFunnel, mode="resume") picks up at the Storage
// step using the consumerId + token from the URL, then POSTs /api/qualify to
// finalize + match — exactly the same finalize the fresh flow uses.
//
// This replaces the old standalone 4-step client quiz. Token validity is
// enforced server-side by /api/qualify (it verifies the qualify-access JWT is
// scoped to this consumerId); the wizard surfaces a graceful error if the token
// is missing/expired rather than dead-ending.
//
// Server component: reads runtime operator config so the reveal flips between
// "your rancher reaches out" and "book Ben's call" with no redeploy.

import { getAdminConfig } from '@/lib/adminConfig';
import BuyerFunnel from '@/app/components/funnel/BuyerFunnel';

export default async function QualifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ consumerId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ consumerId }, { token }, cfg] = await Promise.all([
    params,
    searchParams,
    getAdminConfig(),
  ]);

  return (
    <BuyerFunnel
      mode="resume"
      consumerId={consumerId}
      token={typeof token === 'string' ? token : undefined}
      offerOperatorCall={cfg.funnelOfferOperatorCall}
    />
  );
}
