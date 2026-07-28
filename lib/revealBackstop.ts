// Suspense reveal backstop (rancher-page blank-render incident, 2026-07-28).
//
// ROOT CAUSE this guards against: React 19.2 batches streaming-SSR Suspense
// boundary reveals. The inline `$RC("B:n","S:n")` completion scripts no longer
// swap content directly — they queue the (template, hidden-segment) pair into
// `window.$RB`, and ONLY when the queue length transitions to exactly 2 (the
// first pair) schedule the real reveal (`window.$RV`) via requestAnimationFrame.
// In any environment that never delivers a rAF frame — hidden/background tabs,
// prerendering, headless verifiers (ad-review bots, crawlers, uptime checkers),
// some automation browsers — that flush NEVER runs. The served HTML is complete,
// there are zero console errors, but every deferred segment (e.g. the entire
// /ranchers/[slug] body behind its loading.tsx boundary) stays `hidden` forever
// and the page renders as an eternal skeleton. Later `$RC` calls push onto the
// now-length->2 queue and schedule nothing, so the page can never self-heal.
//
// THE BACKSTOP: a tiny inline script (installed in app/layout.tsx) that polls
// briefly after load. If React's own flush has run at least once,
// `window.$RT` is a number and — critically — every SUBSEQUENT batch is
// scheduled by React with setTimeout (which fires even in hidden documents),
// so the backstop disarms. If instead the queue holds an unflushed pair and
// `$RT` is still undefined, we invoke `window.$RV(window.$RB)` ourselves —
// byte-for-byte the call the missing rAF tick would have made. Idempotent and
// race-free: everything is same-thread, `$RV` drains the queue in place, and a
// late rAF firing afterwards iterates zero pairs.
//
// Fails soft by design: every access is guarded, so if a future Next/React
// upgrade renames these internals the script is a silent no-op — and the
// storefront render canary (lib/storefrontRenderCheck.ts, exercised by the
// synthetic-e2e cron) goes red because pages with deferred boundaries must
// carry this marker.
//
// Do NOT rename the marker without updating lib/storefrontRenderCheck.ts.
export const REVEAL_BACKSTOP_MARKER = 'data-bhc-reveal-backstop';

// Plain ES5, no template-literal backticks inside, safe for inline <script>.
export const REVEAL_BACKSTOP_JS = `(function(){
var deadline=Date.now()+30000;
function flush(){try{var q=window.$RB;if(q&&q.length>1&&typeof window.$RV==="function"){window.$RV(q);}}catch(e){}}
var iv=setInterval(function(){
if(typeof window.$RT==="number"||Date.now()>deadline){clearInterval(iv);return;}
flush();
},250);
document.addEventListener("visibilitychange",flush);
window.addEventListener("pageshow",flush);
})();`;
