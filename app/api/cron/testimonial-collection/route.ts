import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { sendTestimonialAsk } from '@/lib/email';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 60;

// Daily cron that asks recently-closed buyers for a one-sentence
// testimonial. Schedule: `15 18 * * *` (12:15pm MT) — soft hour, well
// after the morning ops cluster.
//
// Selection rules:
//   - Referral.Status = "Closed Won"
//   - Sale Amount > 0
//   - Closed At is between 7 days ago and 90 days ago (the sweet spot —
//     buyer has eaten the beef but the memory is still fresh)
//   - No prior `sendTestimonialAsk` row in Email Sends for this recipient
//     (lifetime dedupe — we only ask once per buyer ever)
//
// Cap: 5 asks per run. Plenty for current volume + leaves headroom so we
// don't burst-send if a backlog accumulates.
//
// On reply, buyer email lands in the Resend Inbound webhook (tagged
// Reply-To = ref-<referralId>@replies.buyhalfcow.com). Conversations row
// is created automatically. Operator pastes the quote into a
// `Testimonial` field on Referrals when adding it (or a future cron
// auto-extracts via Claude if ANTHROPIC_API_KEY is set).
//
// Auto-pause: respects the same Cron Pauses table the email-sequences
// cron does, via the freqGuard pause check inside sendTestimonialAsk
// (template name match).

const ASK_CAP_PER_RUN = 5;
const MIN_DAYS_SINCE_CLOSE = 7;
const MAX_DAYS_SINCE_CLOSE = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string): number {
  if (!iso) return Infinity;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return Infinity;
  return Math.max(0, (Date.now() - then) / DAY_MS);
}

interface Result {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

async function realHandler(_request: Request): Promise<Result> {
  // Pull all Closed Won refs.
  const refs = (await getAllRecords(
    TABLES.REFERRALS,
    `AND({Status} = "Closed Won", {Sale Amount} > 0)`,
  )) as any[];

  // Filter to the freshness window.
  const eligible = refs.filter((r) => {
    const days = daysSince((r['Closed At'] || '').toString());
    return days >= MIN_DAYS_SINCE_CLOSE && days <= MAX_DAYS_SINCE_CLOSE;
  });

  if (eligible.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: 'no eligible referrals (7-90d window)' };
  }

  // Pull all sendTestimonialAsk rows ever sent to build a "skip this
  // recipient" set. Single Airtable read = much cheaper than N reads.
  let alreadyAsked = new Set<string>();
  try {
    const sends = (await getAllRecords(
      TABLES.EMAIL_SENDS,
      `{Template Name} = "sendTestimonialAsk"`,
    )) as any[];
    for (const s of sends) {
      const e = (s['Recipient Email'] || '').toString().trim().toLowerCase();
      if (e) alreadyAsked.add(e);
    }
  } catch (e: any) {
    // If Email Sends read fails we still proceed (fail-open). Worst case:
    // a buyer might get a duplicate ask. Better than dropping the cron run.
    console.warn('[testimonial-collection] Email Sends read failed, proceeding without dedupe:', e?.message);
  }

  let asked = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Sort newest first so if we hit the cap, freshest buyers get asked first.
  eligible.sort((a, b) => {
    const aT = new Date((a['Closed At'] || '').toString()).getTime() || 0;
    const bT = new Date((b['Closed At'] || '').toString()).getTime() || 0;
    return bT - aT;
  });

  for (const ref of eligible) {
    if (asked >= ASK_CAP_PER_RUN) break;

    const buyerEmail = (ref['Buyer Email'] || '').toString().trim().toLowerCase();
    if (!buyerEmail) {
      skipped++;
      continue;
    }

    if (alreadyAsked.has(buyerEmail)) {
      skipped++;
      continue;
    }

    const firstName = (ref['Buyer Name'] || '').toString().split(/\s+/)[0] || 'there';
    const orderType = (ref['Order Type'] || 'Beef').toString();

    // Hydrate rancher name. Rancher field is multipleRecordLinks → first id.
    let ranchName = 'your rancher';
    const rancherIds: string[] = (ref['Rancher'] || []) as string[];
    if (rancherIds[0]) {
      try {
        const rancher: any = await getRecordById(TABLES.RANCHERS, rancherIds[0]);
        ranchName =
          (rancher['Ranch Name'] || rancher['Operator Name'] || ranchName).toString();
      } catch {
        // missing rancher — fall through with generic ranchName
      }
    }

    try {
      await sendTestimonialAsk({
        email: buyerEmail,
        firstName,
        ranchName,
        orderType,
        referralId: ref.id,
      });
      asked++;
      // Add to local set so a second matching ref for the same buyer in
      // this run doesn't double-ask.
      alreadyAsked.add(buyerEmail);
    } catch (e: any) {
      errors.push(`${buyerEmail}: ${e?.message || 'unknown'}`);
      console.error('[testimonial-collection] send failed:', buyerEmail, e?.message);
    }
  }

  const skipReasons: Record<string, number> = {};
  if (skipped > 0) skipReasons['already-asked-or-no-email'] = skipped;
  if (errors.length > 0) skipReasons['send-error'] = errors.length;

  return {
    status: errors.length > 0 ? 'partial' : 'success',
    recordsTouched: asked,
    notes: `asked=${asked} skipped=${skipped} eligible=${eligible.length} cap=${ASK_CAP_PER_RUN}${errors.length ? ` errors=${errors.length}` : ''}`.slice(0, 500),
    skipReasonBreakdown: Object.keys(skipReasons).length > 0 ? skipReasons : undefined,
  };
}

async function authedHandler(request: Request) {
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
  return withCronRun('testimonial-collection', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
