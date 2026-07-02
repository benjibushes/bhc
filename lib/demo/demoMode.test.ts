// Production-safety pin for the demo gate. The FIRST assertion — neither env
// var set → false — is the whole point: if this ever goes true by default,
// production would start serving fake data. Do not weaken it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDemoMode } from './demoMode';

// isDemoMode() reads process.env directly (NEXT_PUBLIC_* is inlined at build
// in the app, but at test time it's a plain env read). Snapshot + restore so
// these cases don't leak into each other or the rest of the suite.
function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
) {
  const keys = ['NEXT_PUBLIC_DEMO_MODE', 'DEMO_MODE', 'VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_ENV'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('isDemoMode: neither env set → false (PRODUCTION SAFETY PIN)', () => {
  withEnv({}, () => {
    assert.equal(isDemoMode(), false);
  });
});

test("isDemoMode: NEXT_PUBLIC_DEMO_MODE='true' → true", () => {
  withEnv({ NEXT_PUBLIC_DEMO_MODE: 'true' }, () => {
    assert.equal(isDemoMode(), true);
  });
});

test("isDemoMode: DEMO_MODE='true' (server-only) → true", () => {
  withEnv({ DEMO_MODE: 'true' }, () => {
    assert.equal(isDemoMode(), true);
  });
});

test("isDemoMode: a random value → false", () => {
  withEnv({ NEXT_PUBLIC_DEMO_MODE: 'yes' }, () => {
    assert.equal(isDemoMode(), false);
  });
  withEnv({ NEXT_PUBLIC_DEMO_MODE: '1' }, () => {
    assert.equal(isDemoMode(), false);
  });
  withEnv({ DEMO_MODE: 'TRUE' }, () => {
    // strict === 'true' — casing matters. 'TRUE' must NOT enable demo mode.
    assert.equal(isDemoMode(), false);
  });
});

test("isDemoMode: empty string → false", () => {
  withEnv({ NEXT_PUBLIC_DEMO_MODE: '', DEMO_MODE: '' }, () => {
    assert.equal(isDemoMode(), false);
  });
});

// ── HARD PRODUCTION LOCK (2026-07-02) ────────────────────────────────────────
// The demo flag must be OVERRIDDEN by a Vercel production deploy. Even if the
// flag is somehow set true in Vercel prod env, demo mode stays off.

test('HARD LOCK: VERCEL_ENV=production overrides NEXT_PUBLIC_DEMO_MODE=true → false', () => {
  withEnv({ VERCEL_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'true' }, () => {
    assert.equal(isDemoMode(), false);
  });
});

test('HARD LOCK: VERCEL_ENV=production overrides DEMO_MODE=true → false', () => {
  withEnv({ VERCEL_ENV: 'production', DEMO_MODE: 'true' }, () => {
    assert.equal(isDemoMode(), false);
  });
});

test('HARD LOCK: NEXT_PUBLIC_VERCEL_ENV=production (client boundary) overrides the flag → false', () => {
  withEnv({ NEXT_PUBLIC_VERCEL_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'true' }, () => {
    assert.equal(isDemoMode(), false);
  });
});

test('preview/development deploys still allow demo when the flag is on', () => {
  // A Vercel PREVIEW deploy (or local) is NOT locked — only 'production' is.
  withEnv({ VERCEL_ENV: 'preview', NEXT_PUBLIC_DEMO_MODE: 'true' }, () => {
    assert.equal(isDemoMode(), true);
  });
  withEnv({ VERCEL_ENV: 'development', DEMO_MODE: 'true' }, () => {
    assert.equal(isDemoMode(), true);
  });
});
