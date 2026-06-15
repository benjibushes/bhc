// app/api/cron/migration-deadline/route.ts
//
// MIGRATION DEADLINE — daily soft-cutover enforcement for tier_v2 rollout.
//
// Runs every day at 15:00 UTC. For each rancher with a Migration Status of
// 'invited' / 'call_scheduled' / 'upgrading' (NOT yet 'completed'):
//
//   1. Compute days remaining until Migration Deadline.
//   2. If past deadline AND Pricing Model still legacy:
//        → flip Active Status to 'Paused'
//        → flip Migration Status to 'paused_overdue'
//        → loud Telegram alert (operator can manually unpause if needed)
//        → buyer routing auto-stops via isRancherOperationalForBuyers gate
//   3. If 7d / 4d / 2d / 1d remaining, fire email nudge to the rancher with
//      a fresh deadline countdown + their wizard link.
//   4. Telegram operator with a daily digest of who's progressing vs at-risk.
//
// Self-healing: once Pricing Model auto-flips to tier_v2 via the webhook
// auto-flip (just shipped), Migration Status = 'completed' and this cron
// skips the rancher entirely.

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { addCalPrefill } from '@/lib/calPrefill';
import { getOperatorBookingUrl } from '@/lib/calBooking';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

export const maxDuration = 180;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
// Operator booking link is resolved once per run via getOperatorBookingUrl()
// (lib/calBooking.ts) and threaded into buildNudgeEmail — single source of
// truth, never a dead hardcoded slug (incident 2026-06-14).
// Days from deadline at which we fire a nudge email. Tighten cadence as
// deadline approaches.
const NUDGE_DAYS = new Set([7, 4, 2, 1]);

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

interface NudgeEmailArgs {
  firstName: string;
  ranchName: string;
  daysLeft: number;
  setupUrl: string;
  // Resolved operator booking URL (from getOperatorBookingUrl). Never a dead
  // hardcoded slug — falls back to /contact if no live Cal event.
  bookUrl: string;
  // Identity passed to Cal.com prefill so the rancher doesn't re-type
  // name/email on the booking form. Falsy values are tolerated — Cal
  // falls back to manual entry.
  fullName?: string;
  email?: string;
  rancherId?: string;
}

