// lib/rancherLeadDigest.ts
//
// Pure decisions for the per-rancher DAILY lead digest (onboarding-comms
// audit 2026-07-28, P1). Replaces the per-referral sendRancherLeadReminder,
// which the 3/week frequency cap silently ate (52 of 58 attempts suppressed
// in 14 days) because its 4-day throttle was per-REFERRAL — a rancher with N
// open leads could draw N reminders per window, so the cap was the only
// per-recipient ceiling and it fired constantly.
//
// The digest inverts that: ONE email per rancher per day listing every lead
// still sitting in 'Intro Sent' 2+ days, throttled by a DB-state stamp on the
// RANCHER (Ranchers.'Lead Digest Sent At', stamped BEFORE the send). Because
// the throttle is per-recipient database state — not a best-effort counter —
// the template is safe to whitelist from the frequency cap: a failed stamp
// write can suppress a digest, never multiply one.
//
// Founder directive 2026-05-20 still holds: only 'Intro Sent' is chased by
// automated rancher email. Once the rancher marks Rancher Contacted or
// Negotiation the deal is theirs; the Monday stale-lead nudge in
// rancher-followup covers those statuses weekly. The digest's per-referral
// 'Rancher Reminded At' stamps keep Intro-Sent rows out of that Monday
// bundle automatically (its 7-day per-referral throttle sees a fresh stamp).

export const DIGEST_MIN_LEAD_AGE_DAYS = 2;
export const DIGEST_THROTTLE_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestLead {
  referralId: string;
  buyerName: string;
  buyerState: string;
  buyerPhone: string;
  buyerEmail: string;
  orderType: string;
  budgetRange: string;
  daysSinceIntro: number;
}

/**
 * DB-state throttle: send at most one digest per rancher per 24h.
 * `lastSentAt` is Ranchers.'Lead Digest Sent At' (may be undefined/blank).
 */
export function shouldSendLeadDigest(
  lastSentAt: string | undefined | null,
  nowMs: number,
): boolean {
  if (!lastSentAt) return true;
  const last = new Date(lastSentAt).getTime();
  if (Number.isNaN(last)) return true;
  return nowMs - last >= DIGEST_THROTTLE_HOURS * 60 * 60 * 1000;
}

/**
 * Filter + shape a rancher's referrals into digest lines.
 * Input rows are raw Airtable Referrals records (fields at the top level,
 * matching how referral-chasup already reads them). Only 'Intro Sent' rows
 * whose intro is DIGEST_MIN_LEAD_AGE_DAYS+ old qualify. Oldest first — the
 * lead the rancher is hurting most on leads the email.
 */
export function buildDigestLeads(
  referrals: Array<Record<string, unknown> & { id: string }>,
  nowMs: number,
): DigestLead[] {
  const leads: DigestLead[] = [];
  for (const r of referrals) {
    if (r['Status'] !== 'Intro Sent') continue;
    const introAt = (r['Intro Sent At'] || r['Approved At']) as string | undefined;
    if (!introAt) continue;
    const introMs = new Date(introAt).getTime();
    if (Number.isNaN(introMs)) continue;
    const days = Math.floor((nowMs - introMs) / DAY_MS);
    if (days < DIGEST_MIN_LEAD_AGE_DAYS) continue;
    leads.push({
      referralId: r.id,
      buyerName: String(r['Buyer Name'] || 'a buyer'),
      buyerState: String(r['Buyer State'] || ''),
      buyerPhone: String(r['Buyer Phone'] || ''),
      buyerEmail: String(r['Buyer Email'] || ''),
      orderType: String(r['Order Type'] || ''),
      budgetRange: String(r['Budget Range'] || ''),
      daysSinceIntro: days,
    });
  }
  leads.sort((a, b) => b.daysSinceIntro - a.daysSinceIntro);
  return leads;
}

/** "3 buyers waiting: Richard 12d, Christine 5d, Ana 2d" — subject helper. */
export function digestSubject(leads: DigestLead[]): string {
  const n = leads.length;
  const firsts = leads
    .slice(0, 3)
    .map((l) => `${l.buyerName.split(' ')[0]} ${l.daysSinceIntro}d`)
    .join(', ');
  return n === 1
    ? `${leads[0].buyerName.split(' ')[0]} has been waiting ${leads[0].daysSinceIntro} days to hear from you`
    : `${n} buyers waiting on you: ${firsts}${n > 3 ? '…' : ''}`;
}
