// Shared rancher-by-email resolver.
//
// Extracted verbatim from /api/auth/rancher/password-login (2026-07-14, wave B)
// so the public setup-link re-mint endpoint resolves the SAME canonical row a
// password login or magic link would — one matching algorithm, no drift.

import { getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';

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

  // P4a read-after-write (2026-07-23): the scan above reads the CACHED unfiltered
  // rancher list (getAllRecords L1/L2, ≤30s stale), so a rancher created seconds
  // ago — a fresh /apply or /self-submit — is invisible here and the setup-link
  // re-mint looks un-sent (the resend-link-missed-fresh-record bug). On a full
  // miss do ONE filtered LIVE read (a filterByFormula bypasses the cache) before
  // giving up, so a just-created row is found within seconds. Best-effort: a read
  // failure degrades to the original null.
  if (normalizedEmail) {
    try {
      const fresh = (await getAllRecords(
        TABLES.RANCHERS,
        `LOWER(TRIM({Email})) = "${escapeAirtableValue(normalizedEmail)}"`,
      )) as any[];
      if (fresh.length === 1) return fresh[0];
      if (fresh.length > 1) {
        fresh.sort((a, b) => recencyMs(b) - recencyMs(a));
        return fresh[0];
      }
    } catch (e) {
      console.error('[findRancherByEmail] fresh live-read fallback failed:', e);
    }
  }

  return null;
}
