// app/api/cron/connect-stuck-nudge/route.ts
//
// Connect-stuck nudge DRIP — the RANCHER mirror of the buyer abandoned-quiz
// drip (app/api/cron/abandoned-quiz-nudge). Recovers tier_v2 ranchers who
// PAID (Subscription Status='active') but bailed at Stripe Connect onboarding
// (Stripe Connect Status != 'active'). Until Connect is live they are:
//   - invisible to buyer routing (lib/rancherEligibility gates them out), and
//   - a 409 wall for any buyer who reaches their deposit
//     (app/api/checkout/deposit/route.ts:123 requires Connect='active').
// Net: they paid and literally cannot get paid. This drip closes that loop.
//
// Targets: Pricing Model='tier_v2' AND Subscription Status='active' AND
// Stripe Connect Status != 'active' AND has Email AND not suppressed
// (Unsubscribed/Bounced/Complained). (Operationally this is the cohort behind
// the 🔄 Resync button + the deposit gate — same "stuck at Connect" state.)
//
// Cadence: 3 touches, spaced — touch 1 on first sight, then +2d, +4d
// (≈ days 1 / 3 / 7). Copy escalates: friendly nudge → "here's the cost of
// leaving it" → last automated note. After 3 touches the rancher stops.
//
// Progress is tracked WITHOUT a new schema field — copied EXACTLY from
// abandoned-quiz-nudge: each send stamps the rancher's Notes with
// `[connect-nudge YYYY-MM-DD tN]`. We count those stamps to know how many
// touches were sent and read the most-recent date for spacing.
//
// Per send we mint a FRESH Stripe Connect onboarding link the same way
// app/api/rancher/connect/start does (createConnectAccount if the rancher has
// no account yet, then createOnboardingLink — Date.now() in the link
// idempotencyKey guarantees a brand-new link every time, so a stale email
// link never dead-ends). return_url drops them back into the wizard at Step 8
// (Fulfillment): /rancher/setup?token=<fresh rancher-setup JWT>&connectComplete=1.
//
// Schedule: daily (vercel.json '0 16 * * *'). Conservative — at most one touch
// per rancher per day, per-run cap below.
//
// CRITICAL — migration safety: this cron MUST NOT write Migration Status,
// Migration Deadline, V2 Upgrade Invite Sent At, or Active Status. The ONLY
// Airtable writes it makes are (a) the Notes cadence stamp, and (b) — only on
// the first-ever account creation for a rancher with no Connect account —
// 'Stripe Connect Account Id' + 'Stripe Connect Status'='onboarding', which is
// the BYTE-FOR-BYTE same persist app/api/rancher/connect/start performs (so a
// refresh mid-flow doesn't duplicate the account). The stripe-connect webhook
// remains the sole authority that flips Connect Status → 'active'; we never
// write 'active' and never touch status-derivation in lib/stripeConnect.ts.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendConnectStuckNudge } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { JWT_SECRET } from '@/lib/secrets';
import { createConnectAccount, createOnboardingLink } from '@/lib/stripeConnect';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Days to wait BEFORE each touch, indexed by touches-already-sent.
// [0,2,4] → touch1 immediately, touch2 +2d after touch1, touch3 +4d after
// touch2 (≈ days 1 / 3 / 7). Length = max touches.
const CADENCE_SPACING_DAYS = [0, 2, 4];
const MAX_TOUCHES = CADENCE_SPACING_DAYS.length;
// Per-run send cap — paces a backlog over multiple daily runs instead of one
// spike (deliverability + avoids tripping a spam filter), and bounds Stripe
// account-link API calls per run. Matches abandoned-quiz-nudge's posture.
const MAX_SENDS_PER_RUN = Number(process.env.CONNECT_NUDGE_MAX_PER_RUN) || 40;

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

