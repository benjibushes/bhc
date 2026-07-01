import { NextResponse, NextRequest } from 'next/server';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';
import { isMaintenanceMode } from '@/lib/maintenance';
import { requireAdmin } from '@/lib/adminAuth';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';

export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Auth: requireAdmin() — bhc-admin-auth cookie OR x-admin-password.
    const unauthorized = await requireAdmin(request);
    if (unauthorized) return unauthorized;

    // Honor global maintenance mode. Audit finding 2026-05-20 #39: go-live
    // bypassed MAINTENANCE_MODE → could trigger 50-buyer warmup blast +
    // matching cycle even when the platform was paused.
    if (isMaintenanceMode()) {
      return NextResponse.json(
        { error: 'Platform in maintenance mode — go-live deferred. Unset MAINTENANCE_MODE first.' },
        { status: 503 },
      );
    }

    const { id } = await context.params;

    // P1 audit D-3: capture pre-state so go-live is reversible
    let prevRancher: any = null;
    try { prevRancher = await getRecordById(TABLES.RANCHERS, id); } catch { /* non-fatal */ }

    // ── tier_v2 Connect-active gate ─────────────────────────────────────────
    // Refuse to flip a tier_v2 rancher Live unless their Stripe Connect account
    // is 'active'. A tier_v2 rancher takes deposits via Connect; if Connect
    // isn't active (restricted / onboarding incomplete) the deposit endpoint
    // 409s them and matching excludes them, so marking them "Live" would
    // display a rancher who can't transact. Mirrors the eligibility fork in
    // app/api/cron/rancher-go-live-sync/route.ts. Legacy (non-tier_v2) ranchers
    // are unaffected — their Stripe Connect Status is irrelevant to go-live.
    // Force is supported (?force=1 / { force: true }) for the rare case where an
    // admin must override (e.g. legacy-Connect rancher mis-tagged tier_v2).
    if (prevRancher) {
      const pricingModel = String(prevRancher['Pricing Model'] || 'legacy').toLowerCase();
      const connectStatus = String(prevRancher['Stripe Connect Status'] || '').toLowerCase();
      let force = false;
      try {
        const url = new URL(request.url);
        force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
      } catch { /* ignore */ }
      if (!force) {
        try {
          const body = await request.clone().json();
          if (body && (body.force === true || body.force === '1')) force = true;
        } catch { /* no/!json body — fine */ }
      }
      if (pricingModel === 'tier_v2' && connectStatus !== 'active' && !force) {
        const rancherName = prevRancher['Operator Name'] || prevRancher['Ranch Name'] || id;
        return NextResponse.json(
          {
            error:
              `${rancherName} can't go live yet — Stripe Connect status is "${prevRancher['Stripe Connect Status'] || 'unset'}", not "active". ` +
              `tier_v2 ranchers take deposits via Stripe Connect, so they'd display as Live but couldn't accept money. ` +
              `Have them finish Stripe Connect onboarding (or use Resync), then retry. Pass force=true to override.`,
            code: 'connect_not_active',
            connectStatus: prevRancher['Stripe Connect Status'] || null,
          },
          { status: 409 },
        );
      }
    }

    // BUG FIX (RW-6 audit): prior version only flipped Page Live. matching/
    // suggest filters by Active Status='Active' — so newly-live rancher
    // would NOT receive routed buyers because Active Status stayed at
    // its prior value (Pending Onboarding / blank). The waitlist blast
    // below would then call matching/suggest which silently excluded
    // this same rancher. Self-defeating.
    //
    // Fix mirrors /api/rancher/activate which sets all 4 fields correctly.
    await updateRecord(TABLES.RANCHERS, id, {
      'Page Live': true,
      'Active Status': 'Active',
      'Onboarding Status': 'Live',
      'Status': 'Active',
    });

    // P1 audit D-3: log go-live so we can trace + reverse if misfired
    if (prevRancher) {
      try {
        await logAuditEntry({
          actor: 'manual',
          tool: 'admin-rancher-go-live',
          targetType: 'Rancher',
          targetId: id,
          args: { rancherId: id },
          result: { activeStatus: 'Active', onboardingStatus: 'Live', pageLive: true },
          reverseAction: buildAirtableUpdateReverse(TABLES.RANCHERS, id, {
            'Page Live': prevRancher['Page Live'] || false,
            'Active Status': prevRancher['Active Status'] || null,
            'Onboarding Status': prevRancher['Onboarding Status'] || null,
            'Status': prevRancher['Status'] || null,
          }),
        });
      } catch (e: any) {
        console.error('[go-live] audit log failed (non-fatal):', e?.message);
      }
    }

    // Fire launch-warmup IMMEDIATELY for this rancher's state. Without this,
    // newly-Live ranchers' Waitlisted buyer queue waits up to 24h for the
    // scheduled cron. Idempotent: per-buyer Warmup Sent At gates double-warm.
    triggerLaunchWarmup(`admin-go-live:${id}`);

    // Waitlist blast: auto-match waiting buyers in this rancher's state(s)
    let matched = 0;
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, id);
      const ranchName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
      const rancherState = rancher['State'] || '';
      const statesServedRaw = rancher['States Served'] || '';
      const statesServed: string[] = Array.isArray(statesServedRaw)
        ? statesServedRaw
        : typeof statesServedRaw === 'string'
          ? statesServedRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
          : [];

      const allStates = new Set<string>();
      if (rancherState) allStates.add(rancherState);
      statesServed.forEach((s: string) => allStates.add(s));

      if (allStates.size > 0) {
        const allConsumers: any[] = await getAllRecords(TABLES.CONSUMERS);
        const waitingBuyers = allConsumers.filter((c: any) => {
          const status = c['Status'] || '';
          const refStatus = c['Referral Status'] || '';
          const consumerState = c['State'] || '';
          if (status !== 'Approved') return false;
          if (refStatus !== 'Unmatched' && refStatus !== 'Waitlisted') return false;
          return allStates.has(consumerState);
        }).slice(0, 50);

        for (const buyer of waitingBuyers) {
          try {
            const res = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(INTERNAL_API_SECRET ? { 'x-internal-secret': INTERNAL_API_SECRET } : {}),
              },
              body: JSON.stringify({
                buyerId: buyer.id,
                buyerState: buyer['State'] || '',
                buyerName: buyer['Full Name'] || '',
                buyerEmail: buyer['Email'] || '',
                buyerPhone: buyer['Phone'] || '',
                orderType: buyer['Order Type'] || '',
                budgetRange: buyer['Budget'] || buyer['Budget Range'] || '',
                intentScore: buyer['Intent Score'] || 0,
                intentClassification: buyer['Intent Classification'] || '',
                notes: buyer['Notes'] || '',
              }),
            });
            if (res.ok) {
              const result = await res.json();
              if (result.matchFound) matched++;
            }
          } catch (e) {
            console.error(`Waitlist blast (admin): error matching ${buyer['Full Name'] || buyer.id}:`, e);
          }
        }

        // Notify via Telegram
        if (matched > 0) {
          try {
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `🚀 <b>${ranchName}</b> is LIVE in <b>${rancherState}</b> — auto-matched <b>${matched}</b> waiting buyer${matched === 1 ? '' : 's'}`
            );
          } catch (e) {
            console.error('Telegram waitlist blast notification error:', e);
          }
        }
      }
    } catch (e) {
      console.error('Waitlist blast error (admin go-live):', e);
    }

    return NextResponse.json({ success: true, matched });
  } catch (error: any) {
    console.error('Error setting rancher page live:', error);
    return NextResponse.json({ error: error.message || 'Failed to go live' }, { status: 500 });
  }
}
