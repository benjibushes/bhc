// app/api/cron/state-coverage-notify/route.ts
//
// THE WAITLIST PROMISE-KEEPER (Wave 2 buyer-comms, 2026-08-01).
//
// Every uncovered-state capture told the buyer "you'll get an email the
// moment a rancher goes live in your area" — and NOTHING sent that email.
// Waitlist rows (Consumers, Source='relaunch_waitlist') were written and
// never read again. This cron closes the loop:
//
//   1. env-gated: STATE_COVERAGE_NOTIFY_ENABLED must be exactly 'true'
//      (default OFF — the operator flips it deliberately; until then the
//      cron reports what it WOULD do and sends nothing);
//   2. daily, computes the operationally covered states from the live
//      rancher pool (lib/routingSegment.getServedStates — the shared P1′
//      helper, capacity-OUT, same truth the signup gate uses);
//   3. selects buyers whose state flipped unserved→served (pure helper
//      ./selection.ts, unit-tested), capped at 50/run — already-notified
//      rows are excluded by the durable Notes stamp, so the cap walks the
//      tail across runs. WIDENED (P1′, 2026-08-08): the pool is no longer
//      just Source='relaunch_waitlist' — any consumer whose stored Routing
//      Segment is STATE_WAITLIST (i.e. classified while their state was
//      unserved) joins it, so every lane-2→1 flip gets the promised letter,
//      not only the /api/waitlist captures. If Airtable ever rejects the
//      {Routing Segment} clause the read degrades to the legacy
//      waitlist-only formula instead of killing the run;
//   4. sends ONE whitelisted 'state_coverage_opened' email per buyer, ever.
//      Once-ever = a durable AREA_OPENED_MARKER appended to the row's Notes
//      after the outcome (hard rule 2: send truth persisted on the record),
//      with a Redis claimOnce (SET NX, ~1yr TTL) taken BEFORE the send as
//      the same-run/racing-runs belt — a crashed run costs one email, never
//      a duplicate. Suppression (unsub/bounce/complaint) is checked both in
//      selection and again by the send wrapper.

import { getAllRecords, updateRecord, TABLES, isInvalidFilterFormulaError } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendStateCoverageOpened } from '@/lib/email';
import { claimOnce } from '@/lib/rancherCapacity';
import { getServedStates } from '@/lib/routingSegment';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { selectStateCoverageTargets, DEFAULT_NOTIFY_CAP, AREA_OPENED_MARKER } from './selection';

export const maxDuration = 120;

async function realHandler(_request: Request): Promise<{
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const enabled = process.env.STATE_COVERAGE_NOTIFY_ENABLED === 'true';

  // Covered states from the live rancher pool — the shared P1′ helper
  // (capacity-OUT, identical semantics to the loop it replaced and to the
  // signup-time "rancher available in your state?" gate).
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const covered = getServedStates(ranchers);

  // WIDENED POOL (P1′): waitlist captures PLUS any consumer whose stored
  // Routing Segment says STATE_WAITLIST. The stored segment is yesterday's
  // truth (nightly reclassify-buyers) — "segment says unserved" ∩ "state is
  // covered NOW" = exactly the unserved→served flip this cron exists to
  // announce. One OR read, so no client-side union; selection dedupes by id
  // as a belt. Degrades to the legacy waitlist-only formula if the segment
  // clause is ever rejected (unknown-field errors kill the whole query —
  // the deposit-accept-sla {Refunded At} lesson).
  let poolRows: any[];
  let widened = true;
  try {
    poolRows = (await getAllRecords(
      TABLES.CONSUMERS,
      `OR({Source} = "relaunch_waitlist", {Routing Segment} = "STATE_WAITLIST")`,
    )) as any[];
  } catch (e: any) {
    if (!isInvalidFilterFormulaError(e)) throw e;
    console.warn('[state-coverage-notify] widened formula rejected; falling back to waitlist-only pool:', e?.message);
    widened = false;
    poolRows = (await getAllRecords(
      TABLES.CONSUMERS,
      `{Source} = "relaunch_waitlist"`,
    )) as any[];
  }

  const targets = selectStateCoverageTargets(poolRows, covered, DEFAULT_NOTIFY_CAP);

  if (!enabled) {
    // DRY by default (the LOSS_RECOVERY precedent): report the would-send
    // list size so the operator can read one report before flipping the flag.
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `DISABLED (STATE_COVERAGE_NOTIFY_ENABLED!=='true') — would notify ${targets.length} of ${poolRows.length} pool rows (${widened ? 'widened: waitlist+STATE_WAITLIST segment' : 'FALLBACK: waitlist-only'}); covered states=${covered.size}`,
    };
  }

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Durable once-ever stamp (audit-D fix): append AREA_OPENED_MARKER into the
  // row's Notes after the outcome is known. This is the hard-rule-2 anchor —
  // Redis claimOnce degrades OPEN and expires (365d), the Notes stamp does
  // neither — and it's what lets selection skip notified rows so the per-run
  // cap walks the tail instead of re-selecting the same head forever. A failed
  // stamp write lands in errors[] (run goes partial); the Redis claim covers
  // the retry window until the next attempt re-stamps.
  const notesById = new Map<string, string>();
  for (const row of poolRows) notesById.set(String(row.id), String(row['Notes'] || ''));
  const stampNotes = async (consumerId: string, outcome: 'sent' | 'suppressed') => {
    const day = new Date().toISOString().slice(0, 10);
    const line = `${AREA_OPENED_MARKER} ${day}] area-opened email ${outcome} (state-coverage-notify)`;
    const existing = notesById.get(consumerId) || '';
    await updateRecord(TABLES.CONSUMERS, consumerId, {
      Notes: existing ? `${existing}\n${line}` : line,
    });
  };

  for (const t of targets) {
    try {
      // Same-run / racing-runs belt, claim-BEFORE-send (see header). Keyed on
      // the consumer id so a re-captured email on the same row can't re-fire.
      // The durable anchor is the Notes stamp below.
      const won = await claimOnce(
        `state-coverage-opened:${t.consumerId}`,
        365 * 24 * 60 * 60,
      );
      if (!won) {
        skipped++;
        continue;
      }
      const result = await sendStateCoverageOpened({
        email: t.email,
        firstName: t.firstName,
        state: t.state,
      });
      if (result?.success) {
        sent++;
        await stampNotes(t.consumerId, 'sent');
      } else {
        // Suppressed at the send layer — stamp too, so a suppressed buyer
        // leaves the selection pool instead of burning a cap slot daily.
        skipped++;
        await stampNotes(t.consumerId, 'suppressed');
      }
      // Pace: stay friendly to the shared send gate.
      await new Promise((r) => setTimeout(r, 400));
    } catch (e: any) {
      errors.push(`${t.consumerId}: ${String(e?.message || e).slice(0, 80)}`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes: `pool=${poolRows.length} (${widened ? 'widened' : 'FALLBACK waitlist-only'}) covered-states=${covered.size} targets=${targets.length} sent=${sent} skipped=${skipped} errs=${errors.length}${errors.length ? ' err1=' + errors[0] : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('state-coverage-notify', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