// Read an Airtable single-select / linked value that may arrive as a string
// or as a { name } object (mirrors lib/rancherEligibility's readEnumOrString).
function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * Mint a FRESH Stripe Connect onboarding link for a stuck rancher — the same
 * path as app/api/rancher/connect/start's mintOnboardingUrl:
 *   1. If the rancher has no Stripe Connect Account Id, create a V2 account
 *      and persist it immediately (so a refresh mid-flow can't duplicate).
 *   2. Mint a fresh account link (Date.now() in idempotencyKey → new link
 *      every call) with return_url back into the wizard at Step 8.
 *
 * The persist in step 1 writes ONLY 'Stripe Connect Account Id' +
 * 'Stripe Connect Status'='onboarding' — identical to connect/start. It never
 * writes 'active' (the webhook owns that) and never touches any migration
 * field. Returns null on any failure so the caller skips this rancher cleanly.
 */
async function mintFreshConnectLink(rancher: any): Promise<string | null> {
  const rancherId: string = rancher.id;
  const email = String(rancher['Email'] || '').trim();
  if (!email) return null;

  let accountId = String(rancher['Stripe Connect Account Id'] || '').trim();

  // First-time onboarding: create the V2 Connect account, persist immediately.
  // Mirrors app/api/rancher/connect/start/route.ts:67-103 exactly.
  if (!accountId) {
    const displayName = String(
      rancher['Operator Name'] || rancher['Ranch Name'] || 'BHC Rancher',
    ).trim();
    try {
      const result = await createConnectAccount({ email, displayName, rancherId });
      accountId = result.accountId;
    } catch (e: any) {
      console.error(`[connect-stuck-nudge] account create failed for ${rancherId}:`, e?.message);
      return null;
    }
    // Persist BEFORE link creation so a refresh mid-flow doesn't duplicate.
    // NOTE: these two fields are the SAME persist connect/start does — NOT a
    // migration field, and never 'active'. The webhook flips to 'active'.
    try {
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Stripe Connect Account Id': accountId,
        'Stripe Connect Status': 'onboarding',
      });
    } catch (e: any) {
      console.error(`[connect-stuck-nudge] Connect-account persist failed for ${rancherId}:`, e?.message);
      // Continue — Stripe account exists; webhook will resync status.
    }
  }

  // Fresh rancher-setup JWT (60d, type='rancher-setup') — same token the
  // wizard validates. This is the wizardToken the return_url carries so the
  // rancher resumes inside the setup wizard (Step 8) after Stripe, exactly
  // like connect/start's wizard caller.
  const wizardToken = jwt.sign({ type: 'rancher-setup', rancherId }, JWT_SECRET, {
    expiresIn: '60d',
  });
  const returnUrl = `${SITE_URL}/rancher/setup?token=${encodeURIComponent(wizardToken)}&connectComplete=1`;

  try {
    const { url } = await createOnboardingLink({
      accountId,
      returnUrl,
      // Same refresh_url as connect/start — Stripe redirects here (GET) when
      // the link expires, and that route auto-re-mints a fresh one.
      refreshUrl: `${SITE_URL}/api/rancher/connect/start`,
    });
    return url;
  } catch (e: any) {
    console.error(`[connect-stuck-nudge] onboarding link mint failed for ${rancherId}:`, e?.message);
    return null;
  }
}

