// app/api/cron/deploy-drift/route.ts
//
// DEPLOY DRIFT DETECTION — fires loud Telegram alert when production
// is serving an old build vs git HEAD on main.
//
// Background: on 2026-06-04 we discovered Vercel was on manual-promotion
// mode. Every commit since 06/02 built successfully but never aliased to
// www.buyhalfcow.com. Phone gate, qualify gate, Cal.com, deposit upgrade
// = all dead in prod for ~3 days. Bad leads piled up. This cron makes
// that scenario IMPOSSIBLE to miss again.
//
// Procedure:
//   1. Fetch GET buyhalfcow.com/api/version → returns prod's build SHA
//   2. Fetch GitHub main HEAD SHA (no auth needed, public repo)
//   3. If sha mismatch:
//        - Compute commit-count drift via GitHub compare API
//        - Telegram alert with diff + count + minutes since drift began
//   4. Stamp Cron Run row with status='partial' if drift detected
//
// Schedule: every 30 min via vercel.json. Cheap (3 HTTP calls).

import { NextResponse } from 'next/server';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 60;

const PROD_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const REPO_OWNER = process.env.DEPLOY_DRIFT_REPO_OWNER || 'benjibushes';
const REPO_NAME = process.env.DEPLOY_DRIFT_REPO_NAME || 'bhc';
const BRANCH = 'main';
// Optional GitHub token. Unauthenticated GitHub API is 60 req/hr per IP and
// Vercel's shared egress IPs blow through it → 403. A token raises the limit
// to 5000/hr and unlocks private-repo refs. Set GITHUB_TOKEN to silence the 403.
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.DEPLOY_DRIFT_GITHUB_TOKEN || '';
function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'cache-control': 'no-cache', 'User-Agent': 'bhc-deploy-drift-cron' };
  if (GH_TOKEN) h['Authorization'] = `Bearer ${GH_TOKEN}`;
  return h;
}

interface DriftResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<DriftResult> {
  let prodSha = '';
  let prodShortSha = '';
  let prodEnv = '';
  try {
    const r = await fetch(`${PROD_URL}/api/version`, {
      // No-cache so we always see live state, not a CDN edge cache.
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
    });
    if (!r.ok) {
      throw new Error(`prod /api/version returned ${r.status}`);
    }
    const j = await r.json();
    prodSha = String(j.sha || '');
    prodShortSha = String(j.shortSha || '');
    prodEnv = String(j.env || '');
  } catch (e: any) {
    // Fatal: can't compare. Fire alert + return error.
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🚨 <b>DEPLOY DRIFT CRON — CAN'T REACH PROD</b>\n\n` +
          `Failed to fetch ${PROD_URL}/api/version\n` +
          `Error: ${(e?.message || 'unknown').slice(0, 200)}\n\n` +
          `<i>Either prod is down OR /api/version not deployed yet. Investigate.</i>`,
      );
    } catch {}
    return {
      status: 'error',
      recordsTouched: 0,
      notes: `prod version fetch failed: ${e?.message || 'unknown'}`,
    };
  }

  let headSha = '';
  let headCommitDate = '';
  try {
    // GitHub public API — no auth needed for public repo refs.
    const r = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}`,
      { cache: 'no-store', headers: ghHeaders() },
    );
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const j = await r.json();
    headSha = String(j.sha || '');
    headCommitDate = String(j.commit?.committer?.date || '');
  } catch (e: any) {
    // GitHub API flakiness (403 rate-limit on shared Vercel IPs, transient
    // network, private repo without a token) is NOT a prod problem — do NOT
    // fire a loud CRON ERROR for it. Return success so withCronRun stays quiet;
    // only real drift (prod behind HEAD) pages. Set GITHUB_TOKEN to kill the 403.
    console.warn('[deploy-drift] GitHub HEAD fetch skipped:', e?.message);
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `GitHub HEAD fetch skipped (no alarm): ${e?.message || 'unknown'}`,
    };
  }

  const inSync = prodSha === headSha;
  if (inSync) {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `in sync at ${prodShortSha} (${prodEnv})`,
    };
  }

  // DRIFT — compute how many commits behind + how long stale.
  let commitsBehind = 0;
  let commitMessages: string[] = [];
  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/compare/${prodSha}...${headSha}`,
      { cache: 'no-store', headers: { 'User-Agent': 'bhc-deploy-drift-cron' } },
    );
    if (r.ok) {
      const j = await r.json();
      commitsBehind = Number(j.ahead_by || 0);
      commitMessages = (j.commits || [])
        .slice(-5)
        .map((c: any) => (c.commit?.message || '').split('\n')[0].slice(0, 60))
        .reverse();
    }
  } catch {}

  const stalenessMin = headCommitDate
    ? Math.floor((Date.now() - new Date(headCommitDate).getTime()) / 60000)
    : 0;

  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🚨 <b>DEPLOY DRIFT — PROD IS STALE</b>\n\n` +
        `🔵 Prod SHA: <code>${prodShortSha}</code> (${prodEnv})\n` +
        `🟢 HEAD SHA: <code>${headSha.slice(0, 7)}</code>\n` +
        `📊 Behind: ${commitsBehind} commit${commitsBehind === 1 ? '' : 's'}\n` +
        `⏱ HEAD pushed ${stalenessMin}m ago\n\n` +
        (commitMessages.length > 0
          ? `<b>Missing commits:</b>\n${commitMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n`
          : '') +
        `<i>Likely cause: Vercel manual-promotion is ON. Click Promote on the latest READY deploy in the Vercel dashboard OR disable manual promotion in Settings → Git.</i>`,
    );
  } catch (e: any) {
    console.error('[deploy-drift] Telegram alert failed:', e?.message);
  }

  return {
    status: 'partial',
    recordsTouched: commitsBehind,
    notes: `DRIFT: prod=${prodShortSha} HEAD=${headSha.slice(0, 7)} (${commitsBehind} behind, ${stalenessMin}m stale)`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('deploy-drift', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
