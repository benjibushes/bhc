import { NextResponse } from 'next/server';
import {
  getAllRecords,
  createRecord,
  updateRecord,
  TABLES,
  escapeAirtableValue,
} from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { sendFoundingHerdWelcome } from '@/lib/email';

export const maxDuration = 30;

type ValidTier = 'Herd' | 'Outlaw' | 'Steward' | 'Founding 100' | 'Title Founder';
const NUMBERED_TIERS = new Set<ValidTier>(['Founding 100', 'Title Founder']);
const VALID_TIERS = new Set<ValidTier>([
  'Herd',
  'Outlaw',
  'Steward',
  'Founding 100',
  'Title Founder',
]);

// Admin: comp someone onto the Founders Wall — full tier benefits, no Stripe
// charge. Mirrors the Stripe webhook flow (handleFounderCheckoutCompleted)
// minus payment + minus Stripe identifiers, so comped backers walk the same
// downstream pipeline (Telegram alert + welcome email + Wall rendering).
//
// Request body:
//   {
//     email: "matt@brimstone.beef",       // required
//     name: "Matt Hirschi",               // optional (falls back to email local-part)
//     tier: "Founding 100",               // required, one of VALID_TIERS
//     founderNumber?: 7,                  // optional — manual override (numbered tiers only)
//     wallOptIn?: true,                   // default: true for Outlaw+, false for Herd
//     backerType?: "Individual"|"Brand",  // default: Individual
//     sendWelcome?: true,                 // default: true (skip for stealth-comps)
//     reason?: "co-build partner — pilot stage"  // free text, stored in Notes
//   }
//
// Idempotency: if a Consumer row already has a Founder Tier set, this
// returns { exists: true } without overwriting. To re-tier an existing
// founder, use the admin Airtable view directly.
export async function POST(request: Request) {
  const __authResp = await requireAdmin(request);
  if (__authResp) return __authResp;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const tier = String(body?.tier || '').trim() as ValidTier;
  const name = String(body?.name || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }
  if (!VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `Invalid tier. Must be one of: ${[...VALID_TIERS].join(', ')}` },
      { status: 400 },
    );
  }

  const explicitNumber =
    typeof body?.founderNumber === 'number' && Number.isFinite(body.founderNumber)
      ? Math.floor(body.founderNumber)
      : undefined;
  if (explicitNumber !== undefined && !NUMBERED_TIERS.has(tier)) {
    return NextResponse.json(
      { error: 'founderNumber only valid for Founding 100 / Title Founder' },
      { status: 400 },
    );
  }

  const backerType = body?.backerType === 'Brand' ? 'Brand' : 'Individual';
  const sendWelcome = body?.sendWelcome !== false; // default true
  const wallOptInProvided = typeof body?.wallOptIn === 'boolean';
  const wallOptIn = wallOptInProvided ? !!body.wallOptIn : tier !== 'Herd';
  const reason = String(body?.reason || '').slice(0, 500);
  const nowIso = new Date().toISOString();

  // Look up Consumer by email
  let consumerRow: any = null;
  try {
    const matches = (await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
    )) as any[];
    consumerRow = matches[0] || null;
  } catch (e: any) {
    return NextResponse.json(
      { error: `Email lookup failed: ${e?.message || 'unknown'}` },
      { status: 500 },
    );
  }

  // Idempotency: if they already have a tier, bail rather than overwrite
  if (consumerRow && consumerRow['Founder Tier']) {
    return NextResponse.json({
      exists: true,
      consumerId: consumerRow.id,
      tier: consumerRow['Founder Tier'],
      founderNumber: consumerRow['Founder Number'] || null,
      message: `${email} is already ${consumerRow['Founder Tier']}${consumerRow['Founder Number'] ? ` #${consumerRow['Founder Number']}` : ''}. No change.`,
    });
  }

  // Compute Founder Number for numbered tiers
  let founderNumber: number | undefined = explicitNumber;
  if (NUMBERED_TIERS.has(tier) && founderNumber === undefined) {
    try {
      const sameTier = (await getAllRecords(
        TABLES.CONSUMERS,
        `{Founder Tier} = "${escapeAirtableValue(tier)}"`,
      )) as any[];
      founderNumber = sameTier.length + 1;
    } catch {
      // Fall through — leave undefined, admin can fill manually
    }
  }

  const founderFields: any = {
    'Founder Tier': tier,
    'Subscribed At': nowIso,
    // Comped backers get $0 paid amount. The Notes field carries the reason
    // so the audit trail is preserved — no schema change needed.
    'Tier Amount Paid': 0,
    'Backer Type': backerType,
    // Subscription Status: 'active' so downstream filters that look for
    // active backers (e.g. founder cancellation cron) don't skip comped
    // rows. Tier Amount Paid = 0 is the canonical comp signal.
    'Subscription Status': 'active',
    'Wall Opt-In': wallOptIn,
  };
  if (founderNumber !== undefined) {
    founderFields['Founder Number'] = founderNumber;
  }

  let consumerId: string;
  if (consumerRow) {
    consumerId = consumerRow.id;
    const existingNotes = String(consumerRow['Notes'] || '');
    const compNote = `[COMPED ${nowIso.slice(0, 10)} · ${tier}${founderNumber ? ` #${founderNumber}` : ''}${reason ? ` · ${reason}` : ''}]`;
    founderFields['Notes'] = existingNotes ? `${existingNotes}\n${compNote}` : compNote;
    try {
      await updateRecord(TABLES.CONSUMERS, consumerId, founderFields);
    } catch (e: any) {
      return NextResponse.json(
        { error: `Update failed: ${e?.message || 'unknown'}` },
        { status: 500 },
      );
    }
  } else {
    // Create a fresh Consumer row. Fall back to email local-part for name.
    const fullName = name || email.split('@')[0];
    const compNote = `[COMPED ${nowIso.slice(0, 10)} · ${tier}${founderNumber ? ` #${founderNumber}` : ''}${reason ? ` · ${reason}` : ''}]`;
    try {
      const created = await createRecord(TABLES.CONSUMERS, {
        ...founderFields,
        Email: email,
        'Full Name': fullName,
        Source: 'admin-comp',
        Status: 'Approved',
        Notes: compNote,
      });
      consumerId = (created as any).id;
    } catch (e: any) {
      return NextResponse.json(
        { error: `Create failed: ${e?.message || 'unknown'}` },
        { status: 500 },
      );
    }
  }

  // Welcome email — non-fatal. Skip if caller opted out.
  let welcomeSent = false;
  if (sendWelcome) {
    try {
      const firstName = (name || email.split('@')[0]).split(' ')[0];
      await sendFoundingHerdWelcome({
        tier,
        firstName,
        email,
        founderNumber,
        amountPaid: 0,
      });
      await updateRecord(TABLES.CONSUMERS, consumerId, {
        'Founder Welcome Sent At': new Date().toISOString(),
      });
      welcomeSent = true;
    } catch (e) {
      console.error('[comp] welcome email failed:', e);
    }
  }

  // Telegram alert — non-fatal. Reuses the same backer-alert helper as the
  // Stripe path so the Telegram cockpit shows comped + paid backers in the
  // same surface.
  try {
    const { sendTelegramFounderBacker } = await import('@/lib/telegram');
    await sendTelegramFounderBacker({
      email,
      name: (name || email.split('@')[0]).split(' ')[0],
      tier,
      founderNumber,
      amountCents: 0,
      isLifetime: NUMBERED_TIERS.has(tier),
      consumerId,
      isComped: true,
    });
  } catch (e) {
    console.error('[comp] Telegram alert failed:', e);
  }

  return NextResponse.json({
    ok: true,
    consumerId,
    tier,
    founderNumber: founderNumber ?? null,
    wallOptIn,
    welcomeSent,
  });
}
