import { NextResponse } from 'next/server';
import {
  getAllRecords,
  updateRecord,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

// Project 1 — Discover Map · prospect opt-out flow.
//
// POST /api/prospects/remove  { slug, reason?, contactEmail? }
//
// Legal-compliance path: NO authentication required. Anyone who claims to be
// the operator (or just an interested party who wants the listing gone) can
// hit this endpoint to:
//   1. Hide the listing from /map (`Public Map Hidden = true`)
//   2. Flip `Verification Status` to `Removed` so /ranchers/<slug> 404s
//   3. Mark `Claim Status` as `removed-on-request`
//   4. Fire a Telegram alert so Ben sees the removal in real time and can
//      reach out personally if it was an error or trolling.
//
// We accept this asymmetric trust model because:
//   - The prospect was scraped from public info; we never had explicit consent.
//   - False removals can be undone in Airtable (24h Telegram window for review).
//   - A locked-down auth flow would prevent legit ranchers who don't want to
//     be listed from getting off the list quickly.

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

  if (!slug) {
    return NextResponse.json({ error: 'Missing slug' }, { status: 400 });
  }

  // Find the rancher by slug. Allow Prospect OR Verified — if a Verified
  // rancher hits this page, they're using the wrong path, but we still
  // honor the removal (legal). Their existing onboarding workflow can
  // unhide them later if it was an accident.
  const safe = escapeAirtableValue(slug);
  const rows = await getAllRecords(
    TABLES.RANCHERS,
    `{Slug} = "${safe}"`
  );
  const target = rows[0] as any | undefined;
  if (!target) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
  }

  const ranchName = (target['Ranch Name'] || target['Operator Name'] || 'Ranch') as string;
  const state = (target['State'] || '').toString();
  const wasVerified = target['Verification Status'] === 'Verified';

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

  // Telegram alert. If it was a Verified partner being removed, that's a
  // bigger deal — flag it loudly.
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      const header = wasVerified
        ? '🚨 VERIFIED RANCHER OPTED OUT'
        : '⚠️ PROSPECT OPT-OUT';
      const msg =
        `${header}\n` +
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
