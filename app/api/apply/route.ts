import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import {
  findOrCreateRancherByEmail,
  updateRecord,
  getAllRecords,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendRancherApplyAutoApproved } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { JWT_SECRET } from '@/lib/secrets';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

// POST /api/apply — public endpoint.
//
// Pre-wizard fit-check form. Captures rancher's qualification context
// (volume band, biggest constraint, channels, deposit-capability) +
// basic contact. On success:
//
//   • Creates Airtable Ranchers record w/ Status='Pending'; Onboarding
//     Status is intentionally left BLANK — blank is what routes the record
//     into rancher-followup's New Applicant chase path (its `if (!status)`
//     branch; STALL_THRESHOLDS has no 'Lead' key and onboarding-stuck has
//     no Lead bucket). Writing 'Lead' here would silently hide every
//     applicant from the only rail that chases them. Pricing Model
//     defaults to 'legacy' (e-sign + own payment link go-live; the
//     Stripe-Connect SSN wall killed 73% of cold signups — Connect/tier_v2
//     is a later upgrade).
//   • Mints a collision-safe Slug from Ranch Name (2026-07-08) — without
//     it an /apply rancher can never reach a live public page self-serve:
//     sign-agreement auto-go-live requires a Slug, the wizard PATCH
//     allowlist excludes it, and batch-approve skips slug-less ranchers.
//   • Mints rancher-setup JWT (60d) → returns wizard URL.
//   • Fires Telegram alert tagged w/ qualification score so Ben can
//     prioritize the high-volume + high-intent apps.
//
// Auto-qualification logic:
//   high-volume (25-100 or 100+ head) + accepts deposits = HOT LEAD
//   moderate volume (5-25) = standard
//   <5 head = manual review flag (still gets wizard but Ben triages)
//
// Anti-abuse:
//   • Honeypot field 'fax' — submit-with-non-empty drops silently.
//   • Email dedupe — existing rancher w/ same email is updated, not duped.
//   • Rate limit per IP (basic — Vercel KV would be tighter, fine for v1).

export const dynamic = 'force-dynamic';
// Raised 30→60 (2026-07-23 hardening) — the pre-record-write window (slug mint +
// dedupe read + create) is what threw/timed out and stranded "Justin". More
// headroom lets withRateLimitRetry actually back off + recover under an Airtable
// rate-limit blip instead of the function being killed mid-write.
export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// P2c internal deadline (2026-07-23) — a Vercel HARD kill at maxDuration runs no
// catch, so a slow-but-alive record write would still vanish without a trace.
// Race the write against a deadline safely BELOW maxDuration; on breach we throw
// this, fire the loud rescue signal with the full payload, and return 503 — a
// near-kill now leaves a trail Ben can act on.
class ApplyDeadlineError extends Error {}
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApplyDeadlineError('apply write deadline exceeded')), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

type VolumeBand = '<5' | '5-25' | '25-100' | '100+';
type Constraint = 'more_buyers' | 'better_pricing' | 'easier_logistics' | 'brand_visibility' | 'all_above';

interface ApplyBody {
  operatorName?: string;
  ranchName?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  headPerYear?: VolumeBand;
  constraint?: Constraint;
  channels?: string[];
  acceptsDeposits?: 'yes' | 'no';
  website?: string;
  notes?: string;
  fax?: string; // honeypot
}

function isHotLead(body: ApplyBody): boolean {
  return (
    (body.headPerYear === '25-100' || body.headPerYear === '100+') &&
    body.acceptsDeposits === 'yes'
  );
}

function needsManualReview(body: ApplyBody): boolean {
  return body.headPerYear === '<5';
}

