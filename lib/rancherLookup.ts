// Shared rancher-by-email resolver.
//
// Extracted verbatim from /api/auth/rancher/password-login (2026-07-14, wave B)
// so the public setup-link re-mint endpoint resolves the SAME canonical row a
// password login or magic link would — one matching algorithm, no drift.

import { getAllRecords, TABLES } from '@/lib/airtable';

/**
 * Resolve a Rancher record by email — direct {Email} match first, then
 * {Team Emails}. Both branches collect ALL matches and pick the
 * most-recently-active one (latest of Last Assigned At / Agreement Signed At /
 * Docs Sent At / _createdTime), exactly like /api/auth/rancher/login so every
 * email-based auth path lands on the same canonical row.
 *
 * `normalizedEmail` must already be trimmed + lowercased (callers normalize
 * with `.trim().toLowerCase()` — password-login also strips inner whitespace).
 */
export async function findRancherByEmail(normalizedEmail: string): Promise<any | null> {
  const all = await getAllRecords(TABLES.RANCHERS) as any[];
  const splitRe = /[\s,;\n]+/;
  const recencyMs = (r: any): number => {
    const candidates = [
      r['Last Assigned At'],
      r['Agreement Signed At'],
      r['Docs Sent At'],
      r._createdTime,
    ].map((d) => (d ? new Date(d).getTime() : 0));
    return Math.max(...candidates, 0);
  };

  const emailMatches = all.filter((r) => {
    const stored = String(r['Email'] || '').trim().toLowerCase().replace(/\s+/g, '');
    return stored && stored === normalizedEmail;
  });
  if (emailMatches.length === 1) return emailMatches[0];
  if (emailMatches.length > 1) {
    emailMatches.sort((a, b) => recencyMs(b) - recencyMs(a));
    return emailMatches[0];
  }

  const teamMatches: any[] = [];
  for (const r of all) {
    const teamRaw = String(r['Team Emails'] || '').toLowerCase();
    if (!teamRaw) continue;
    const list = teamRaw.split(splitRe).map((s) => s.trim()).filter(Boolean);
    if (list.includes(normalizedEmail)) teamMatches.push(r);
  }
  if (teamMatches.length === 1) return teamMatches[0];
  if (teamMatches.length > 1) {
    teamMatches.sort((a, b) => recencyMs(b) - recencyMs(a));
    return teamMatches[0];
  }

  return null;
}
