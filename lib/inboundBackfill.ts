// Backfill engine for the 50+ blind inbound Conversations rows.
//
// CONTEXT (2026-08-03): every real email reply captured by the resend-inbound
// webhook before the content-fetch fix landed as an envelope-only row —
// From/Subject/Timestamp present, Body + Body Plain empty, Raw Headers '{}',
// Message Id never written. There is therefore NO stored Resend id to fetch
// content by. Recovery instead walks Resend's received-emails listing
// (GET /emails/receiving) and matches each blind row by bare From address +
// timestamp proximity (subject as tiebreaker), then pulls the full content by
// the listing id and re-runs the CLASSIFIER ONLY.
//
// HARD BOUNDARIES (pinned by lib/inboundBackfill.test.ts):
//   - NO autoresponse, NO staged-reply sending, NO per-row Telegram. This
//     module must never import or call any send path. The admin route fires
//     ONE summary operator signal at the end of a run.
//   - Idempotent: rows with a non-empty Body Plain are never touched — that
//     includes rows already stamped with a marker.
//   - Capped per invocation (default 50) + paced between Resend fetches
//     (default 500ms) so a run can't hammer Resend or blow the lambda budget.
//     Re-run until drained.
//   - Rows whose content Resend no longer retains (no listing match, or the
//     per-id fetch 404s) get CONTENT_UNRECOVERABLE_MARKER so they stop
//     looking pending. Transient fetch errors leave the row untouched for
//     the next run.
//
// Airtable field names (verified against the live Conversations schema —
// never guess): Timestamp, Direction, From, Subject, Body, Body Plain,
// Raw Headers, Message Id, Sender Type, Objection Category, Sentiment,
// Action Needed, AI Summary.

import {
  CONTENT_UNRECOVERABLE_MARKER,
  htmlToPlain,
  type FetchContentResult,
  type ListReceivedResult,
  type ReceivedEmailListItem,
} from '@/lib/inboundContent';
import { bareEmail } from '@/lib/inboundIdentity';
import type { Classification } from '@/lib/inboundClassify';

export const BACKFILL_CAP_DEFAULT = 50;
export const BACKFILL_PACE_MS_DEFAULT = 500;
/** From/created_at match window: the blind row Timestamp is the webhook's
 *  processing time, always within moments of Resend's created_at. */
export const BACKFILL_MATCH_WINDOW_MS = 15 * 60 * 1000;

export interface ConversationRowLike {
  id: string;
  [field: string]: any;
}

/** Tolerant timestamp parse — Resend emits both ISO-T and space-separated forms. */
export function parseTs(v: unknown): number {
  const s = String(v || '').trim();
  if (!s) return NaN;
  const t = new Date(s).getTime();
  if (Number.isFinite(t)) return t;
  return new Date(s.replace(' ', 'T')).getTime();
}

/**
 * A row qualifies for backfill ONLY when it is an inbound EMAIL row with an
 * empty Body Plain. Direction is matched case-insensitively ('inbound' from
 * the email webhook, 'Inbound' from ManyChat). IG DM rows (From "ig:…") have
 * no Resend counterpart and are excluded. Any non-empty Body Plain —
 * including a previously stamped marker — makes the row untouchable.
 */
export function isBackfillCandidate(row: ConversationRowLike): boolean {
  if (!row?.id) return false;
  if (String(row['Direction'] || '').toLowerCase() !== 'inbound') return false;
  if (String(row['Body Plain'] || '').trim() !== '') return false;
  const from = String(row['From'] || '');
  if (from.startsWith('ig:')) return false;
  if (!from.includes('@')) return false;
  return true;
}

export function selectBackfillRows(
  rows: ConversationRowLike[],
  cap: number = BACKFILL_CAP_DEFAULT,
): ConversationRowLike[] {
  return rows.filter(isBackfillCandidate).slice(0, Math.max(0, cap));
}

/**
 * Match a blind row to a received email in Resend's listing:
 *   1. bare From address must be identical;
 *   2. created_at within ±window of the row Timestamp;
 *   3. among survivors, exact (trimmed, case-insensitive) subject match is
 *      preferred; final tiebreak = nearest in time.
 * Returns null when nothing plausibly matches (→ unrecoverable).
 */
export function matchReceivedEmail(
  row: ConversationRowLike,
  items: ReceivedEmailListItem[],
  windowMs: number = BACKFILL_MATCH_WINDOW_MS,
): ReceivedEmailListItem | null {
  const rowFrom = bareEmail(row['From']);
  if (!rowFrom) return null;
  const rowTs = parseTs(row['Timestamp']);
  const rowSubject = String(row['Subject'] || '').trim().toLowerCase();

  const candidates = items
    .filter((it) => bareEmail(it.from) === rowFrom)
    .map((it) => ({ it, dt: Math.abs(parseTs(it.createdAt) - rowTs) }))
    .filter((c) => Number.isFinite(c.dt) && c.dt <= windowMs);
  if (candidates.length === 0) return null;

  const subjectMatches = candidates.filter(
    (c) => String(c.it.subject || '').trim().toLowerCase() === rowSubject,
  );
  const pool = subjectMatches.length > 0 ? subjectMatches : candidates;
  pool.sort((a, b) => a.dt - b.dt);
  return pool[0].it;
}

