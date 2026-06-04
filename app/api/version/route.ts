import { NextResponse } from 'next/server';

// Public version endpoint — no auth, no Airtable, no external calls.
// Returns the build SHA + deploy time so the deploy-drift cron + external
// monitors can detect when prod is stale relative to git HEAD.
//
// Why public: drift checks need to work from outside the platform (status
// page, uptime monitor, GitHub Action). Auth-gating would force every
// caller to share CRON_SECRET, which leaks the secret surface area.
// Build SHA isn't sensitive — anyone can see commit hashes on GitHub.
//
// Source of truth: Vercel auto-injects VERCEL_GIT_COMMIT_SHA at build time.
// If missing (local dev), falls back to env-supplied COMMIT_SHA or 'dev'.
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    'dev';
  const shortSha = sha.length >= 7 ? sha.slice(0, 7) : sha;
  const ref = process.env.VERCEL_GIT_COMMIT_REF || 'unknown';
  const repo = process.env.VERCEL_GIT_REPO_SLUG || '';
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown';
  const region = process.env.VERCEL_REGION || '';
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID || '';
  // Vercel doesn't expose a build-time "deployed at" so we use the deployment
  // URL's created stamp via header. Best proxy: VERCEL_GIT_COMMIT_AUTHOR_LOGIN
  // + repoPushedAt aren't injected. Caller can hit Vercel API to cross-check.

  return NextResponse.json({
    ok: true,
    sha,
    shortSha,
    ref,
    repo,
    env,
    region,
    deploymentId,
    timestamp: new Date().toISOString(),
  });
}
