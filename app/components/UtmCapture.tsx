'use client';

// UtmCapture — first-touch attribution on every entry page.
//
// Why: ads can land directly on /access, /start, /founders, /brand-partners,
// /access/[state], /ranchers/[slug] — not just /. Before this lived inside
// FullHomepage only, so ad traffic to deep links silently dropped UTM →
// Source fell back to "organic" → over-attribution to organic.
//
// Now: mounted from app/layout.tsx, fires once on first mount per page.
// Writes legacy plain-string localStorage keys (bhc_source, bhc_campaign,
// bhc_utm_params, bhc_ref) for backward compat w/ existing /access readers
// PLUS richer JSON bhc_source_v2 holding the full first-touch snapshot.

import { useEffect } from 'react';

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
] as const;

export default function UtmCapture() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);

      // ── Legacy plain-string keys (consumed by app/access/page.tsx) ──
      const campaign = params.get('campaign');
      const source = params.get('source') || params.get('utm_source');
      const ref = params.get('ref') || params.get('aff');
      const utmParams = params.toString();

      if (campaign) {
        localStorage.setItem('bhc_campaign', campaign);
        if (!localStorage.getItem('bhc_source')) {
          localStorage.setItem('bhc_source', source || 'email');
        }
      } else if (source && !localStorage.getItem('bhc_source')) {
        localStorage.setItem('bhc_source', source);
      }
      if (ref) localStorage.setItem('bhc_ref', ref);
      // utm_params: only overwrite when new params present, preserves first-touch
      if (utmParams && !localStorage.getItem('bhc_utm_params')) {
        localStorage.setItem('bhc_utm_params', utmParams);
      }

      // ── Rich JSON snapshot (bhc_source_v2) — first-touch wins ──
      const captured_at = new Date().toISOString();
      const stored: Record<string, string> = {};
      try {
        const existing = localStorage.getItem('bhc_source_v2');
        if (existing) Object.assign(stored, JSON.parse(existing));
      } catch {
        // corrupt — start fresh.
      }

      let captured = false;
      for (const k of UTM_KEYS) {
        const v = params.get(k);
        if (v && !stored[k]) {
          stored[k] = v;
          captured = true;
        }
      }

      if (captured) {
        stored.captured_at = stored.captured_at || captured_at;
        stored.landing_path = stored.landing_path || window.location.pathname;
        try {
          localStorage.setItem('bhc_source_v2', JSON.stringify(stored));
        } catch {
          // localStorage full or disabled — silent.
        }
      }
    } catch {
      // Defensive — never crash render.
    }
  }, []);

  return null;
}
