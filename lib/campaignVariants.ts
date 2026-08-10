// Repo-versioned subject variants + the deterministic 50/50 split for the
// campaign rail — PR 1 of docs/ADAPTIVE-MARKETING-DESIGN.md (measurement
// substrate). INSTRUMENTATION ONLY: no epsilon, no commit rule, no explore
// loop. The split exists so the (future, gated) learning report can join a
// send's `Variant` stamp on Email Sends to its outcome; at current volume the
// prespecified test is expected to read "inconclusive" and that is fine.
//
// SAFETY SHAPE (design doc §2):
//   • Every string here is REPO-VERSIONED, Ben-reviewable copy. No runtime
//     generated prose is ever sent — a new variant lands via PR, never via
//     code that writes copy.
//   • Kill switch ADAPTIVE_VARIANTS_ENABLED is tri-state and FAILS TO OFF:
//     only the exact string 'true' sends variant B; 'dry-run' computes and
//     reports the split without changing what is sent; anything else (unset,
//     'false', typos) is off.
//   • The split is a pure hash of (consumerId, templateName) — deterministic,
//     so a re-send to the same buyer can never flip arms, and per-template,
//     so each template's wave is its own experiment.
//
// COPY RULES (same as lib/requalifyCampaign): no hyphens in outbound prose
// (Ben), money model stays true — never "deduct" / "keep 90%" framing.

export type CampaignVariant = 'A' | 'B';

export type VariantMode = 'off' | 'shadow' | 'live';

/**
 * Resolve the tri-state kill switch. Fail-to-off: ONLY the exact string
 * 'true' goes live, ONLY 'dry-run' goes shadow (split computed + surfaced in
 * the route response, variant A still sent to everyone). Everything else —
 * unset, 'false', casing typos — is off.
 */
export function variantMode(
  raw: string | undefined = process.env.ADAPTIVE_VARIANTS_ENABLED,
): VariantMode {
  if (raw === 'true') return 'live';
  if (raw === 'dry-run') return 'shadow';
  return 'off';
}

/**
 * Deterministic 50/50 arm assignment over `consumerId:templateName` (the
 * design doc's `hash(consumerId+templateName) % 2`). Pure — same inputs
 * always land the same arm, different templates re-randomize.
 *
 * FNV-1a alone is NOT enough here: its low bit is linear in the input (odd
 * multiplier ⇒ bit 0 of the hash equals the XOR of bit 0 of every byte), so
 * `fnv % 2` splits by character parity, and two template names with the same
 * parity would give every buyer the same arm in both experiments. The
 * murmur3-style finalizer avalanches all 32 bits into bit 0 (caught by the
 * re-randomization test).
 */
export function campaignVariantIndex(consumerId: string, templateName: string): 0 | 1 {
  const s = `${consumerId}:${templateName}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // fmix32 (murmur3 finalizer) — full avalanche before taking one bit.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return ((h >>> 0) % 2) as 0 | 1;
}

/** Letter form of the arm — the exact value stamped to Email Sends `Variant`. */
export function campaignVariant(consumerId: string, templateName: string): CampaignVariant {
  return campaignVariantIndex(consumerId, templateName) === 0 ? 'A' : 'B';
}

/**
 * The requalify campaign's subject pair. Variant A is the ORIGINAL subject,
 * byte-identical to what lib/requalifyCampaign has always sent — the default
 * path (kill switch off, no consumer identity) must be indistinguishable from
 * pre-PR behavior. Variant B makes the same claim in different words; both
 * follow the copy rules above.
 */
export function requalifySubject(name: string, variant: CampaignVariant = 'A'): string {
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  if (variant === 'B') return `${first}, a ranch near you just opened up`;
  return `${first}, there's a ranch for you now`;
}
