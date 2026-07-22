// lib/paymentPathSmoke.ts
//
// MONEY-TRUTH invariants 1c/1d — the go-live PAYMENT-PATH smoke test.
// "Live" must mean "can actually take a buyer's money." This module answers
// that in two layers:
//
//   evaluateStaticGates(rancher)  — pure field checks, unit-tested. Mirrors
//     the readiness semantics already enforced by the go-live rails
//     (app/api/rancher/activate/route.ts ~225-271): both models need a Slug
//     and at least one share-size price; legacy additionally needs at least
//     one Payment Link (its only buyer purchase path); tier_v2 additionally
//     needs a Stripe Connect Account Id. Deliberately NOT stricter than the
//     existing rails (e.g. no matched price↔link pairing) — the smoke test
//     verifies the established rules, it does not invent new ones.
//
//   runPaymentPathSmoke(rancher)  — static gates + for tier_v2 a LIVE Stripe
//     probe (getConnectAccountStatus) asserting the Connect account is
//     'active' with card payments capable. The Airtable 'Stripe Connect
//     Status' field is a cached mirror; the probe catches the cached-active/
//     actually-restricted drift (bank removed, KYC re-triggered) that
//     silently loses sales. Legacy ranchers get static checks only — probing
//     third-party Payment Link URLs is a false-positive machine (bot walls,
//     transient 5xx), so their link liveness is deliberately not probed.
//
// Used by: the human go-live doors (rancher activate, admin go-live, admin
// Mark-Live PATCH, Telegram spgolive) as a BLOCK, and the nightly-rancher-audit as a per-
// Active-rancher canary (1d). The stripe-connect webhook auto-go-live door
// is intentionally untouched — Connect-active IS its trigger.
//
// evaluateStaticGates is pure/import-free so the colocated test never drags
// in the Stripe client or the secrets chain; the live probe is dynamically
// imported inside runPaymentPathSmoke for the same reason.

export interface SmokeGateResult {
  gate: string;
  ok: boolean;
  detail: string;
}

const CUT_TIERS = ['Quarter', 'Half', 'Whole'] as const;

function str(v: unknown): string {
  return String(v ?? '').trim();
}

/** Pricing model with the platform default: unset ⇒ legacy (matches the
 *  activate route and lib/rancherEligibility — only an explicit 'tier_v2'
 *  routes through Connect). */
export function smokePricingModel(rancher: any): 'tier_v2' | 'legacy' {
  return str(rancher?.['Pricing Model']).toLowerCase() === 'tier_v2' ? 'tier_v2' : 'legacy';
}

/**
 * Pure, testable field gates. Every gate is returned (pass AND fail) so
 * callers can render a full readiness picture; filter on !ok for failures.
 */
export function evaluateStaticGates(rancher: any): SmokeGateResult[] {
  const r = rancher || {};
  const model = smokePricingModel(r);
  const gates: SmokeGateResult[] = [];

  // Slug — both models: without it there is no public page/pay URL.
  const slug = str(r['Slug']);
  gates.push({
    gate: 'slug',
    ok: !!slug,
    detail: slug ? `Slug=${slug}` : 'Slug is empty — no public page URL',
  });

  // Price — both models: at least one share size priced. Truthiness match to
  // the activate route's hasPrice (0/empty/unset all fail).
  const pricedTiers = CUT_TIERS.filter((t) => !!r[`${t} Price`]);
  gates.push({
    gate: 'price',
    ok: pricedTiers.length > 0,
    detail: pricedTiers.length > 0
      ? `priced: ${pricedTiers.join('/')}`
      : 'no Quarter/Half/Whole Price set — buyers see nothing to buy',
  });

  if (model === 'tier_v2') {
    // tier_v2 — deposits ride the platform Connect rails; the account id is
    // the anchor for every charge.
    const acct = str(r['Stripe Connect Account Id']);
    gates.push({
      gate: 'connect-account',
      ok: !!acct,
      detail: acct
        ? `Stripe Connect Account Id=${acct}`
        : 'tier_v2 but Stripe Connect Account Id is empty — cannot take a deposit',
    });
  } else {
    // Legacy — Payment Links are the ONLY buyer purchase path (the deposit
    // endpoint 409s legacy ranchers). At least one link, per the go-live rails.
    const linkedTiers = CUT_TIERS.filter((t) => !!str(r[`${t} Payment Link`]));
    gates.push({
      gate: 'payment-link',
      ok: linkedTiers.length > 0,
      detail: linkedTiers.length > 0
        ? `payment links: ${linkedTiers.join('/')}`
        : 'legacy model with no Quarter/Half/Whole Payment Link — buyers cannot pay',
    });
  }

  return gates;
}

/**
 * Full smoke: static gates + (tier_v2 only) a live Stripe Connect probe.
 * NEVER throws — a Stripe API error surfaces as a failure string marked
 * transient so callers can decide whether to retry or force.
 */
export async function runPaymentPathSmoke(
  rancher: any,
): Promise<{ ok: boolean; failures: string[]; warnings: string[] }> {
  const failures = evaluateStaticGates(rancher)
    .filter((g) => !g.ok)
    .map((g) => `${g.gate}: ${g.detail}`);

  const model = smokePricingModel(rancher);
  const acct = str(rancher?.['Stripe Connect Account Id']);
  if (model === 'tier_v2' && acct) {
    try {
      // Dynamic import: keeps the Stripe client + secrets chain out of the
      // static graph so evaluateStaticGates stays unit-testable.
      const { getConnectAccountStatus } = await import('@/lib/stripeConnect');
      const live = await getConnectAccountStatus(acct);
      if (live.status !== 'active' || !live.cardPaymentsActive) {
        failures.push(
          `connect-probe: live Stripe status=${live.status} cardPaymentsActive=${live.cardPaymentsActive}` +
            (live.currentlyDueCount > 0 ? ` currentlyDue=${live.currentlyDueCount}` : '') +
            ' — Connect account cannot take charges right now',
        );
      }
    } catch (e: any) {
      failures.push(
        `connect-probe-failed (transient?): ${String(e?.message || e).slice(0, 120)}`,
      );
    }
  }

  // Fulfillment connector (2026-07-21, PR-D; downgraded to WARNING by the
  // GTM audit): a dead store token matters — but STORE health must never
  // block BEEF go-live, and a transient Shopify 429 must never strand a
  // rancher. Store problems surface as warnings (operator ping + canary
  // warn), not go-live failures.
  const warnings: string[] = [];
  try {
    const { parseIntegration, getConnector } = await import('@/lib/fulfillmentConnector');
    const integration = parseIntegration(rancher?.['Fulfillment Integration']);
    if (integration) {
      const valid = await getConnector(integration.provider).validateConfig(integration);
      if (!valid.ok) warnings.push(`shopify-auth: ${valid.detail}`);
    }
  } catch (e: any) {
    warnings.push(`shopify-auth-probe-failed (transient?): ${String(e?.message || e).slice(0, 120)}`);
  }

  return { ok: failures.length === 0, failures, warnings };
}
