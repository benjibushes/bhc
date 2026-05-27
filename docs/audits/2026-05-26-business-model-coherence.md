# Business Model Coherence Audit — 2026-05-26

## Executive Summary

**Status:** DONE_WITH_CONCERNS

Verified that `lib/tiers.ts` contains well-defined tier configurations. However, the tier subscription model (Pasture/Ranch/Operator with their respective prices and commission rates) is **not documented in BUSINESS-MODEL.md**. The document discusses marketplace commissions and marketing services but does not reference the subscription tier structure.

---

## Tier Definitions Verification

### From lib/tiers.ts (source of truth):

| Tier | Monthly Price | Commission Rate | Type |
|---|---|---|---|
| Pasture | $150/mo (15000¢) | 7% (0.07) | Subscription |
| Ranch | $350/mo (35000¢) | 3% (0.03) | Subscription |
| Operator | $500/mo (50000¢) | 0% (0) | Subscription |

**Code reference:** Lines 33-88 in `lib/tiers.ts` define the `TIERS` record with explicit `monthlyCents` and `commissionRate` fields.

### From BUSINESS-MODEL.md:

**NOT FOUND.** The document discusses:
- Engine 1 (Marketplace Commission): generic 10% commission rate, no tier breakdown
- Engine 3 (Marketing Services): $500–$2,500/mo retainers (different purpose)
- Engine 4 (Payments Platform): 10% rate, coming in Phase 1

The Pasture/Ranch/Operator subscription tier model with per-tier commission rates does not appear in BUSINESS-MODEL.md.

---

## Findings

### Match Status: PARTIAL

- ✅ **lib/tiers.ts** is internally consistent and well-documented
- ⚠️ **BUSINESS-MODEL.md** does not document the tier subscription model
- ⚠️ The 7%/3%/0% per-tier commission structure is missing from the business model reference

### Recommendation

**Action:** Update `BUSINESS-MODEL.md` to document the subscription tier model as a formal part of the business (likely Engine 2 or an evolution of Engine 1). Currently, BUSINESS-MODEL.md is missing a key component of the revenue model.

Suggested addition:

> ### Engine 2 — Subscription Tiers (Rancher Support)
> - **Pasture:** $150/mo, 7% commission on closed deals, baseline lead-gen + landing page
> - **Ranch:** $350/mo, 3% commission on closed deals, priority routing + quarterly content
> - **Operator:** $500/mo, 0% commission (flat subscription), fully managed marketing + unlimited leads

This keeps `lib/tiers.ts` as the source of truth for implementation, while ensuring `BUSINESS-MODEL.md` reflects the actual business structure.

---

## Conclusion

The code is **correct and complete**. The audit reveals a **documentation gap**, not a code-to-docs mismatch. This is a candidate for Phase 0 refinement: align BUSINESS-MODEL.md to include the subscription tier model.
