// Tests for the storefront render canary (lib/storefrontRenderCheck.ts).
//
// Red-first anchor: the "incident" fixture below is the exact structural shape
// production served on 2026-07-28 (/ranchers/foodstead — complete HTML, whole
// body deferred behind B:0/S:0, $RC present, NO reveal backstop) which rendered
// as a blank skeleton in every rAF-less browser. The canary must flag it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStorefrontHtml } from './storefrontRenderCheck';
import { REVEAL_BACKSTOP_MARKER, REVEAL_BACKSTOP_JS } from './revealBackstop';

const BACKSTOP = `<script ${REVEAL_BACKSTOP_MARKER}="">${REVEAL_BACKSTOP_JS}</script>`;

function page(parts: { backstop?: boolean; template?: boolean; segment?: boolean; rc?: boolean; body?: string }) {
  return [
    '<!DOCTYPE html><html><head>',
    parts.backstop ? BACKSTOP : '',
    '</head><body><header>nav</header>',
    parts.template ? '<!--$?--><template id="B:0"></template><main class="animate-pulse">skeleton</main><!--/$-->' : '',
    parts.segment ? `<div hidden id="S:0"><main>${parts.body ?? 'Foodstead — Montana Grass-Fed Beef $1650'}</main></div>` : '',
    parts.rc ? '<script>$RC=function(){};$RC("B:0","S:0")</script>' : '',
    '</body></html>',
  ].join('');
}

test('healthy page with no deferred boundaries passes (homepage shape)', () => {
  const r = checkStorefrontHtml('<!DOCTYPE html><html><head></head><body><main>Full content</main></body></html>');
  assert.equal(r.ok, true);
  assert.equal(r.deferredBoundaries, 0);
});

test('INCIDENT SHAPE: deferred boundary + $RC but NO backstop is flagged', () => {
  // This is exactly what production served when foodstead rendered blank.
  const r = checkStorefrontHtml(page({ template: true, segment: true, rc: true, backstop: false }));
  assert.equal(r.ok, false);
  assert.equal(r.deferredBoundaries, 1);
  assert.match(r.problems.join('\n'), /reveal backstop/);
});

test('deferred boundary + $RC + backstop passes (fixed shape)', () => {
  const r = checkStorefrontHtml(page({ template: true, segment: true, rc: true, backstop: true }));
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.deferredBoundaries, 1);
});

test('boundary with segment but missing $RC completion call is flagged', () => {
  const r = checkStorefrontHtml(page({ template: true, segment: true, rc: false, backstop: true }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /no \$RC\("B:0","S:0"\) completion call/);
});

test('boundary with no hidden segment (truncated stream) is flagged', () => {
  const r = checkStorefrontHtml(page({ template: true, segment: false, rc: false, backstop: true }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /truncated\/partial stream/);
});

test('hidden segment with attributes in either order is recognized', () => {
  const swapped =
    `<!DOCTYPE html><html><head>${BACKSTOP}</head><body>` +
    '<!--$?--><template id="B:1"></template>fallback<!--/$-->' +
    '<div id="S:1" hidden><main>content</main></div>' +
    '<script>$RC("B:1","S:1")</script></body></html>';
  const r = checkStorefrontHtml(swapped);
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('expectContent marker missing is flagged', () => {
  const r = checkStorefrontHtml(page({ template: true, segment: true, rc: true, backstop: true }), {
    expectContent: 'Reserve your share',
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /expected content marker/);
});

test('expectContent marker present passes', () => {
  const r = checkStorefrontHtml(
    page({ template: true, segment: true, rc: true, backstop: true, body: 'Foodstead — Reserve your share' }),
    { expectContent: 'Reserve your share' },
  );
  assert.equal(r.ok, true, r.problems.join('; '));
});
