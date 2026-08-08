// lib/ranchStandDigest.ts
//
// THE RANCH STAND DIGEST (P3′, MARKETING-REVAMP-2026-08 §5 Convergence).
//
// The monthly merchandising email for every marketing-lane consumer — the
// first send in the program that markets what the recipient can actually BUY
// (principle 1). Lane 2 (national) finally gets product mail instead of share
// pressure; Lane 1 + Lane 3 get the same digest (plan §3: customers 'get
// digest').
//
// Everything here is PURE (node:test, zero Airtable/network deps — the
// routingSegment/demandRouter pattern). The cron at
// app/api/cron/ranch-stand-digest/route.ts does all I/O and hands rows here.
//
// DESIGN RULES (panel-amended spec):
//   • v1 layout = exactly TWO blocks: 'ships to you' (nationwide items) +
//     'in your state' (only when the recipient's state has share coverage).
//   • skip-if-thin applies ONLY to the new-products section (<3 new). The
//     digest ALWAYS has content: current-shelf highlights + latest-close
//     social proof (first name + state ONLY — never a full buyer name; the
//     repo is public and so is the inbox) + a rotating ranch story.
//   • Engagement-tiered rollout: the send month spreads over UTC days 1-4,
//     tier 1 (most recently engaged) on day 1 … tier 4 (least) on day 4 —
//     never one 2,700-send day.
//   • Deliverability gates: zero-engagement consumers created >180d ago get
//     NO digest (they belong to the P5′ re-permission flow — excluded here,
//     never re-permissioned here); 12mo+ never-engaged are excluded outright.
//   • Cadence cap: 1 digest per 25 days per recipient, owned by DB state —
//     a dated Notes marker (the AREA_OPENED_MARKER pattern; Consumers has no
//     'Digest Last Sent At' field and we do NOT add Airtable fields). The
//     generic 3/week guardedSend cap still applies on top (the template is
//     marketing, deliberately NOT whitelisted).

import { isSellableRow } from './marketplaceProducts';
import { operationTypeFor, operationTypeEmailLine } from './operationType';
import { isSyntheticTestEmail } from './demandRouter';
import { laneForSegment, type BuyerLane } from './routingSegment';
import { normalizeState, stateName } from './states';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// CONSTANTS (exported so the cron + tests share one truth)
// ─────────────────────────────────────────────────────────────────────

/** Durable per-recipient send marker appended to Consumers.Notes (dated). */
export const DIGEST_MARKER = '[RANCH-STAND-DIGEST';

/** Own cap lane: at most one digest per recipient per 25 days (the
 *  compliance-reminders dedup window — monthly cadence with retry slack). */
export const DIGEST_CADENCE_DAYS = 25;

/** Per-run send ceiling. A tier at current list size is ~500-600; 200/run
 *  keeps a single run inside Airtable pacing + Vercel maxDuration, and the
 *  Notes stamp means an over-cap tail is simply picked up next month. */
export const DIGEST_RUN_CAP = 200;

/** "Newly listed" window for the new-on-the-stand section. Digest cadence is
 *  monthly; 35 days covers month-length drift so a product listed the day
 *  after last month's send is never silently skipped. */
export const NEW_ARRIVALS_WINDOW_DAYS = 35;

/** skip-if-thin threshold — applies ONLY to the new-products section. */
export const THIN_MONTH_MIN_NEW = 3;

/** Sunset gate: zero engagement ever + older than this → no digest (P5′
 *  re-permission owns them). */
export const SUNSET_AGE_DAYS = 180;

/** Hard exclusion: zero engagement ever + older than this → suppressed
 *  outright, no re-permission either. */
export const NEVER_ENGAGED_AGE_DAYS = 365;

// ─────────────────────────────────────────────────────────────────────
// CONTENT SELECTION — products
// ─────────────────────────────────────────────────────────────────────

export interface DigestProduct {
  id: string;
  name: string;
  rancher: string;
  category: string;
  price: number;
  shelfStable: boolean;
  /** Airtable record creation time (ms) — the only listing timestamp the
   *  Rancher Products table carries ('Marketplace Approved' is a checkbox
   *  with no date; we use existing fields only). 0 when unparseable. */
  createdTimeMs: number;
}

/** Map one raw Rancher Products row → DigestProduct, or null when the row is
 *  not sellable (isSellableRow — the money-integrity gate; local-pickup rows
 *  are excluded by its `Ships Nationwide !== false` clause, so everything
 *  that reaches the digest genuinely ships). */
