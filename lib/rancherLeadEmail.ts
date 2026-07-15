// lib/rancherLeadEmail.ts
//
// Pure builders for the rancher lead-intro email's claim-bearing blocks.
// Extracted (2026-07-15 rancher-feedback-loop) because the inline HTML made
// three claims the data didn't back:
//   1. "acknowledged commitment to respond within 24 hours" — the funnel
//      hard-coded ack:true for every buyer (BuyerFunnel.tsx:451-454); the
//      line now renders ONLY when the buyer's 'Response Ack At' is stamped.
//   2. "⭐ Qualified buyer — N/100" — the score is a 3-value constant
//      post-funnel (75/90/100); every lead was a star. Replaced by a FACTS
//      block: cut wanted, timing, storage, budget, how fresh the quiz is.
//   3. "Reach out within 24 hours to close the sale" on Operator-tier
//      ranchers — Operator closes are run by the BHC team (the buyer is told
//      "ben reaches out today"); telling the rancher to close contradicts
//      both the buyer promise and reality.
//
// Everything here is deterministic HTML-string building — unit-tested in
// lib/rancherLeadEmail.test.ts, consumed by app/api/matching/suggest and
// lib/bulkRoute.

import type { TierSlug } from './tiers';

export const STORAGE_LABELS: Record<string, string> = {
  have_freezer: 'Has freezer space',
  need_freezer: 'Buying a freezer',
  rancher_holds: 'Needs rancher to hold short-term',
  cuts_only: 'Pickup cuts only',
};

/** 'qualified 3h ago' under 48h, then 'qualified 4d ago'. '' when unknown. */
export function qualifiedAgoLabel(qualifiedAtIso: string | undefined, nowMs: number): string {
  if (!qualifiedAtIso) return '';
  const t = new Date(qualifiedAtIso).getTime();
  if (!Number.isFinite(t)) return '';
  const hours = Math.max(0, Math.floor((nowMs - t) / (60 * 60 * 1000)));
  if (hours < 48) return `qualified ${hours}h ago`;
  return `qualified ${Math.floor(hours / 24)}d ago`;
}

/**
 * The 24-hour commitment line — renders ONLY when the buyer actually tapped
 * the acknowledgment (Consumers 'Response Ack At' stamped). Older buyers
 * (pre-field) and non-ack buyers get no line: absence of evidence = no claim.
 */
export function commitmentLineHtml(responseAckAt: unknown): string {
  if (!responseAckAt) return '';
  return `<p style="margin:8px 0 0 0;font-size:12px;color:#6B4F3F;">Buyer acknowledged the commitment to respond within 24 hours.</p>`;
}

export interface LeadFacts {
  cut?: string;
  timing?: string;
  storage?: string; // raw funnel value; mapped through STORAGE_LABELS
  budget?: string;
  qualifiedAtIso?: string;
  responseAckAt?: unknown;
}

/**
 * The FACTS block that replaces the fabricated score banner. Rows render
 * only when the datum exists — no 'unspecified' filler, no score anywhere.
 * Returns '' when there are no facts to show.
 */
export function leadFactsHtml(facts: LeadFacts, nowMs: number): string {
  const rows: string[] = [];
  if (facts.cut) rows.push(`<p style="margin:4px 0;"><strong>Cut wanted:</strong> ${facts.cut}</p>`);
  if (facts.timing) rows.push(`<p style="margin:4px 0;"><strong>Timing:</strong> ${facts.timing}</p>`);
  if (facts.storage) {
    rows.push(`<p style="margin:4px 0;"><strong>Storage:</strong> ${STORAGE_LABELS[facts.storage] || facts.storage}</p>`);
  }
  if (facts.budget) rows.push(`<p style="margin:4px 0;"><strong>Budget:</strong> ${facts.budget}</p>`);
  const ago = qualifiedAgoLabel(facts.qualifiedAtIso, nowMs);
  if (rows.length === 0 && !ago) return '';
  const agoLine = ago
    ? `<p style="margin:8px 0 0 0;font-size:12px;color:#6B4F3F;">Completed the 4-question qualification quiz — ${ago}.</p>`
    : '';
  return `<div style="background:#F4F1EC;border:2px solid #0E0E0E;padding:14px 18px;margin:16px 0;font-size:14px;color:#0E0E0E;">
                <p style="margin:0 0 8px 0;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">What this buyer told us</p>
                ${rows.join('\n                ')}
                ${agoLine}${commitmentLineHtml(facts.responseAckAt)}
              </div>`;
}

/**
 * The closing instruction line. Operator tier: the BHC team runs the close
 * (zero commission, fully managed) — the rancher fulfills, they don't chase.
 * Everyone else keeps the 24-hour call urging: it's the one behavior that
 * moves the 38% touch rate.
 */
export function closeCtaHtml(tier: TierSlug | null): string {
  if (tier === 'operator') {
    return `<p>Our team is running this close — you'll get the confirmed order to fulfill. Reply-all with any questions.</p>`;
  }
  return `<p>Reach out within 24 hours to close the sale. Reply-all to keep me in the loop.</p>`;
}

/** Ready-to-Buy banner — Operator variant can't promise the rancher's call. */
export function readyBannerHtml(tier: TierSlug | null): string {
  const tail =
    tier === 'operator'
      ? `Our team is reaching out to them now to set up the close.`
      : `They're expecting your call within 24–48 hours.`;
  return `<div style="background:#FFF6E0;border:2px solid #C99A2E;padding:14px 18px;margin:16px 0;font-size:14px;color:#0E0E0E;"><strong>READY TO BUY in 1–2 months.</strong> Buyer just clicked YES on the Ready-to-Buy CTA. ${tail}</div>`;
}
