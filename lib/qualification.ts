/**
 * Single source of truth for "is this buyer qualified to be introduced to a rancher?"
 *
 * TWO TIERS:
 *
 * 1. isQualifiedForRancherMatch — the SIGNUP-time gate.
 *    Used the moment a buyer fills out the form. The form itself is the consent
 *    signal: they answered the qualifying questions and clicked submit. If they
 *    pass, route them. If not, they go to nurture.
 *
 * 2. isQualifiedForRouting — the STRICTER gate for buyers who've been sitting.
 *    Used by bulkRoute, waitlist retry, auto-route-on-go-live, and any path
 *    that takes an OLDER record and tries to introduce them to a rancher.
 *    Adds an explicit "actually opted in" check on top of #1: either the buyer
 *    clicked YES on a warmup email (Warmup Engaged At is set) OR they signed
 *    up in the last 14 days with strong signals (their fresh signup IS consent).
 *
 * THE BUG WE'RE PREVENTING: Older buyers on the waitlist were being bulk-routed
 * to ranchers without ever raising their hand again — leading to spam, low-
 * quality intros, and rancher fatigue. This module makes that impossible.
 */

// Read either a stored singleSelect ({name,id,color}) or a plain string field.
function readField(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'name' in value) return String(value.name || '');
  return String(value);
}

function isUnsureValue(s: string): boolean {
  const v = s.toLowerCase();
  return v.includes('unsure') || v.includes('not sure');
}

/**
 * SIGNUP-time qualification. Used by /api/consumers/route.ts on form submit.
 * Buyer just filled out the form — the form's qualifier questions ARE consent.
 */
export function isQualifiedForRancherMatch(opts: {
  segment: string;
  orderType: string;
  budgetRange: string;
  intentScore: number;
}): boolean {
  if (opts.segment !== 'Beef Buyer') return false;
  if (!opts.orderType) return false;
  if (isUnsureValue(opts.orderType)) return false;
  if (!opts.budgetRange) return false;
  if (isUnsureValue(opts.budgetRange)) return false;
  if (opts.intentScore < 40) return false;
  return true;
}

/**
 * Stricter qualification for buyers being routed AFTER initial signup
 * (bulk routing, waitlist retry, auto-route on rancher go-live).
 *
 * Returns { ok, reason }. The reason is logged so silent exclusions are
 * visible — never lose a buyer to an invisible filter again.
 *
 * Required for routing:
 *   - Status = Approved (operator-vetted)
 *   - Not unsubscribed/bounced/complained
 *   - Beef Buyer signals (stored Segment OR Order Type + Budget present — same
 *     inference rule batch-approve uses for new signups)
 *   - Order Type set to a real value (not Unsure)
 *   - Budget set to a real value (not Unsure)
 *   - AT LEAST ONE explicit consent signal:
 *       (a) Warmup Engaged At is set (clicked YES on launch warmup), OR
 *       (b) Created within last 14 days AND Intent Score >= 80 (fresh hot lead)
 */
export function isQualifiedForRouting(buyer: any): { ok: boolean; reason?: string; signal?: 'ready-to-buy' | 'warmup-engaged' | 'fresh-hot-signup' } {
  if (!buyer) return { ok: false, reason: 'no buyer record' };

  // Operator-vetted
  const status = readField(buyer['Status']);
  if (status !== 'Approved') return { ok: false, reason: `status=${status || 'empty'}` };

  // Suppression
  if (buyer['Unsubscribed']) return { ok: false, reason: 'unsubscribed' };
  if (buyer['Bounced']) return { ok: false, reason: 'bounced' };
  if (buyer['Complained']) return { ok: false, reason: 'complained' };

  // Buyer Health gate — block leads who've ghosted ranchers (the "slop" filter).
  // Auto-flagged after 2+ consecutive Closed Lost referrals with no_response reason.
  // Resets when buyer engages (rancher reports a Rancher Contacted or Negotiation
  // transition) or buys (Closed Won). Admin can manually flip back to Active.
  const health = readField(buyer['Buyer Health']);
  if (health === 'Non-Responsive') return { ok: false, reason: 'non-responsive (ghosted prior ranchers)' };
  if (health === 'Closed Won') return { ok: false, reason: 'already a customer (use repeat-purchase flow)' };

  // Beef Buyer — accept either explicit Segment or inferred from order/budget.
  // Mirrors batch-approve's inference rule so backfill drift doesn't recur.
  const segment = readField(buyer['Segment']);
  const orderType = readField(buyer['Order Type']);
  const budget = readField(buyer['Budget']);
  const inferredBeefBuyer = !!(orderType && budget);
  const isBeefBuyer = segment === 'Beef Buyer' || inferredBeefBuyer;
  if (!isBeefBuyer) return { ok: false, reason: 'not a beef buyer (no order/budget signals)' };

  // Real values, not "Unsure"
  if (!orderType) return { ok: false, reason: 'no order type' };
  if (isUnsureValue(orderType)) return { ok: false, reason: 'order type unsure' };
  if (!budget) return { ok: false, reason: 'no budget' };
  if (isUnsureValue(budget)) return { ok: false, reason: 'budget unsure' };

  // CONSENT SIGNAL — exactly two paths qualify, both require an explicit click.
  // Quality over quantity: a buyer never reaches a rancher's inbox unless
  // they actively pressed a button affirming they want this introduction.
  //
  // (a) Explicit "Ready to Buy" — clicked YES on the new ready-to-buy prompt
  //     email or any warmup email (the YES CTA sets Ready to Buy = true).
  if (buyer['Ready to Buy']) return { ok: true, signal: 'ready-to-buy' };

  // (b) Legacy warmup engagement — clicked YES on a launch warmup before the
  //     CTA was renamed. Same explicit-click signal, just older copy.
  if (buyer['Warmup Engaged At']) return { ok: true, signal: 'warmup-engaged' };

  // No path 3 by design. Fresh signups, regardless of intent score or form
  // completeness, must click the Ready-to-Buy prompt email before any rancher
  // hears about them. Form completion alone is not enough — the click is.
  return { ok: false, reason: 'no explicit consent click yet — buyer must click "Ready to Buy" to be routed' };
}

/**
 * Detects whether a buyer is the highest-priority "ready to buy in 1-2 months"
 * tier. Used to flag intro emails (subject prefix), Telegram alerts, and admin
 * dashboards. Distinct from `isQualifiedForRouting` which is the gate.
 */
export function isReadyToBuy(buyer: any): boolean {
  if (!buyer) return false;
  return !!buyer['Ready to Buy'];
}
