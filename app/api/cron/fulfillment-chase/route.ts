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
// Escalation tiers (days past Processing Date, or past accept-date + fallback
// when no Processing Date is set — see lib/fulfillmentChase.ts):
//   T+2d → gentle rancher nudge email ("one tap confirms").
//   T+5d → second rancher nudge + LOUD operator signal (money at risk).
//   T+8d → operator signal only — a human takes over. Deliberately NO buyer
//          email at any tier: we can't verify what actually happened, and
//          "checking on your order" promises we can't back. Buyer comms at
//          this stage is Ben's call.
//
// Mirrors deposit-accept-sla exactly: CRON_SECRET fail-closed auth wrapper +
// withCronRun + maintenance gate + claim-stamp-BEFORE-send ordering +
// per-referral try/catch.
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
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';
import { sendRancherFulfillmentNudge } from '@/lib/email';
import { resolveRancherEmail, rancherFirstName } from '@/lib/rancherNotify';
import { FULFILLMENT_FIELDS } from '@/lib/fulfillmentTracking';
import {
  selectFulfillmentChase,
  CHASE_FIELDS,
  CHASE_AIRTABLE_FIELDS_NEEDED,
} from '@/lib/fulfillmentChase';

export const maxDuration = 60;

const MAX_PER_RUN = 25;

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const nowIso = new Date().toISOString();
  const fallbackDays = Number(process.env.FULFILLMENT_CHASE_FALLBACK_DAYS) || undefined;

  // Formula on LONG-STANDING fields only ({Deposit Paid At} + {Rancher
  // Accepted At} are already in the deposit-accept-sla formula; {Status} is
  // core). The fulfillment fields ({Fulfillment Confirmed At}, {Fulfillment
  // Status}) and this cron's own stamps may not exist in the schema yet — an
  // unknown field name in a formula errors the WHOLE query (the {Refunded At}
  // lesson), so every check on those lives in the JS selector, where an
  // absent field is just `undefined`.
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Paid At} != '', {Rancher Accepted At} != '', {Status} != 'Closed Lost')`,
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

  for (const { referralId, tier, daysPastDue } of toChase) {
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

      // ── Sends by tier. Each wire best-effort in its own try/catch.
      const dueLabel = ref[FULFILLMENT_FIELDS.processingDate]
        ? `processing date ${ref[FULFILLMENT_FIELDS.processingDate]}`
        : `no processing date set (accept + fallback window)`;

      if (tier === 1 || tier === 2) {
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
              isSecondNudge: tier === 2,
            });
          } catch (e: any) {
            errors.push(`${referralId}: nudge email failed (${e?.message?.slice(0, 80)})`);
          }
        } else {
          errors.push(`${referralId}: rancher has no email`);
        }
      }

      if (tier === 2 || tier === 3) {
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

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: touched,
    notes: `candidates=${candidates.length} eligible=${eligible.length} chased=${touched} tiers=[${toChase.map((c) => c.tier).join(',')}] errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
  };
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
  return withCronRun('fulfillment-chase', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
