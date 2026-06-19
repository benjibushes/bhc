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
 * "Just exploring" is a soft no — buyer self-identified as not yet committed.
 * Qualified for nurture but NEVER for routing. Lets us keep tire-kickers in
 * the funnel without spamming ranchers with non-buyers.
 */
function isJustExploringValue(s: string): boolean {
  return /just exploring/i.test(s);
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
  // "Just exploring" budget = explicit non-buyer. Don't route.
  if (isJustExploringValue(opts.budgetRange)) return false;
  // Threshold raised from 40 to 60 alongside the form rework. With realistic
  // budget brackets in place, casual signups land at ~40 and serious buyers
  // at 70+. The new threshold cleanly separates them.
  if (opts.intentScore < 60) return false;
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
export function isQualifiedForRouting(buyer: any): { ok: boolean; reason?: string; signal?: 'qualified-quiz' | 'ready-to-buy' | 'warmup-engaged' | 'fresh-hot-signup' } {
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

  // Order type (tier) is required for EVERYONE — it's what the quiz captures
  // and what sets the price the buyer is matched on.
  if (!orderType) return { ok: false, reason: 'no order type' };
  if (isUnsureValue(orderType)) return { ok: false, reason: 'order type unsure' };

  // ── THE QUIZ IS THE QUALIFIER ───────────────────────────────────────────
  // A passed quiz (Qualified At + score >= 75) with a chosen tier qualifies for
  // routing — full stop. This runs BEFORE the budget gate on purpose: the
  // 4-question quiz captures tier/timing/storage but NOT budget, so a quiz-passer
  // legitimately has a blank Budget field. Hard-rejecting them for "no budget"
  // was stranding score-100 buyers in Waitlisted forever — batch-approve's retry
  // rejected them here before ever reaching the quiz signal. matching/suggest
  // treats a blank budget as unbounded and prices on the chosen tier, so the
  // resulting route is correct. (Fix 2026-06-18.)
  //
  // Strict policy still holds: ONLY the quiz qualifies (score >= 75). No legacy
  // ready-to-buy / warmup fallback — those caused the 2026-06-05 cascade (179
  // healed buyers → matching/suggest → 39 cross-state misroutes to Ashcraft +
  // Hartsock). Pre-quiz buyers get a fresh /qualify invite via the nurture cron.
  const qualScore = Number(buyer['Qualification Score'] || 0);
  if (buyer['Qualified At'] && qualScore >= 75) {
    return { ok: true, signal: 'qualified-quiz' };
  }

  // ── Not quiz-qualified → REJECTED (no legacy bypass). The budget /
  // beef-buyer checks below only shape the diagnostic reason; a buyer without
  // a passing quiz never routes regardless of budget. ──
  if (!isBeefBuyer) return { ok: false, reason: 'not a beef buyer (no order/budget signals)' };
  if (!budget) return { ok: false, reason: 'no budget' };
  if (isUnsureValue(budget)) return { ok: false, reason: 'budget unsure' };
  if (isJustExploringValue(budget)) {
    return { ok: false, reason: 'just exploring — buyer hasn\'t committed yet' };
  }
  const reason = buyer['Qualified At']
    ? `quiz incomplete — score ${qualScore}/100 below 75 threshold`
    : buyer['Ready to Buy'] || buyer['Warmup Engaged At']
      ? 'pre-quiz buyer — strict gate rejects legacy ready-to-buy/warmup signals; needs fresh /qualify completion'
      : 'no qualification signal — buyer must complete /qualify quiz to be routed';
  return { ok: false, reason };
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
