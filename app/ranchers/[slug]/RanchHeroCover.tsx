'use client';

import { useState } from 'react';

// ── Hero cover with bulletproof degradation ──────────────────────────────
// P0 #1: the cover photo (first Gallery Photo) must NEVER render as a broken-
// image icon or a stark blank. Three states are handled:
//   1. No URL given          → branded gradient + ranch motif (rendered by
//                              the parent's `else` branch; this component is
//                              only mounted when a URL exists).
//   2. URL given, loads OK   → full-bleed cover photo + legibility scrim.
//   3. URL given, 404/errors → onError swaps to the SAME branded gradient +
//                              motif as state 1, so a dead link looks
//                              intentional, not broken.
//
// We intentionally use a plain <img> (not next/image) here: next/image's
// optimizer proxies remote URLs through /_next/image, and a dead upstream
// surfaces as a 500 from the optimizer with no client onError we can catch.
// A raw <img> gives us a reliable onError to fall back on. `loading="eager"`
// + fetchPriority keep it LCP-fast. The wrapper is absolutely positioned by
// the parent, so this fills the hero box.

export default function RanchHeroCover({
  src,
  alt,
}: {
  src: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return <RanchCoverFallback />;
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="absolute inset-0 h-full w-full object-cover"
        loading="eager"
        // @ts-expect-error fetchpriority is valid HTML, types lag
        fetchpriority="high"
        decoding="async"
        onError={() => setFailed(true)}
      />
      {/* Legibility scrim — keeps overlaid hero text readable on any image. */}
      <div className="absolute inset-0 bg-gradient-to-t from-charcoal/85 via-charcoal/50 to-charcoal/30" />
    </>
  );
}

// Branded gradient placeholder with a subtle ranch motif (rolling hills +
// sun). Warm charcoal→saddle wash matches the palette; the motif is a faint
// bone-tinted SVG so it reads as "ranch" without competing with hero text.
// Exported so the server page can render the identical fallback when there's
// no cover URL at all — one source of truth for "never blank".
export function RanchCoverFallback() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-gradient-to-br from-charcoal via-divider to-saddle">
      <svg
        aria-hidden
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 800 400"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* soft sun */}
        <circle cx="620" cy="120" r="60" fill="var(--color-bone)" opacity="0.06" />
        <circle cx="620" cy="120" r="38" fill="var(--color-bone)" opacity="0.05" />
        {/* layered rolling hills */}
        <path
          d="M0 300 C 160 250 280 290 420 270 C 560 250 680 300 800 280 L800 400 L0 400 Z"
          fill="var(--color-bone)"
          opacity="0.05"
        />
        <path
          d="M0 340 C 180 300 300 340 440 320 C 600 296 700 340 800 322 L800 400 L0 400 Z"
          fill="var(--color-bone)"
          opacity="0.07"
        />
        {/* a couple of fence posts for texture */}
        <g stroke="var(--color-bone)" strokeWidth="3" opacity="0.06">
          <line x1="120" y1="300" x2="120" y2="360" />
          <line x1="190" y1="296" x2="190" y2="356" />
          <line x1="260" y1="300" x2="260" y2="360" />
          <line x1="110" y1="320" x2="270" y2="316" />
        </g>
      </svg>
      {/* Keep the same text scrim direction so hero copy contrast is identical
          whether the cover is a photo or this fallback. */}
      <div className="absolute inset-0 bg-gradient-to-t from-charcoal/70 via-charcoal/30 to-transparent" />
    </div>
  );
}
