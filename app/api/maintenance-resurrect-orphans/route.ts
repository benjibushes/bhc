import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';

export const maxDuration = 120;

// One-time resurrection for the 438+ orphaned "Pending Approval" referrals
// that got stuck when the states-comparison bug prevented auto-matching.
//
// Strategy (Option B — gradual re-engagement):
//   1. Mark every orphan Pending Approval referral (no rancher linked) as
//      Closed Lost with a timestamped note.
//   2. Reset the linked buyer's Referral Status to "Waitlisted" and their
//      Sequence Stage to "none" so they re-enter the nurture funnel.
//   3. Clear Sequence Sent At so the first nurture email fires on schedule
//      rather than being skipped by the 24h frequency gate.
//
// Once this runs, the existing batch-approve cron's waitlisted-retry loop
// picks them up at 50/day and attempts rematching. The email-sequences cron
// sends regular nurture emails (Day 3 "we're finding your rancher", etc.)
// to gradually re-engage without a mass blast.
//
// Auth: ?password=ADMIN_PASSWORD
// Safe to re-run — idempotent (only acts on Pending Approval referrals with
// no rancher linked, which shrinks to zero after a successful pass).
//
// Dry run: add &dry=1 to see what would change without writing.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password');
  const dryRun = url.searchParams.get('dry') === '1';

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowIso = new Date().toISOString();
  const summary = {
    dryRun,
    scanned: 0,
    orphansFound: 0,
    referralsClosed: 0,
    consumersReset: 0,
    consumersAlreadyActive: 0,
    errors: [] as string[],
  };

  try {
    // Pull ALL active Pending Approval referrals. getAllRecords paginates.
    const referrals = await getAllRecords(
      TABLES.REFERRALS,
      '{Status} = "Pending Approval"'
    ) as any[];

    summary.scanned = referrals.length;

    // An orphan has no Rancher AND no Suggested Rancher link
    const orphans = referrals.filter((r: any) => {
      const rancherLinks = r['Rancher'] || [];
      const suggestedLinks = r['Suggested Rancher'] || [];
      const hasRancher =
        (Array.isArray(rancherLinks) && rancherLinks.length > 0) ||
        (Array.isArray(suggestedLinks) && suggestedLinks.length > 0);
      return !hasRancher;
    });

    summary.orphansFound = orphans.length;

    // Deduplicate buyer IDs so we don't reset the same consumer twice
    const seenBuyers = new Set<string>();

    for (const ref of orphans) {
      try {
        const buyerLinks = ref['Buyer'] || [];
        const buyerId = Array.isArray(buyerLinks) ? buyerLinks[0] : null;

        // 1. Close the orphan referral
        if (!dryRun) {
          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Status': 'Closed Lost',
            'Closed At': nowIso,
            'Notes': `[LEGACY ORPHAN RESET ${nowIso.slice(0, 10)}] Buyer was stuck Pending Approval with no rancher linked (pre-states-fix era). Reset to Waitlisted for re-matching.\n${ref['Notes'] || ''}`.trim(),
          });
        }
        summary.referralsClosed++;

        // 2. Reset the linked consumer to Waitlisted + restart nurture
        if (buyerId && !seenBuyers.has(buyerId)) {
          seenBuyers.add(buyerId);
          if (!dryRun) {
            try {
              await updateRecord(TABLES.CONSUMERS, buyerId, {
                'Referral Status': 'Waitlisted',
                'Sequence Stage': 'none',
                'Sequence Sent At': null,
              });
              summary.consumersReset++;
            } catch (e: any) {
              summary.errors.push(`Consumer ${buyerId}: ${e.message}`);
            }
          } else {
            summary.consumersReset++;
          }
        } else if (buyerId) {
          summary.consumersAlreadyActive++;
        }

        // Respect Airtable's 5 req/sec: 250ms between records covers 2 writes each.
        if (!dryRun) {
          await new Promise((res) => setTimeout(res, 250));
        }
      } catch (e: any) {
        summary.errors.push(`Referral ${ref.id}: ${e.message}`);
      }
    }
  } catch (e: any) {
    summary.errors.push(`Scan: ${e.message}`);
  }

  return NextResponse.json({
    success: true,
    ...summary,
    note: dryRun
      ? 'DRY RUN — nothing was written. Remove ?dry=1 to execute.'
      : 'Orphans reset. Batch-approve cron will gradually re-match waitlisted buyers (~50/day).',
  });
}
