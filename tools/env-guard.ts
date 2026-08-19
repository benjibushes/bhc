// tools/env-guard.ts — every env read must have a real fallback, or be
// explicitly declared as "presence IS the flag".
//
// WHY (launch-readiness audit 2026-08-19). 202 env vars are read across the
// codebase and 104 are set in production. That gap is fine — most reads carry
// a default — but nothing enforced it. A knob added without a fallback is
// `undefined` in production, and `Number(undefined)` is NaN, which silently
// disables a cadence gate rather than failing loudly. This makes that a build
// error instead of a live-traffic surprise.
//
// Two modes:
//   npm run env:check          CI-safe. No network. Fails when an env read has
//                              no fallback and is not declared optional.
//   npm run env:check -- --live  Also lists vars SET in Vercel production that
//                              no code reads (debris). Needs the vercel CLI.
//
// The "dead var" half deliberately does NOT run in CI: it needs network and an
// authenticated CLI, and a var can be read dynamically (process.env[name]),
// which static analysis cannot always resolve. Live mode reports; it never
// fails the build on its own.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Vars whose ABSENCE is the configuration: the code branches on
 * `if (!VAR) return` or renders nothing. These need no fallback because
 * undefined already means "feature off" — the safe direction.
 *
 * Adding a name here is a claim that unset is a valid, safe production state.
 * Do not add a var whose absence would break a money path or a send.
 */
const PRESENCE_IS_THE_FLAG: ReadonlySet<string> = new Set([
  // Analytics tags — unset renders no script at all, which is the privacy-safe
  // default and exactly what a consent-denied visitor gets anyway.
  'NEXT_PUBLIC_GA4_ID',
  'NEXT_PUBLIC_GOOGLE_ADS_ID',
  'NEXT_PUBLIC_META_PIXEL_ID',
  // Meta CAPI test-events code. Set only while validating in Events Manager;
  // in normal operation it MUST be unset or events land in test mode.
  'META_CAPI_TEST_CODE',
  // Optional per-table retention overrides ("Email Sends=45"). The parser
  // returns {} for undefined and the committed RETENTION table applies.
  'LOG_RETENTION_DAYS_OVERRIDE',
  // Twilio call recording — the whole feature no-ops without credentials.
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  // Local tooling only; never read by the app at runtime.
  'AIRTABLE_PAT',
]);

/**
 * Vars that MUST be set in production and correctly have no fallback: a
 * default would be a wrong key, a wrong price, or a silently disabled money
 * path. Absence must break loudly, not degrade quietly.
 *
 * These are the opposite of PRESENCE_IS_THE_FLAG. Live mode checks each one is
 * actually present in Vercel production and FAILS if not — that check is the
 * whole reason this list is worth maintaining.
 */
const REQUIRED_IN_PRODUCTION: ReadonlySet<string> = new Set([
  // Stripe subscription price ids — a fallback price would bill the wrong tier.
  'STRIPE_OPERATOR_PRICE_ID',
  'STRIPE_RANCH_PRICE_ID',
  'STRIPE_PASTURE_PRICE_ID',
  // Client-side Stripe key. Build-inlined; unset means checkout cannot mount.
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  // Meta Conversions API. A default token/pixel would post conversions to
  // someone else's ad account.
  'META_CAPI_ACCESS_TOKEN',
  'META_PIXEL_ID',
  // Web-push signing key for rancher notifications.
  'VAPID_PRIVATE_KEY',
]);

/** Tokens that count as "this read has a fallback" within a few lines. */
const FALLBACK = new RegExp(
  [
    '\\|\\|', '\\?\\?', '\\?\\s', 'DEFAULT', 'Number\\.isFinite',
    '>\\s*0', "===?\\s*['\"]", "!==?\\s*['\"]", 'fallback', 'parseNudgeKnob',
    '\\bknob\\b', 'if\\s*\\(!', 'Boolean\\(',
  ].join('|'),
  'i',
);

function sourceFiles(): string[] {
  const out = execSync('git ls-files app lib tools', { encoding: 'utf-8' });
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.includes('.test.'));
}

interface Ref {
  hasFallback: boolean;
  sites: string[];
}

