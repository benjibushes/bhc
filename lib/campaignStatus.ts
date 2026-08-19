// lib/campaignStatus.ts
//
// The Campaigns.Status contract, in one place, because it was broken in the
// most invisible way possible.
//
// THE BUG (2026-08-19). Campaigns.Status is a singleSelect whose choices are
// Pending / Sending / Aborting / Aborted / Partial / Sent / Failed. There is
// no 'Scheduled'. But BOTH schedulers — app/api/admin/broadcast and the
// Telegram broadcast command — wrote `Status: 'Scheduled'`. lib/schema/
// selectGuard dropped the key (correctly: minting an option nothing reads is
// its own bug), so the campaign row was created with a BLANK status.
//
// app/api/cron/send-scheduled then selected only 'scheduled' | 'sending'. A
// blank matched neither. So every campaign scheduled from either surface sat
// there forever and NEVER SENT — no error, no alert, no failed row. A live
// example was still sitting in the base when this was found.
//
// Two halves of one contract that lived in different files and drifted. They
// live here now, and the test asserts the written value is a real choice.

/**
 * What a scheduler writes for "queued, not sent yet". MUST be one of the
 * field's real choices — see CAMPAIGN_STATUS_CHOICES.
 */
export const CAMPAIGN_STATUS_QUEUED = 'Pending';

/**
 * Statuses send-scheduled will pick up.
 *  - 'pending'   — the real queued state.
 *  - 'sending'   — a run killed mid-send (audience > maxDuration) RESUMES
 *                  from its cursor instead of stranding.
 *  - 'scheduled' — never a valid choice; accepted only so a legacy row that
 *                  somehow carries it is not stranded a second time.
 */
export const CAMPAIGN_SENDABLE_STATUSES: readonly string[] = ['pending', 'sending', 'scheduled'];

/** True when this campaign row is eligible for the sender. */
export function isCampaignSendable(status: unknown): boolean {
  return CAMPAIGN_SENDABLE_STATUSES.includes(String(status ?? '').trim().toLowerCase());
}
