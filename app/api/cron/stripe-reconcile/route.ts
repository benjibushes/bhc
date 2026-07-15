// app/api/cron/stripe-reconcile/route.ts
//
// STRIPE ↔ AIRTABLE RECONCILIATION — the nightly truth sync for the two state
// classes whose ONLY bridge is webhooks: rancher TIER SUBSCRIPTIONS and
// CONNECT ACCOUNT status. A missed webhook (unregistered endpoint, secret
// drift, retry horizon exceeded) drifts these silently FOREVER — nobody
// complains, the rails just go blind. Sibling of product-settlement-net,
// which closes the same class for product-purchase PaymentIntents.
//
// Live proof this class is real (bulletproof audit 2026-07-15): Champion
// Valley Farm (rec2ni15F7NXtY9Ij) has a REAL active Stripe subscription but
// an EMPTY 'Stripe Subscription Id' in Airtable — the dunning, tier-change,
// and cancellation rails all key on that field and were blind to it.
//
// Procedure (idempotent, small volume — tens of subs / tens of accounts):
//   A. SUBSCRIPTIONS — stripe.subscriptions.list (platform acct, status
//      'all', paginated). Keep tier subs (tier price id OR rancherId
//      metadata). Match to Ranchers via the webhook's own order —
//      metadata.rancherId → customer_account → unique email ({Email} +
//      {Team Emails}). Heal: backfill EMPTY 'Stripe Subscription Id', sync
//      'Subscription Status', sync 'Tier' from the price (live subs only).
//      Ambiguous (0 / >1 rows) → REPORTED, never written. Reverse drift
//      (Airtable active+Tier, no Stripe sub) → phantom report, never an
//      auto-downgrade.
//   B. CONNECT — for every rancher with a 'Stripe Connect Account Id',
//      getConnectAccountStatus (live V2 retrieve → the SAME
//      classifyConnectStatus the webhook uses) → computeConnectResync (the
//      SAME field-writes the webhook/admin-resync perform). Heals the stale
//      cached 'Stripe Connect Status' the audit flagged as never
//      self-healing. NO rancher-facing comms from here — the webhook owns
//      downgrade emails/pushes; double-notify is worse than a day's delay.
//   C. Safety — DRY-RUN by default; ?apply=1 writes (bhc-mutation-
//      guardrails). Per-item try/catch. Telegram summary only when something
//      drifted; silent when clean.
//
// Schedule: daily 10:20 UTC (vercel.json) — after the 09:00 batch-approve
// wave, before the 13:00-18:00 ops crons that read these fields.

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { getStripeClient, getConnectAccountStatus } from '@/lib/stripeConnect';
import { computeConnectResync } from '@/lib/connectResync';
import {
  selectValue,
  tierPriceMapFromEnv,
  isTierSubscription,
  tierSlugForSub,
  pickCurrentSubscription,
  matchSubToRancher,
  computeSubscriptionReconcile,
  findPhantomSubscribers,
  type RancherLite,
  type SubLite,
} from '@/lib/stripeReconcile';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 300;

interface ReconcileResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

function toRancherLite(row: any): RancherLite {
  return {
    id: String(row.id || ''),
    name: String(row['Ranch Name'] || row['Operator Name'] || row.id || ''),
    email: String(row['Email'] || ''),
    teamEmails: String(row['Team Emails'] || ''),
    connectAccountId: String(row['Stripe Connect Account Id'] || '').trim(),
    // FIELD-NAME LANDMINE: Ranchers uses 'Stripe Subscription Id' (lowercase d).
    subscriptionId: String(row['Stripe Subscription Id'] || '').trim(),
    subscriptionStatus: selectValue(row['Subscription Status']),
    tier: selectValue(row['Tier']),
  };
}

function toSubLite(raw: any): SubLite {
  const customer = raw?.customer;
  return {
    id: String(raw?.id || ''),
    status: String(raw?.status || ''),
    created: Number(raw?.created || 0),
    // V2: tier subs bill the connected account AS the customer
    // (lib/stripeSubscription.ts) — customer_account is the acct_* id.
    customerAccount: String(raw?.customer_account || ''),
    customerEmail:
      customer && typeof customer === 'object' ? String(customer.email || '') : '',
    metadataRancherId: String(raw?.metadata?.rancherId || ''),
    metadataTier: String(raw?.metadata?.tier || ''),
    priceId: String(raw?.items?.data?.[0]?.price?.id || ''),
  };
}

