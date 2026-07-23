// app/api/cron/setup-link-undelivered/route.ts
//
// P3e — "setup link may not have landed" sweep.
//
// Why: a rancher who was SENT a welcome/setup email but never received it
// (dead address, hard bounce, silent Resend drop — the Justin / Vale Creek
// class) sits pre-live forever with no wizard link and no human ever told.
// The daily-health-digest counts bounces in aggregate; this cron NAMES the
// specific ranchers so Ben can hand-resend in 60s.
//
// Selection (pure, tested in ./setupLinkUndelivered logic below): an Email
// Sends row with Status='sent' for a rancher-onboarding template, NO
// delivered/bounced signal, sent >N minutes ago, whose rancher is still
// pre-live (Page Live != true).
//
// GATED behind SETUP_LINK_UNDELIVERED_ENABLED: the delivered/bounced webhook
// stamping is group C's work and does not exist yet. Until Email Sends rows
// carry a delivery signal, EVERY sent row reads as "undelivered" and this
// cron would false-alarm on every setup email — so it stays dark until the
// flag is flipped (flip it when group C lands the stamping).
//
// Schedule: hourly. Uses withCronRun + requireCron.

import { getAllRecords, TABLES } from '@/lib/airtable';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 60;

// Only sweep over the 48h behind us — a link that has been unconfirmed for
// two days is stale beyond rescue value, and a wider window bloats the read.
const LOOKBACK_HOURS = 48;

// Rancher-onboarding email templates that carry the setup/wizard link. A
// missing DELIVERED signal on any of these = the rancher may have no way in.
export const ONBOARDING_SETUP_TEMPLATES = new Set<string>([
  'sendRancherApplyAutoApproved', // /api/apply welcome + wizard link
  'sendRancherApproval', // manual approval + wizard link
  'sendRancherSetupLink', // /api/rancher/setup/resend-link
  'sendRancherSelfSubmitWelcome', // /self-submit welcome
]);

export interface SetupSendRow {
  recipientEmail: string;
  templateName: string;
  sentAtMs: number;
  // Group C stamps a delivered/bounced webhook signal onto the send row; until
  // then this is always false (which is exactly why the cron is env-gated).
  hasDeliverySignal: boolean;
}

export interface RancherLite {
  email: string;
  pageLive: boolean;
}

export interface UndeliveredHit {
  email: string;
  templateName: string;
  minutesAgo: number;
}

/**
 * Pure selection: which setup/welcome emails were sent long enough ago, with
 * no delivery confirmation, to a rancher who is still pre-live. Deduped to the
 * MOST-RECENT qualifying send per email; returned most-stale-first (the ones
 * most likely truly lost). A send whose recipient has no matching rancher, or
 * a matching rancher who is already live, is skipped.
 */
export function selectUndeliveredSetupLinks(
  sends: SetupSendRow[],
  ranchers: RancherLite[],
  nowMs: number,
  thresholdMinutes: number,
): UndeliveredHit[] {
  // email -> pageLive (OR across duplicate rows: any live record wins so we
  // never chase a rancher who has already gone live under a second row).
  const liveByEmail = new Map<string, boolean>();
  for (const r of ranchers) {
    const e = (r.email || '').trim().toLowerCase();
    if (!e) continue;
    liveByEmail.set(e, (liveByEmail.get(e) || false) || r.pageLive === true);
  }

  const best = new Map<string, UndeliveredHit>();
  for (const s of sends) {
    if (!ONBOARDING_SETUP_TEMPLATES.has(s.templateName)) continue;
    if (s.hasDeliverySignal) continue;
    const email = (s.recipientEmail || '').trim().toLowerCase();
    if (!email) continue;
    if (!liveByEmail.has(email)) continue; // no rancher for this send — can't confirm pre-live
    if (liveByEmail.get(email)) continue; // already live → the link clearly landed
    if (!Number.isFinite(s.sentAtMs)) continue;
    const minutesAgo = Math.floor((nowMs - s.sentAtMs) / 60000);
    if (minutesAgo < thresholdMinutes) continue; // too fresh — webhook may still be in flight
    const prev = best.get(email);
    if (!prev || minutesAgo < prev.minutesAgo) {
      best.set(email, { email, templateName: s.templateName, minutesAgo });
    }
  }
  return Array.from(best.values()).sort((a, b) => b.minutesAgo - a.minutesAgo);
}

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  // GATE: dark until group C stamps Email Sends with a delivered/bounced
  // signal. Without it every sent row looks undelivered → false-alarm storm.
  if (String(process.env.SETUP_LINK_UNDELIVERED_ENABLED || '').toLowerCase() !== 'true') {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: 'disabled — set SETUP_LINK_UNDELIVERED_ENABLED=true once group C stamps Email Sends delivered/bounced',
    };
  }

  const thresholdMinutes = Math.max(
    1,
    parseInt(process.env.SETUP_LINK_UNDELIVERED_MIN_MINUTES || '60', 10) || 60,
  );
  const now = Date.now();
  const cutoffISO = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const templateClause = Array.from(ONBOARDING_SETUP_TEMPLATES)
    .map((t) => `{Template Name}='${t}'`)
    .join(', ');
  const emailSends = (await getAllRecords(
    TABLES.EMAIL_SENDS,
    `AND({Status}='sent', IS_AFTER({Sent At}, '${cutoffISO}'), OR(${templateClause}))`,
  )) as any[];

  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];

  const sends: SetupSendRow[] = emailSends.map((e: any) => ({
    recipientEmail: String(e['Recipient Email'] || ''),
    templateName: String(e['Template Name'] || ''),
    sentAtMs: new Date(String(e['Sent At'] || '')).getTime(),
    // Read every plausible group-C stamp shape defensively — a missing field
    // simply reads undefined (falsy), and the env gate above keeps us dark
    // until at least one of these actually exists.
    hasDeliverySignal: !!(e['Delivered At'] || e['Bounced At'] || e['Delivered'] || e['Bounced']),
  }));
  const rlite: RancherLite[] = ranchers.map((r: any) => ({
    email: String(r['Email'] || ''),
    pageLive: r['Page Live'] === true,
  }));

  const hits = selectUndeliveredSetupLinks(sends, rlite, now, thresholdMinutes);

  if (hits.length > 0) {
    const list = hits
      .slice(0, 25)
      .map((h) => `• ${h.email} (${h.templateName}, ${h.minutesAgo}m ago)`)
      .join('\n');
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'stuck-rancher',
      summary: `${hits.length} setup link${hits.length === 1 ? '' : 's'} may not have landed`,
      detail:
        `Sent an onboarding/setup email >${thresholdMinutes}m ago with NO delivered/bounced ` +
        `signal, still pre-live:\n\n${list}\n\n` +
        `Confirm the address is real; hand-resend via POST /api/rancher/setup/resend-link {email}.`,
      dedupeKey: 'setup-link-undelivered',
      dedupeWindowMs: 60 * 60 * 1000,
    }).catch(() => {});
  }

  return {
    status: 'success',
    recordsTouched: hits.length,
    notes: `undelivered=${hits.length} threshold=${thresholdMinutes}m sends=${sends.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('setup-link-undelivered', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
