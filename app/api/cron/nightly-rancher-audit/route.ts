import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 180;

// ─────────────────────────────────────────────────────────────────────────
// NIGHTLY RANCHER DATABASE AUDIT
//
// Runs once per night and produces a per-rancher pipeline status + a
// system-wide bug list. Posts a Telegram digest so Ben knows where every
// rancher is at and what needs attention.
//
// Per-rancher (Active rancher only):
//   • capacity (current/max + drift if Airtable counter ≠ actual)
//   • pipeline state breakdown (Intro Sent / Rancher Contacted / Negotiation / closes)
//   • last close + time since
//   • days since last lead assigned
//   • pilot progress (closes vs goal)
//
// System-wide checks (each is a separate "issue"):
//   1. Active rancher missing core fields (Slug / Page Live / States Served)
//   2. Active rancher with Agreement Signed=false (broken state)
//   3. Capacity counter drift (Current Active Referrals != actual count)
//   4. Tier-mismatch active referrals (Quarter buyer routed to Half/Whole-only rancher)
//   5. Stalled referrals (Intro Sent ≥7d / Rancher Contacted ≥10d, no chase recently)
//   6. Active referral on a buyer who is unsubscribed/bounced/complained
//   7. Active referral on a buyer marked Buyer Health=Non-Responsive
//   8. Stale Suggested Rancher Name (cached text doesn't match linked rancher Operator/Ranch)
//   9. Active rancher with 0 Closed Won in 30+ days but ≥5 referrals routed → underperforming
//  10. Pilot threshold reached but Pilot Upsell Notified At still empty
//
// All findings: posted to Telegram + returned in JSON for admin dashboard.
// ─────────────────────────────────────────────────────────────────────────

