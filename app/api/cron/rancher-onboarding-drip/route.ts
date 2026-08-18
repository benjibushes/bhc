import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { excludeBrokerRanchers } from '@/lib/brokerRail';
import {
  sendRancherOnboardingDripDay2,
  sendRancherOnboardingDripDay5,
  sendRancherOnboardingDripDay14,
} from '@/lib/email';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { JWT_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import jwt from 'jsonwebtoken';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

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
    // BROKER RAIL: represented ranchers get no onboarding drip — there is no
    // onboarding for them to complete.
    const ranchers = excludeBrokerRanchers((await getAllRecords(TABLES.RANCHERS)) as any[]);

    const now = Date.now();
    const DAY_MS = 86_400_000;

    // ── Day 2 live demand count (campaign-rewrite 2026-08-18) ───────────────
    // Same definition as /api/stats/buyers-by-state (Beef Buyer segment,
    // routable stage, not suppressed). Pulled lazily ONCE per run, only when
    // a Day 2 send is actually due; a read failure renders the email's
    // count-free network line instead — never blocks a send, never claims a
    // number we didn't count.
    const ROUTABLE_STAGES = ['NEW', 'WAITING', 'READY', 'MATCHED'];
    let buyersByStatePromise: Promise<Map<string, number>> | null = null;
    const buyersByState = () => {
      if (!buyersByStatePromise) {
        buyersByStatePromise = (async () => {
          const map = new Map<string, number>();
          try {
            const buyers = (await getAllRecords(
              TABLES.CONSUMERS,
              '{Segment} = "Beef Buyer"',
            )) as any[];
            for (const b of buyers) {
              if (b['Unsubscribed'] || b['Bounced'] || b['Complained']) continue;
              if (!ROUTABLE_STAGES.includes(String(b['Buyer Stage'] || ''))) continue;
              const st = String(b['State'] || '').trim().toUpperCase();
              if (!/^[A-Z]{2}$/.test(st)) continue;
              map.set(st, (map.get(st) || 0) + 1);
            }
          } catch (e) {
            console.error('[drip] buyers-by-state pull failed — Day 2 renders count-free line:', e);
          }
          return map;
        })();
      }
      return buyersByStatePromise;
    };

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

      // Mint a fresh 60-day self-serve setup link so the drip nudges can lead
      // with the 5-minute wizard (primary CTA) instead of only "book a call".
      // Token is minted per send and never stored — same shape as /go.
      const state = (r['State'] || '').toString();
      let setupUrl = '';
      try {
        const token = jwt.sign({ type: 'rancher-setup', rancherId: r.id }, JWT_SECRET, { expiresIn: '60d' });
        setupUrl = `${SITE_URL}/rancher/setup?token=${token}`;
      } catch (e) {
        console.error('[drip] setup token mint failed:', e);
      }

      // MISMATCH FIX (P0 2026-06-23): stamp the stage BEFORE the send (with
      // rollback on send failure), mirroring rancher-launch-warmup's Phase 1
      // pattern. The prior order was send-then-flip inside this try: a good
      // send followed by a thrown stage `updateRecord` left the stage at
      // welcome-sent/day2-sent/day5-sent, so the SAME drip re-sent on EVERY
      // daily run until the write landed (no date sub-guard — purely
      // stage+elapsed-days). Flip-first means worst-case we skip one drip on a
      // send failure (recoverable: the rollback restores the prior stage), not
      // spam the rancher daily.
      //
      // dripStep: advance the stage first, fire the email, restore the prior
      // stage if the send throws. Returns true if the email was sent.
      const dripStep = async (
        nextStage: string,
        send: () => Promise<unknown>,
        label: string,
      ): Promise<void> => {
        // CROSS-RAIL DEDUP (email-hygiene 2026-08-02): rancher-followup's
        // daily new-applicant "finish your setup" nudge and this drip had no
        // cross-read — a self-submit rancher with blank Onboarding Status got
        // BOTH on day 2. Both rails now honor the shared Ranchers stamp
        // 'Last Onboarding Nudge At': if ANY onboarding nudge touched this
        // rancher in the last 48h, skip this run WITHOUT advancing the stage
        // (the step simply retries on a later daily run), and stamp it on our
        // own sends (below) so rancher-followup's ≥2-day throttle backs off
        // in the other direction too.
        const lastNudgeMs = new Date(String(r['Last Onboarding Nudge At'] || '')).getTime();
        if (isFinite(lastNudgeMs) && now - lastNudgeMs < 48 * 60 * 60 * 1000) {
          console.info(`[drip] ${r.id} (${ranchName}) nudged by another rail <48h ago — deferring ${label}`);
          return;
        }
        try {
          await updateRecord(TABLES.RANCHERS, r.id, {
            'Self-Submit Drip Stage': nextStage,
            // Shared cross-rail stamp — kept even if the send below fails and
            // the stage rolls back (conservative: suppressing a nudge for 48h
            // beats double-mailing the rancher).
            'Last Onboarding Nudge At': new Date().toISOString(),
          });
        } catch (stampErr) {
          // Couldn't advance the stage — do NOT send (sending now would
          // re-send next run since the stage never moved). Skip this run.
          console.error(`[drip] stage pre-stamp failed for ${r.id} (${ranchName}) — skipping send:`, stampErr);
          return;
        }
        try {
          await send();
          sent.push({ id: r.id, ranch: ranchName, sent: label });
        } catch (sendErr) {
          // Best-effort rollback so the next run retries this same step
          // instead of skipping ahead with no email delivered.
          console.error(`[drip] send failed for ${r.id} (${ranchName}) after stage flip — rolling back stage:`, sendErr);
          try {
            await updateRecord(TABLES.RANCHERS, r.id, { 'Self-Submit Drip Stage': stage });
          } catch (rollbackErr) {
            console.error(`[drip] stage rollback failed for ${r.id} (${ranchName}):`, rollbackErr);
          }
        }
      };

      try {
        if (stage === 'welcome-sent' && elapsedDays >= 2) {
          const st = state.trim().toUpperCase();
          const familiesInState = /^[A-Z]{2}$/.test(st) ? (await buyersByState()).get(st) || 0 : 0;
          await dripStep('day2-sent', () => sendRancherOnboardingDripDay2({ to: email, ranchName, operatorName, setupUrl, state, familiesInState }), 'day2');
        } else if (stage === 'day2-sent' && elapsedDays >= 5) {
          await dripStep('day5-sent', () => sendRancherOnboardingDripDay5({ to: email, ranchName, operatorName, setupUrl, state }), 'day5');
        } else if (stage === 'day5-sent' && elapsedDays >= 14) {
          await dripStep('day14-sent', () => sendRancherOnboardingDripDay14({ to: email, ranchName, operatorName, setupUrl, state }), 'day14');
        } else if (stage === 'day14-sent') {
          // Day 14 already fired — close out the drip.
          await updateRecord(TABLES.RANCHERS, r.id, { 'Self-Submit Drip Stage': 'completed' });
          stopped.push({ id: r.id, ranch: ranchName, reason: 'completed-after-day14' });

          // If they're still a Prospect after the full drip, alert Ben so he can call them.
          if (verification === 'Prospect' && TELEGRAM_ADMIN_CHAT_ID) {
            try {
              const rancherState = (r['State'] || '').toString().replace(/[<>&"]/g, (c: string) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
              const rancherPhone = (r['Phone'] || r['Cell Phone'] || '').toString().replace(/[<>&"]/g, (c: string) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
              const safeName = operatorName.replace(/[<>&"]/g, (c: string) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
              const safeEmail = email.replace(/[<>&"]/g, (c: string) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
              const safeRanch = ranchName.replace(/[<>&"]/g, (c: string) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
              const prospectMsg = [
                `📞 <b>Drip exhausted — still a Prospect</b>`,
                `Ranch: ${safeRanch}`,
                `Name: ${safeName}`,
                `State: ${rancherState || '(unknown)'}`,
                `Email: ${safeEmail}`,
                `Phone: ${rancherPhone || '(none on file)'}`,
                `Action: drip exhausted, still a prospect — call them`,
              ].join('\n');
              await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, prospectMsg);
            } catch (e) {
              console.error('[drip] prospect-alert telegram failed:', e);
            }
          }
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
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('rancher-onboarding-drip', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
