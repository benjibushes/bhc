import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import {
  sendRancherOnboardingDripDay2,
  sendRancherOnboardingDripDay5,
  sendRancherOnboardingDripDay14,
} from '@/lib/email';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';

// Self-submit / community-submit drip — fires Day 2 / Day 5 / Day 14 nudges
// for ranchers who landed on the map via /map/add-a-rancher and haven't been
// onboarded yet. After Day 14 the cron stops touching them (no infinite drip;
// Ben can resume manually if he wants).
//
// Cadence (loose — runs daily, picks whoever's eligible):
//   Day 2  — if welcome-sent + 2 days elapsed → send Day 2 nudge → stage = day2-sent
//   Day 5  — if day2-sent    + 3 days elapsed → send Day 5 case-study → stage = day5-sent
//   Day 14 — if day5-sent    + 9 days elapsed → send Day 14 last-call → stage = day14-sent
//   After Day 14 sent → stage = completed (drip stops)
//
// Stop conditions (any → set stage = stopped, never email again):
//   - Verification Status flips to "Verified" (Ben closed them)
//   - Onboarding Status moves past pre-onboarding (Call Scheduled, etc.)
//   - Active Status = "Paused" or "Non-Compliant"
//
// All logic gated by Self-Submitted At being non-null. We don't drip ranchers
// who came in via the manual scrape, the claim flow, or USDA/state imports.

export const maxDuration = 60;

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  {
    // Pull only self-submitted prospects whose drip stage is still active.
    // Filtering in code (not formula) — ranchers table is small and
    // formula-side date math against Self-Submitted At is fiddly.
    const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];

    const now = Date.now();
    const DAY_MS = 86_400_000;

    const sent: Array<{ id: string; ranch: string; sent: string }> = [];
    const stopped: Array<{ id: string; ranch: string; reason: string }> = [];

    for (const r of ranchers) {
      const submittedAt = (r['Self-Submitted At'] || '').toString();
      if (!submittedAt) continue;

      const stage = (r['Self-Submit Drip Stage'] || '').toString();
      if (!stage || stage === 'completed' || stage === 'stopped') continue;

      const verification = (r['Verification Status'] || '').toString();
      const onboarding = (r['Onboarding Status'] || '').toString();
      const active = (r['Active Status'] || '').toString();
      const email = (r['Email'] || '').toString().trim().toLowerCase();
      const ranchName = (r['Ranch Name'] || r['Operator Name'] || 'Ranch').toString();
      const operatorName = (r['Operator Name'] || '').toString();

      // Stop conditions — flip stage to "stopped" and bail.
      const stopReason =
        verification === 'Verified'
          ? 'verified'
          : (r['Unsubscribed'] || r['Bounced'] || r['Complained'])
          ? 'opted-out'
          : ['Paused', 'Non-Compliant'].includes(active)
          ? `active:${active}`
          : onboarding && !['', 'pre-onboarding'].includes(onboarding)
          ? `onboarding:${onboarding}`
          : '';
      if (stopReason) {
        try {
          await updateRecord(TABLES.RANCHERS, r.id, {
            'Self-Submit Drip Stage': 'stopped',
          });
          stopped.push({ id: r.id, ranch: ranchName, reason: stopReason });
        } catch (e) {
          console.error('[drip] stop flip failed:', e);
        }
        continue;
      }

      if (!email) continue; // can't drip without an email (community-submit w/ no rancher email)

      const elapsedDays = Math.floor((now - new Date(submittedAt).getTime()) / DAY_MS);

      try {
        if (stage === 'welcome-sent' && elapsedDays >= 2) {
          await sendRancherOnboardingDripDay2({ to: email, ranchName, operatorName });
          await updateRecord(TABLES.RANCHERS, r.id, { 'Self-Submit Drip Stage': 'day2-sent' });
          sent.push({ id: r.id, ranch: ranchName, sent: 'day2' });
        } else if (stage === 'day2-sent' && elapsedDays >= 5) {
          await sendRancherOnboardingDripDay5({ to: email, ranchName, operatorName });
          await updateRecord(TABLES.RANCHERS, r.id, { 'Self-Submit Drip Stage': 'day5-sent' });
          sent.push({ id: r.id, ranch: ranchName, sent: 'day5' });
        } else if (stage === 'day5-sent' && elapsedDays >= 14) {
          await sendRancherOnboardingDripDay14({ to: email, ranchName, operatorName });
          await updateRecord(TABLES.RANCHERS, r.id, { 'Self-Submit Drip Stage': 'day14-sent' });
          sent.push({ id: r.id, ranch: ranchName, sent: 'day14' });
        } else if (stage === 'day14-sent') {
          // Day 14 already fired — close out the drip.
          await updateRecord(TABLES.RANCHERS, r.id, { 'Self-Submit Drip Stage': 'completed' });
          stopped.push({ id: r.id, ranch: ranchName, reason: 'completed-after-day14' });
        }
      } catch (e) {
        console.error(`[drip] send failed for ${r.id} (${ranchName}):`, e);
      }
    }

    // Telegram summary if anything happened.
    if ((sent.length || stopped.length) && TELEGRAM_ADMIN_CHAT_ID) {
      try {
        const lines: string[] = ['🌱 Self-submit drip cron'];
        if (sent.length) {
          lines.push(`Sent (${sent.length}):`);
          for (const s of sent) lines.push(`  · ${s.ranch} — ${s.sent}`);
        }
        if (stopped.length) {
          lines.push(`Stopped (${stopped.length}):`);
          for (const s of stopped) lines.push(`  · ${s.ranch} — ${s.reason}`);
        }
        await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'));
      } catch (e) {
        console.error('[drip] telegram summary failed:', e);
      }
    }

    return {
      status: 'success',
      recordsTouched: sent.length + stopped.length,
      notes: `sent=${sent.length} stopped=${stopped.length}`,
    };
  }
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('rancher-onboarding-drip', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
