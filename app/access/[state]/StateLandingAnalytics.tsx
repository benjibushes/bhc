'use client';

// Audit 6 P1 — paid-scale tracking gap.
//
// /access/[state] is a server component (revalidate=3600 SSG, 50 states
// generated statically). State-targeted Meta ads need a state-segmented
// view event so Meta's optimization algorithm sees per-state conversion
// signal — not just a generic PageView lumped in with every other surface.
//
// Zero-render island: fires state_landing_view on mount, then nothing.

import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

interface Props {
  state: string;
  stateName?: string;
  rancherCount?: number;
}

export default function StateLandingAnalytics({
  state,
  stateName,
  rancherCount,
}: Props) {
  useEffect(() => {
    trackEvent('state_landing_view', {
      state,
      ...(stateName ? { stateName } : {}),
      ...(typeof rancherCount === 'number' ? { rancherCount } : {}),
    });
  }, [state, stateName, rancherCount]);

  return null;
}