function collectRefs(files: string[]): Map<string, Ref> {
  const refs = new Map<string, Ref>();
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(resolve(process.cwd(), file), 'utf-8').split('\n');
    } catch (e: any) {
      // A file git lists but that is not on disk (unstaged deletion) must not
      // crash the guard — a crash reports zero problems, which reads exactly
      // like a clean tree.
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    lines.forEach((line, i) => {
      // Skip comment lines: a var named only in prose is not a read. This is
      // what makes the difference between "SEND_DOMAINS is live" and the truth
      // (its only mentions are comments explaining it was REPLACED).
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      for (const m of line.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        const name = m[1];
        const window = lines.slice(i, i + 4).join('\n');
        const entry = refs.get(name) || { hasFallback: false, sites: [] };
        if (FALLBACK.test(window)) entry.hasFallback = true;
        if (entry.sites.length < 3) entry.sites.push(`${file}:${i + 1}`);
        refs.set(name, entry);
      }
    });
  }
  return refs;
}

/**
 * Names reached only through `process.env[someVariable]`. Static analysis
 * cannot resolve these, so live mode must not call them dead. We collect the
 * string literals that appear in name-map objects near a dynamic read.
 */
function collectDynamicNames(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(resolve(process.cwd(), file), 'utf-8');
    } catch {
      continue;
    }
    if (!/process\.env\[/.test(src)) continue;
    // Any SCREAMING_SNAKE string literal in a file that does a dynamic read is
    // a candidate env name. Deliberately generous: a false "this is live" is
    // far cheaper than telling someone to delete a var that IS read.
    for (const m of src.matchAll(/['"]([A-Z][A-Z0-9_]{3,})['"]/g)) names.add(m[1]);
  }
  return names;
}

function main(): void {
  const live = process.argv.includes('--live');
  const files = sourceFiles();
  const refs = collectRefs(files);

  const missingFallback: Array<[string, string[]]> = [];
  for (const [name, ref] of [...refs].sort()) {
    if (ref.hasFallback) continue;
    if (PRESENCE_IS_THE_FLAG.has(name)) continue;
    if (REQUIRED_IN_PRODUCTION.has(name)) continue;
    missingFallback.push([name, ref.sites]);
  }

  console.log(`env-guard: ${refs.size} env vars read across ${files.length} files.`);

  if (missingFallback.length > 0) {
    console.error('');
    console.error('ENV READ WITH NO FALLBACK — undefined in production:');
    for (const [name, sites] of missingFallback) {
      console.error(`  ${name}  ${sites[0]}`);
    }
    console.error('');
    console.error(
      'Resolve it one of three ways:\n' +
        '  - give the read a default (most cadence knobs);\n' +
        '  - add it to PRESENCE_IS_THE_FLAG, if unset means "feature off" and that is SAFE;\n' +
        '  - add it to REQUIRED_IN_PRODUCTION, if absence must break loudly (keys, price ids).\n' +
        'All three are in tools/env-guard.ts. Say WHY in a comment.',
    );
    process.exit(1);
  }

  console.log(
    `env-guard: clean. Every read has a fallback, or is declared ` +
      `(${PRESENCE_IS_THE_FLAG.size} presence-flags, ${REQUIRED_IN_PRODUCTION.size} required secrets).`,
  );

  if (!live) return;

  // ── live mode: vars set in Vercel that nothing reads ────────────────────
  let vercelOut = '';
  try {
    vercelOut = execSync('npx vercel env ls production', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.log('env-guard: --live skipped (vercel CLI unavailable or not authenticated).');
    return;
  }
  const setNames = new Set(
    vercelOut
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((n) => /^[A-Z][A-Z0-9_]+$/.test(n)),
  );
  // Required secrets must actually BE there. This is the check that would have
  // caught STRIPE_CONNECT_ENABLED sitting blank while the admin surface 403'd.
  const missingRequired = [...REQUIRED_IN_PRODUCTION].filter((n) => !setNames.has(n)).sort();
  if (missingRequired.length > 0) {
    console.error('');
    console.error('REQUIRED IN PRODUCTION BUT NOT SET:');
    for (const n of missingRequired) console.error(`  ${n}`);
    process.exitCode = 1;
  } else {
    console.log('');
    console.log(`env-guard: all ${REQUIRED_IN_PRODUCTION.size} required secrets are set in production.`);
  }

  const dynamic = collectDynamicNames(files);
  const dead = [...setNames].filter((n) => !refs.has(n) && !dynamic.has(n)).sort();

  console.log('');
  if (dead.length === 0) {
    console.log('env-guard: no dead production vars.');
    return;
  }
  console.log(`SET IN PRODUCTION, NEVER READ (${dead.length}) — safe to delete:`);
  for (const n of dead) console.log(`  ${n}`);
  console.log('');
  console.log('Comment-only mentions do not count as a read. Verify one by hand before deleting.');
}

main();
