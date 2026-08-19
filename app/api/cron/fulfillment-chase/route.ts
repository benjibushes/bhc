// app/api/cron/fulfillment-chase/route.ts
//
// E3/B15 (2026-07-01): fulfillment chase — nothing chased a rancher who never
// confirmed fulfillment.
//
// The highest post-purchase trust risk on the platform: a buyer's deposit is
// paid (NON-REFUNDABLE once the rancher accepted), the rancher tapped Accept
// Slot, the Processing Date came and went… and if the rancher never confirms
// fulfillment the deal sits frozen forever — no rancher nudge, no operator
// escalation, no signal at all that a paying customer may not have gotten
// their beef. This daily cron is the backstop.
//
// Escalation tiers (days past the due date — Handoff Date > Processing Date >
// accept + 14d fallback; see lib/fulfillmentChase.ts):
//   T+2d → gentle rancher nudge email ("one tap confirms").
//   T+5d → second rancher nudge + LOUD operator signal (money at risk).
//   T+8d → operator signal only — a human takes over. Deliberately NO buyer
//          email at any tier: we can't verify what actually happened, and
//          "checking on your order" promises we can't back. Buyer comms at
//          this stage is Ben's call.
//
// Wave 2 (2026-07-29) — two earlier kinds so an accepted deal is never silent
// for a month (the old accept+30d fallback meant first touch at accept+32d):
//   accept+3d, no Handoff/Processing Date → 'schedule' ("pick a date").
//   accept+7d, no Final Invoice Sent At   → 'invoice' ("send the invoice",
//                                           max 2 touches).
// Both ride the SAME stamps/cadence, skip 'rancher-added' CRM leads (#511),
// and NEVER email the buyer (deliberate).
//
// F12 (2026-08-18) — BROKER lane ('broker-pickup' kind). The old formula
// required {Rancher Accepted At}, which is empty FOREVER on a broker row
// (lib/depositSla.ts — a represented ranch has no dashboard, no Accept
// button), so after the one 72h deposit-accept escalation NOBODY verified a
// broker buyer got their beef. Cohort (lib/fulfillmentChase.selectBrokerPickup):
// broker marker + Deposit Paid At + fulfillment sheet DELIVERED ('Intro Sent
// At' ≥ 'Deposit Paid At' — the stamp deliverBrokerRancherSheet writes only on
// a real delivery) + not closed/confirmed. Cadence mirrors the confirm lane
// (T+2/5/8, shared stamps). The ask goes to the BUYER — "did pickup happen?"
// (balance-at-pickup framing, no commission words; the ranch is off-platform,
// so the buyer is the only party who can confirm) — with the tier-2/3
// operator escalation mirroring the Connect lane. The rancher nudge email
// NEVER fires on this kind (the #628/#634 leak class).
//
// Mirrors deposit-accept-sla exactly: CRON_SECRET fail-closed auth wrapper +
// withCronRun + maintenance gate + claim-stamp-BEFORE-send ordering +
// per-referral try/catch.
//
// P0-3 (fulfillment audit, 2026-08-18) — THE LADDER NOW ENDS SOMEWHERE. The
// 3-lifetime cap used to be a cliff: at Count 3 the selector skipped the row
// forever, with no terminal stamp, no escalation and no surface inheriting it,
// while the buyer's non-refundable money sat with delivery unproven. A second
// pass now picks those rows up (lib/fulfillmentChase::selectExhaustedChases):
// it stamps `Fulfillment Escalated At`, raises ONE loud operator signal, and
// re-raises it every FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS until the deal is
// confirmed or closed. The same rows show permanently in the cockpit's
// OBLIGATIONS band (/admin/today), which reads the stamp — and falls back to
// `Fulfillment Chase Count` so the pin works before the field exists.
//
// Idempotent: stamps `Fulfillment Chase Last Sent At` + `Fulfillment Chase
// Count` (claim-before-send). The selector enforces a 48h cooldown, one send
// per tier (Count doubles as highest-tier-sent), and a 3-lifetime cap. Those
// two stamp fields are NEW — this run VERIFIES the first stamp persisted
// (lib/airtable's updateRecord silently strips unknown fields) and aborts
// before any sends if it didn't, reporting the fields the founder must add.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendRancherFulfillmentNudge, sendEmail } from '@/lib/email';
import { resolveRancherEmail, rancherFirstName } from '@/lib/rancherNotify';
import { FULFILLMENT_FIELDS } from '@/lib/fulfillmentTracking';
import { claimOnce } from '@/lib/rancherCapacity';
import {
  selectFulfillmentChase,
  selectExhaustedChases,
  exhaustionClaimTtlSec,
  buildBrokerPickupEmail,
  CHASE_FIELDS,
  CHASE_AIRTABLE_FIELDS_NEEDED,
  FULFILLMENT_ESCALATED_AT_FIELD,
  FULFILLMENT_ESCALATION_AIRTABLE_FIELDS_NEEDED,
  FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS,
} from '@/lib/fulfillmentChase';