function qualificationScore(body: ApplyBody): number {
  let score = 0;
  if (body.headPerYear === '100+') score += 4;
  else if (body.headPerYear === '25-100') score += 3;
  else if (body.headPerYear === '5-25') score += 2;
  else if (body.headPerYear === '<5') score += 1;
  if (body.acceptsDeposits === 'yes') score += 2;
  if ((body.channels?.length || 0) >= 2) score += 1;
  if (body.website) score += 1;
  if (body.constraint === 'more_buyers' || body.constraint === 'brand_visibility') score += 1;
  return score;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Slug minting (2026-07-08) — replicates the kebab + collision-check pattern
// from /api/rancher/activate. Two ranchers with the same name (e.g. two
// "Bar S Ranch") must NOT auto-generate the same slug — getRancherBySlug
// returns whichever Airtable lists first, so the second rancher's page and
// all their direct traffic would silently route to the first. Append -2, -3,
// … until free; on lookup failure fall back to a suffixed slug rather than
// risk writing a collision.
function kebab(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

async function mintUniqueSlug(
  ranchName: string,
  opts: { excludeRecordId?: string; fallbackSuffix: string },
): Promise<string> {
  const base = kebab(ranchName) || `ranch-${opts.fallbackSuffix}`;
  let unique = base;
  try {
    // Cap the collision loop at a bounded handful (2026-07-23 hardening). The
    // old ceiling of ~48 sequential filtered scans could burn most of the
    // function budget on a common ranch name INSIDE the pre-write window (the
    // Justin timeout). After a few numbered tries, fall back to the random
    // suffix — globally unique in one more step instead of dozens of reads.
    let resolved = false;
    for (let n = 2; n <= 9; n++) {
      const safe = escapeAirtableValue(unique);
      const taken = (
        (await getAllRecords(TABLES.RANCHERS, `LOWER({Slug}) = "${safe}"`)) as any[]
      ).filter((r) => r.id !== opts.excludeRecordId);
      if (taken.length === 0) {
        resolved = true;
        break;
      }
      unique = `${base}-${n}`;
    }
    if (!resolved) unique = `${base}-${opts.fallbackSuffix}`;
  } catch (e: any) {
    console.warn('[apply] slug collision check failed:', e?.message);
    unique = `${base}-${opts.fallbackSuffix}`;
  }
  return unique;
}

export async function POST(req: Request) {
  const ip = getRequestIp(req);
  const rlMin = await rateLimit(`apply:${ip}`, { requests: 3, window: '1m' });
  if (!rlMin.ok) {
    return NextResponse.json(
      { error: 'Too many applications from this network — wait a minute and try again.' },
      { status: 429 }
    );
  }
  const rlHour = await rateLimit(`apply-hr:${ip}`, { requests: 10, window: '1h' });
  if (!rlHour.ok) {
    return NextResponse.json(
      { error: 'Too many applications from this network in the past hour. Email ben@buyhalfcow.com if this is wrong.' },
      { status: 429 }
    );
  }

  let body: ApplyBody = {};
  try {
    body = (await req.json()) as ApplyBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Honeypot — silent drop, return success to confuse bots.
  if (body.fax && body.fax.trim().length > 0) {
    return NextResponse.json({ ok: true, manualReview: true });
  }

  // Required fields
  if (
    !body.operatorName?.trim() ||
    !body.ranchName?.trim() ||
    !body.email?.trim() ||
    !body.state
  ) {
    return NextResponse.json(
      { error: 'Name, ranch, email, and state are required.' },
      { status: 400 }
    );
  }
  if (!isValidEmail(body.email.trim())) {
    return NextResponse.json({ error: 'Please enter a valid email.' }, { status: 400 });
  }
  // PHONE REQUIRED (2026-07-20) — server-side, so it holds regardless of client.
  // Vale Creek Ranch signed up with a typo'd email (hard bounce, "mailbox not
  // found") and no phone: approved, sent a setup link that could never arrive,
  // permanently unreachable, nobody alerted. Email as the ONLY channel means one
  // typo silently loses a rancher. A second channel is non-negotiable.
  if (String(body.phone || '').replace(/\D/g, '').length < 10) {
    return NextResponse.json(
      { error: 'A phone number is required — it is how we reach you if email fails.' },
      { status: 400 },
    );
  }

  const email = body.email.trim().toLowerCase();

  // Build qualification + Notes payload
  const hot = isHotLead(body);
  const manualReview = needsManualReview(body);
  const score = qualificationScore(body);
  const channelsList = (body.channels || []).join(', ') || 'none specified';
  const constraintLabel: Record<Constraint, string> = {
    more_buyers: 'Finding more buyers',
    better_pricing: 'Better pricing / margins',
    easier_logistics: 'Easier logistics & fulfillment',
    brand_visibility: 'Brand visibility',
    all_above: 'All of the above',
  };

  const opDetails = [
    `[APPLY ${new Date().toISOString().slice(0, 10)}]`,
    `Volume: ${body.headPerYear || 'not specified'} head/year`,
    `Constraint: ${body.constraint ? constraintLabel[body.constraint] : 'not specified'}`,
    `Channels: ${channelsList}`,
    `Accepts deposits online: ${body.acceptsDeposits || 'not specified'}`,
    body.website ? `Website: ${body.website}` : null,
    body.notes ? `Notes: ${body.notes}` : null,
    `Qualification score: ${score}/9`,
    hot ? '🔥 HOT LEAD' : manualReview ? '⚠️ MANUAL REVIEW (<5 head)' : '✓ Standard',
  ]
    .filter(Boolean)
    .join('\n');

  // Find-or-create through the shared duplicate-rancher guard. Default
  // Pricing Model to 'legacy' for new ranchers — go-live on e-sign + slug +
  // price + their own payment link, no Stripe Connect onboarding (the SSN
  // wall killed 73% of cold signups). Ben can upgrade to tier_v2 later.
  //
  // Dedupe now goes beyond the old email-only check: the helper also matches
  // Team Emails, phone, and (Ranch Name + State) so a 2nd team member or a
  // re-submit under a different email can't fork a new "Jesse" row. On a
  // match we return the EXISTING rancher's wizard URL instead of duplicating.
  // Mint the Slug BEFORE create (2026-07-08). There's no record id yet, so
  // the no-collision fallback uses a random suffix instead of activate's
  // record-id suffix.
  // Hoist the required-field values into consts BEFORE the race closure — the
  // async IIFE below is a nested scope, so TS drops the guard-narrowing of the
  // mutable `body` inside it. These are already validated non-empty above.
  const operatorName = body.operatorName.trim();
  const ranchNameTrimmed = body.ranchName.trim();
  const phoneTrimmed = body.phone?.trim() || '';

  let rancherId: string;
  try {
    // P2c: race slug-mint + find/create against an internal deadline (below
    // maxDuration=60) so a slow-but-alive Airtable still leaves a trace — the
    // catch below fires the loud rescue signal + 503 BEFORE Vercel hard-kills
    // the function (a hard kill runs no catch at all). Slug mint moved inside
    // the race so a hung collision loop is covered too.
    const { record, created, matchedBy } = await withDeadline(
      (async () => {
        const slug = await mintUniqueSlug(ranchNameTrimmed, {
          fallbackSuffix: Math.random().toString(36).slice(2, 8),
        });
        return findOrCreateRancherByEmail(
          email,
          {
            'Operator Name': operatorName,
            'Ranch Name': ranchNameTrimmed,
            Email: email,
            Phone: phoneTrimmed,
            City: body.city?.trim() || '',
            State: body.state,
            Status: 'Pending',
            'Pricing Model': 'legacy',
            'Operation Details': opDetails,
            Slug: slug,
          },
          { phone: phoneTrimmed, ranchName: ranchNameTrimmed, state: body.state },
        );
      })(),
      45_000,
    );

    if (!created) {
      // Existing rancher — hand back their existing wizard URL, don't dupe.
      //
      // Slug backfill (2026-07-08): rows created before /apply minted slugs
      // have none, which blocks sign-agreement auto-go-live + batch-approve.
      // Re-mint from the record's own Ranch Name (dedupe can match by phone /
      // team email, so it may differ from what was just submitted), excluding
      // the record itself from the collision check. Non-fatal — the wizard
      // URL still goes out if the write hiccups.
      if (!record['Slug']) {
        try {
          const backfillSlug = await mintUniqueSlug(
            String(record['Ranch Name'] || body.ranchName.trim()),
            { excludeRecordId: record.id, fallbackSuffix: String(record.id).slice(-6) },
          );
          await updateRecord(TABLES.RANCHERS, record.id, { Slug: backfillSlug });
        } catch (e: any) {
          console.warn('[apply] slug backfill failed (non-fatal):', e?.message);
        }
      }

      // Re-apply recovery (2026-07-21): the old path returned the wizard URL
      // and dropped everything else on the floor — no contact update, no
      // Operation Details append, no Telegram. Concrete failure: a rancher
      // whose record carries a bounced email (Vale Creek class) re-applies
      // with the CORRECTED email, matches by phone / ranch+state, and the
      // record KEEPS the dead email forever while Ben never learns they
      // came back. Persist the fresh truth (non-fatal — wizard URL still
      // goes out if the write hiccups).
      try {
        const resubmitFields: Record<string, string> = {};
        // Email: only when the match came via phone / ranch+state — i.e. the
        // submitted email exists NOWHERE on the record (corrected-email
        // recovery). An 'email' match is identical; a 'team' match must not
        // clobber the primary owner's email with a team member's.
        if (
          (matchedBy === 'phone' || matchedBy === 'ranch+state') &&
          email !== String(record['Email'] || '').trim().toLowerCase()
        ) {
          resubmitFields['Email'] = email;
        }
        const submittedPhone = body.phone?.trim() || '';
        if (
          submittedPhone &&
          submittedPhone.replace(/\D/g, '') !==
            String(record['Phone'] || '').replace(/\D/g, '')
        ) {
          resubmitFields['Phone'] = submittedPhone;
        }
        if (body.city?.trim() && !record['City']) {
          resubmitFields['City'] = body.city.trim();
        }
        // Always append the fresh fit-check — volume/constraint/notes are
        // qualification signal Ben triages on.
        resubmitFields['Operation Details'] = [
          String(record['Operation Details'] || ''),
          opDetails,
        ]
          .filter(Boolean)
          .join('\n\n');
        await updateRecord(TABLES.RANCHERS, record.id, resubmitFields);
      } catch (e: any) {
        console.warn('[apply] existing-rancher resubmit update failed (non-fatal):', e?.message);
      }
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `↩️ <b>EXISTING rancher re-applied</b> · /apply\n\n` +
            `<b>${body.operatorName}</b> · ${body.ranchName} (${body.state})\n` +
            `${email}${body.phone ? ` · ${body.phone}` : ''}\n` +
            `Matched by: ${matchedBy || '?'}\n\n` +
            `<i>Fresh fit-check appended to Operation Details. Existing wizard link re-issued.</i>\n\n` +
            `Rancher ${record.id}`
        );
      } catch (e: any) {
        console.warn('[apply] resubmit Telegram alert failed (non-fatal):', e?.message);
      }

      const existingToken = jwt.sign(
        { type: 'rancher-setup', rancherId: record.id },
        JWT_SECRET,
        { expiresIn: '60d' }
      );
      return NextResponse.json({
        ok: true,
        existing: true,
        wizardUrl: `${SITE_URL}/rancher/setup?token=${existingToken}`,
        manualReview: false,
      });
    }

    rancherId = record.id;
  } catch (e: any) {
    // P1a + P2c: the pre-record-write window is where "Justin" vanished — a
    // throw here logged console.error only (no page), and a hard timeout ran no
    // catch at all. Fire a LOUD, deduped operator signal carrying the FULL
    // submitted payload so Ben can hand-create the record + resend the wizard
    // link in ~60s. withDeadline throws ApplyDeadlineError just below the
    // maxDuration kill, so the slow-but-alive case now lands here too (503).
    const timedOut = e instanceof ApplyDeadlineError;
    console.error(
      `[apply] Airtable create ${timedOut ? 'timed out' : 'failed'}:`,
      e?.message,
    );
    try {
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: `Signup ${timedOut ? 'TIMED OUT' : 'create FAILED'} · /apply · ${body.ranchName} (${body.state})`,
        detail:
          `A rancher's /apply submission ${timedOut ? 'is taking too long' : 'threw'} in the pre-record-write window — ` +
          `nothing was saved. Hand-create the Ranchers row + resend the wizard link.\n\n` +
          `Operator: ${body.operatorName}\n` +
          `Ranch: ${body.ranchName}\n` +
          `Email: ${email}\n` +
          `Phone: ${body.phone || '(none)'}\n` +
          `State: ${body.state}\n` +
          `Error: ${e?.message || 'unknown'}`,
        dedupeKey: `signup-create-fail:apply:${email}`,
      });
    } catch (sigErr: any) {
      console.error('[apply] rescue operator signal failed:', sigErr?.message);
    }
    return NextResponse.json(
      {
        error: timedOut
          ? 'Saving your application is taking longer than expected. Please try again in a moment or email ben@buyhalfcow.com.'
          : 'Could not save your application. Please try again or email ben@buyhalfcow.com.',
      },
      { status: timedOut ? 503 : 500 },
    );
  }

  // Mint wizard token (60d). All approved applicants get the wizard link —
  // manual-review flagged ones still get it but Ben sees the warning in
  // Telegram and can hold a discovery call before they proceed.
  const wizardToken = jwt.sign(
    { type: 'rancher-setup', rancherId },
    JWT_SECRET,
    { expiresIn: '60d' }
  );
  const wizardUrl = `${SITE_URL}/rancher/setup?token=${wizardToken}`;

  // Fire the auto-approval welcome email. Carries the wizard URL so the
  // rancher can resume even after closing the browser tab. Non-fatal —
  // log + continue if Resend hiccups (rancher still has URL in client
  // response + Telegram alert lets Ben follow up manually).
  //
  // EMAIL TRUTH (2026-07-21): guardedSend NEVER throws on a failed/suppressed
  // send — it RESOLVES {success:false} (dead Resend key, frequency cap,
  // bounce suppression). The old try/catch only caught throws, so those
  // failures were invisible: no warning, no stamp, and the Telegram alert
  // claimed all was well while the rancher had NO copy of their wizard link
  // (the exact 2026-07-14 dead-key / 503-cap shape). Capture the result,
  // persist the truth on the record, and warn Ben with the link so he can
  // send it manually.
  let welcomeEmail: { success: boolean; suppressed?: boolean; reason?: string } = {
    success: false,
    reason: 'send threw',
  };
  try {
    welcomeEmail = await sendRancherApplyAutoApproved({
      operatorName: body.operatorName.trim(),
      ranchName: body.ranchName.trim(),
      email,
      wizardUrl,
      score,
      hotLead: hot,
    });
  } catch (e: any) {
    welcomeEmail = { success: false, reason: e?.message || 'send threw' };
  }
  if (!welcomeEmail.success) {
    console.warn(
      '[apply] auto-approved welcome email failed/suppressed (non-fatal):',
      welcomeEmail.reason
    );
    // Persist the truth on the record (existing field — no schema change).
    try {
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Operation Details':
          opDetails +
          `\n⚠️ Welcome email ${welcomeEmail.suppressed ? 'SUPPRESSED' : 'FAILED'} (${
            welcomeEmail.reason || 'unknown'
          }) ${new Date().toISOString().slice(0, 10)} — rancher may have no copy of wizard link`,
        // P4d: also stamp the queryable field (free-text buried in Operation
        // Details is invisible to a sweep) so a "welcome never delivered" cohort
        // is findable in one filter.
        'Welcome Email Failed At': new Date().toISOString(),
      });
    } catch (e: any) {
      console.warn('[apply] welcome-email-failure stamp failed (non-fatal):', e?.message);
    }
  }

  // Telegram alert — tier the emoji + label so Ben can triage at a glance
  try {
    const emoji = hot ? '🔥🔥🔥' : manualReview ? '⚠️' : '🆕';
    const tier = hot ? 'HOT LEAD' : manualReview ? 'MANUAL REVIEW' : 'NEW APPLICATION';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `${emoji} <b>${tier}</b> · /apply\n\n` +
        `<b>${body.operatorName}</b> · ${body.ranchName} (${body.state})\n` +
        `${email}${body.phone ? ` · ${body.phone}` : ''}\n\n` +
        `Volume: <b>${body.headPerYear || '?'}</b> head/year\n` +
        `Constraint: ${body.constraint ? constraintLabel[body.constraint] : '?'}\n` +
        `Channels: ${channelsList}\n` +
        `Deposits online: ${body.acceptsDeposits || '?'}\n` +
        `Score: ${score}/9${body.website ? ` · ${body.website}` : ''}\n\n` +
        `<i>Pricing Model defaulted to legacy. Wizard token minted — they'll be redirected.</i>\n` +
        (welcomeEmail.success
          ? ''
          : `\n⚠️ <b>Welcome email ${welcomeEmail.suppressed ? 'SUPPRESSED' : 'FAILED'}</b> (${
              welcomeEmail.reason || 'unknown'
            }) — they have NO emailed copy of the wizard link. Send it manually:\n${wizardUrl}\n`) +
        `\nRancher ${rancherId}`
    );
  } catch (e: any) {
    console.warn('[apply] Telegram alert failed (non-fatal):', e?.message);
  }

  return NextResponse.json({
    ok: true,
    wizardUrl,
    manualReview,
    rancherId,
    // P4d: let the client adapt its copy — "check your inbox" only when the
    // welcome actually sent; otherwise it can lean on the on-screen wizard link.
    emailSent: welcomeEmail.success,
  });
}
