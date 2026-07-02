// POST /api/member/preferences — buyer matching preference (2026-07-01
// founder directive: nationwide opt-in/opt-out).
//
// Writes EXACTLY ONE whitelisted Consumers field — 'Nationwide Preference'
// (singleSelect: 'nationwide-ok' | 'local-only') — for the session's own
// consumer record. The field name + option values come from server-side
// constants (lib/nationwidePreference.ts); the client sends only a boolean,
// so nothing in the request body can smuggle another field or value.
//
// Auth mirrors the other member routes (upgrade-intent pattern): origin
// allowlist (CSRF) + resolveBuyerSession cookie. Ownership is structural —
// the record id written is session.consumerId, never client-supplied.
//
// Callers:
//   1. Funnel waitlist reveal choice ("match me with a shipping rancher?").
//      Sends { nationwide, refireMatching: true } — after an opt-in we
//      re-fire matching/suggest in-process (same B4 pattern as /api/qualify)
//      so the buyer may match immediately instead of waiting for the
//      waitlist-retry cron. The buyer has the bhc-member-auth cookie here:
//      /api/qualify mints it on every quiz pass (HOT-PATH SESSION), and the
//      choice UI only renders for qualified buyers.
//   2. /member "Matching preference" toggle. Sends { nationwide } only.

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { resolveBuyerSession } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import {
  NATIONWIDE_PREFERENCE_FIELD,
  NATIONWIDE_OK,
  LOCAL_ONLY,
} from '@/lib/nationwidePreference';
import { isDepositCapableMatch } from '@/lib/depositOptionality';
import { generateMemberLoginToken } from '@/lib/secrets';
// In-process invocation of the matching engine — same import-the-handler
// pattern /api/qualify uses (B4, 2026-07-01) so the re-fire costs zero
// network hops and shares the lambda.
import { POST as matchingSuggestPOST } from '@/app/api/matching/suggest/route';