async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial'; recordsTouched: number; notes: string }> {
  {
    const startedAt = Date.now();

    // Pull entire dataset once. Audit is read-only so no rate concerns beyond initial fetch.
    const [ranchers, referrals, consumers] = await Promise.all([
      getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
      getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
    ]);

    const consumerById = new Map(consumers.map((c: any) => [c.id, c]));
    const rancherById = new Map(ranchers.map((r: any) => [r.id, r]));

    const now = Date.now();
    const DAY = 24 * 3600 * 1000;

    const ACTIVE_REF_STATES = new Set(['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Pending Approval']);

    type Issue = { severity: 'critical' | 'warn' | 'info'; rancher?: string; refId?: string; text: string };
    const issues: Issue[] = [];

    // ── Per-rancher pipeline summaries ──────────────────────────────────────
    type RancherSummary = {
      id: string;
      name: string;
      state: string;
      activeStatus: string;
      tierSpecialty: string[];
      capacity: { current: number; max: number; actualActive: number; drift: number };
      pipeline: { intro: number; contacted: number; negotiation: number; pending: number };
      closes: { won: number; lost: number; wonLast30d: number };
      lastCloseDays: number | null;
      lastAssignedDays: number | null;
      pilotGoal: number | null;
      pilotNotifiedAt: string | null;
    };
    const rancherSummaries: RancherSummary[] = [];

    for (const r of ranchers) {
      const id = r.id;
      const name = r['Operator Name'] || r['Ranch Name'] || '(unnamed)';
      const activeStatus = r['Active Status'] || '';
      const isActive = activeStatus === 'Active';
      const state = r['State'] || '—';
      const tier = Array.isArray(r['Tier Specialty']) ? r['Tier Specialty'] : (r['Tier Specialty'] ? [r['Tier Specialty']] : []);
      const max = getMaxActiveReferrals(r);
      const counter = Number(r['Current Active Referrals'] || 0);

      // Find this rancher's referrals
      const myRefs = referrals.filter((ref: any) => {
        const linked = ref['Rancher'] || [];
        const suggested = ref['Suggested Rancher'] || [];
        return linked.includes(id) || suggested.includes(id);
      });

      const pipeline = { intro: 0, contacted: 0, negotiation: 0, pending: 0 };
      const closes = { won: 0, lost: 0, wonLast30d: 0 };
      let lastCloseAt: number | null = null;
      let lastAssignedAt: number | null = null;

      for (const ref of myRefs) {
        const status = ref['Status'] || '';
        if (status === 'Intro Sent') pipeline.intro++;
        else if (status === 'Rancher Contacted') pipeline.contacted++;
        else if (status === 'Negotiation') pipeline.negotiation++;
        else if (status === 'Pending Approval') pipeline.pending++;
        else if (status === 'Closed Won') {
          closes.won++;
          const closedAt = ref['Closed At'] ? new Date(ref['Closed At']).getTime() : null;
          if (closedAt) {
            if (!lastCloseAt || closedAt > lastCloseAt) lastCloseAt = closedAt;
            if (now - closedAt <= 30 * DAY) closes.wonLast30d++;
          }
        } else if (status === 'Closed Lost') {
          closes.lost++;
        }
        const introSentAt = ref['Intro Sent At'] ? new Date(ref['Intro Sent At']).getTime() : null;
        if (introSentAt && (!lastAssignedAt || introSentAt > lastAssignedAt)) lastAssignedAt = introSentAt;
      }

      const actualActive = pipeline.intro + pipeline.contacted + pipeline.negotiation + pipeline.pending;
      const drift = counter - actualActive;

      const summary: RancherSummary = {
        id,
        name,
        state,
        activeStatus,
        tierSpecialty: tier.map((t: any) => typeof t === 'string' ? t : t?.name || ''),
        capacity: { current: counter, max, actualActive, drift },
        pipeline,
        closes,
        lastCloseDays: lastCloseAt ? Math.floor((now - lastCloseAt) / DAY) : null,
        lastAssignedDays: lastAssignedAt ? Math.floor((now - lastAssignedAt) / DAY) : null,
        pilotGoal: r['Pilot Closes Goal'] != null ? Number(r['Pilot Closes Goal']) : null,
        pilotNotifiedAt: r['Pilot Upsell Notified At'] || null,
      };
      rancherSummaries.push(summary);

      // ── System checks (only meaningful for Active ranchers) ───────────────
      if (!isActive) continue;

      // 1. Missing core fields
      const missing: string[] = [];
      if (!r['Slug']) missing.push('Slug');
      if (!r['Page Live']) missing.push('Page Live');
      const hasStateOrServed = r['State'] || (Array.isArray(r['States Served']) ? r['States Served'].length > 0 : !!r['States Served']);
      if (!hasStateOrServed) missing.push('States Served');
      if (missing.length > 0) {
        issues.push({ severity: 'critical', rancher: name, text: `${name} is Active but missing: ${missing.join(', ')}` });
      }

      // 2. Agreement Signed=false
      if (!r['Agreement Signed']) {
        issues.push({ severity: 'critical', rancher: name, text: `${name} is Active but Agreement Signed=false — won't appear in matching.` });
      }

      // 3. Capacity drift
      if (Math.abs(drift) >= 1 && (counter > 0 || actualActive > 0)) {
        issues.push({
          severity: Math.abs(drift) >= 3 ? 'warn' : 'info',
          rancher: name,
          text: `${name} capacity counter drift: Current Active Referrals=${counter} but actual=${actualActive} (diff=${drift > 0 ? '+' : ''}${drift})`,
        });
      }

      // 9. 0 closes in 30d but ≥5 referrals routed → underperforming
      const totalRouted = myRefs.length;
      if (closes.wonLast30d === 0 && totalRouted >= 5 && (closes.won + closes.lost) >= 3) {
        issues.push({
          severity: 'warn',
          rancher: name,
          text: `${name} has 0 Closed Won in 30 days despite ${totalRouted} referrals routed (won total=${closes.won}, lost=${closes.lost}). Health-check the relationship.`,
        });
      }

      // 10. Pilot threshold reached, no notification fired — FIRE celebration
      //     + STAMP Pilot Upsell Notified At so the audit only does this once.
      //     Previously the audit only surfaced this as a critical issue line
      //     that got buried in 30+ other warn lines and was easy to miss.
      if (summary.pilotGoal && closes.won >= summary.pilotGoal && !summary.pilotNotifiedAt) {
        const celebrationText =
          `🎉 <b>PILOT COMPLETE — UPSELL TIME</b>\n\n` +
          `<b>${name}</b> hit pilot goal (<b>${closes.won}</b>/${summary.pilotGoal} closed won)\n\n` +
          `State: ${r['State'] || '?'}\n` +
          `Performance Score: ${r['Performance Score'] || '?'}\n\n` +
          `→ Time to start the retainer conversation.`;
        try {
          if (TELEGRAM_ADMIN_CHAT_ID) {
            await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, celebrationText);
          }
          await updateRecord(TABLES.RANCHERS, r.id, {
            'Pilot Upsell Notified At': new Date().toISOString(),
          });
        } catch (e: any) {
          console.error('[nightly-rancher-audit] pilot celebration failed:', e?.message);
          issues.push({
            severity: 'critical',
            rancher: name,
            text: `🎯 ${name} hit pilot goal but celebration alert failed: ${e?.message}`,
          });
        }
      }
    }

    // ── Per-referral checks (across all referrals) ─────────────────────────
    for (const ref of referrals) {
      const status = ref['Status'] || '';
      if (!ACTIVE_REF_STATES.has(status)) continue;

      const buyerId = (ref['Buyer'] || [])[0];
      const buyer = buyerId ? consumerById.get(buyerId) : null;
      const rancherId = (ref['Rancher'] || [])[0] || (ref['Suggested Rancher'] || [])[0];
      const rancher = rancherId ? rancherById.get(rancherId) : null;
      const rancherName = rancher ? (rancher['Operator Name'] || rancher['Ranch Name'] || '?') : '?';

      // 4. Tier mismatch (buyer Quarter routed to Half/Whole-only rancher)
      if (rancher && buyer) {
        const tier = Array.isArray(rancher['Tier Specialty'])
          ? rancher['Tier Specialty'].map((t: any) => typeof t === 'string' ? t : t?.name || '')
          : [];
        if (tier.length > 0) {
          const ot = String(buyer['Order Type'] || '').toLowerCase();
          let buyerTier: string | null = null;
          if (ot.includes('quarter')) buyerTier = 'Quarter';
          else if (ot.includes('half')) buyerTier = 'Half';
          else if (ot.includes('whole')) buyerTier = 'Whole';
          if (buyerTier && !tier.includes(buyerTier)) {
            issues.push({
              severity: 'critical',
              rancher: rancherName,
              refId: ref.id,
              text: `Tier mismatch: ${buyer['Full Name']} wants ${buyerTier} but ${rancherName}'s Tier Specialty=[${tier.join(',')}] (refId=${ref.id})`,
            });
          }
        }
      }

      // 5. Stalled referrals
      const introSentAt = ref['Intro Sent At'] ? new Date(ref['Intro Sent At']).getTime() : null;
      if (introSentAt) {
        const daysOld = Math.floor((now - introSentAt) / DAY);
        const lastChasedAt = ref['Last Chased At'] ? new Date(ref['Last Chased At']).getTime() : null;
        const daysSinceChase = lastChasedAt ? Math.floor((now - lastChasedAt) / DAY) : null;
        if (status === 'Intro Sent' && daysOld >= 7 && (daysSinceChase === null || daysSinceChase >= 5)) {
          issues.push({
            severity: 'warn',
            rancher: rancherName,
            refId: ref.id,
            text: `${ref['Buyer Name'] || '?'} → ${rancherName}: Intro Sent ${daysOld}d ago, no recent chase. Stalled.`,
          });
        } else if (status === 'Rancher Contacted' && daysOld >= 14) {
          issues.push({
            severity: 'warn',
            rancher: rancherName,
            refId: ref.id,
            text: `${ref['Buyer Name'] || '?'} → ${rancherName}: Rancher Contacted ${daysOld}d ago, still open. Push to close or close-lost.`,
          });
        }
      }

      // 6. Active ref on suppressed buyer
      if (buyer) {
        if (buyer['Unsubscribed'] || buyer['Bounced'] || buyer['Complained']) {
          const flags = [
            buyer['Unsubscribed'] && 'unsubscribed',
            buyer['Bounced'] && 'bounced',
            buyer['Complained'] && 'complained',
          ].filter(Boolean).join('+');
          issues.push({
            severity: 'critical',
            rancher: rancherName,
            refId: ref.id,
            text: `Active ref on suppressed buyer (${flags}): ${buyer['Full Name']} → ${rancherName}. Close as Lost.`,
          });
        }

        // 7. Active ref on Non-Responsive buyer
        const health = buyer['Buyer Health'];
        const healthName = typeof health === 'object' ? health?.name : health;
        if (healthName === 'Non-Responsive') {
          issues.push({
            severity: 'warn',
            rancher: rancherName,
            refId: ref.id,
            text: `Active ref on Non-Responsive buyer: ${buyer['Full Name']} → ${rancherName}. Should auto-close.`,
          });
        }
      }

      // 8. Stale Suggested Rancher Name
      const cachedName = ref['Suggested Rancher Name'] || '';
      if (rancher && cachedName) {
        const liveName = rancher['Operator Name'] || rancher['Ranch Name'] || '';
        // Allow either Operator Name or Ranch Name to match (history of swapping these)
        if (cachedName !== liveName && cachedName !== (rancher['Ranch Name'] || '') && cachedName !== (rancher['Operator Name'] || '')) {
          issues.push({
            severity: 'info',
            rancher: rancherName,
            refId: ref.id,
            text: `Stale Suggested Rancher Name: cached="${cachedName}" but linked rancher resolves to "${liveName}" (refId=${ref.id})`,
          });
        }
      }
    }

    // ── Build Telegram digest ───────────────────────────────────────────────
    const activeSummaries = rancherSummaries.filter(s => s.activeStatus === 'Active');
    activeSummaries.sort((a, b) => b.closes.won - a.closes.won || b.capacity.actualActive - a.capacity.actualActive);

    const critical = issues.filter(i => i.severity === 'critical');
    const warn = issues.filter(i => i.severity === 'warn');
    const info = issues.filter(i => i.severity === 'info');

    const fmtRancher = (s: RancherSummary): string => {
      const tier = s.tierSpecialty.length ? `[${s.tierSpecialty.join('/')}]` : '[all tiers]';
      const cap = `${s.capacity.actualActive}/${s.capacity.max}`;
      const closes = s.closes.won > 0
        ? `· 💰 ${s.closes.won} won (${s.closes.wonLast30d} in 30d)`
        : '';
      const lastClose = s.lastCloseDays !== null
        ? ` · last close ${s.lastCloseDays}d ago`
        : '';
      const stale = s.lastAssignedDays !== null && s.lastAssignedDays >= 7 && s.capacity.actualActive === 0
        ? ` · ⚠️ idle ${s.lastAssignedDays}d`
        : '';
      const pilot = s.pilotGoal && !s.pilotNotifiedAt
        ? ` · pilot ${s.closes.won}/${s.pilotGoal}`
        : '';
      return `<b>${s.name}</b> (${s.state}) ${tier}\n   ${cap} active · 📥 ${s.pipeline.intro} intro / 🤝 ${s.pipeline.contacted} contacted / 💬 ${s.pipeline.negotiation} negotiation ${closes}${lastClose}${stale}${pilot}`;
    };

    const headerLine = `🌙 <b>NIGHTLY RANCHER AUDIT</b> — ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'short', timeStyle: 'short' })}`;
    const subhead = `${activeSummaries.length} active ranchers · ${critical.length} critical · ${warn.length} warn · ${info.length} info`;

    const summaryLines = activeSummaries.map(fmtRancher).join('\n\n');

    const issuesBlock = (() => {
      if (critical.length === 0 && warn.length === 0) {
        return '\n\n✅ <b>No critical or warning issues.</b>';
      }
      const parts: string[] = [];
      if (critical.length > 0) {
        parts.push(`\n\n🔴 <b>CRITICAL (${critical.length})</b>\n` + critical.slice(0, 12).map(i => `• ${i.text}`).join('\n'));
        if (critical.length > 12) parts.push(`<i>...and ${critical.length - 12} more critical</i>`);
      }
      if (warn.length > 0) {
        parts.push(`\n\n🟡 <b>WARN (${warn.length})</b>\n` + warn.slice(0, 10).map(i => `• ${i.text}`).join('\n'));
        if (warn.length > 10) parts.push(`<i>...and ${warn.length - 10} more warnings</i>`);
      }
      return parts.join('\n');
    })();

    const totalRefs = referrals.length;
    const activeRefs = referrals.filter(r => ACTIVE_REF_STATES.has(r['Status'] || '')).length;
    const totalWon = referrals.filter(r => r['Status'] === 'Closed Won').length;
    const wonLast30 = referrals.filter(r => {
      if (r['Status'] !== 'Closed Won') return false;
      const t = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
      return t > 0 && (now - t) <= 30 * DAY;
    }).length;

    const totalsLine = `\n\n📊 <b>System totals:</b> ${activeRefs} active refs · ${totalWon} all-time won (${wonLast30} in 30d) · ${totalRefs} refs total`;

    const message = headerLine + '\n' + subhead + '\n\n' + summaryLines + issuesBlock + totalsLine;

    // Telegram has a 4096-char hard limit. Split into chunks if needed.
    const MAX = 3900;
    const chunks: string[] = [];
    if (message.length <= MAX) chunks.push(message);
    else {
      // Split on double-newlines so we don't break mid-rancher
      const parts = message.split('\n\n');
      let cur = '';
      for (const p of parts) {
        if ((cur + '\n\n' + p).length > MAX) {
          if (cur) chunks.push(cur);
          cur = p;
        } else {
          cur = cur ? cur + '\n\n' + p : p;
        }
      }
      if (cur) chunks.push(cur);
    }

    for (const chunk of chunks) {
      try {
        await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, chunk);
      } catch (e) {
        console.error('Telegram send failed for nightly audit chunk:', e);
      }
    }

    return {
      status: critical.length > 0 ? 'partial' : 'success',
      recordsTouched: activeSummaries.length,
      notes: `ranchers=${activeSummaries.length} critical=${critical.length} warn=${warn.length} info=${info.length} activeRefs=${activeRefs} won30=${wonLast30}`,
    };
  }
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
  return withCronRun('nightly-rancher-audit', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