export const maxDuration = 60;

const MAX_PER_RUN = 25;
// Ladder-exhaustion escalations per run (P0-3). Small on purpose: the first
// sweep over historical backlog drains over days instead of flooding Ben.
const MAX_ESCALATIONS_PER_RUN = 10;

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const nowIso = new Date().toISOString();
  const fallbackDays = Number(process.env.FULFILLMENT_CHASE_FALLBACK_DAYS) || undefined;

  // Formula on LONG-STANDING fields only ({Deposit Paid At} is already in the
  // deposit-accept-sla formula; {Status} is core). The fulfillment fields
  // ({Fulfillment Confirmed At}, {Fulfillment Status}) and this cron's own
  // stamps may not exist in the schema yet — an unknown field name in a
  // formula errors the WHOLE query (the {Refunded At} lesson), so every check
  // on those lives in the JS selector, where an absent field is just
  // `undefined`.
  //
  // F12: the {Rancher Accepted At} clause moved into the JS selector — a
  // broker row NEVER gets acceptance (no dashboard, no Accept button), so the
  // formula version made the broker lane unreachable forever. The selector
  // still requires acceptance for every Connect kind (byte-identical
  // behavior) and routes broker rows to the broker-pickup branch only; the
  // extra rows this admits (deposit-paid, not-yet-accepted Connect deals —
  // deposit-accept-sla territory) are dropped there.
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Paid At} != '', {Status} != 'Closed Lost')`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
    };
  }

  const byId = new Map<string, any>(candidates.map((r) => [String(r.id), r]));
  const eligible = selectFulfillmentChase(candidates, { nowISO: nowIso, fallbackDays });
  const toChase = eligible.slice(0, MAX_PER_RUN);

  const errors: string[] = [];
  let touched = 0;
  // The stamp fields are new — verify the FIRST successful stamp actually
  // persisted (read-back) before allowing any sends this run.
  let stampVerified = false;

  for (const { referralId, kind, tier, daysPastDue } of toChase) {
    try {
      const ref = byId.get(referralId);
      if (!ref) continue;

      const buyerName = ref['Buyer Name'] || '?';
      const cut = String(ref['Order Type'] || '').trim(); // same read as lib/rancherNotify
      const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
      const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
      if (!rancherId) {
        errors.push(`${referralId}: no rancher linked`);
        continue;
      }

      let rancher: any = null;
      try {
        rancher = await getRecordById(TABLES.RANCHERS, rancherId);
      } catch (e: any) {
        errors.push(`${referralId}: rancher fetch failed (${e?.message?.slice(0, 80)})`);
        continue;
      }
      if (!rancher) {
        errors.push(`${referralId}: rancher record missing`);
        continue;
      }
      const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || '?';

      // ── Claim BEFORE send (deposit-accept-sla ordering). If the stamp
      // write fails we skip this referral so a failed claim can't cause a
      // re-send storm on the next daily run.
      const prevCount = Number(ref[CHASE_FIELDS.count]) || 0;
      try {
        await updateRecord(TABLES.REFERRALS, referralId, {
          [CHASE_FIELDS.lastSentAt]: nowIso,
          [CHASE_FIELDS.count]: prevCount + 1,
        });
      } catch (e: any) {
        errors.push(`${referralId}: claim stamp failed (${e?.message?.slice(0, 80)})`);
        continue;
      }

      // ── Verify the first stamp persisted. updateRecord silently strips
      // unknown fields (with a warn), so a "successful" write proves nothing
      // until the schema has the fields. Read back once per run; if either
      // stamp is missing, abort the WHOLE run before any sends — otherwise
      // every daily run would re-email every stuck referral forever.
      if (!stampVerified) {
        let readBack: any = null;
        try {
          readBack = await getRecordById(TABLES.REFERRALS, referralId);
        } catch (e: any) {
          errors.push(`${referralId}: stamp read-back failed (${e?.message?.slice(0, 80)})`);
          continue; // can't prove the claim — skip this referral, try the next
        }
        const missing = [
          !readBack?.[CHASE_FIELDS.lastSentAt] ? CHASE_FIELDS.lastSentAt : null,
          !readBack?.[CHASE_FIELDS.count] ? CHASE_FIELDS.count : null,
        ].filter(Boolean);
        if (missing.length > 0) {
          await sendOperatorSignal({
            urgency: 'normal',
            kind: 'system-error',
            summary: `fulfillment-chase blocked — Referrals is missing its stamp fields`,
            detail:
              `The chase cron found ${eligible.length} overdue unconfirmed fulfillment(s) but cannot safely send: ` +
              `its dedupe stamps don't persist (Airtable strips unknown fields).\n\n` +
              `Add to Referrals:\n${CHASE_AIRTABLE_FIELDS_NEEDED.map((f) => `• ${f}`).join('\n')}`,
            dedupeKey: 'fulfillment-chase-missing-fields',
          });
          return {
            status: 'partial',
            recordsTouched: 0,
            notes: `ABORTED before any sends: stamp field(s) not in schema [${missing.join(', ')}] — add ${CHASE_AIRTABLE_FIELDS_NEEDED.join(' + ')} to Referrals. eligible=${eligible.length}`,
          };
        }
        stampVerified = true;
      }

      // ── Sends by kind + tier. Each wire best-effort in its own try/catch.
      // Wave 2: 'schedule'/'invoice' are rancher-email-only kinds (never the
      // buyer, never the operator signal — that stays a confirm-tier
      // escalation). Due label prefers the buyer-facing Handoff Date.
      const dueLabel = ref[FULFILLMENT_FIELDS.handoffDate]
        ? `handoff date ${ref[FULFILLMENT_FIELDS.handoffDate]}`
        : ref[FULFILLMENT_FIELDS.processingDate]
          ? `processing date ${ref[FULFILLMENT_FIELDS.processingDate]}`
          : `no handoff/processing date set (accept + fallback window)`;

      // ── BROKER lane (F12): the ask goes to the BUYER, never the ranch ───
      // A represented ranch is off-platform — no dashboard, no confirm
      // button, and no BHC emails TO it (the #628/#634 containment rule).
      // Tier 1/2 → buyer "did pickup happen?" (balance-at-pickup framing, no
      // commission words — copy pinned in lib/fulfillmentChase.test.ts);
      // tier 2/3 → operator signal, mirroring the Connect confirm ladder.
      // guardedSend inside sendEmail handles unsubscribed/bounced buyers.
      if (kind === 'broker-pickup') {
        const buyerEmail = String(ref['Buyer Email'] || '').trim();
        const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || 'the ranch');
        if (tier === 1 || tier === 2) {
          if (buyerEmail) {
            try {
              const { subject, html } = buildBrokerPickupEmail({
                // NOT the loop's `buyerName` — that defaults to '?' for the
                // operator surfaces; the buyer greeting wants 'there'.
                buyerFirstName: String(ref['Buyer Name'] || '').split(/\s+/)[0] || 'there',
                ranchName,
                cutLabel: cut || undefined,
                tier,
              });
              await sendEmail({
                to: buyerEmail,
                subject,
                html,
                templateName: 'buyer_broker_pickup_check',
                // Replies land in the resend-inbound webhook tagged to this
                // referral — a "YES" is classified there, same as the chasup
                // buyer chase.
                _replyContext: { type: 'ref', recordId: String(referralId) },
              });
            } catch (e: any) {
              errors.push(`${referralId}: broker buyer email failed (${e?.message?.slice(0, 80)})`);
            }
          } else {
            errors.push(`${referralId}: broker buyer has no email`);
          }
        }
        if (tier === 2 || tier === 3) {
          try {
            await sendOperatorSignal({
              urgency: 'loud',
              kind: 'stuck-rancher',
              summary: `BROKER pickup unverified ${daysPastDue}d past window — did the buyer get their beef?`,
              detail:
                tier === 2
                  ? `${buyerName} paid a broker-rail deposit and ${rancherName} was emailed the fulfillment sheet, but nothing confirms pickup ${daysPastDue}d past the window. Second buyer check-in just sent. If this stays silent it escalates to human takeover at T+8d.`
                  : `${buyerName} paid a broker-rail deposit and ${rancherName} was emailed the fulfillment sheet, but nothing confirms pickup ${daysPastDue}d past the window after two buyer check-ins. HUMAN TAKEOVER: call ${rancherName} — the ranch is off-platform, so a phone call is the only rancher-side channel.`,
              refs: [
                { type: 'referral', id: String(referralId), label: String(buyerName) },
                { type: 'rancher', id: String(rancherId), label: String(rancherName) },
              ],
              dedupeKey: `fulfillment-chase:${referralId}:t${tier}`,
            });
          } catch (e: any) {
            errors.push(`${referralId}: broker operator signal failed (${e?.message?.slice(0, 80)})`);
          }
        }
      }

      if (kind !== 'broker-pickup' && (kind !== 'confirm' || tier === 1 || tier === 2)) {
        const email = resolveRancherEmail(rancher);
        if (email) {
          try {
            await sendRancherFulfillmentNudge({
              rancherEmail: email,
              rancherFirstName: rancherFirstName(rancher),
              buyerFirstName: String(buyerName).split(/\s+/)[0] || 'your buyer',
              cut: cut ? String(cut) : undefined,
              processingDate: ref[FULFILLMENT_FIELDS.processingDate] || undefined,
              rancherId,
              isSecondNudge: kind === 'confirm' && tier === 2,
              kind,
            });
          } catch (e: any) {
            errors.push(`${referralId}: nudge email failed (${e?.message?.slice(0, 80)})`);
          }
        } else {
          errors.push(`${referralId}: rancher has no email`);
        }
      }

      if (kind === 'confirm' && (tier === 2 || tier === 3)) {
        try {
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'stuck-rancher',
            summary: `unconfirmed fulfillment ${daysPastDue}d past due — buyer money at risk`,
            detail:
              tier === 2
                ? `${buyerName} paid a non-refundable deposit; ${rancherName} accepted, but ${dueLabel} passed ${daysPastDue}d ago with NO fulfillment confirmation. Second rancher nudge just sent. If this stays silent it escalates to human-takeover at T+8d.`
                : `${buyerName} paid a non-refundable deposit; ${rancherName} accepted, but ${dueLabel} passed ${daysPastDue}d ago with NO fulfillment confirmation after two nudges. HUMAN TAKEOVER: call ${rancherName}. Buyer has NOT been emailed — whether/how to reassure them is your call.`,
            refs: [
              { type: 'referral', id: String(referralId), label: String(buyerName) },
              { type: 'rancher', id: String(rancherId), label: String(rancherName) },
            ],
            dedupeKey: `fulfillment-chase:${referralId}:t${tier}`,
          });
        } catch (e: any) {
          errors.push(`${referralId}: operator signal failed (${e?.message?.slice(0, 80)})`);
        }
      }

      touched++;
    } catch (e: any) {
      errors.push(`${referralId}: ${e?.message?.slice(0, 100) || 'unknown error'}`);
    }
  }

  // ── P0-3: LADDER EXHAUSTED — the terminal state the cap never had ─────────
  // Rows whose 3 chases are spent and whose delivery is still unproven. The
  // Redis claim is the throttle (TTL == the re-escalation cooldown), so the
  // cadence is identical whether or not `Fulfillment Escalated At` exists in
  // the schema yet; the stamp adds durability across a Redis flush and gives
  // Ben something visible in the base. Claim BEFORE the send, deposit-accept-
  // sla ordering. Deliberately does NOT abort the run when the field is
  // missing (unlike the chase stamps, this stamp is not the dedupe) — it
  // warns once and keeps escalating, because going quiet is the bug.
  const exhausted = selectExhaustedChases(candidates, { nowISO: nowIso });
  let escalated = 0;
  let escalationStampChecked = false;
  for (const row of exhausted.slice(0, MAX_ESCALATIONS_PER_RUN)) {
    const { referralId, rail, daysSinceLastChase } = row;
    try {
      const won = await claimOnce(
        `fulfillment-exhausted:${referralId}`,
        exhaustionClaimTtlSec(),
      );
      if (!won) continue;

      const ref = byId.get(referralId) || {};
      const buyerName = ref['Buyer Name'] || 'A buyer';
      const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
      const rancherId = Array.isArray(rancherIds) ? String(rancherIds[0] || '') : '';
      let rancherName = String(ref['Rancher Name'] || ref['Suggested Rancher Name'] || 'the ranch');
      if (rancherId) {
        const rec: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
        if (rec) rancherName = String(rec['Ranch Name'] || rec['Operator Name'] || rancherName);
      }

      // Durable stamp — best-effort. updateRecord strips unknown fields, so a
      // missing schema field costs a warning, never the escalation.
      try {
        await updateRecord(TABLES.REFERRALS, referralId, {
          [FULFILLMENT_ESCALATED_AT_FIELD]: nowIso,
        });
        if (!escalationStampChecked) {
          escalationStampChecked = true;
          const readBack: any = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
          if (readBack && !readBack[FULFILLMENT_ESCALATED_AT_FIELD]) {
            await sendOperatorSignal({
              urgency: 'normal',
              kind: 'system-error',
              summary: `Referrals is missing '${FULFILLMENT_ESCALATED_AT_FIELD}'`,
              detail:
                `Fulfillment chase-exhaustion escalations are firing on the Redis cooldown, but the durable ` +
                `stamp does not persist (Airtable strips unknown fields), so a Redis flush would restart the ` +
                `clock and the base shows no record of the escalation.\n\n` +
                `Add to Referrals:\n${FULFILLMENT_ESCALATION_AIRTABLE_FIELDS_NEEDED.map((f) => `• ${f}`).join('\n')}`,
              dedupeKey: 'fulfillment-escalated-missing-field',
            });
          }
        }
      } catch (e: any) {
        errors.push(`${referralId}: escalation stamp failed (${e?.message?.slice(0, 60)})`);
      }

      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'stuck-rancher',
        summary: `fulfillment chase EXHAUSTED — ${daysSinceLastChase}d silent, delivery still unproven`,
        detail:
          rail === 'broker'
            ? `${buyerName} paid a broker-rail deposit and every automated buyer check-in is spent — ` +
              `${daysSinceLastChase}d of silence and nothing confirms they got their beef. The ranch is ` +
              `off-platform, so a phone call to ${rancherName} is the only channel left. Confirm the pickup ` +
              `happened or refund. This repeats every ${FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS}d until it is ` +
              `resolved, and the deal is pinned in the OBLIGATIONS band on /admin/today.`
            : `${buyerName} paid a non-refundable deposit, ${rancherName} accepted, and all 3 automated ` +
              `chases are spent — ${daysSinceLastChase}d of silence with NO fulfillment confirmation. ` +
              `Nothing else in the machine will touch this deal. Call ${rancherName}, confirm delivery, or ` +
              `refund. This repeats every ${FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS}d until it is resolved, ` +
              `and the deal is pinned in the OBLIGATIONS band on /admin/today.`,
        refs: [{ type: 'referral', id: String(referralId), label: String(buyerName) }],
        dedupeKey: `fulfillment-exhausted:${referralId}`,
      });
      escalated++;
    } catch (e: any) {
      errors.push(`${referralId}: exhaustion escalation failed (${e?.message?.slice(0, 80)})`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: touched + escalated,
    notes: `candidates=${candidates.length} eligible=${eligible.length} chased=${touched} kinds=[${toChase.map((c) => (c.kind === 'confirm' ? `t${c.tier}` : c.kind === 'broker-pickup' ? `bp${c.tier}` : c.kind)).join(',')}] exhausted=${escalated}/${exhausted.length} errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('fulfillment-chase', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
