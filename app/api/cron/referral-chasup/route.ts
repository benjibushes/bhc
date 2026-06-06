import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, sendTelegramUpdate, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';
import { sendEmail, sendRepeatPurchaseEmail, sendRancherLeadReminder } from '@/lib/email';
import { withCronRun } from '@/lib/cronRun';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHASE_UPS = 3;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
import { JWT_SECRET } from '@/lib/secrets';
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_CONFIGURED = !!(OLLAMA_URL || ANTHROPIC_KEY);

// Runs daily at 11am MT (17:00 UTC)
// Auto-sends AI re-engagement emails (max 3 per referral), auto-closes stale referrals
async function realHandler(request: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked' | 'error'; recordsTouched: number; notes: string; skipReasonBreakdown?: Record<string, number> }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  if (!AI_CONFIGURED) {
    return { status: 'error', recordsTouched: 0, notes: 'AI not configured (set OLLAMA_BASE_URL or ANTHROPIC_API_KEY)' };
  }

  const skipReasons: Record<string, number> = {};

  const referrals = await getAllRecords(
      TABLES.REFERRALS,
      'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")'
    ) as any[];

    // Fetch unsubscribed emails to skip them
    const consumers = await getAllRecords(TABLES.CONSUMERS) as any[];
    const unsubscribedEmails = new Set(
      consumers
        .filter((c: any) => c['Unsubscribed'])
        .map((c: any) => (c['Email'] || '').trim().toLowerCase())
    );

    // CHASUP-FIX (2026-06-06): build a rancher-status lookup so we can skip
    // chase-ups on referrals whose rancher is no longer Active. Without this
    // we kept chasing buyers about Paused/Disabled ranchers (e.g., Matula
    // pause earlier today). Net result: buyer churned, rancher silently
    // billed for slot they couldn't honor, BHC reputation hit. Single fetch
    // up front; lookup is in-memory below.
    const rancherStatusById = new Map<string, string>();
    try {
      const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
      for (const r of ranchers) {
        const status = String(r['Active Status'] || '').toLowerCase();
        rancherStatusById.set(r.id, status);
      }
    } catch (e: any) {
      console.warn('[chasup] rancher status prefetch failed:', e?.message);
    }
    const isRancherPaused = (referral: any): boolean => {
      const rancherIds: string[] =
        (referral['Rancher'] as string[]) ||
        (referral['Suggested Rancher'] as string[]) ||
        [];
      const rid = rancherIds[0];
      if (!rid) return false;
      const status = rancherStatusById.get(rid) || '';
      // Treat anything that isn't explicit 'active' as paused for chasup
      // purposes — covers Paused / Disabled / blank / typo states. Better to
      // skip a chase that should fire than to fire one we shouldn't.
      return status !== 'active';
    };

    // Recency check — used by BOTH stale and maxed-out filters. Returns true
    // if the referral has any signal of real activity within window. The big
    // pipeline rewrite added Last Rancher/Buyer Activity At + Rancher Engaged
    // Flag — if we don't check them here, the legacy chase-up sender will
    // email buyers who already replied off-platform ("why are you bugging me?").
    const recentlyActive = (r: any, windowDays = 5) => {
      const cutoff = Date.now() - windowDays * DAY_MS;
      const lastR = r['Last Rancher Activity At'] ? new Date(r['Last Rancher Activity At']).getTime() : 0;
      const lastB = r['Last Buyer Activity At'] ? new Date(r['Last Buyer Activity At']).getTime() : 0;
      if (lastR > cutoff || lastB > cutoff) return true;
      // Engaged flag means rancher confirmed in_talks via Telegram or email
      // reply. Honor it for a full 14-day window before re-prompting.
      if (r['Rancher Engaged Flag']) {
        const introAt = r['Intro Sent At'] ? new Date(r['Intro Sent At']).getTime() : 0;
        if (introAt > Date.now() - 14 * DAY_MS) return true;
      }
      return false;
    };

    const stale = referrals.filter(r => {
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      if (!lastActivity) return false;
      const buyerEmail = (r['Buyer Email'] || '').trim().toLowerCase();
      if (unsubscribedEmails.has(buyerEmail)) {
        skipReasons['bounced-or-unsub'] = (skipReasons['bounced-or-unsub'] || 0) + 1;
        return false;
      }
      // CHASUP-FIX: rancher Paused/Disabled → don't chase buyer about a
      // rancher who can't fulfill. Operator gets a Telegram digest separately
      // so reassignment surfaces above the silence.
      if (isRancherPaused(r)) {
        skipReasons['rancher-paused'] = (skipReasons['rancher-paused'] || 0) + 1;
        return false;
      }
      const chaseCount = r['Chase Count'] || 0;
      if (chaseCount >= MAX_CHASE_UPS) return false; // Already maxed out
      // CHASUP-FIX: status-aware staleness windows. The 5-day window over-
      // chased Rancher Contacted referrals where the rancher had texted /
      // called the buyer off-platform — BHC has no signal, so we kept firing.
      //   Intro Sent     → 5d  (default; matching pre-fix behavior)
      //   Rancher Contacted → 14d (rancher confirmed; give real runway)
      const status = String(r['Status'] || '');
      const windowDays =
        status === 'Rancher Contacted' ? 14 : 5;
      if (recentlyActive(r, windowDays)) {
        skipReasons['recentlyActive'] = (skipReasons['recentlyActive'] || 0) + 1;
        return false;
      }
      return (Date.now() - new Date(lastActivity).getTime()) >= windowDays * DAY_MS;
    });

    // ── Auto-close referrals that hit max chase-ups ──────────────────────────
    //
    // CHASUP-FIX (2026-06-06): DISABLED the legacy chase-count auto-close path.
    // It was the primary source of "you're dropping leads the ranchers are
    // working" — buyers who hit chase=3 got auto-Closed-Lost even when the
    // rancher had real off-platform activity (texts / calls / DMs) that BHC
    // couldn't see. The activity-aware 30-day disengaged close block below
    // still handles genuine ghost cases.
    //
    // Surfaced cases instead get a Telegram operator alert so a human decides
    // whether to reopen, reassign, or actually close.
    let autoClosed = 0;
    const maxedOut: any[] = [];
    const maxedOutForAlert = referrals.filter(r => {
      const chaseCount = r['Chase Count'] || 0;
      if (chaseCount < MAX_CHASE_UPS) return false;
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      if (!lastActivity) return false;
      if (recentlyActive(r, 7)) {
        skipReasons['recentlyActive-no-close'] = (skipReasons['recentlyActive-no-close'] || 0) + 1;
        return false;
      }
      if (isRancherPaused(r)) {
        skipReasons['paused-no-close'] = (skipReasons['paused-no-close'] || 0) + 1;
        return false;
      }
      return (Date.now() - new Date(lastActivity).getTime()) >= 5 * DAY_MS;
    });
    if (maxedOutForAlert.length > 0) {
      try {
        const lines = maxedOutForAlert.slice(0, 10).map((r: any) =>
          `• ${r['Buyer Name'] || r['Buyer Email'] || r.id} (${r['Suggested Rancher Name'] || '?'}) — chase=${r['Chase Count'] || 0}`,
        );
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⏸ <b>${maxedOutForAlert.length} referrals at chase=3 — operator review</b>\n\n` +
            lines.join('\n') +
            (maxedOutForAlert.length > 10 ? `\n…and ${maxedOutForAlert.length - 10} more` : '') +
            `\n\n<i>Auto-close DISABLED — pick Reopen / Reassign / Close in /admin/referrals.</i>`,
        );
      } catch (e: any) {
        console.warn('[chasup] maxed-out alert send failed:', e?.message);
      }
    }

    for (const referral of maxedOut) {
      try {
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'Status': 'Closed Lost',
          'Closed At': new Date().toISOString(),
          'Notes': (referral['Notes'] || '') + '\n[Auto-closed: no response after 3 follow-ups]',
        });
        // Decrement rancher's active referral count atomically via Redis.
        // Was non-atomic read+write — race with concurrent matching/suggest
        // INCR could drift the counter. PA-MATCH audit (2026-05-28) flagged.
        const rancherIds = referral['Suggested Rancher'] || referral['Rancher'] || [];
        if (rancherIds.length > 0) {
          try {
            const { decrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
            const newCount = await decrementCapacity(rancherIds[0]);
            await syncCapacityToAirtable(rancherIds[0], newCount);
          } catch (e) { console.error('Error decrementing rancher count:', e); }
        }

        // Re-route the buyer to another rancher
        const buyerIds = referral['Buyer'] || [];
        const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
        if (buyerId) {
          try {
            const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
            if (buyer && buyer['Email']) {
              await updateRecord(TABLES.CONSUMERS, buyerId, {
                'Referral Status': 'Unmatched',
                'Sequence Stage': 'rerouted',
              });
              await fetch(`${SITE_URL}/api/matching/suggest`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                },
                body: JSON.stringify({
                  buyerState: buyer['State'] || '',
                  buyerId,
                  buyerName: buyer['Full Name'] || '',
                  buyerEmail: buyer['Email'],
                  buyerPhone: buyer['Phone'] || '',
                  orderType: buyer['Order Type'] || '',
                  budgetRange: buyer['Budget'] || '',
                  intentScore: buyer['Intent Score'] || 50,
                  intentClassification: buyer['Intent Classification'] || 'Medium',
                  notes: buyer['Notes'] || '',
                }),
              });
            }
          } catch (rerouteErr) {
            console.error('Re-route error on auto-close:', rerouteErr);
          }
        }

        autoClosed++;
      } catch (e: any) {
        console.error('Auto-close error:', e.message);
      }
    }

    if (autoClosed > 0) {
      await sendTelegramUpdate(`🔒 <b>Auto-Closed ${autoClosed} Stale Referrals</b>\nNo response after ${MAX_CHASE_UPS} follow-ups. Rancher capacity freed.`);
    }

    // ── L2a: DAY 2 RANCHER REMINDER ────────────────────────────────────────
    // Ranchers don't have Telegram — they only have email + dashboard. If a
    // rancher hasn't moved a lead off "Intro Sent" within 2 days, email them
    // directly with the buyer's contact info + a CTA. Throttled to one
    // reminder per 4-day window via Rancher Reminded At field.
    let rancherReminders = 0;
    try {
      // 2026-05-20: Rancher reminder email now fires ONLY on 'Intro Sent'.
      // Per founder directive: when the rancher updates status to Rancher
      // Contacted OR Negotiation, the deal is THEIRS — stop hounding them
      // with email reminders. The dashboard + Telegram operator views still
      // surface stalled-contacted deals for Ben to act on if he wants;
      // automated rancher email is killed at this status.
      const introSentRefs = referrals.filter(r =>
        r['Status'] === 'Intro Sent'
      );
      const now = Date.now();
      const needsReminder = introSentRefs.filter(r => {
        const introAt = r['Intro Sent At'] || r['Approved At'];
        if (!introAt) return false;
        const days = (now - new Date(introAt).getTime()) / DAY_MS;
        if (days < 2) return false;
        // Throttle: skip if reminded within last 4 days
        const lastReminder = r['Rancher Reminded At'];
        if (lastReminder) {
          const daysSinceReminder = (now - new Date(lastReminder).getTime()) / DAY_MS;
          if (daysSinceReminder < 4) return false;
        }
        return true;
      });

      for (const ref of needsReminder.slice(0, 10)) {
        try {
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
          if (!rancherId) continue;
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          if (!rancher) continue;
          const rancherEmail = rancher['Email'] || '';
          if (!rancherEmail) {
            skipReasons['no-rancher-email'] = (skipReasons['no-rancher-email'] || 0) + 1;
            continue;
          }
          if (rancher['Unsubscribed'] || rancher['Bounced']) {
            skipReasons['bounced-or-unsub'] = (skipReasons['bounced-or-unsub'] || 0) + 1;
            continue;
          }

          const introAt = ref['Intro Sent At'] || ref['Approved At'];
          const days = Math.floor((now - new Date(introAt).getTime()) / DAY_MS);

          await sendRancherLeadReminder({
            rancherEmail,
            operatorName: rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher',
            buyerName: ref['Buyer Name'] || 'a buyer',
            buyerState: ref['Buyer State'] || '',
            buyerPhone: ref['Buyer Phone'] || '',
            buyerEmail: ref['Buyer Email'] || '',
            orderType: ref['Order Type'] || '',
            budgetRange: ref['Budget Range'] || '',
            daysSinceIntro: days,
            dashboardUrl: `${SITE_URL}/rancher`,
          });

          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Rancher Reminded At': new Date().toISOString(),
          });

          rancherReminders++;
        } catch (e: any) {
          console.error(`Rancher reminder error for referral ${ref.id}:`, e.message);
        }
      }

      if (rancherReminders > 0) {
        await sendTelegramUpdate(`📧 <b>${rancherReminders} rancher reminder${rancherReminders > 1 ? 's' : ''} sent</b>\nNudged ranchers sitting on Intro Sent leads for 2+ days.`);
      }
    } catch (e: any) {
      console.error('Rancher reminder query error:', e.message);
    }

    // ── L2c: STALLED RANCHER NUDGE ─────────────────────────────────────────
    // Detect referrals where the rancher hasn't moved in 3+ days (Intro Sent stage).
    // Fires a Telegram alert (max once per 3-day window) so Ben can nudge or reassign.
    let stalledNudges = 0;
    try {
      // Include both Intro Sent AND Rancher Contacted in stalled-handler
      // queries. Was Intro Sent only, which silently excluded leads where
      // the rancher updated to "Rancher Contacted" but then went dormant —
      // they'd accumulate forever without rancher reminders / stalled
      // alerts / auto-reassign firing. Critical for ranchers whose habit
      // is to mark "contacted" then never update again.
      const introSentRefs = referrals.filter(r =>
        r['Status'] === 'Intro Sent' || r['Status'] === 'Rancher Contacted'
      );
      const now = Date.now();
      const stalledForNudge = introSentRefs.filter(r => {
        const introAt = r['Intro Sent At'] || r['Approved At'];
        if (!introAt) return false;
        const daysSinceIntro = (now - new Date(introAt).getTime()) / DAY_MS;
        if (daysSinceIntro < 3) return false;
        // Throttle: don't re-alert if we already alerted within the last 3 days
        const lastAlert = r['Stalled Alert Sent At'];
        if (lastAlert) {
          const daysSinceAlert = (now - new Date(lastAlert).getTime()) / DAY_MS;
          if (daysSinceAlert < 3) return false;
        }
        return true;
      });

      for (const ref of stalledForNudge.slice(0, 6)) {
        try {
          const buyerName = ref['Buyer Name'] || 'Unknown buyer';
          const buyerState = ref['Buyer State'] || '?';
          const rancherName = ref['Suggested Rancher Name'] || 'Unknown rancher';
          const introAt = ref['Intro Sent At'] || ref['Approved At'];
          const days = Math.floor((now - new Date(introAt).getTime()) / DAY_MS);

          const alertMsg = `🔕 <b>STALLED RANCHER</b> — ${days}d no activity\n\n` +
            `👤 Buyer: <b>${buyerName}</b> (${buyerState})\n` +
            `🤠 Rancher: <b>${rancherName}</b>\n` +
            `📊 Status: Intro Sent (rancher hasn't engaged)\n\n` +
            `<i>Tap a button to act:</i>`;

          const keyboard = {
            inline_keyboard: [
              [
                { text: '📞 Nudge Rancher', callback_data: `nudgerancher_${ref.id}` },
                { text: '🔄 Reassign', callback_data: `reassign_${ref.id}` },
              ],
              [
                { text: '🔒 Close Lost', callback_data: `closelost_${ref.id}` },
                { text: '👁 Details', callback_data: `details_${ref.id}` },
              ],
            ],
          };

          await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, alertMsg, keyboard);
          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Stalled Alert Sent At': new Date().toISOString(),
          });
          stalledNudges++;
        } catch (e: any) {
          console.error(`Stalled nudge error for referral ${ref.id}:`, e.message);
        }
      }

      if (stalledNudges > 0) {
        await sendTelegramUpdate(`🔕 <b>${stalledNudges} stalled deal alert${stalledNudges > 1 ? 's' : ''} sent</b>\nNudge or reassign before they go cold.`);
      }
    } catch (e: any) {
      console.error('Stalled nudge query error:', e.message);
    }

    // ── REAL-ACTIVITY-AWARE STALL HANDLING (replaces hard auto-reassign) ──
    //
    // Pre-2026-05-09: this block hard-auto-closed referrals at day 14 based
    // ONLY on Intro Sent At / Approved At. That signal couldn't see off-platform
    // rancher work (calls, direct emails) — system killed 70 active leads
    // across 8 ranchers in 7 days. Zero of those auto-reassigns produced a
    // Closed Won with the next rancher. Pure churn.
    //
    // New logic:
    //   1. Freshness = MAX(Last Rancher Activity At, Last Buyer Activity At,
    //      Intro Sent At). Off-platform replies + dashboard clicks + quick-
    //      action buttons all reset the clock.
    //   2. At day 14 (configurable via STALE_PROMPT_DAYS): send the rancher
    //      ONE email with the 4 quick-action buttons (already shipped at
    //      /api/rancher/quick-action). Rancher self-corrects in one click.
    //      DO NOT auto-close.
    //   3. Hard auto-close only when: Rancher Engaged Flag = false AND days
    //      since freshness ≥ STALE_AUTOCLOSE_DAYS (default 30) AND no buyer
    //      activity ever. Rancher who NEVER signaled engagement after 30+ days
    //      with no buyer reply = real ghost.
    //   4. Dry-run mode (?dryRun=1) returns what WOULD happen, writes nothing.
    const STALE_PROMPT_DAYS = 14;
    const STALE_AUTOCLOSE_DAYS = 30;
    const dryRunMode = new URL(request.url).searchParams.get('dryRun') === '1';

    const promptedRanchers: Array<{
      refId: string;
      buyerName: string;
      rancherEmail: string;
      rancherName: string;
      daysSinceActivity: number;
    }> = [];
    const autoClosePlanned: Array<{
      refId: string;
      buyerName: string;
      rancherName: string;
      daysSinceActivity: number;
      reason: string;
    }> = [];

    let stalePromptsFired = 0;
    let autoReassigned = 0;

    try {
      // 2026-05-20: Stale-prompt rancher email + 30-day auto-close fires
      // ONLY on 'Intro Sent'. Once the rancher self-attests they Contacted
      // the buyer, the lead is theirs — automated re-engagement email is
      // killed. Operator can still manually intervene via dashboard or
      // Telegram action buttons on the Telegram stalled-rancher card.
      const activeStallable = referrals.filter(
        (r) => r['Status'] === 'Intro Sent',
      );
      const now = Date.now();

      for (const ref of activeStallable) {
        const lastRancher = ref['Last Rancher Activity At'];
        const lastBuyer = ref['Last Buyer Activity At'];
        const introAt = ref['Intro Sent At'] || ref['Approved At'];
        // Pick the freshest signal of any activity on the referral.
        const freshnessSource = [lastRancher, lastBuyer, introAt]
          .filter(Boolean)
          .map((s) => new Date(s).getTime())
          .filter((t) => Number.isFinite(t));
        if (freshnessSource.length === 0) continue;
        const lastActivity = Math.max(...freshnessSource);
        const daysSince = (now - lastActivity) / DAY_MS;

        const rancherEngaged = !!ref['Rancher Engaged Flag'];
        const buyerEngaged = !!lastBuyer;

        // Auto-close eligibility: only the actual ghosts.
        const isRealGhost =
          !rancherEngaged && !buyerEngaged && daysSince >= STALE_AUTOCLOSE_DAYS;

        if (isRealGhost) {
          autoClosePlanned.push({
            refId: ref.id,
            buyerName: ref['Buyer Name'] || '',
            rancherName: ref['Suggested Rancher Name'] || '',
            daysSinceActivity: Math.floor(daysSince),
            reason: `No rancher engagement + no buyer reply for ${Math.floor(daysSince)}d`,
          });
          continue;
        }

        // Prompt eligibility: 14+ days since last activity AND haven't been
        // prompted in the last 7 days (track via Last Chased At).
        if (daysSince >= STALE_PROMPT_DAYS) {
          const lastChased = ref['Last Chased At'];
          const daysSinceChase = lastChased
            ? (now - new Date(lastChased).getTime()) / DAY_MS
            : Infinity;
          if (daysSinceChase < 7) continue; // throttle prompts

          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
          if (!rancherId) continue;

          let rancherEmail = '';
          let rancherFirstName = '';
          try {
            const r: any = await getRecordById(TABLES.RANCHERS, rancherId);
            rancherEmail = r?.['Email'] || '';
            const op = (r?.['Operator Name'] || '').toString();
            rancherFirstName = op.split(' ')[0] || 'there';
          } catch {
            continue;
          }
          if (!rancherEmail) continue;

          promptedRanchers.push({
            refId: ref.id,
            buyerName: ref['Buyer Name'] || 'Buyer',
            rancherEmail,
            rancherName: rancherFirstName,
            daysSinceActivity: Math.floor(daysSince),
          });
        }
      }

      // ── DRY-RUN exit ────────────────────────────────────────────────────
      if (dryRunMode) {
        const summary = `${promptedRanchers.length} prompts would fire, ${autoClosePlanned.length} hard auto-closes would fire`;
        console.log('[chasup:dryRun]', JSON.stringify({ stalePromptsPlanned: promptedRanchers, autoClosePlanned, summary }));
        return {
          status: 'success',
          recordsTouched: 0,
          notes: `dryRun: ${summary}`,
          skipReasonBreakdown: Object.keys(skipReasons).length ? skipReasons : undefined,
        };
      }

      // ── Send rancher prompt emails (one per stale referral, throttled) ──
      for (const p of promptedRanchers.slice(0, 10)) {
        try {
          const token = jwt.sign(
            { type: 'rancher-quick-action', referralId: p.refId, rancherId: (await getRecordById(TABLES.REFERRALS, p.refId) as any)?.['Rancher']?.[0] || (await getRecordById(TABLES.REFERRALS, p.refId) as any)?.['Suggested Rancher']?.[0] },
            JWT_SECRET,
            { expiresIn: '30d' }
          );
          const base = `${SITE_URL}/api/rancher/quick-action?token=${token}`;
          // MISMATCH FIX: stamp throttle BEFORE send. Prior order sent email,
          // then attempted stamp; if Airtable threw, the next cron run had no
          // Last Chased At and re-sent the same 4-button card. Stamp-first
          // means at worst we lose one chase if the email send throws — much
          // safer than spamming the rancher with duplicate prompts.
          const chaseCount = (referrals.find((r: any) => r.id === p.refId)?.['Chase Count'] || 0) + 1;
          await updateRecord(TABLES.REFERRALS, p.refId, {
            'Last Chased At': new Date().toISOString(),
            'Chase Count': chaseCount,
          });
          await sendEmail({
            to: p.rancherEmail,
            subject: `Quick check — ${p.buyerName}: still working it?`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:32px;border:1px solid #A7A29A;background:#fff;">
              <h2 style="font-family:Georgia,serif;margin:0 0 12px;">Hey ${p.rancherName},</h2>
              <p>It's been ${p.daysSinceActivity} days since I saw activity on this lead. Want to give me a 1-click update?</p>
              <p><strong>Buyer:</strong> ${p.buyerName}</p>
              <table cellspacing="0" cellpadding="0" style="margin:20px 0;width:100%;">
                <tr>
                  <td style="padding:0 6px 8px 0;width:25%;"><a href="${base}&action=in_talks" style="display:block;padding:11px 8px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">💬 In talks</a></td>
                  <td style="padding:0 6px 8px 0;width:25%;"><a href="${base}&action=won" style="display:block;padding:11px 8px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">✓ Closed Won</a></td>
                  <td style="padding:0 6px 8px 0;width:25%;"><a href="${base}&action=lost" style="display:block;padding:11px 8px;background:#6B4F3F;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">✗ Closed Lost</a></td>
                  <td style="padding:0 0 8px 0;width:25%;"><a href="${base}&action=pass" style="display:block;padding:11px 8px;background:#A7A29A;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">⏭ Pass</a></td>
                </tr>
              </table>
              <p style="font-size:12px;color:#6B4F3F;">If you're actively working this one, just click "💬 In talks" — it refreshes the lead in your dashboard. No login needed.</p>
              <p style="margin-top:24px;">— Ben</p>
            </div>` as any,
            _replyContext: { type: 'ref', recordId: p.refId },
          } as any);
          stalePromptsFired++;
        } catch (e: any) {
          console.error('[chasup-prompt]', e?.message);
        }
      }

      // ── Hard auto-close real ghosts (no engagement >= 30d) ──────────────
      for (const c of autoClosePlanned.slice(0, 10)) {
        try {
          const ref = referrals.find((r: any) => r.id === c.refId);
          if (!ref) continue;
          await updateRecord(TABLES.REFERRALS, c.refId, {
            'Status': 'Closed Lost',
            'Closed At': new Date().toISOString(),
            'Notes': `[GHOST AUTO-CLOSE ${new Date().toISOString().slice(0, 10)} — ${c.reason}]\n${ref['Notes'] || ''}`.trim(),
          });
          const rancherIds = ref['Rancher'] || ref['Suggested Rancher'] || [];
          const prevRancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
          if (prevRancherId) {
            try {
              // Atomic Redis decrement + Airtable mirror sync. Replaces
              // non-atomic read+write that could race with matching/suggest
              // INCR. PA-MATCH audit (2026-05-28).
              const { decrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
              const newCount = await decrementCapacity(prevRancherId);
              await syncCapacityToAirtable(prevRancherId, newCount);
            } catch {}
          }
          autoReassigned++;
        } catch (e: any) {
          console.error('[ghost-close]', e?.message);
        }
      }

      if (stalePromptsFired > 0 || autoReassigned > 0) {
        await sendTelegramUpdate(
          `📋 <b>Stale-handling run</b>\n` +
            `${stalePromptsFired} rancher prompts sent (1-click update, no auto-close)\n` +
            `${autoReassigned} ghosts auto-closed (zero engagement 30+ days)`
        );
      }
    } catch (e: any) {
      console.error('Stalled-handling error:', e?.message);
    }

    if (stale.length === 0) {
      return {
        status: 'success',
        recordsTouched: autoClosed + rancherReminders + stalledNudges + autoReassigned + stalePromptsFired,
        notes: `no stale; closed=${autoClosed} reminders=${rancherReminders} nudges=${stalledNudges} reassigned=${autoReassigned} prompts=${stalePromptsFired}`,
        skipReasonBreakdown: Object.keys(skipReasons).length ? skipReasons : undefined,
      };
    }

    let sent = 0;
    let errors = 0;

    // Was 8/run — too low when many leads stale at once (e.g., a single
    // rancher with 40+ Rancher Contacted referrals never caught up). Bumped
    // to 25/run to flush backlogs while staying under Resend's per-minute
    // and Airtable's 5 req/sec rate limits (paced via 350ms sleep at end of
    // loop = ~2.8 req/sec, well under Airtable's ceiling).
    for (const referral of stale.slice(0, 25)) {
      try {
        const buyerName = referral['Buyer Name'] || 'the buyer';
        const buyerEmail = referral['Buyer Email'] || '';
        // Resolve rancher name from the actual Rancher (or Suggested Rancher)
        // link, NOT the cached Suggested Rancher Name text. Reassigned referrals
        // can have stale text fields (e.g., a CO referral originally suggested
        // to Jose at Next Horizon, then reassigned to Ace at High Lonesome,
        // still cached "Jose Rodriguez" in the text). Trusting the cache
        // produced confusing emails like "did Jose reach out at High Lonesome
        // Ranch". Always go to the linked record for the source of truth.
        let rancherName = referral['Suggested Rancher Name'] || 'the rancher';
        try {
          const rIds = referral['Rancher'] || referral['Suggested Rancher'] || [];
          const rId = Array.isArray(rIds) ? rIds[0] : null;
          if (rId) {
            const rancherRec = await getRecordById(TABLES.RANCHERS, rId) as any;
            const live = rancherRec['Operator Name'] || rancherRec['Ranch Name'];
            if (live) rancherName = live;
          }
        } catch { /* fall back to cached name */ }
        const chaseCount = (referral['Chase Count'] || 0) + 1;
        const daysStale = Math.floor((Date.now() - new Date(referral['Last Chased At'] || referral['Intro Sent At'] || referral['Approved At']).getTime()) / DAY_MS);

        if (!buyerEmail) continue;

        const draftPrompt = `Draft a friendly, concise re-engagement email for a beef buyer who was introduced to a rancher ${daysStale} days ago and we haven't heard back. This is follow-up #${chaseCount} of ${MAX_CHASE_UPS}. 2-3 short paragraphs. Warm, not pushy. ${chaseCount === MAX_CHASE_UPS ? 'Mention this is your last follow-up.' : ''} Do NOT include a subject line — just the body paragraphs. Sign as Benjamin from BuyHalfCow.

Buyer: ${buyerName}, ${referral['Buyer State'] || ''}
Rancher introduced: ${rancherName}
Order interest: ${referral['Order Type'] || 'bulk beef'}, Budget: ${referral['Budget Range'] || 'not specified'}`;

        const draft = await callClaude({
          system: `You are Ben's AI business assistant for BuyHalfCow, a private beef brokerage. Write warm, direct emails that feel personal.`,
          user: draftPrompt,
          maxTokens: 500,
        });

        // Send immediately (no Telegram approval needed)
        const firstName = buyerName.split(' ')[0] || 'there';
        const subject = chaseCount === 1
          ? `Quick check-in — ${rancherName} on BuyHalfCow`
          : chaseCount === MAX_CHASE_UPS
          ? `Last follow-up — ${rancherName} on BuyHalfCow`
          : `Following up — ${rancherName} on BuyHalfCow`;

        await sendEmail({
          to: buyerEmail,
          subject,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
            <p>Hi ${firstName},</p>
            ${draft.split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('')}
            <div style="background:#F4F1EC;border-left:3px solid #0E0E0E;padding:14px 18px;margin:20px 0;">
              <p style="margin:0;font-size:14px;color:#0E0E0E;"><strong>Already bought from ${rancherName}?</strong> Just reply <strong>"YES"</strong> to this email and I'll close the loop on our end. Takes 5 seconds.</p>
            </div>
            <p style="font-size:12px;color:#A7A29A;margin-top:30px;">You're receiving this because you signed up on BuyHalfCow. <a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(buyerEmail)}" style="color:#A7A29A;">Unsubscribe</a></p>
          </div>`,
        });

        // Update referral
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'AI Chase Draft': draft,
          'Chase Count': chaseCount,
          'Last Chased At': new Date().toISOString(),
        });

        // Info-only Telegram notification
        await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID,
          `🎯 <b>AUTO CHASE-UP #${chaseCount}/${MAX_CHASE_UPS}</b>\n👤 ${buyerName} → 🤠 ${rancherName}\n📧 Sent to ${buyerEmail}\n${chaseCount >= MAX_CHASE_UPS ? '⚠️ Final follow-up — will auto-close if no response' : ''}`
        );

        sent++;
      } catch (err: any) {
        console.error(`Chase-up error for referral ${referral.id}:`, err.message);
        errors++;
      }
    }

    if (sent > 0) {
      await sendTelegramUpdate(`🎯 <b>Chase-Up Complete</b>\n${sent} emails auto-sent\n${autoClosed} referrals auto-closed${errors > 0 ? `\n⚠️ ${errors} errors` : ''}`);
    }

    // ── Repeat purchase emails — 30 days post-close ────────────────────────
    let repeatSent = 0;
    try {
      const closedReferrals = await getAllRecords(
        TABLES.REFERRALS,
        '{Status} = "Closed Won"'
      ) as any[];

      const reorderWindow = Date.now() - 250 * DAY_MS;
      const repeatCandidates = closedReferrals.filter(r => {
        if (r['Repeat Outreach Sent']) return false;
        const closedAt = r['Closed At'];
        if (!closedAt) return false;
        return new Date(closedAt).getTime() < reorderWindow;
      });

      for (const referral of repeatCandidates) {
        try {
          const buyerEmail = referral['Buyer Email'] || '';
          const buyerName = referral['Buyer Name'] || '';
          if (!buyerEmail) continue;

          const firstName = buyerName.split(' ')[0] || 'there';
          const rancherName = referral['Suggested Rancher Name'] || 'your rancher';

          // Build a magic login link for the consumer
          const consumerIds: string[] = referral['Buyer'] || [];
          const consumerId = consumerIds[0] || '';
          const token = consumerId
            ? jwt.sign(
                { type: 'member-login', consumerId, email: buyerEmail.trim().toLowerCase() },
                JWT_SECRET,
                { expiresIn: '7d' }
              )
            : '';
          const loginUrl = token ? `${SITE_URL}/member/verify?token=${token}` : `${SITE_URL}/member`;

          await sendRepeatPurchaseEmail({ firstName, email: buyerEmail, rancherName, loginUrl });
          await updateRecord(TABLES.REFERRALS, referral.id, { 'Repeat Outreach Sent': true });
          repeatSent++;
        } catch (e: any) {
          console.error('Repeat purchase email error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Repeat purchase query error:', e.message);
    }

    if (repeatSent > 0) {
      await sendTelegramUpdate(`🔄 <b>Repeat Purchase Emails</b>: ${repeatSent} sent to past buyers`);
    }

  const touched = sent + autoClosed + rancherReminders + stalledNudges + autoReassigned + stalePromptsFired + repeatSent;
  return {
    status: errors > 0 ? 'partial' : 'success',
    recordsTouched: touched,
    notes: `stale=${stale.length} sent=${sent} closed=${autoClosed} reminders=${rancherReminders} nudges=${stalledNudges} reassigned=${autoReassigned} prompts=${stalePromptsFired} repeat=${repeatSent} errors=${errors}`,
    skipReasonBreakdown: Object.keys(skipReasons).length ? skipReasons : undefined,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('referral-chasup', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
