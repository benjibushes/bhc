// Storefront render canary (rancher-page blank-render incident, 2026-07-28).
//
// THE FAILURE MODE THIS CATCHES: served HTML is complete (200, full bytes,
// closes </html>) but the page renders BLANK in a real browser. Cause: Next
// streaming-SSR defers content behind a Suspense boundary — the body ships as
// `<div hidden id="S:n">` plus a `<template id="B:n">` marker, and an inline
// `$RC("B:n","S:n")` completion script performs the swap. React 19.2 made that
// swap depend on a requestAnimationFrame tick, so in rAF-less environments
// (hidden tabs, headless verifiers, ad-review crawlers) the content never
// unhides and buyers/bots see the loading skeleton forever. HTTP-level probes
// (status + byte count) are blind to it — which is exactly how it shipped.
//
// A Vercel cron can't run a browser, so this is the cheapest HONEST proxy:
// structural assertions on the served HTML that encode the reveal contract.
//   1. Every deferred boundary must be COMPLETE: for each `<template id="B:n">`
//      there is a matching hidden segment `S:n` AND a `$RC("B:n","S:n")`
//      completion call (catches truncated/partially-baked static artifacts).
//   2. If ANY deferred boundary exists, the document must carry the reveal
//      backstop (lib/revealBackstop.ts marker) — the script that guarantees
//      the swap happens even when rAF never fires. Before the 2026-07-28 fix
//      this check goes red on /ranchers/foodstead; after it, removing the
//      backstop from app/layout.tsx turns it red again.
//   3. The expected content marker (e.g. the ranch name) must be present
//      somewhere in the document — a pure sanity floor.
//
// Pure string logic, no DOM, unit-tested in lib/storefrontRenderCheck.test.ts.

import { REVEAL_BACKSTOP_MARKER } from './revealBackstop';

export interface StorefrontRenderCheckResult {
  ok: boolean;
  /** Human-readable problems, empty when ok. */
  problems: string[];
  /** Number of deferred (streamed) Suspense boundaries found in the HTML. */
  deferredBoundaries: number;
}

export function checkStorefrontHtml(
  html: string,
  opts: { expectContent?: string } = {},
): StorefrontRenderCheckResult {
  const problems: string[] = [];

  // Deferred boundary ids: <template id="B:0"> etc.
  const templateIds = new Set<string>();
  for (const m of html.matchAll(/<template[^>]*\bid="B:([^"]+)"/g)) {
    templateIds.add(m[1]);
  }
  // Hidden segment ids: <div hidden id="S:0"> (attribute order can vary).
  const segmentIds = new Set<string>();
  for (const m of html.matchAll(/<div[^>]*\bhidden[^>]*\bid="S:([^"]+)"|<div[^>]*\bid="S:([^"]+)"[^>]*\bhidden/g)) {
    segmentIds.add(m[1] ?? m[2]);
  }
  // Completion calls: $RC("B:0","S:0")
  const completed = new Set<string>();
  for (const m of html.matchAll(/\$RC\("B:([^"]+)","S:\1"\)/g)) {
    completed.add(m[1]);
  }

  for (const id of templateIds) {
    if (!segmentIds.has(id)) {
      problems.push(
        `deferred boundary B:${id} has no hidden segment S:${id} — truncated/partial stream baked into the artifact; fallback renders forever`,
      );
    } else if (!completed.has(id)) {
      problems.push(
        `deferred boundary B:${id} has segment S:${id} but no $RC("B:${id}","S:${id}") completion call — content can never reveal`,
      );
    }
  }

  if (templateIds.size > 0 && !html.includes(REVEAL_BACKSTOP_MARKER)) {
    problems.push(
      `HTML has ${templateIds.size} deferred boundary(ies) but no reveal backstop (${REVEAL_BACKSTOP_MARKER}) — ` +
        'reveal depends on a requestAnimationFrame tick that hidden tabs / headless verifiers / ad crawlers never deliver ' +
        '(the 2026-07-28 blank-storefront bug). Restore the backstop script in app/layout.tsx.',
    );
  }

  if (opts.expectContent && !html.includes(opts.expectContent)) {
    problems.push(`expected content marker ${JSON.stringify(opts.expectContent)} not found in HTML`);
  }

  return { ok: problems.length === 0, problems, deferredBoundaries: templateIds.size };
}