export interface BackfillDeps {
  /** All Conversations rows that MIGHT qualify (route pre-filters via formula). */
  listRows: () => Promise<ConversationRowLike[]>;
  listReceived: () => Promise<ListReceivedResult>;
  fetchContent: (emailId: string) => Promise<FetchContentResult>;
  classify: (opts: { from: string; subject: string; body: string; context: null }) => Promise<Classification>;
  updateRow: (rowId: string, fields: Record<string, unknown>) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  cap?: number;
  paceMs?: number;
  dryRun?: boolean;
}

export interface BackfillSummary {
  ok: boolean;
  error?: string;
  scanned: number;
  selected: number;
  recovered: number;
  unrecoverable: number;
  skippedTransient: number;
  remaining: number;
  dryRun: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runInboundBackfill(deps: BackfillDeps): Promise<BackfillSummary> {
  const cap = deps.cap ?? BACKFILL_CAP_DEFAULT;
  const paceMs = deps.paceMs ?? BACKFILL_PACE_MS_DEFAULT;
  const sleep = deps.sleep ?? defaultSleep;
  const dryRun = !!deps.dryRun;

  const base: BackfillSummary = {
    ok: true,
    scanned: 0,
    selected: 0,
    recovered: 0,
    unrecoverable: 0,
    skippedTransient: 0,
    remaining: 0,
    dryRun,
  };

  const rows = await deps.listRows();
  base.scanned = rows.length;
  const candidates = rows.filter(isBackfillCandidate);
  const batch = candidates.slice(0, Math.max(0, cap));
  base.selected = batch.length;
  base.remaining = candidates.length - batch.length;
  if (batch.length === 0) return base;

  // One listing walk per run — if Resend's listing itself is unreachable we
  // abort WITHOUT stamping anything: we can't tell "unretained" from "API
  // down", and a wrong unrecoverable stamp would permanently hide a
  // recoverable reply.
  const listing = await deps.listReceived();
  if (!listing.ok) {
    return { ...base, ok: false, error: `received-emails listing failed: ${listing.error}` };
  }

  let first = true;
  for (const row of batch) {
    if (!first) await sleep(paceMs); // pace ALL Resend traffic, including per-id fetches
    first = false;

    const match = matchReceivedEmail(row, listing.items);
    if (!match) {
      base.unrecoverable++;
      if (!dryRun) {
        await deps.updateRow(row.id, { 'Body Plain': CONTENT_UNRECOVERABLE_MARKER });
      }
      continue;
    }

    const fetched = await deps.fetchContent(match.id);
    if (!fetched.ok) {
      if (fetched.status === 404 || fetched.status === 410) {
        // Resend no longer retains this email's content — stop it looking pending.
        base.unrecoverable++;
        if (!dryRun) {
          await deps.updateRow(row.id, { 'Body Plain': CONTENT_UNRECOVERABLE_MARKER });
        }
      } else {
        // Transient (timeout / 5xx / network) — leave untouched for the next run.
        base.skippedTransient++;
      }
      continue;
    }

    const { text, html, headers, messageId } = fetched.content;
    const bodyPlain = (text || htmlToPlain(html)).trim();
    if (!bodyPlain) {
      // Stored email exists but has no readable body — mark so it stops
      // looking pending rather than re-fetching forever.
      base.unrecoverable++;
      if (!dryRun) {
        await deps.updateRow(row.id, { 'Body Plain': CONTENT_UNRECOVERABLE_MARKER });
      }
      continue;
    }

    base.recovered++;
    if (!dryRun) {
      // CLASSIFIER ONLY — no sends, no Telegram, no staged replies.
      // (dry-run skips classification too: no writes → no reason to spend
      // an AI call per row just to throw the result away.)
      const classification = await deps.classify({
        from: String(row['From'] || ''),
        subject: String(row['Subject'] || ''),
        body: bodyPlain,
        context: null,
      });
      await deps.updateRow(row.id, {
        'Body': html || text,
        'Body Plain': bodyPlain,
        'Raw Headers': JSON.stringify(headers || {}),
        'Message Id': messageId || match.messageId || '',
        'Sender Type': classification.senderType,
        'Objection Category': classification.objectionCategory,
        'Sentiment': classification.sentiment,
        'Action Needed': classification.actionNeeded,
        'AI Summary': classification.summary,
      });
    }
  }

  return base;
}
