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

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const HIGH_INTENT_THRESHOLD = 80; // signup IS consent if intent >= this

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
export function isQualifiedForRouting(buyer: any): { ok: boolean; reason?: string } {
  if (!buyer) return { ok: false, reason: 'no buyer record' };

  // Operator-vetted
  const status = readField(buyer['Status']);
  if (status !== 'Approved') return { ok: false, reason: `status=${status || 'empty'}` };

  // Suppression
  if (buyer['Unsubscribed']) return { ok: false, reason: 'unsubscribed' };
  if (buyer['Bounced']) return { ok: false, reason: 'bounced' };
  if (buyer['Complained']) return { ok: false, reason: 'complained' };

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

  // CONSENT SIGNAL — at least one must be present.
  // (a) Explicit warmup engagement.
  if (buyer['Warmup Engaged At']) return { ok: true };

  // (b) Recent signup with strong intent — signup IS consent for fresh hot leads.
  const created = buyer['Created'] || buyer['Created Time'] || buyer['createdTime'];
  if (created) {
    const ageMs = Date.now() - new Date(created).getTime();
    if (ageMs >= 0 && ageMs <= FOURTEEN_DAYS_MS) {
      const intent = Number(buyer['Intent Score'] || 0);
      if (intent >= HIGH_INTENT_THRESHOLD) return { ok: true };
    }
  }

  return { ok: false, reason: 'no engagement signal — not warmup-engaged, not a fresh high-intent signup' };
}