export function toDigestProduct(row: Record<string, unknown> & { id?: string; _createdTime?: unknown }): DigestProduct | null {
  if (!row || !isSellableRow(row)) return null;
  const sel = (v: unknown) => (v && typeof v === 'object' && 'name' in (v as any) ? (v as any).name : v) || '';
  const created = new Date(String(row._createdTime || '')).getTime();
  return {
    id: String(row.id || ''),
    name: String(row['Product Name'] || ''),
    rancher: String(row['Rancher Name'] || ''),
    category: String(sel(row['Category']) || 'Other'),
    price: Number(row['Display Price'] || 0),
    shelfStable: !!row['Shelf Stable'],
    createdTimeMs: Number.isFinite(created) ? created : 0,
  };
}

/**
 * Products newly listed inside the window, newest first, capped at 6 (email
 * length). "Newly listed" = record created inside the window — the honest
 * reading of the only timestamp the table has.
 */
export function selectNewArrivals(
  rows: Array<Record<string, unknown>>,
  nowMs: number,
  windowDays: number = NEW_ARRIVALS_WINDOW_DAYS,
  cap = 6,
): DigestProduct[] {
  const cutoff = nowMs - windowDays * DAY_MS;
  const out: DigestProduct[] = [];
  for (const row of rows || []) {
    const p = toDigestProduct(row as any);
    if (!p) continue;
    if (p.createdTimeMs <= 0 || p.createdTimeMs < cutoff) continue;
    out.push(p);
  }
  out.sort((a, b) => b.createdTimeMs - a.createdTimeMs);
  return out.slice(0, cap);
}

/** skip-if-thin — the NEW-PRODUCTS section only (never the whole digest). */
export function isThinMonth(newArrivals: readonly DigestProduct[]): boolean {
  return newArrivals.length < THIN_MONTH_MIN_NEW;
}

/**
 * The always-there fallback block: current-shelf highlights. Cheapest-first
 * with category variety (one per category before a second from any), capped.
 * Merch is excluded — food leads the stand (MARKETPLACE_GROUPS ordering
 * rule); `excludeIds` lets the renderer avoid repeating a new arrival.
 */
export function selectShelfHighlights(
  rows: Array<Record<string, unknown>>,
  opts?: { cap?: number; excludeIds?: ReadonlySet<string> },
): DigestProduct[] {
  const cap = opts?.cap ?? 4;
  const exclude = opts?.excludeIds;
  const sellable: DigestProduct[] = [];
  for (const row of rows || []) {
    const p = toDigestProduct(row as any);
    if (!p) continue;
    if (/^merch$/i.test(p.category.trim())) continue;
    if (exclude?.has(p.id)) continue;
    sellable.push(p);
  }
  sellable.sort((a, b) => a.price - b.price);
  const picks: DigestProduct[] = [];
  const seenCategories = new Set<string>();
  for (const p of sellable) {
    if (picks.length >= cap) return picks;
    if (seenCategories.has(p.category)) continue;
    seenCategories.add(p.category);
    picks.push(p);
  }
  for (const p of sellable) {
    if (picks.length >= cap) break;
    if (!picks.includes(p)) picks.push(p);
  }
  return picks;
}

// ─────────────────────────────────────────────────────────────────────
// CONTENT SELECTION — latest-close social proof
// ─────────────────────────────────────────────────────────────────────

export interface DigestLatestClose {
  /** First name ONLY — anti-pattern 5 / public-repo rule: never a full name. */
  firstName: string;
  /** 'half cow' | 'quarter cow' | 'whole cow' | lowercased raw | 'beef'. */
  orderLabel: string;
  /** Uppercased 2-letter-ish state string, '' when unknown. */
  buyerState: string;
}

function orderTypeLabel(orderType: string): string {
  const t = String(orderType || '').trim().toLowerCase();
  if (t === 'quarter' || t === 'half' || t === 'whole') return `${t} cow`;
  return t || 'beef';
}

/**
 * Newest Closed Won referral with a real sale amount → the digest's proof
 * line (the /api/stats/public latestClose shape, trimmed to first name +
 * state only). Rows are expected pre-filtered to Status='Closed Won'; the
 * Sale Amount > 0 hygiene filter (the /wins rule) applies here. null when
 * nothing qualifies — the renderer drops the line entirely (honesty rule:
 * never a fabricated win).
 */
