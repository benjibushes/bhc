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
//   C. Safety — SPLIT WRITE POLICY (lib/connectResync#reconcileWritePolicy).
//      CONNECT applies on EVERY run: the write only copies a fact Stripe
//      already considers true into BHC's cache — no pricing, no billing, no
//      comms. SUBS stay observe-only on the schedule (they move 'Tier' and
//      'Subscription Status', which drive commission rate + billing); ?apply=1
//      is the manual escape hatch (bhc-mutation-guardrails). Per-item
//      try/catch. Telegram summary only when something drifted; silent when
//      clean. Cron Runs Notes always names which class healed vs reported.
//
//      History: this cron was DRY-RUN by default and vercel.json calls the
//      bare path — so from the day it shipped until 2026-07-25 it healed
//      NOTHING. A rancher whose account.updated webhook was lost sat stuck at
//      'onboarding' until a human hit the admin Resync button.
//
//   D. Paused-overdue dead-end — when computeConnectResync flags
//      wasPausedOverdue AND the row is still Active Status='Paused', fire a
//      LOUD signal carrying a ONE-TAP unpause button (cxunpause_<id>, handled
//      in app/api/webhooks/telegram). We do NOT auto-unpause: Active Status
//      flips are Ben's per-rancher call (a Paused row can also be a deliberate
//      manual pause). The button IS that call.
//
// Schedule: daily 10:20 UTC (vercel.json) — after the 09:00 batch-approve
// wave, before the 13:00-18:00 ops crons that read these fields.

