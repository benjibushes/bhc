// lib/stateAdjacency.ts
//
// US state adjacency for food-miles-aware routing (founder directive
// 2026-07-08: buyers route to ranchers actually AROUND their operation).
//
// Two consumers:
//   1. matching/suggest sort — among ranchers reaching a buyer via Routing
//      States, the geographically closer home state wins (1 hop beats 3).
//   2. Routing-config guard — a Routing State further than
//      ROUTING_MAX_HOPS (default 2) from the rancher's home state is flagged
//      (warn) or dropped (strict) so a fat-fingered "CA" on a Vermont ranch
//      can never quietly ship beef across the country.
//
// Pure data + BFS. Land borders of the 48 contiguous states + DC; AK/HI are
// islands (no neighbors — they only ever match their own state).

export const STATE_NEIGHBORS: Record<string, string[]> = {
  AL: ['FL', 'GA', 'MS', 'TN'],
  AK: [],
  AZ: ['CA', 'CO', 'NM', 'NV', 'UT'],
  AR: ['LA', 'MO', 'MS', 'OK', 'TN', 'TX'],
  CA: ['AZ', 'NV', 'OR'],
  CO: ['AZ', 'KS', 'NE', 'NM', 'OK', 'UT', 'WY'],
  CT: ['MA', 'NY', 'RI'],
  DC: ['MD', 'VA'],
  DE: ['MD', 'NJ', 'PA'],
  FL: ['AL', 'GA'],
  GA: ['AL', 'FL', 'NC', 'SC', 'TN'],
  HI: [],
  IA: ['IL', 'MN', 'MO', 'NE', 'SD', 'WI'],
  ID: ['MT', 'NV', 'OR', 'UT', 'WA', 'WY'],
  IL: ['IA', 'IN', 'KY', 'MO', 'WI'],
  IN: ['IL', 'KY', 'MI', 'OH'],
  KS: ['CO', 'MO', 'NE', 'OK'],
  KY: ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV'],
  LA: ['AR', 'MS', 'TX'],
  MA: ['CT', 'NH', 'NY', 'RI', 'VT'],
  MD: ['DC', 'DE', 'PA', 'VA', 'WV'],
  ME: ['NH'],
  MI: ['IN', 'OH', 'WI'],
  MN: ['IA', 'ND', 'SD', 'WI'],
  MO: ['AR', 'IA', 'IL', 'KS', 'KY', 'NE', 'OK', 'TN'],
  MS: ['AL', 'AR', 'LA', 'TN'],
  MT: ['ID', 'ND', 'SD', 'WY'],
  NC: ['GA', 'SC', 'TN', 'VA'],
  ND: ['MN', 'MT', 'SD'],
  NE: ['CO', 'IA', 'KS', 'MO', 'SD', 'WY'],
  NH: ['MA', 'ME', 'VT'],
  NJ: ['DE', 'NY', 'PA'],
  NM: ['AZ', 'CO', 'OK', 'TX', 'UT'],
  NV: ['AZ', 'CA', 'ID', 'OR', 'UT'],
  NY: ['CT', 'MA', 'NJ', 'PA', 'VT'],
  OH: ['IN', 'KY', 'MI', 'PA', 'WV'],
  OK: ['AR', 'CO', 'KS', 'MO', 'NM', 'TX'],
  OR: ['CA', 'ID', 'NV', 'WA'],
  PA: ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV'],
  RI: ['CT', 'MA'],
  SC: ['GA', 'NC'],
  SD: ['IA', 'MN', 'MT', 'ND', 'NE', 'WY'],
  TN: ['AL', 'AR', 'GA', 'KY', 'MO', 'MS', 'NC', 'VA'],
  TX: ['AR', 'LA', 'NM', 'OK'],
  UT: ['AZ', 'CO', 'ID', 'NM', 'NV', 'WY'],
  VA: ['DC', 'KY', 'MD', 'NC', 'TN', 'WV'],
  VT: ['MA', 'NH', 'NY'],
  WA: ['ID', 'OR'],
  WI: ['IA', 'IL', 'MI', 'MN'],
  WV: ['KY', 'MD', 'OH', 'PA', 'VA'],
  WY: ['CO', 'ID', 'MT', 'NE', 'SD', 'UT'],
};

/**
 * BFS hop distance between two states. 0 = same state, 1 = bordering,
 * Infinity = unknown code, island (AK/HI), or beyond maxHops.
 */
export function hopDistance(from: string, to: string, maxHops = 6): number {
  const a = String(from || '').toUpperCase();
  const b = String(to || '').toUpperCase();
  if (!STATE_NEIGHBORS[a] || !STATE_NEIGHBORS[b]) return Infinity;
  if (a === b) return 0;
  let frontier = [a];
  const seen = new Set(frontier);
  for (let hops = 1; hops <= maxHops; hops++) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const n of STATE_NEIGHBORS[s]) {
        if (seen.has(n)) continue;
        if (n === b) return hops;
        seen.add(n);
        next.push(n);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return Infinity;
}

/** Routing States further than maxHops from home — the food-miles guard. */
export function adjacencyViolations(
  home: string,
  routingStates: string[],
  maxHops = 2,
): { state: string; hops: number }[] {
  const out: { state: string; hops: number }[] = [];
  for (const s of routingStates) {
    const st = String(s || '').toUpperCase();
    if (!st || st === String(home || '').toUpperCase()) continue;
    const hops = hopDistance(home, st);
    if (hops > maxHops) out.push({ state: st, hops: hops === Infinity ? -1 : hops });
  }
  return out;
}