export function latestCloseFromRefs(
  refs: Array<Record<string, unknown>>,
): DigestLatestClose | null {
  let best: Record<string, unknown> | null = null;
  let bestMs = -1;
  for (const ref of refs || []) {
    if (!(Number(ref['Sale Amount']) > 0)) continue;
    const t = new Date(String(ref['Closed At'] || '')).getTime();
    const ms = Number.isFinite(t) ? t : 0;
    if (ms > bestMs) {
      best = ref;
      bestMs = ms;
    }
  }
  if (!best) return null;
  const firstName = String(best['Buyer Name'] || '').trim().split(/\s+/)[0] || 'a buyer';
  return {
    firstName,
    orderLabel: orderTypeLabel(String(best['Order Type'] || '')),
    buyerState: String(best['Buyer State'] || '').trim().toUpperCase(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// CONTENT — the rotating ranch story (static v1 copy, brand-voice rules:
// lowercase, no NO-words, honest, no manufactured urgency, — Ben voice)
// ─────────────────────────────────────────────────────────────────────

export interface RanchStory {
  title: string;
  body: string;
}

export const RANCH_STORIES: readonly RanchStory[] = [
  {
    title: 'why your beef shows up frozen',
    body:
      'flash-freezing at the processor locks the cut at its best day — it is the honest way to ship beef across state lines. ' +
      'a vacuum-sealed cut holds close to a year in a chest freezer, which is why ranch families have bought this way for generations.',
  },
  {
    title: 'what a processing date really means',
    body:
      'a ranch does not keep a warehouse — it books animals into a small USDA processor weeks out, and that date sets everything downstream. ' +
      'when a rancher says a slot is open, that is a real spot on a real calendar, not a marketing counter.',
  },
  {
    title: 'the freezer math',
    body:
      'one chest freezer holds a quarter cow with room left for the garden. ' +
      'buying cuts by the box is how most families start; the share is where the per-pound math gets serious.',
  },
];

/** Deterministic rotation — one story per calendar month, cycling. */
export function ranchStoryForMonth(monthIndex: number): RanchStory {
  const i = ((Math.trunc(monthIndex) % RANCH_STORIES.length) + RANCH_STORIES.length) % RANCH_STORIES.length;
  return RANCH_STORIES[i];
}

// ─────────────────────────────────────────────────────────────────────
// SEND WINDOW + ENGAGEMENT TIERS
// ─────────────────────────────────────────────────────────────────────

export type DigestTier = 1 | 2 | 3 | 4;

/** Day-of-month → tier: day 1 sends tier 1 (most engaged) … day 4 tier 4.
 *  Any other day → null (the cron no-ops with an honest note). */
export function tierForDayOfMonth(utcDay: number): DigestTier | null {
  if (utcDay === 1 || utcDay === 2 || utcDay === 3 || utcDay === 4) return utcDay;
  return null;
}

/** Engagement recency: the most recent of the click/open stamps (Resend
 *  webhook) and the quiz-activity stamps (funnel/qualify/warmup) — the exact
 *  field names other rails read; never guessed. 0 = no engagement ever. */
export function engagementMs(row: Record<string, unknown>): number {
  const fields = [
    'Last Email Clicked At',
    'Last Email Opened At',
    'Qualified At',
    'Funnel Completed At',
    'Warmup Engaged At',
  ];
  let max = 0;
  for (const f of fields) {
    const v = row[f];
    if (!v) continue;
    const t = new Date(String(v)).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/** Record age anchor — same triple fallback /api/stats/public uses. */
export function createdMs(row: Record<string, unknown>): number {
  for (const f of ['Created', 'Created At', '_createdTime']) {
    const v = row[f];
    if (!v) continue;
    const t = new Date(String(v)).getTime();
    if (Number.isFinite(t) && t > 0) return t;
  }
  return 0;
}

export interface DigestTarget {
  consumerId: string;
  email: string;
  firstName: string;
  /** Normalized 2-letter code, '' unknown. */
  state: string;
  lane: BuyerLane;
  engagementMs: number;
}

export type DigestSkipReason =
  | 'no-email'
  | 'synthetic'
  | 'suppressed'
  | 'skipped-neverengaged'
  | 'skipped-sunset'
  | 'recently-sent';

export type DigestClassification =
  | { eligible: true; target: DigestTarget }
  | { eligible: false; reason: DigestSkipReason };

/** Latest dated DIGEST_MARKER stamp in Notes → ms (0 when never stamped /
 *  unparseable). Multiple stamps accumulate over months; the max wins. */
export function lastDigestMs(notes: unknown): number {
  const s = String(notes || '');
  let max = 0;
  const re = /\[RANCH-STAND-DIGEST (\d{4}-\d{2}-\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const t = new Date(m[1] + 'T00:00:00.000Z').getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/** The dated Notes line the cron appends after each outcome (hard rule 2:
 *  send truth persisted on the record; the durable half of the cap lane). */
export function buildDigestMarkerLine(
  dayIso: string,
  outcome: 'sent' | 'suppressed',
  tier: DigestTier,
): string {
  return `${DIGEST_MARKER} ${dayIso}] digest ${outcome} (tier ${tier})`;
}

function readSegment(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * Recipient gate. All three lanes receive the digest (plan §3 — Lane 2 is
 * the headline audience, Lane 1 sees the same honest shelf, Lane 3 'gets
 * digest'); what excludes a consumer is deliverability, suppression, and
 * cadence — never lane:
 *   - no/undeliverable email, synthetic test addresses;
 *   - Unsubscribed / Bounced / Complained (the send wrapper re-checks; this
 *     keeps them out of the claim loop entirely);
 *   - 12mo+ zero-engagement → excluded outright ('skipped-neverengaged');
 *   - 180d+ zero-engagement → excluded here, P5′ re-permission owns them
 *     ('skipped-sunset'). If a sunset/intentWindows module lands on main it
 *     keeps owning re-permission; this selector only ever excludes.
 *     A record whose age cannot be read fails OPEN (eligible) — in practice
 *     _createdTime always exists; the gate must not block what it can't prove;
 *   - a dated DIGEST_MARKER younger than DIGEST_CADENCE_DAYS
 *     ('recently-sent' — the 1-per-25-days cap lane).
 */
export function classifyDigestRecipient(
  row: Record<string, unknown> & { id?: string },
  nowMs: number,
): DigestClassification {
  const email = String(row['Email'] || '').trim().toLowerCase();
  if (!row?.id || !email || !email.includes('@')) return { eligible: false, reason: 'no-email' };
  if (isSyntheticTestEmail(email)) return { eligible: false, reason: 'synthetic' };
  if (row['Unsubscribed'] || row['Bounced'] || row['Complained']) {
    return { eligible: false, reason: 'suppressed' };
  }

  const eng = engagementMs(row);
  if (eng === 0) {
    const created = createdMs(row);
    if (created > 0) {
      const ageDays = (nowMs - created) / DAY_MS;
      if (ageDays >= NEVER_ENGAGED_AGE_DAYS) return { eligible: false, reason: 'skipped-neverengaged' };
      if (ageDays >= SUNSET_AGE_DAYS) return { eligible: false, reason: 'skipped-sunset' };
    }
  }

  const last = lastDigestMs(row['Notes']);
  if (last > 0 && nowMs - last < DIGEST_CADENCE_DAYS * DAY_MS) {
    return { eligible: false, reason: 'recently-sent' };
  }

  const fullName = String(row['Full Name'] || '').replace('(waitlist signup)', '').trim();
  return {
    eligible: true,
    target: {
      consumerId: String(row.id),
      email,
      firstName: fullName.split(/\s+/)[0] || '',
      state: normalizeState(row['State']),
      lane: laneForSegment(readSegment(row['Routing Segment'])),
      engagementMs: eng,
    },
  };
}

/**
 * Quartile the eligible list by engagement recency, most recent first.
 * Returns exactly 4 tiers (index 0 = tier 1). Sizes are near-equal with the
 * remainder loaded onto the EARLIER tiers (n=10 → 3/3/2/2) so the most
 * engaged cohort — the deliverability warmup — is never the small one.
 * Never-engaged eligibles (engagementMs 0, i.e. young records) sort last →
 * tier 4, exactly where the rollout wants them. Ties break on email for
 * determinism across runs.
 */
export function assignTiers(targets: readonly DigestTarget[]): [DigestTarget[], DigestTarget[], DigestTarget[], DigestTarget[]] {
  const sorted = [...targets].sort(
    (a, b) => b.engagementMs - a.engagementMs || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0),
  );
  const n = sorted.length;
  const base = Math.floor(n / 4);
  const rem = n % 4;
  const tiers: [DigestTarget[], DigestTarget[], DigestTarget[], DigestTarget[]] = [[], [], [], []];
  let idx = 0;
  for (let t = 0; t < 4; t++) {
    const size = base + (t < rem ? 1 : 0);
    tiers[t] = sorted.slice(idx, idx + size);
    idx += size;
  }
  return tiers;
}

// ─────────────────────────────────────────────────────────────────────
// RENDER — the two-block v1 email
// ─────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function productLine(p: DigestProduct): string {
  // Operation-type truth on every product block (principle 4). Digest rows
  // are sellable → never localOnly, so the label always resolves.
  const op = operationTypeFor({ type: 'product', localOnly: false, shelfStable: p.shelfStable, category: p.category });
  const price = Number.isInteger(p.price) ? `$${p.price.toLocaleString('en-US')}` : `$${p.price.toFixed(2)}`;
  return `
      <div style="margin:0 0 14px 0;">
        <p style="margin:0;font-size:15px;color:#0E0E0E;"><strong>${esc(p.name)}</strong> — ${price}${p.rancher ? ` · ${esc(p.rancher)}` : ''}</p>
        ${operationTypeEmailLine(op)}
      </div>`;
}

export interface RenderDigestInput {
  firstName: string;
  /** Normalized 2-letter recipient state code ('' = unknown). */
  recipientState: string;
  /** getServedStates(ranchers) — capacity-OUT (P1′ shared helper). */
  servedStates: ReadonlySet<string>;
  /** [] on a thin month — the section is omitted, never padded. */
  newArrivals: readonly DigestProduct[];
  /** Always-present fallback content. */
  shelf: readonly DigestProduct[];
  latestClose: DigestLatestClose | null;
  story: RanchStory;
  /** 0-11 — subject month. */
  monthIndex: number;
  siteUrl: string;
}

/**
 * Render the digest. EXACTLY two blocks:
 *   1. 'ships to you' — nationwide items (new arrivals when the month isn't
 *      thin, shelf highlights always) + proof line + ranch story, one CTA
 *      button to /shop (brand rule: one CTA — the in-state block below uses
 *      a quiet text link, the deposit-invite precedent).
 *   2. 'in your state' — ONLY when the recipient's state has share coverage
 *      (getServedStates); carries the local-share operation label via the
 *      shared P4 helper so every surface says exactly the same thing.
 */
export function renderRanchStandDigest(input: RenderDigestInput): { subject: string; html: string } {
  const MONTHS = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const month = MONTHS[((Math.trunc(input.monthIndex) % 12) + 12) % 12];
  const subject = `the ranch stand — ${month}`;
  const hey = input.firstName ? `hey ${esc(input.firstName)},` : 'hey,';

  const newBlock = input.newArrivals.length >= THIN_MONTH_MIN_NEW
    ? `
      <p style="margin:24px 0 10px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B4F3F;">new on the stand</p>
      ${input.newArrivals.map(productLine).join('')}`
    : '';

  const shelfBlock = input.shelf.length
    ? `
      <p style="margin:24px 0 10px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B4F3F;">on the shelf</p>
      ${input.shelf.map(productLine).join('')}`
    : '';

  // Proof line — first name + state only, real close or nothing.
  const proofLine = input.latestClose
    ? `<p style="margin:20px 0 0 0;font-size:14px;color:#2A2A2A;">latest close: ${esc(input.latestClose.firstName)}${input.latestClose.buyerState ? ` in ${esc(input.latestClose.buyerState)}` : ''} took a ${esc(input.latestClose.orderLabel)}.</p>`
    : '';

  const storyBlock = `
      <div style="border-left:3px solid #A7A29A;padding:2px 0 2px 14px;margin:26px 0 0 0;">
        <p style="margin:0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B4F3F;">${esc(input.story.title)}</p>
        <p style="margin:8px 0 0 0;font-size:14px;color:#5A5752;line-height:1.6;">${esc(input.story.body)}</p>
      </div>`;

  // Block 2 — only when the recipient's state actually has share coverage.
  const st = normalizeState(input.recipientState);
  const covered = st !== '' && input.servedStates.has(st);
  const stateBlock = covered
    ? `
      <div style="margin:30px 0 0 0;padding-top:22px;border-top:1px solid #A7A29A;">
        <p style="margin:0 0 6px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B4F3F;">in ${esc(stateName(st))}</p>
        ${operationTypeEmailLine(operationTypeFor({ type: 'share-ranch', state: st }))}
        <p style="margin:6px 0 0 0;font-size:14px;color:#2A2A2A;">a ranch near you fills real shares — quarters, halves, wholes. <a href="${input.siteUrl}/access" style="color:#6B4F3F;text-decoration:underline;">see what's open in your state</a></p>
      </div>`
    : '';

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p style="margin:0 0 4px 0;">${hey}</p>
      <p style="margin:0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B4F3F;">ships to you</p>
      <p style="margin:10px 0 0 0;font-size:14px;color:#2A2A2A;">the month's stand — real cuts from real ranches, shipped frozen to your door.</p>
      ${newBlock}
      ${shelfBlock}
      <p style="margin:26px 0 8px 0;">
        <a href="${input.siteUrl}/shop" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600">see the ranch stand →</a>
      </p>
      ${proofLine}
      ${storyBlock}
      ${stateBlock}
      <p style="font-size:12px;color:#A7A29A;margin-top:32px;">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`;

  return { subject, html };
}
