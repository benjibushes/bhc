// lib/prospectOutreach.ts
//
// COLD RANCHER OUTREACH — the natural-voice engine (2026-07-08).
//
// The prospector agents enrich 500+ Rancher Prospects rows with real signals
// (demand tells, family history, finish type, fit score) but their
// First-Touch Drafts all shared ONE skeleton with the name swapped — the
// exact "sounds like AI" smell. This module replaces that with per-prospect
// drafting grounded in the prospect's OWN facts + the live buyer count for
// their state, run through a hard ban-list of AI-tells and template phrases.
//
// PIPELINE (both crons DARK behind PROSPECT_OUTREACH_ENABLED):
//   draft cron  → picks prospects (pure selector below) → drafts via
//                 callClaude → writes First-Touch Draft + Outreach Subject +
//                 Outreach Status='Draft Ready' → Telegram digest to Ben.
//   Ben         → reviews on the prospects dashboard / Airtable, edits
//                 freely, flips rows to 'Approved' (or 'Passed').
//   send cron   → sends ONLY 'Approved', inside the send window, capped per
//                 day, claim-before-send, suppresses anyone who already
//                 applied as a rancher. One touch — no automated follow-ups
//                 until the loop earns trust.
//
// NOTHING in this file sends email. Sending lives in the send cron, behind
// the env + the Approved gate + Ben's per-row click. Two humans gates deep.

import { callClaude } from '@/lib/ai';

// ── Selection ───────────────────────────────────────────────────────────────

export interface ProspectRow {
  id: string;
  ranchName: string;
  operatorName: string;
  state: string;
  city: string;
  email: string;
  fitScore: number;
  fitReasons: string;
  disqualifiers: string;
  sizeSignal: string;
  beefType: string;
  status: string; // prospecting Status field ('new' | 'reviewed' | ...)
  outreachStatus: string; // '' | Draft Ready | Approved | Sent | ...
}

export function toProspectRow(r: any): ProspectRow {
  const sel = (v: any) => (v && typeof v === 'object' ? v.name : v) || '';
  return {
    id: String(r.id),
    ranchName: String(r['Ranch Name'] || '').trim(),
    operatorName: String(r['Operator Name'] || '').trim(),
    state: String(r['State'] || '').trim().toUpperCase(),
    city: String(r['City'] || '').trim(),
    email: String(r['Email'] || '').trim().toLowerCase(),
    fitScore: Number(r['Fit Score'] || 0),
    fitReasons: String(r['Fit Reasons'] || ''),
    disqualifiers: String(r['Disqualifiers'] || ''),
    sizeSignal: String(r['Size Signal'] || ''),
    beefType: String(r['Beef Type'] || ''),
    status: String(sel(r['Status'])),
    outreachStatus: String(sel(r['Outreach Status'])),
  };
}

/**
 * Pure selector: who gets a draft today.
 *   - has an email (phone-only prospects are Ben's call list, not this rail)
 *   - fit score >= minScore (default 60 — the enricher's "good fit" band)
 *   - prospecting Status 'new' or 'reviewed' (never contacted/rejected lanes)
 *   - no Outreach Status yet (never re-draft; never touch Sent/Suppressed)
 *   - hard ANTI-FIT skip when the enricher wrote it in Disqualifiers
 * Ranked: state buyer-demand first (that's the pitch), fit score second.
 */
export function pickProspectsForDraft(
  rows: ProspectRow[],
  waitingByState: Record<string, number>,
  cap: number,
  minScore = 60,
): ProspectRow[] {
  return rows
    .filter(
      (p) =>
        p.email.includes('@') &&
        p.fitScore >= minScore &&
        (p.status === 'new' || p.status === 'reviewed') &&
        p.outreachStatus === '' &&
        !/ANTI-FIT/i.test(p.disqualifiers),
    )
    .sort((a, b) => {
      const da = waitingByState[a.state] || 0;
      const db = waitingByState[b.state] || 0;
      if (db !== da) return db - da;
      return b.fitScore - a.fitScore;
    })
    .slice(0, Math.max(0, cap));
}

// ── Voice engine ────────────────────────────────────────────────────────────

// Phrases that instantly read as templated/AI — a draft containing ANY of
// these is rejected and re-drafted once, then skipped. Includes the exact
// skeleton the old prospector drafts overused.
export const BANNED_PHRASES = [
  'i hope this finds you well',
  'i hope this email finds you',
  'just reaching out',
  'i wanted to reach out',
  'quick question for you',
  'exactly the kind of direct operation',
  'the hard part is keeping the buyers coming',
  "that's our piece",
  'i came across your',
  'i stumbled upon',
  'in today’s market',
  'in today\'s market',
  'game-changer',
  'game changer',
  'revolutioniz',
  'seamless',
  'leverage',
  'synergy',
  'unlock',
  'elevate',
  'i’d love to hop on a call',
  'touch base',
  'circle back',
  'no pressure, but',
  'as a fellow',
];

