// lib/closeCheckMute.ts
//
// THE MIS-TAP THIS CLOSES (pause-asymmetry sweep 2026-07-25):
// the Telegram close-check card's "🔇 Stop asking" button used to write
// `Close Check Sent At = '2099-12-31'`. app/api/cron/close-detector skips any
// referral whose stamp is newer than its cooldown, so a far-future stamp meant
// ONE accidental tap silenced close-detection on a live deal FOREVER — no
// undo in the UI, no expiry, no report. Same shape as the rancher pauses that
// nothing ever reversed: an automatic silence with no automatic end.
//
// A mute is now a SNOOZE. 30 days is long enough that the founder isn't
// re-asked about a deal they just triaged, and short enough that a fat-finger
// costs one missed month instead of the whole deal.
//
// EFFECTIVE SILENCE is a little longer than the window: the stamp sits in the
// future for MUTE_DAYS, and once it matures the detector's own 14-day cooldown
// (CHECK_COOLDOWN_DAYS) still measures from it — so the next card lands ~44
// days after the tap. That is intended; it is bounded, which is the point.
//
// NOT TO BE CONFUSED WITH the detector's own give-up gate, which stamps the
// same far-future sentinel once a referral passes MAX_DAYS_SINCE_INTRO. That
// one is deliberate and permanent — the deal is past any realistic close
// window and the machine is done asking on purpose. It keeps the sentinel.

/** How long a manual "stop asking" tap silences close-detection. */
export const CLOSE_CHECK_MUTE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure. The `Close Check Sent At` value a manual mute should write.
 *
 * @param nowMs injected for testability — never reads the clock itself.
 */
export function closeCheckMuteUntilISO(nowMs: number): string {
  return new Date(nowMs + CLOSE_CHECK_MUTE_DAYS * DAY_MS).toISOString();
}