function buildNudgeEmail({ firstName, ranchName, daysLeft, setupUrl, bookUrl, fullName, email, rancherId }: NudgeEmailArgs) {
  const first = firstName || 'there';
  const urgency = daysLeft <= 1 ? 'tomorrow' : daysLeft <= 2 ? 'in 2 days' : `in ${daysLeft} days`;
  const subject =
    daysLeft <= 1
      ? `${first} — ${ranchName} payout upgrade deadline ${urgency}`
      : `${first} — ${daysLeft} days left to upgrade ${ranchName} payouts`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;margin:0 0 16px 0;">${first}, ${urgency} on the payout upgrade</h1>
<p>Quick reminder — you've got <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong> left to switch ${ranchName} to the new platform-collected deposit flow. After the deadline, the system pauses new lead routing to your page until you finish.</p>
<p><strong>5-min DIY path:</strong> open your wizard, pick tier, Stripe Connect, set deposits. Done.</p>
<div style="text-align:center;margin:24px 0;">
  <a href="${setupUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Finish the upgrade →</a>
</div>
<p><strong>Want me to walk you through it on a 15-min call?</strong></p>
<div style="text-align:center;margin:14px 0;">
  <a href="${addCalPrefill(bookUrl, { name: fullName, email, metadata: { rancherId } })}" style="display:inline-block;padding:12px 28px;background:#FFFFFF;color:#0E0E0E;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;border:1px solid #0E0E0E;">Book your 15-min call →</a>
</div>
<p style="font-size:13px;color:#6B4F3F;">Reply to this email if you hit any snag — I'll respond same-day.</p>
<p style="font-size:13px;color:#6B4F3F;">— Benjamin, BuyHalfCow</p>
</body></html>`;
  return { subject, html };
}

async function realHandler(_request: Request): Promise<CronResult> {
  // Resolve the operator booking link once per run (single source of truth;
  // cached 1h inside calBooking). Never throws; falls back to /contact.
  const bookUrl = await getOperatorBookingUrl('rancher');
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
  // Only legacy ranchers with an invite already sent. Other statuses (not_invited,
  // completed, paused_overdue) are out of scope for this cron.
  // M1 (2026-06-10): EXCLUDE Active Status='Paused' rows. Renick Valley
  // Zimmerman (rec3K0LsDGQKONNnb) is paused as a known duplicate of
  // Gajewski. Without this filter, the cron would email Day 7/4/2/1
  // nudges to jesse@renickvalley.com and auto-pause again on Day 14.
  const inFlight = ranchers.filter((r) => {
    const pm = String(r['Pricing Model'] || '').toLowerCase();
    const ms = String(r['Migration Status'] || '');
    const activeStatusObj: any = r['Active Status'];
    const activeStatus = String(
      typeof activeStatusObj === 'object' && activeStatusObj?.name
        ? activeStatusObj.name
        : activeStatusObj || ''
    );
    if (activeStatus === 'Paused') return false;
    return pm !== 'tier_v2' && ['invited', 'call_scheduled', 'upgrading'].includes(ms);
  });

  let nudged = 0;
  let paused = 0;
  const nudgeFailures: string[] = [];
  const pausedRanchers: string[] = [];

  for (const r of inFlight) {
    const id: string = r.id;
    const name: string = r['Operator Name'] || r['Ranch Name'] || id;
    const firstName = String(name).split(' ')[0] || 'there';
    const email: string = String(r['Email'] || '').trim();
    const deadlineRaw: string = r['Migration Deadline'] || '';

    if (!deadlineRaw) {
      // Invited but no deadline stamped — backfill 14d from now (legacy
      // edge case: invite sent before this field existed).
      try {
        await updateRecord(TABLES.RANCHERS, id, {
          'Migration Deadline': new Date(
            Date.now() + 14 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });
      } catch {}
      continue;
    }

    const deadlineMs = new Date(deadlineRaw).getTime();
    const daysLeft = Math.ceil((deadlineMs - Date.now()) / (24 * 60 * 60 * 1000));

    // ── PAST DEADLINE → AUTO-PAUSE ────────────────────────────────────
    if (daysLeft <= 0) {
      try {
        await updateRecord(TABLES.RANCHERS, id, {
          'Active Status': 'Paused',
          'Migration Status': 'paused_overdue',
        });
        paused++;
        pausedRanchers.push(name);
      } catch (e: any) {
        nudgeFailures.push(`${name}: pause-flip failed — ${e?.message || 'unknown'}`);
      }
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⏸ <b>RANCHER AUTO-PAUSED</b>\n\n🤠 ${name}\nReason: tier_v2 migration deadline passed.\n\nState: ${r['State'] || '?'}\n\n<i>Their buyers will waitlist until they finish the upgrade. Manually unpause from /admin/ranchers/${id} once they complete it.</i>`,
        );
      } catch {}
      continue;
    }

    // ── NUDGE WINDOWS ────────────────────────────────────────────────
    if (NUDGE_DAYS.has(daysLeft) && email) {
      // Mint a fresh wizard token per nudge (rancher may have lost the
      // original email). 60-day expiry matches send-v2-upgrade.
      const token = jwt.sign({ type: 'rancher-setup', rancherId: id }, JWT_SECRET, { expiresIn: '60d' });
      const setupUrl = `${SITE_URL}/rancher/setup?token=${token}`;
      const { subject, html } = buildNudgeEmail({
        firstName,
        ranchName: name,
        daysLeft,
        setupUrl,
        bookUrl,
        fullName: name,
        email,
        rancherId: id,
      });
      try {
        const sendRes: any = await sendEmail({
          to: email,
          subject,
          html,
          templateName: 'sendMigrationNudge',
          _replyContext: { type: 'rnc', recordId: id },
        } as any);
        if (sendRes?.suppressed) {
          nudgeFailures.push(`${name}: nudge suppressed — ${sendRes.reason || 'unknown'}`);
        } else {
          nudged++;
        }
      } catch (e: any) {
        nudgeFailures.push(`${name}: nudge send failed — ${e?.message || 'unknown'}`);
      }
    }
  }

  // Daily operator digest — only fires if there's something to report.
  if (paused > 0 || nudged > 0 || inFlight.length > 0) {
    try {
      const lines: string[] = [
        `📊 <b>MIGRATION DAILY</b>`,
        '',
        `Total in-flight: ${inFlight.length}`,
        `Nudge emails sent today: ${nudged}`,
        `Paused today (deadline hit): ${paused}`,
      ];
      if (pausedRanchers.length > 0) {
        lines.push('', '<b>Paused:</b>', ...pausedRanchers.map((n) => `• ${n}`));
      }
      if (nudgeFailures.length > 0) {
        lines.push('', '<b>Failures:</b>', ...nudgeFailures.slice(0, 5).map((f) => `• ${f}`));
      }
      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'));
    } catch {}
  }

  const status: CronResult['status'] = nudgeFailures.length > 0 ? 'partial' : 'success';
  return {
    status,
    recordsTouched: nudged + paused,
    notes: `inflight=${inFlight.length} nudged=${nudged} paused=${paused} failures=${nudgeFailures.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    const ok = authHeader === `Bearer ${cronSecret}`;
    if (!ok) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('migration-deadline', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