export function violatesVoice(draft: string): string | null {
  const d = draft.toLowerCase();
  for (const p of BANNED_PHRASES) if (d.includes(p)) return p;
  const words = draft.trim().split(/\s+/).length;
  if (words > 110) return `too long (${words} words)`;
  if (words < 35) return `too short (${words} words)`;
  if ((draft.match(/!/g) || []).length > 1) return 'exclamation overload';
  if (/\bAI\b|\bautomated\b|\bautomation\b/i.test(draft)) return 'mentions automation';
  return null;
}

const VOICE_SYSTEM = `You write short first-touch emails from Ben, the solo founder of BuyHalfCow — a network that routes families who want to buy beef in bulk directly to family ranches. Ben is a Montana rancher-aligned founder, not a marketer.

VOICE (non-negotiable):
- lowercase openers, plain english, short sentences. reads like a text from a busy rancher, not a pitch.
- concrete numbers over adjectives. no hype words, no "seamless/leverage/unlock/elevate", no exclamation points.
- specific to THIS ranch: reference one real detail from the facts given (their booking model, their history, their finish style, their town) in your own words — never quote their website back at them robotically.
- the pitch, in whatever words fit naturally: there are [N] families in their state on our waitlist wanting bulk beef; we route buyers, they raise and fulfill, keep their brand and customers; free to start, they only pay when something sells.
- ONE ask: a short call or a look at the signup page. never both hard-pushed.
- end with an easy out phrased like a human would: some variation of "if it's not for you, tell me no thanks and that's the last you'll hear from me."
- sign exactly: — Ben
- 45-95 words for the body. no greeting-name errors: address the operator by first name if known, else the ranch name, else no name.

STRUCTURAL VARIANCE (critical — no two emails may share a skeleton):
Use the opening style you're assigned in the user message. Never re-use the phrase "exactly the kind of direct operation" or "the hard part is keeping the buyers coming".

OUTPUT FORMAT — exactly this, nothing else:
SUBJECT: <lowercase, specific, 4-8 words, no clickbait>
BODY:
<the email body, plain text, no links except buyhalfcow.com/sell if natural>`;

const OPENING_STYLES = [
  'open with the buyer number for their state, stated flat',
  'open with the one specific detail about their ranch, then why you’re writing',
  'open with a direct question about their sell-out/booking situation',
  'open with what you do in one blunt sentence, then their detail',
  'open with their town/state and the demand sitting in it',
];

export interface DraftInput {
  prospect: ProspectRow;
  waitingInState: number;
  /** deterministic seed for variance (record id works) */
  seed: string;
}

export interface DraftResult {
  subject: string;
  body: string;
}

export function parseDraftOutput(raw: string): DraftResult | null {
  const m = raw.match(/SUBJECT:\s*(.+)\s*\nBODY:\s*\n?([\s\S]+)/);
  if (!m) return null;
  const subject = m[1].trim().replace(/^["']|["']$/g, '');
  const body = m[2].trim();
  if (!subject || !body) return null;
  return { subject, body };
}

function openingStyleFor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return OPENING_STYLES[h % OPENING_STYLES.length];
}

/**
 * Draft one email. Tries twice: if the first attempt trips the voice
 * validator, redraft with the violation named. Returns null when both
 * attempts fail — the caller skips the prospect (never ship a bad draft).
 */
export async function draftOutreach(input: DraftInput): Promise<DraftResult | null> {
  const p = input.prospect;
  const firstName = p.operatorName.split(/\s+/)[0] || '';
  const facts = [
    `Ranch: ${p.ranchName} (${p.city ? p.city + ', ' : ''}${p.state})`,
    firstName ? `Operator first name: ${firstName}` : 'Operator name unknown',
    p.beefType ? `Their beef: ${p.beefType}` : null,
    p.sizeSignal ? `Operation signal: ${p.sizeSignal}` : null,
    p.fitReasons ? `Why they fit (internal notes, do NOT quote verbatim): ${p.fitReasons.slice(0, 500)}` : null,
    `Families on our waitlist in ${p.state}: ${input.waitingInState}`,
    `Opening style for THIS email: ${openingStyleFor(input.seed)}`,
  ]
    .filter(Boolean)
    .join('\n');

  let lastViolation = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = await callClaude({
        system: VOICE_SYSTEM,
        user:
          attempt === 0
            ? facts
            : `${facts}\n\nYour previous draft was rejected: ${lastViolation}. Write a fresh one avoiding that.`,
        maxTokens: 400,
      });
    } catch {
      return null; // AI unavailable — skip silently, cron reports the count
    }
    const parsed = parseDraftOutput(raw);
    if (!parsed) continue;
    const violation = violatesVoice(parsed.body);
    if (!violation) return parsed;
    lastViolation = violation;
  }
  return null;
}