/** List EVERY platform subscription (status 'all'), paginated. Volume is
 *  tens, not thousands — the 20-page cap is a runaway guard, not a limit we
 *  expect to hit. expand customer for the email fallback; if the expand is
 *  rejected (V2 account-customers can lack an expandable cus_*), retry the
 *  whole listing without it — matching still works via acct id/metadata. */
async function listAllSubscriptions(stripe: any): Promise<any[]> {
  const collect = async (withExpand: boolean): Promise<any[]> => {
    const out: any[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await stripe.subscriptions.list({
        status: 'all',
        limit: 100,
        ...(withExpand ? { expand: ['data.customer'] } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      out.push(...(res?.data || []));
      if (!res?.has_more || !res?.data?.length) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
    return out;
  };
  try {
    return await collect(true);
  } catch {
    return await collect(false);
  }
}

/** Best-effort field write: whole-row first; on failure retry field-by-field
 *  so one possibly-missing column can't block the rest of the heal. */
async function writeFieldsBestEffort(
  recordId: string,
  fields: Record<string, any>,
): Promise<{ wroteAny: boolean; failed: string[] }> {
  try {
    await updateRecord(TABLES.RANCHERS, recordId, fields);
    return { wroteAny: true, failed: [] };
  } catch {
    let wroteAny = false;
    const failed: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      try {
        await updateRecord(TABLES.RANCHERS, recordId, { [k]: v });
        wroteAny = true;
      } catch {
        failed.push(k);
      }
    }
    return { wroteAny, failed };
  }
}

function realHandlerFor(apply: boolean) {
  return async function realHandler(_request: Request): Promise<ReconcileResult> {
    const stripe = getStripeClient();
    const nowISO = new Date().toISOString();

    const rancherRows = (await getAllRecords(TABLES.RANCHERS)) as any[];
    const ranchers = rancherRows.map(toRancherLite).filter((r) => r.id);

    let healedRecords = 0;
    const subDriftLines: string[] = [];
    const connectDriftLines: string[] = [];
    const reportLines: string[] = [];
    const errorLines: string[] = [];
    let cancellationsHealed = 0;

    // ── A. SUBSCRIPTIONS ────────────────────────────────────────────────
    const priceMap = tierPriceMapFromEnv(process.env as Record<string, string | undefined>);
    if (Object.keys(priceMap).length === 0) {
      reportLines.push('tier price envs (STRIPE_*_PRICE_ID) all empty — price→tier sync limited to metadata');
    }

    let tierSubCount = 0;
    let matchedRancherIds = new Set<string>();
    let subListOk = false;

    try {
      const rawSubs = await listAllSubscriptions(stripe);
      subListOk = true;
      const tierSubs = rawSubs.map(toSubLite).filter((s) => isTierSubscription(s, priceMap));
      tierSubCount = tierSubs.length;

      // Match every tier sub to a rancher; group by rancher (history-safe).
      const byRancher = new Map<string, { rancher: RancherLite; subs: SubLite[] }>();
      for (const s of tierSubs) {
        const m = matchSubToRancher(s, ranchers);
        if (m.kind === 'matched') {
          const entry = byRancher.get(m.rancher.id) || { rancher: m.rancher, subs: [] };
          entry.subs.push(s);
          byRancher.set(m.rancher.id, entry);
        } else if (m.kind === 'ambiguous') {
          reportLines.push(`sub ${s.id} (${s.status}): AMBIGUOUS — ${m.reason} [${m.candidateIds.join(', ')}]`);
        } else {
          reportLines.push(`sub ${s.id} (${s.status}): unmatched — ${m.reason}`);
        }
      }
      matchedRancherIds = new Set(byRancher.keys());

      for (const { rancher, subs } of byRancher.values()) {
        try {
          const current = pickCurrentSubscription(subs);
          if (!current) continue;
          const decision = computeSubscriptionReconcile(
            rancher,
            current,
            tierSlugForSub(current, priceMap),
          );
          reportLines.push(...decision.reports);
          if (decision.changes.length === 0) continue;
          if (decision.cancellationHealed) cancellationsHealed += 1;
          subDriftLines.push(`${rancher.name} (${rancher.id}): ${decision.changes.join('; ')}`);
          if (apply) {
            const w = await writeFieldsBestEffort(rancher.id, decision.writeFields);
            if (w.wroteAny) healedRecords += 1;
            if (w.failed.length) {
              errorLines.push(`${rancher.name}: field write failed for ${w.failed.join(', ')}`);
            }
          }
        } catch (e: any) {
          errorLines.push(`${rancher.name}: sub reconcile threw (${e?.message || 'unknown'})`);
        }
      }

      // Reverse drift — phantom subscribers. Only meaningful when the Stripe
      // listing succeeded end-to-end; a partial list would cry wolf.
      for (const p of findPhantomSubscribers(ranchers, matchedRancherIds)) {
        reportLines.push(
          `PHANTOM: ${p.name} (${p.id}) has Subscription Status '${p.subscriptionStatus}' + Tier '${p.tier}' but NO Stripe subscription — review (never auto-downgraded)`,
        );
      }
    } catch (e: any) {
      errorLines.push(`subscriptions.list failed (${e?.message || 'unknown'}) — sub + phantom passes skipped`);
    }

    // ── B. CONNECT ACCOUNT STATUS ───────────────────────────────────────
    const withConnect = ranchers.filter((r) => r.connectAccountId);
    for (const r of withConnect) {
      const row = rancherRows.find((x: any) => x.id === r.id);
      try {
        const live = await getConnectAccountStatus(r.connectAccountId);
        const decision = computeConnectResync({
          liveStatus: live.status,
          previousStatus: selectValue(row?.['Stripe Connect Status']),
          alreadyConnectedAt: !!row?.['Stripe Connect Connected At'],
          pricingModel: selectValue(row?.['Pricing Model']),
          migrationStatus: selectValue(row?.['Migration Status']),
          nowISO,
        });
        if (!decision.changed) continue;
        connectDriftLines.push(
          `${r.name} (${r.id}): Connect '${selectValue(row?.['Stripe Connect Status']) || '(empty)'}' → '${live.status}'` +
            (decision.migrationCompleted ? ' (+Migration completed)' : ''),
        );
        if (apply) {
          const w = await writeFieldsBestEffort(r.id, decision.writeFields);
          if (w.wroteAny) healedRecords += 1;
          if (w.failed.length) {
            errorLines.push(`${r.name}: Connect field write failed for ${w.failed.join(', ')}`);
          }
        }
        // Comms stay webhook-owned: no downgrade emails/pushes from the cron.
      } catch (e: any) {
        // Restricted/deauthorized accounts can refuse retrieves — note + go on.
        errorLines.push(`${r.name} (${r.connectAccountId}): Connect read failed (${e?.message || 'unknown'})`);
      }
    }

    // ── C. Report ───────────────────────────────────────────────────────
    const driftCount = subDriftLines.length + connectDriftLines.length;
    const mode = apply ? 'LIVE' : 'DRY-RUN';
    const notes =
      `${mode}: ${tierSubCount} tier subs${subListOk ? '' : ' (LIST FAILED)'}, ${matchedRancherIds.size} matched, ` +
      `${subDriftLines.length} sub drift + ${connectDriftLines.length} connect drift` +
      (apply ? ` (${healedRecords} healed)` : ' (would heal)') +
      (cancellationsHealed ? `, ${cancellationsHealed} MISSED CANCELLATION(S)` : '') +
      (reportLines.length ? `, ${reportLines.length} report-only` : '') +
      (errorLines.length ? `, ${errorLines.length} errors: ${errorLines.slice(0, 3).join(' | ')}` : '');

    // Telegram only when something drifted / needs eyes — silence means clean.
    if ((driftCount > 0 || reportLines.length > 0 || errorLines.length > 0) && TELEGRAM_ADMIN_CHAT_ID) {
      try {
        const section = (title: string, lines: string[]) =>
          lines.length ? `\n<b>${title}</b>\n${lines.slice(0, 15).join('\n')}\n` : '';
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🩺 <b>STRIPE RECONCILE (${mode})</b>\n` +
            (driftCount > 0
              ? `\nEvery drift line below means a webhook was MISSED — check endpoint + secret if these recur.\n`
              : '') +
            section('Subscription drift', subDriftLines) +
            section('Connect drift', connectDriftLines) +
            section('Report-only (needs eyes)', reportLines) +
            section('Errors', errorLines) +
            `\n<i>${notes}</i>`,
        );
      } catch (e: any) {
        console.error('[stripe-reconcile] telegram failed:', e?.message);
      }
    }

    const status: ReconcileResult['status'] =
      errorLines.length > 0 ? 'partial' : 'success';
    return { status, recordsTouched: apply ? healedRecords : 0, notes };
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  const apply = new URL(request.url).searchParams.get('apply') === '1';
  return withCronRun('stripe-reconcile', realHandlerFor(apply))(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