import { getAllRecords, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { getStripeClient, getConnectAccountStatus } from '@/lib/stripeConnect';
import {
  computeConnectResync,
  reconcileWritePolicy,
  shouldEscalateUnpause,
  unpauseCallbackData,
  type ReconcileWritePolicy,
} from '@/lib/connectResync';
import { sendOperatorSignal } from '@/lib/operatorSignal';
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

/** Routable buyer stages — mirrors app/api/stats/buyers-by-state. */
const ROUTABLE_BUYER_STAGES = new Set(['NEW', 'WAITING', 'READY', 'MATCHED']);

/** How many buyers are stranded in this rancher's state? Answers "is this
 *  unpause worth a tap right now". Best-effort + filtered read (escalations are
 *  rare — usually zero per run), null when we can't cheaply tell. */
async function countWaitingBuyers(state: string): Promise<number | null> {
  const code = String(state || '').trim().toUpperCase();
  if (code.length !== 2) return null;
  try {
    const buyers = (await getAllRecords(
      TABLES.CONSUMERS,
      `AND({Segment} = "Beef Buyer", {State} = "${escapeAirtableValue(code)}")`,
    )) as any[];
    return buyers.filter(
      (b) =>
        !b['Unsubscribed'] &&
        !b['Bounced'] &&
        !b['Complained'] &&
        ROUTABLE_BUYER_STAGES.has(String(b['Buyer Stage'] || '')),
    ).length;
  } catch {
    return null;
  }
}

function realHandlerFor(policy: ReconcileWritePolicy) {
  return async function realHandler(_request: Request): Promise<ReconcileResult> {
    const stripe = getStripeClient();
    const nowISO = new Date().toISOString();

    const rancherRows = (await getAllRecords(TABLES.RANCHERS)) as any[];
    const ranchers = rancherRows.map(toRancherLite).filter((r) => r.id);

    let subsHealed = 0;
    let connectHealed = 0;
    const subDriftLines: string[] = [];
    const connectDriftLines: string[] = [];
    const unpauseLines: string[] = [];
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
          // Money-touching class — observe-only unless a human passed ?apply=1.
          if (policy.subscriptions) {
            const w = await writeFieldsBestEffort(rancher.id, decision.writeFields);
            if (w.wroteAny) subsHealed += 1;
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

        // ── PAUSED-OVERDUE DEAD-END → loud alert + ONE-TAP unpause ────────
        // Runs BEFORE the !changed short-circuit on purpose: the worst version
        // of this dead-end is a rancher whose cache ALREADY says active (so
        // there is no drift to heal) while Active Status sits at 'Paused'
        // forever. NOT auto-unpaused — Active Status flips are Ben's
        // per-rancher call. 24h dedupe key is SHARED with the webhook +
        // dashboard-poll emitters so the founder gets one card, not three.
        const activeStatus = selectValue(row?.['Active Status']);
        if (shouldEscalateUnpause({ wasPausedOverdue: decision.wasPausedOverdue, activeStatus })) {
          const state = selectValue(row?.['State']);
          const waiting = await countWaitingBuyers(state);
          unpauseLines.push(
            `${r.name} (${r.id}) — ${state || 'state?'} — Connect active but Active Status='Paused'` +
              (waiting === null ? '' : `, ${waiting} buyer(s) waiting`),
          );
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'stuck-rancher',
            summary: `UPGRADE COMPLETE — UNPAUSE ${r.name}`,
            detail:
              `${r.name}${state ? ` (${state})` : ''} was auto-paused by the migration deadline ` +
              `(paused_overdue) and has now finished Stripe Connect (active).\n` +
              (waiting === null ? '' : `${waiting} buyer(s) are waiting in ${state}.\n`) +
              `Active Status is still 'Paused' → they receive ZERO buyers until it flips.\n` +
              `Tap below to unpause, or do it from /admin/ranchers/${r.id}.`,
            refs: [{ type: 'rancher', id: r.id, label: r.name }],
            actions: [{ label: `▶️ Unpause ${r.name}`.slice(0, 60), callbackData: unpauseCallbackData(r.id) }],
            dedupeKey: `paused-overdue-upgrade:${r.id}`,
            dedupeWindowMs: 24 * 3600 * 1000,
          });
        }

        if (!decision.changed) continue;
        connectDriftLines.push(
          `${r.name} (${r.id}): Connect '${selectValue(row?.['Stripe Connect Status']) || '(empty)'}' → '${live.status}'` +
            (decision.migrationCompleted ? ' (+Migration completed)' : ''),
        );
        // Read-derived heal: this only copies what Stripe already believes into
        // BHC's cache — the same fields account.updated would have written.
        if (policy.connect) {
          const w = await writeFieldsBestEffort(r.id, decision.writeFields);
          if (w.wroteAny) connectHealed += 1;
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
    // Cron Runs Notes is the queryable trace. It must ALWAYS say, in words,
    // which class wrote and which only looked — including "nothing to heal",
    // so a silent night is distinguishable from a night the cron didn't run.
    const driftCount = subDriftLines.length + connectDriftLines.length;
    const mode = policy.subscriptions ? 'CONNECT+SUBS APPLY' : 'CONNECT APPLY / SUBS REPORT-ONLY';

    const connectNote = policy.connect
      ? connectDriftLines.length === 0
        ? `CONNECT: applied — nothing to heal (${withConnect.length} accounts checked)`
        : `CONNECT: applied — ${connectHealed}/${connectDriftLines.length} healed :: ${connectDriftLines.slice(0, 5).join(' :: ')}` +
          (connectDriftLines.length > 5 ? ` :: +${connectDriftLines.length - 5} more` : '')
      : `CONNECT: dry-run — ${connectDriftLines.length} would heal`;

    const subsNote = policy.subscriptions
      ? subDriftLines.length === 0
        ? 'SUBS: applied — nothing to heal'
        : `SUBS: applied — ${subsHealed}/${subDriftLines.length} healed`
      : subDriftLines.length === 0
        ? 'SUBS: report-only — nothing drifted'
        : `SUBS: report-only — ${subDriftLines.length} WOULD heal (re-run with ?apply=1 to write) :: ${subDriftLines.slice(0, 3).join(' :: ')}`;

    const notes = (
      `${mode} | ${tierSubCount} tier subs${subListOk ? '' : ' (LIST FAILED)'}, ${matchedRancherIds.size} matched | ` +
      `${connectNote} | ${subsNote}` +
      (unpauseLines.length ? ` | UNPAUSE NEEDED (${unpauseLines.length}, one-tap alert sent): ${unpauseLines.join(' :: ')}` : '') +
      (cancellationsHealed ? ` | ${cancellationsHealed} MISSED CANCELLATION(S)` : '') +
      (reportLines.length ? ` | ${reportLines.length} report-only` : '') +
      (errorLines.length ? ` | ${errorLines.length} errors: ${errorLines.slice(0, 3).join(' | ')}` : '')
    ).slice(0, 2000);

    // Telegram only when something drifted / needs eyes — silence means clean.
    // (The unpause escalations ride their own LOUD sendOperatorSignal cards.)
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
            section(`Connect drift — HEALED (${connectHealed})`, connectDriftLines) +
            section(
              policy.subscriptions ? 'Subscription drift — HEALED' : 'Subscription drift — REPORT ONLY (no write)',
              subDriftLines,
            ) +
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
    return { status, recordsTouched: connectHealed + subsHealed, notes };
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  // ?apply=1 is the MANUAL escape hatch and now only unlocks the money-touching
  // subscription class — Connect heals on the scheduled run either way.
  const manualApply = new URL(request.url).searchParams.get('apply') === '1';
  return withCronRun('stripe-reconcile', realHandlerFor(reconcileWritePolicy(manualApply)))(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