async function realHandler(_request: Request): Promise<CronResult> {
  // Hard env gate — mirrors connect/start. If Connect isn't enabled in this
  // env we can't mint links, so there's nothing to do (clean no-op, not error).
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return { status: 'success', recordsTouched: 0, notes: 'STRIPE_CONNECT_ENABLED!=true — skipped' };
  }

  const today = new Date().toISOString().slice(0, 10);

  // Candidate cohort: tier_v2, paid (Subscription active), Connect NOT active,
  // has Email, not suppressed. Filtered in JS off the full Ranchers pull (the
  // table is small and Pricing Model / Subscription Status / Stripe Connect
  // Status can be single-select objects, which formula equality is brittle
  // against — readEnumOrString normalizes both shapes).
  const ranchers = (await getAllRecords(TABLES.RANCHERS).catch(() => [])) as any[];
  const candidates = ranchers.filter((r) => {
    const pm = readEnumOrString(r['Pricing Model']).toLowerCase();
    if (pm !== 'tier_v2') return false;
    const sub = readEnumOrString(r['Subscription Status']).toLowerCase();
    if (sub !== 'active') return false;
    const connect = readEnumOrString(r['Stripe Connect Status']).toLowerCase();
    if (connect === 'active') return false; // already done — not stuck
    if (!String(r['Email'] || '').trim()) return false;
    if (r['Unsubscribed'] || r['Bounced'] || r['Complained']) return false;
    return true;
  });

  let touched = 0;
  let skipped = 0;
  const byTouch: Record<number, number> = {};

  for (const r of candidates) {
    if (touched >= MAX_SENDS_PER_RUN) break; // pace: drain the rest next run

    const notes = String(r['Notes'] || '');

    // One touch per rancher per day, max.
    if (notes.includes(`connect-nudge ${today}`)) { skipped++; continue; }

    // Count prior touches + find the most-recent nudge date.
    const dates = [...notes.matchAll(/connect-nudge (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort();
    const touchesSent = dates.length;
    if (touchesSent >= MAX_TOUCHES) { skipped++; continue; } // drip exhausted

    // Spacing: enough days since the last touch before firing the next one.
    if (touchesSent > 0) {
      const lastDate = dates[dates.length - 1];
      const daysSinceLast = Math.floor((Date.parse(today) - Date.parse(lastDate)) / 86_400_000);
      if (daysSinceLast < CADENCE_SPACING_DAYS[touchesSent]) { skipped++; continue; }
    }

    const touchNum = touchesSent + 1;
    const email = String(r['Email'] || '').trim().toLowerCase();
    const ranchName = String(r['Ranch Name'] || r['Operator Name'] || 'your ranch');
    const operatorName = String(r['Operator Name'] || r['Ranch Name'] || '');

    // Mint the fresh Connect link (creates the account if missing). If this
    // fails we DON'T stamp Notes — so the rancher is retried next run rather
    // than silently consuming a cadence slot with no email sent.
    const connectUrl = await mintFreshConnectLink(r);
    if (!connectUrl) { skipped++; continue; }

    try {
      const res = await sendConnectStuckNudge({
        to: email,
        ranchName,
        operatorName,
        connectUrl,
        touchNum,
      });
      if (res?.suppressed) {
        // Unsubscribed/bounced/complained caught at send time — don't stamp,
        // they'll be filtered out on the next run by the suppression check.
        console.warn(`[connect-stuck-nudge] send suppressed for ${email}: ${res.reason || 'unknown'}`);
        skipped++;
        continue;
      }
      await updateRecord(TABLES.RANCHERS, r.id, {
        Notes: `[connect-nudge ${today} t${touchNum}] sent. ${notes}`.slice(0, 2000),
      });
      touched++;
      byTouch[touchNum] = (byTouch[touchNum] || 0) + 1;
    } catch (e: any) {
      console.warn(`[connect-stuck-nudge] send failed for ${email}:`, e?.message);
    }
    await new Promise((r) => setTimeout(r, 500)); // pace
  }

  if (touched > 0) {
    const breakdown = Object.keys(byTouch).sort().map((t) => `t${t}:${byTouch[+t]}`).join(' ');
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🔌 <b>Connect-stuck nudge</b> (tier_v2 paid · Connect not live): ${touched} sent (${breakdown}) · ${skipped} skipped · ${candidates.length} in cohort.`,
    ).catch(() => {});
  }

  return { status: 'success', recordsTouched: touched, notes: `sent=${touched} skipped=${skipped} cohort=${candidates.length}` };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('connect-stuck-nudge', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
