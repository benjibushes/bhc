import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { normalizeState, normalizeStates, stringifyStates } from '@/lib/states';

export const maxDuration = 60;

// One-time migration: scan all ranchers + consumers and normalize their state
// fields to canonical 2-letter codes. Fixes the "Montana" vs "MT" comparison
// bug that left waitlisted buyers stranded.
//
// Idempotent — re-running is safe (already-normalized values stay the same).
//
// Auth: ?password=ADMIN_PASSWORD (matches existing setup endpoint convention)
export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password');
  const dryRun = url.searchParams.get('dry') === '1';

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = {
    dryRun,
    ranchers: { scanned: 0, normalized_state: 0, normalized_states_served: 0, unrecognized: [] as string[] },
    consumers: { scanned: 0, normalized: 0, unrecognized: [] as string[] },
    errors: [] as string[],
  };

  // ── RANCHERS ──────────────────────────────────────────────────────────
  try {
    const ranchers: any[] = await getAllRecords(TABLES.RANCHERS);
    for (const r of ranchers) {
      summary.ranchers.scanned++;
      const updates: Record<string, any> = {};

      // Primary State
      const rawState = r['State'];
      if (rawState) {
        const normalized = normalizeState(rawState);
        if (!normalized) {
          summary.ranchers.unrecognized.push(`${r['Operator Name'] || r.id}: State="${rawState}"`);
        } else if (normalized !== String(rawState).trim()) {
          updates['State'] = normalized;
          summary.ranchers.normalized_state++;
        }
      }

      // States Served
      const rawServed = r['States Served'];
      if (rawServed) {
        const codes = normalizeStates(rawServed);
        const canonical = stringifyStates(codes);
        const original = String(rawServed).trim();
        if (canonical !== original && canonical) {
          updates['States Served'] = canonical;
          summary.ranchers.normalized_states_served++;
        }
        // Track entries that didn't normalize (e.g., typos)
        const inputItems = Array.isArray(rawServed) ? rawServed : original.split(',').map((s) => s.trim());
        for (const item of inputItems) {
          if (item && !normalizeState(item)) {
            summary.ranchers.unrecognized.push(`${r['Operator Name'] || r.id}: States Served entry="${item}"`);
          }
        }
      }

      if (!dryRun && Object.keys(updates).length > 0) {
        try {
          await updateRecord(TABLES.RANCHERS, r.id, updates);
          // Throttle to respect Airtable's 5 req/sec
          await new Promise((res) => setTimeout(res, 250));
        } catch (e: any) {
          summary.errors.push(`Rancher ${r.id}: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    summary.errors.push(`Rancher scan: ${e.message}`);
  }

  // ── CONSUMERS ─────────────────────────────────────────────────────────
  try {
    const consumers: any[] = await getAllRecords(TABLES.CONSUMERS);
    for (const c of consumers) {
      summary.consumers.scanned++;
      const rawState = c['State'];
      if (!rawState) continue;
      const normalized = normalizeState(rawState);
      if (!normalized) {
        summary.consumers.unrecognized.push(`${c['Full Name'] || c.id}: State="${rawState}"`);
        continue;
      }
      if (normalized !== String(rawState).trim()) {
        if (!dryRun) {
          try {
            await updateRecord(TABLES.CONSUMERS, c.id, { 'State': normalized });
            await new Promise((res) => setTimeout(res, 250));
          } catch (e: any) {
            summary.errors.push(`Consumer ${c.id}: ${e.message}`);
          }
        }
        summary.consumers.normalized++;
      }
    }
  } catch (e: any) {
    summary.errors.push(`Consumer scan: ${e.message}`);
  }

  return NextResponse.json({
    success: true,
    ...summary,
  });
}
