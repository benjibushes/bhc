// Client-side preview of the qualification score. MUST mirror scoreAnswers() in
// app/api/qualify/route.ts exactly — the server is the source of truth; this is
// only for in-flow UI (progress feel). `completed` stands in for the server's
// `ack` (reaching the final step IS the commitment).

export interface FunnelAnswers {
  tier: string;
  timing: string;
  storage: string;
  completed: boolean;
}

const VALID_TIERS = ['Quarter', 'Half', 'Whole'];
const VALID_STORAGE = ['have_freezer', 'need_freezer', 'rancher_holds', 'cuts_only'];

export function scoreFunnel(a: FunnelAnswers): number {
  let s = 0;
  if (a.tier === 'Not Sure') s += 5;
  else if (VALID_TIERS.includes(a.tier)) s += 25;

  if (a.timing === 'ASAP' || a.timing === 'Within 30 days') s += 25;
  else if (a.timing === 'Within 60 days') s += 15;
  else if (a.timing === 'Within 90 days') s += 10;

  if (VALID_STORAGE.includes(a.storage)) s += 25;
  if (a.completed) s += 25;
  return s;
}

export const FUNNEL_PASS_THRESHOLD = 75;
