import { NextResponse } from 'next/server';
import {
  getAllRecords,
  updateRecord,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { rateLimit, rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
import { prospectOptOutVerdict } from '@/lib/prospectOptOut';

// Project 1 — Discover Map · prospect opt-out flow.
//
// POST /api/prospects/remove  { slug, reason?, contactEmail? }
//
// Legal-compliance path: NO authentication required, and that stays. These
// listings were built from public information about ranchers who never
// consented to being listed, so a real operator has to be able to retract one
// in a single tap without proving anything to us. An auth wall here would
// defeat the entire purpose of the door.
//
// ── What the door may touch (hardened 2026-08-19) ─────────────────────────
// The write this route performs — Verification Status = 'Removed' — is the
// most destructive flag on a rancher record:
//   • lib/rancherEligibility.ts stops routing buyers to a 'Removed' ranch;
//   • app/api/auth/rancher/verify/route.ts refuses a 'Removed' account's own
//     magic-link login, so the operator cannot sign in to undo it;
//   • the public page 404s and Page Live is cleared.
// The route used to resolve its target by SLUG ALONE. Slugs are public — they
// are the /ranchers/<slug> URLs and /api/public/ranchers enumerates the whole
// roster — so the anonymous door reached live, signed, paying partners, not
// just the scraped listings it exists to retract.
//
// Two changes close that without closing the door:
//   (a) TARGET GATE. lib/prospectOptOut decides whether the row is a genuine
//       unclaimed prospect. Same spirit as the sibling claim door, which
//       already scopes its lookup to {Verification Status} = "Prospect", but
//       stricter: it also rejects represented (broker-rail) ranches, signed
//       agreements, any explicit account lifecycle state, a live onboarding,
//       and any Stripe Connect state. Anything else is refused with a 403 and
//       an operator alert — a refusal is a tripwire, so Ben hears about an
//       attempted delisting the same way he hears about a real one.
//   (b) ABUSE CAP. Three buckets on the shared limiter. The per-IP and
//       per-slug burst caps use rateLimitStrict, which NEVER fails open — the
//       plain rateLimit() falls through to ok:true when Upstash env is
//       missing, and an unbounded destructive anonymous write is exactly the
//       shape that must not depend on optional platform infra. The IP comes
//       from getTrustedClientIp (platform-set headers), not the first
//       x-forwarded-for hop, which a caller can forge to mint a fresh bucket
//       per request.
//
// Deliberately NOT added: an emailed confirm-link handshake. See the PR — with
// (a) in place the worst an anonymous caller achieves is un-publishing a
// listing the ranch never asked for, reversible in Airtable, and a mandatory
// email round-trip would lock out exactly the scraped rows that have no email
// on file (the claim door's "manual review" population). Revisit as a
// narrower follow-up for rows that DO carry an address.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const slug = String(body.slug || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 1000);
  const contactEmail = String(body.contactEmail || '').trim().toLowerCase();
  // Honeypot, same convention as the claim + self-submit doors (`website2` /
  // `company`): bots fill hidden fields, humans never see them. Silent success
  // so the bot believes it worked while nothing is written or alerted.
  const honeypot = String(body.website2 || body.company || '');

  if (!slug) {
    return NextResponse.json({ error: 'Missing slug' }, { status: 400 });
  }
  if (honeypot) {
    return NextResponse.json({ success: true });
  }

  // ── Abuse caps, BEFORE any read/write/alert ────────────────────────────
  const ip = getTrustedClientIp(req);
  const ipBurst = await rateLimitStrict(`prospect-remove:ip:${ip}`, { requests: 5 });
  if (!ipBurst.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again in a minute.' },
      { status: 429 },
    );
  }
  // Per-listing: a distributed flood from many IPs against ONE listing is the
  // shape the per-IP cap cannot see.
  const slugBurst = await rateLimitStrict(`prospect-remove:slug:${slug}`, { requests: 2 });
  if (!slugBurst.ok) {
    return NextResponse.json(
      { error: 'This listing was just updated. Please try again in a minute.' },
      { status: 429 },
    );
  }
  // Slow-drip belt: caps how much of the roster one caller can walk in an hour
  // even while staying under the per-minute burst.
  const ipHour = await rateLimit(`prospect-remove:ip:${ip}`, { requests: 20, window: '1h' });
  if (!ipHour.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Please email hello@buyhalfcow.com and we will take care of it.' },
      { status: 429 },
    );
  }

  // Resolve by slug WITHOUT a status filter on purpose: we want to tell a real
  // partner "not from this page, here's what to do" rather than a bare 404,
  // and we want the operator tripwire to know which listing was targeted.
  const safe = escapeAirtableValue(slug);
  const rows = await getAllRecords(TABLES.RANCHERS, `{Slug} = "${safe}"`);
  const target = rows[0] as any | undefined;
  if (!target) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
  }

  const ranchName = (target['Ranch Name'] || target['Operator Name'] || 'Ranch') as string;
  const state = (target['State'] || '').toString();

  const verdict = prospectOptOutVerdict(target);

  // Already off the map — idempotent. A double-click or a retry must not 403
  // at a prospect who successfully opted out a moment ago, and must not
  // re-alert.
  if (verdict.decision === 'already-removed') {
    return NextResponse.json({ success: true, alreadyRemoved: true });
  }

  if (verdict.decision === 'refuse') {
    // TRIPWIRE. Someone tried to delist a ranch that is NOT an unclaimed
    // prospect. That is either a confused real operator (who needs a human) or
    // an attempt at vandalism (which Ben must see). Both are worth a ping; the
    // rate limiter above bounds how loud it can get.
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🛑 OPT-OUT REFUSED (not an unclaimed prospect)\n` +
            `Ranch: ${ranchName} (${state})\n` +
            `Slug: ${slug}\n` +
            `Gate: ${verdict.reason}\n` +
            (contactEmail ? `Contact given: ${contactEmail}\n` : '') +
            (reason ? `\nReason given:\n"${reason}"\n` : '') +
            `\nNothing was changed. If this is the real operator, handle it by hand.`,
        );
      }
    } catch (e) {
      console.error('[remove] refusal alert failed:', e);
    }
    return NextResponse.json(
      {
        error:
          "This listing belongs to an active BuyHalfCow account, so it can't be removed from this page. Email hello@buyhalfcow.com and we'll sort it out the same day.",
      },
      { status: 403 },
    );
  }

  try {
    await updateRecord(TABLES.RANCHERS, target.id, {
      'Public Map Hidden': true,
      'Verification Status': 'Removed',
      'Claim Status': 'removed-on-request',
      // Flip Page Live off so the SEO landing page doesn't keep serving.
      // (getRancherOrProspectBySlug already excludes "Removed" anyway, but
      // belt-and-suspenders on the data layer.)
      'Page Live': false,
    });
  } catch (e) {
    console.error('[remove] Airtable update failed:', e);
    return NextResponse.json({ error: 'Could not remove — try again' }, { status: 500 });
  }

  // Telegram alert so Ben sees the removal in real time and can reach out
  // personally if it was an error or trolling.
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      const msg =
        `⚠️ PROSPECT OPT-OUT\n` +
        `Ranch: ${ranchName} (${state})\n` +
        `Slug: ${slug}\n` +
        (contactEmail ? `Contact: ${contactEmail}\n` : '') +
        (reason ? `\nReason given:\n"${reason}"\n` : '\n(no reason given)\n') +
        `\nListing is hidden from /map and /ranchers/${slug} now 404s. Reverse in Airtable if needed.`;
      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, msg);
    }
  } catch (e) {
    console.error('[remove] telegram alert failed:', e);
  }

  return NextResponse.json({ success: true });
}