export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function POST(request: Request) {
  try {
    const originCheck = checkOriginGuard(request);
    if (!originCheck.ok && originCheck.response) return originCheck.response;
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const consumerId = session.consumerId;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (typeof body?.nationwide !== 'boolean') {
      return NextResponse.json({ error: 'nationwide must be true or false' }, { status: 400 });
    }
    const preference = body.nationwide ? NATIONWIDE_OK : LOCAL_ONLY;
    const refire = body.nationwide === true && body.refireMatching === true;

    // The single whitelisted write. typecast rides along inside updateRecord;
    // the singleSelect options exist in Airtable ('nationwide-ok'/'local-only')
    // so this is a plain option pick, never an option-create.
    try {
      await updateRecord(TABLES.CONSUMERS, consumerId, {
        [NATIONWIDE_PREFERENCE_FIELD]: preference,
      });
    } catch (e: any) {
      console.error('[member/preferences] preference write failed:', e?.message);
      return NextResponse.json(
        { error: 'Could not save your preference — please try again.' },
        { status: 500 },
      );
    }

    // ── Optional re-fire (funnel opt-in path only) ─────────────────────────
    // The buyer just said "yes, match me with a shipping rancher" from the
    // waitlist reveal — try right now instead of waiting for the retry cron.
    // Every existing matching guard still applies (qualified gate, dedup,
    // eligibility, capacity); the ONLY thing that changed is the preference
    // we just wrote, which the fallback reads fresh from the consumer row.
    let match: {
      rancher: { id: string; name: string; state: string };
      referralId: string | null;
      pricingModel: string;
    } | null = null;

    if (refire) {
      try {
        const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId);
        if (consumer?.['Email'] && consumer?.['State']) {
          const matchRes = await matchingSuggestPOST(new Request(`${SITE_URL}/api/matching/suggest`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
            },
            body: JSON.stringify({
              buyerState: consumer['State'],
              buyerId: consumerId,
              buyerName: consumer['Full Name'] || '',
              buyerEmail: consumer['Email'],
              buyerPhone: consumer['Phone'] || '',
              orderType: consumer['Order Type'] || '',
              budgetRange: consumer['Budget'] || '',
              intentScore: consumer['Intent Score'] || 0,
              intentClassification: consumer['Intent Classification'] || 'High',
              notes:
                (consumer['Notes'] || '') +
                `\n[NATIONWIDE OPT-IN ${new Date().toISOString()}] buyer chose nationwide shipping from waitlist reveal`,
              // Same flags as the /api/qualify fire this re-run replaces:
              // the explicit opt-in click is the engagement signal (hot-lead
              // capacity allowance), and tier_v2 buyer intro stays suppressed
              // (Ben/deposit-email runs that play, not a rancher text).
              warmupEngaged: true,
              skipBuyerIntro: true,
            }),
          }));
          const j: any = await matchRes.json().catch(() => ({}));
          if (matchRes.ok && (j.matchFound || j.alreadyActive) && j.suggestedRancher) {
            const referralId: string | null = j.referralId || null;
            // Pricing model drives the reveal mode (deposit CTA vs call).
            let pricingModel = 'legacy';
            let depositAmount: number | null = null;
            let nextProcessingDate = '';
            try {
              const rancher: any = await getRecordById(TABLES.RANCHERS, j.suggestedRancher.id);
              pricingModel = String(rancher?.['Pricing Model'] || 'legacy');
              nextProcessingDate = String(rancher?.['Next Processing Date'] || '');
              if (pricingModel === 'tier_v2') {
                const tier = String(consumer['Order Type'] || '');
                const depositField =
                  tier === 'Quarter' ? 'Quarter Deposit'
                  : tier === 'Half' ? 'Half Deposit'
                  : tier === 'Whole' ? 'Whole Deposit'
                  : '';
                if (depositField) depositAmount = Number(rancher?.[depositField]) || null;
              }
            } catch (e: any) {
              console.warn('[member/preferences] rancher lookup failed:', e?.message);
            }
            match = {
              rancher: {
                id: String(j.suggestedRancher.id || ''),
                name: String(j.suggestedRancher.name || ''),
                state: String(j.suggestedRancher.state || ''),
              },
              referralId,
              pricingModel,
            };

            // Email parity with the quiz-pass match moment (/api/qualify
            // after() block): deposit-capable → deposit-first invite with a
            // member-verify magic link; tier_v2 without a referral → call
            // invite. Legacy matches already got the standard buyer intro
            // from matching itself (skipBuyerIntro only suppresses tier_v2).
            // Same score>=60 guard; deferred past the response flush.
            const score = Number(consumer['Qualification Score'] || 0);
            const rancherName = match.rancher.name;
            if (score >= 60 && consumer['Email']) {
              const buyerEmail = String(consumer['Email']);
              const buyerFirstName = String(consumer['Full Name'] || 'there').split(' ')[0];
              after(async () => {
                try {
                  if (isDepositCapableMatch(pricingModel, referralId)) {
                    const magicToken = generateMemberLoginToken(consumerId, buyerEmail);
                    const nextPath = `/checkout/${referralId}/deposit`;
                    const depositMagicLinkUrl = `${SITE_URL}/api/auth/member/verify?token=${magicToken}&next=${encodeURIComponent(nextPath)}`;
                    const { sendQuizCompleteDepositInvite } = await import('@/lib/emailMinimal');
                    await sendQuizCompleteDepositInvite({
                      to: buyerEmail,
                      firstName: buyerFirstName,
                      score,
                      depositMagicLinkUrl,
                      rancherName,
                      depositAmount,
                      nextProcessingDate,
                    });
                  } else if (pricingModel === 'tier_v2') {
                    const { sendQuizCompleteCalInvite } = await import('@/lib/emailMinimal');
                    await sendQuizCompleteCalInvite({
                      to: buyerEmail,
                      firstName: buyerFirstName,
                      score,
                    });
                  }
                } catch (e: any) {
                  console.warn('[member/preferences] match invite email failed:', e?.message);
                }
              });
            }
          }
        }
      } catch (e: any) {
        // Re-fire is best-effort — the preference is saved either way and the
        // waitlist-retry cron picks the buyer up. Never fail the response.
        console.error('[member/preferences] matching re-fire failed:', e?.message);
      }
    }

    return NextResponse.json({ success: true, preference, match });
  } catch (error: any) {
    console.error('[member/preferences] error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
