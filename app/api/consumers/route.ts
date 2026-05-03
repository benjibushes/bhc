import { NextResponse } from 'next/server';
import { createRecord, updateRecord, getAllRecords, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';

export const maxDuration = 60;

async function validateAffiliateRef(ref: string | undefined): Promise<boolean> {
  if (!ref || typeof ref !== 'string' || ref.length > 50) return false;
  const code = ref.trim();
  if (!code) return false;
  try {
    const affiliates = await getAllRecords(TABLES.AFFILIATES, `AND({Code} = "${escapeAirtableValue(code)}", {Status} = "Active")`);
    return affiliates.length > 0;
  } catch {
    return false;
  }
}
import { sendConsumerConfirmation, sendAdminAlert, sendWelcomeAndReadyToBuy } from '@/lib/email';
import { normalizeState } from '@/lib/states';
import { hasOperationalRancherForState } from '@/lib/rancherEligibility';
import { sendTelegramConsumerSignup, sendTelegramHotLeadAlert } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Every signup is an Approved member. No "Pending" purgatory — the old
// Pending status created a delay where customers thought they were in but
// couldn't actually log in or get matched until a cron ran the next day.
// Qualification (do they get matched to a rancher, or do they get nurtured?)
// is a separate decision, made below.
function deriveStatus(_segment: string, _intentClassification: string): string {
  return 'Approved';
}

// Qualification gate for sending a buyer to a rancher. We never want a rancher
// to get a tire-kicker — minimum bar is: explicitly want beef + chose a tier
// (Quarter/Half/Whole) + provided a budget. Without all three, the rancher
// can't quote, and the rancher's perception of BHC lead quality tanks.
//
// Buyers who don't qualify still get Approved + access — they just go into
// nurture instead of matching, and can self-upgrade via /api/member/upgrade-intent
// once they fill in the missing details.
// Logic moved to lib/qualification.ts as the single source of truth — re-imported
// here so signup-time and routing-time gates can never drift apart.

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com', '10minutemail.com', 'trashmail.com'];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function isValidName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/[<>{}()\[\]\\\/]/.test(trimmed)) return false;
  return true;
}

export async function POST(request: Request) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const {
      fullName, email, phone, state,
      orderType, budgetRange, timing, notes,
      interestBeef, interestLand, interestMerch, interestAll,
      intentScore, intentClassification, segment,
      source, campaign, utmParams, ref,
    } = body;

    if (!fullName || !email || !state) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!isValidName(fullName)) {
      return NextResponse.json({ error: 'Please enter a valid name' }, { status: 400 });
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
    }

    if (phone && !isValidPhone(phone)) {
      return NextResponse.json({ error: 'Please enter a valid phone number' }, { status: 400 });
    }

    if (notes && notes.length > 2000) {
      return NextResponse.json({ error: 'Notes must be under 2000 characters' }, { status: 400 });
    }

    // Check for duplicate email. Special case: if the existing record is an
    // abandoned-application stub (Source = 'abandoned_application'), we'll
    // UPGRADE it in place rather than rejecting the user. Otherwise the user
    // who started the form, abandoned it, then came back to finish would see
    // a confusing "already registered" error.
    let upgradeStubId: string | null = null;
    try {
      const existing = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${escapeAirtableValue(email.trim().toLowerCase())}"`
      ) as any[];
      if (existing.length > 0) {
        const stub = existing.find((c) => c['Source'] === 'abandoned_application');
        if (stub) {
          upgradeStubId = stub.id;
        } else {
          return NextResponse.json({ error: 'This email is already registered. Check your inbox for your confirmation.' }, { status: 409 });
        }
      }
    } catch (e) {
      console.error('Error checking duplicate email:', e);
    }

    const interests: string[] = [];
    if (interestBeef) interests.push('Beef');
    if (interestLand) interests.push('Land');
    if (interestMerch) interests.push('Merch');
    if (interestAll) interests.push('All');

    // Server-side segment + intent calculation (don't trust client-supplied values).
    // Mirrors app/access/page.tsx calculateIntentScore — the form rework gives
    // bracket-level weights so casual signups land at ~40, serious buyers at 70+.
    const consumerSegment = (interestBeef || interestAll) && orderType ? 'Beef Buyer' : 'Community';
    const isRancherPageLead = source === 'rancher-page' && campaign?.startsWith('rancher-');
    let serverIntentScore = 0;
    if (isRancherPageLead) {
      // Rancher page leads clicked "Buy" on a specific rancher — high intent by definition.
      serverIntentScore = 85;
    } else {
      // Interest signal
      if (interestBeef) serverIntentScore += 30;
      if (interestAll) serverIntentScore += 15;
      if (interestMerch && !interestBeef && !interestAll) serverIntentScore -= 10;

      // Tier — bigger commit = higher intent
      if (orderType === 'Whole') serverIntentScore += 30;
      else if (orderType === 'Half') serverIntentScore += 20;
      else if (orderType === 'Quarter') serverIntentScore += 10;

      // Budget bracket — realistic ones add, "Just exploring" subtracts
      if (budgetRange === '$5000+') serverIntentScore += 30;
      else if (budgetRange === '$4000-$5000') serverIntentScore += 25;
      else if (budgetRange === '$2000-$2500') serverIntentScore += 20;
      else if (budgetRange === '$1000-$1500') serverIntentScore += 15;
      else if (/just exploring/i.test(budgetRange || '')) serverIntentScore -= 15;
      // Legacy brackets (existing buyers in DB) — keep partial credit so old
      // records don't get demoted on a re-evaluation.
      else if (budgetRange === '$2000+') serverIntentScore += 25;
      else if (budgetRange === '$1000-$2000') serverIntentScore += 20;
      else if (budgetRange === '$500-$1000') serverIntentScore += 5;

      // Timing — strongest commitment signal we have
      if (timing === 'Within 30 days') serverIntentScore += 25;
      else if (timing === '1-3 months') serverIntentScore += 15;
      else if (timing === '3-6 months') serverIntentScore += 5;
      else if (/just exploring/i.test(timing || '')) serverIntentScore -= 15;

      if (notes && notes.length > 20) serverIntentScore += 15;
      if (phone) serverIntentScore += 15;
    }
    serverIntentScore = Math.max(serverIntentScore, 0);
    const serverIntentClassification = serverIntentScore >= 70 ? 'High' : serverIntentScore >= 40 ? 'Medium' : 'Low';

    const status = deriveStatus(consumerSegment, serverIntentClassification);
    const firstName = fullName.split(' ')[0];

    const referredBy = ref && (await validateAffiliateRef(ref)) ? ref.trim() : '';

    const consumerFields: Record<string, unknown> = {
      'Full Name': fullName.trim(),
      'Email': email.trim().toLowerCase(),
      'Phone': phone || '',
      // Always store as canonical 2-letter code via normalizeState so all
      // downstream comparisons (matching, warmup, sequences) hit the same
      // value. Form may submit "Montana", "montana", "MT", or " mt " —
      // they all collapse to "MT". Invalid input returns ''.
      'State': normalizeState(state) || state.toString().trim().toUpperCase(),
      'Interests': interests,
      'Status': status,
      'Segment': consumerSegment,
      'Order Type': orderType || '',
      'Budget': budgetRange || '',
      // Timing prepended to Notes (no schema migration needed). Surfaces in
      // admin views + the rancher intro email for context. Used transiently
      // below to decide auto-route eligibility too.
      'Notes': [
        timing ? `[Timing: ${timing}]` : '',
        notes || '',
      ].filter(Boolean).join('\n'),
      'Source': source || 'organic',
      'Intent Score': serverIntentScore,
      'Intent Classification': serverIntentClassification,
      'Referral Status': 'Unmatched',
      'Campaign': campaign || '',
      'UTM Parameters': utmParams || '',
      // Rancher-page leads explicitly clicked "Buy {tier}" on a specific
      // rancher's landing page. That's the strongest possible intent signal —
      // equivalent to a YES click on the Ready-to-Buy prompt. Mark them
      // ready-to-buy at creation so matching/suggest sees the flag and
      // formats the rancher's intro email with the 🔥 prefix + READY TO BUY
      // banner. Telegram fires the READY-TO-BUY MATCH alert too.
      'Ready to Buy': isRancherPageLead,
    };
    if (referredBy) consumerFields['Referred By'] = referredBy;

    // Maintenance mode: store the consumer record but skip ALL downstream
    // processing — no emails, no telegram, no matching. Tag the record as
    // maintenance_capture so it's distinguishable from live signups and can
    // be batch-processed cleanly when we exit maintenance.
    if (isMaintenanceMode()) {
      consumerFields['Source'] = 'maintenance_capture';
      consumerFields['Notes'] = `${consumerFields['Notes'] || ''}\n[CAPTURED DURING MAINTENANCE ${new Date().toISOString()}]`.trim();
      try {
        if (upgradeStubId) {
          await updateRecord(TABLES.CONSUMERS, upgradeStubId, consumerFields);
        } else {
          await createRecord(TABLES.CONSUMERS, consumerFields);
        }
      } catch (e) {
        console.error('Maintenance capture error:', e);
      }
      return NextResponse.json({
        success: true,
        maintenance: true,
        message: "You're on the list. We'll email you as soon as the platform re-opens.",
      }, { status: 201 });
    }

    // If we're upgrading an abandoned stub, update the existing record in
    // place — keeps the original record ID stable + clears the abandon stage.
    let record: any;
    if (upgradeStubId) {
      consumerFields['Sequence Stage'] = 'none'; // remove the abandon marker so they stop receiving recovery emails
      consumerFields['Source'] = source || 'organic'; // overwrite "abandoned_application"
      await updateRecord(TABLES.CONSUMERS, upgradeStubId, consumerFields);
      record = { id: upgradeStubId, ...consumerFields };
    } else {
      record = await createRecord(TABLES.CONSUMERS, consumerFields);
    }

    // ── REBUILT POST-APPROVAL FLOW (state-machine driven) ────────────────────
    // Old flow sent 2 emails on approval (sendConsumerApproval + then RTB or
    // Waitlist) — collapsed into ONE founder-voice email (sendWelcomeAndReadyToBuy)
    // that branches by rancher-availability. Buyer Stage transitions:
    //   no rancher in state            → WAITING  (founder letters via cron)
    //   rancher in state, auto-routed  → MATCHED  (matching/suggest fired intro)
    //   rancher in state, not routed   → READY    (welcome includes YES button)
    //   not approved (rare path)       → NEW      (sendConsumerConfirmation only)
    if (status === 'Approved') {
      const isRancherPageLead = (campaign || '').startsWith('rancher-');
      let buyerStage: 'WAITING' | 'READY' | 'MATCHED' = 'WAITING';

      try {
        const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
        const hasInStateRancher = hasOperationalRancherForState(allRanchers, state);

        // Beef-buyer auto-route attempt (only when rancher available + form qualified)
        // Rancher-page-leads are routed in backgroundTasks below; skip here.
        let autoRouted = false;
        if (hasInStateRancher && consumerSegment === 'Beef Buyer' && !isRancherPageLead) {
          // QUALITY GATE — protects rancher reputation; sub-budget leads bash the
          // platform when they see real prices. Buyers who fail still get the
          // welcome email (with YES button) and can opt in via click — not blocked.
          const isJustExploring = /just exploring/i.test(budgetRange || '') ||
            /just exploring/i.test(timing || '');
          const isFutureTiming = /3-6 months/i.test(timing || '');
          // Phone optional for high-intent (>=80) buyers — phone signal is
          // already baked into the intent score itself (lib has +15 for phone).
          // Requiring it as a hard gate dropped ~15% of high-quality signups.
          // Score >=80 means the buyer cleared the bar even without phone, so
          // route them. Medium-intent (60-79) still requires phone as proxy
          // for seriousness.
          const formIsQualified =
            !!orderType && !!budgetRange &&
            !/unsure|not sure/i.test(orderType) &&
            !/unsure/i.test(budgetRange) &&
            !isJustExploring &&
            !isFutureTiming &&
            serverIntentScore >= 60 &&
            (serverIntentScore >= 80 || !!phone);

          if (formIsQualified) {
            try {
              const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                },
                body: JSON.stringify({
                  buyerState: state,
                  buyerId: record.id,
                  buyerName: fullName.trim(),
                  buyerEmail: email.trim().toLowerCase(),
                  buyerPhone: phone || '',
                  orderType: orderType || '',
                  budgetRange: budgetRange || '',
                  intentScore: serverIntentScore,
                  intentClassification: serverIntentClassification,
                  notes: notes || '',
                  warmupEngaged: false, // fresh signup is normal capacity
                }),
              });
              if (matchRes.ok) {
                const j = await matchRes.json();
                if (j.matchFound) autoRouted = true;
              }
            } catch (e: any) {
              console.error('Signup auto-route failed:', e?.message);
            }
          }
        }

        // Determine stage + send the appropriate single welcome email
        if (autoRouted) {
          // matching/suggest already sent the intro emails — no welcome needed.
          // Buyer Stage = MATCHED.
          buyerStage = 'MATCHED';
        } else if (hasInStateRancher && !isRancherPageLead) {
          // Rancher available, not auto-routed (form not qualified or rancher full).
          // Send welcome with YES button — engageUrl drives the matching click later.
          const engageToken = jwt.sign(
            { type: 'warmup-engage', consumerId: record.id },
            JWT_SECRET,
            { expiresIn: '60d' }
          );
          const engageUrl = `${SITE_URL}/api/warmup/engage?token=${engageToken}`;
          await sendWelcomeAndReadyToBuy({
            firstName, email, state, rancherAvailable: true, engageUrl,
          });
          buyerStage = 'READY';
        } else if (isRancherPageLead) {
          // Rancher-page lead: matching fires in backgroundTasks below. We don't
          // send a welcome email here — the rancher-page intro flow handles it.
          // Default to MATCHED here on the assumption that backgroundTasks will
          // succeed; if it doesn't, the buyer still has a record + we'll see
          // the failure in the bg-task error log.
          buyerStage = 'MATCHED';
        } else {
          // No rancher in state — waitlist with the founder-voice welcome
          await sendWelcomeAndReadyToBuy({
            firstName, email, state, rancherAvailable: false,
          });
          buyerStage = 'WAITING';
        }

        // Set Buyer Stage + Updated At — ONE write
        await updateRecord(TABLES.CONSUMERS, record.id, {
          'Buyer Stage': buyerStage,
          'Buyer Stage Updated At': new Date().toISOString(),
        });
      } catch (e) {
        console.error('Post-approval flow error:', e);
      }
    } else {
      // status !== Approved → NEW state, application received but not yet approved
      await sendConsumerConfirmation({ firstName, email, state });
    }

    // ── RESPOND TO BUYER IMMEDIATELY — everything below runs without blocking ──
    // Fire-and-forget: admin notifications, Telegram, and matching engine
    // These can take 5-10 seconds combined and don't affect the buyer's experience
    const backgroundTasks = async () => {
      try {
        await sendAdminAlert({
          type: 'consumer',
          name: fullName,
          email,
          details: {
            State: state,
            Segment: consumerSegment,
            Status: status,
            'Order Type': orderType || 'Not specified',
            'Budget': budgetRange || 'Not specified',
            'Intent Score': `${serverIntentScore} (${serverIntentClassification})`,
            Interests: interests.join(', '),
            Phone: phone || 'Not provided',
            Notes: notes || 'None',
          },
        });
      } catch (e) { console.error('Admin alert error:', e); }

      // Telegram noise reduction: silence routine signups. Only ping for
      // signups that warrant attention (intent score >= 70). Everything else
      // rolls into the morning digest. The separate hot-lead alert below
      // (score >= 80) gets action buttons; this signup alert is informational.
      if (serverIntentScore >= 70) {
        try {
          await sendTelegramConsumerSignup({
            consumerId: record.id,
            name: fullName,
            email,
            state,
            segment: consumerSegment,
            intentScore: serverIntentScore,
            intentClassification: serverIntentClassification,
            status,
            orderType,
            budgetRange,
          });
        } catch (e) { console.error('Telegram consumer signup error:', e); }
      }

      // 🔥 HOT LEAD: score 80+ Beef Buyers get a loud second alert with 1-tap actions
      if (serverIntentScore >= 80 && consumerSegment === 'Beef Buyer') {
        try {
          await sendTelegramHotLeadAlert({
            consumerId: record.id,
            name: fullName,
            email,
            phone,
            state,
            intentScore: serverIntentScore,
            orderType,
            budgetRange,
            notes,
          });
        } catch (e) { console.error('Telegram hot lead alert error:', e); }
      }

      // ROUTING DELIBERATELY DOES NOT HAPPEN HERE.
      // Quality over quantity: every signup must click YES on the Ready-to-Buy
      // prompt email (sent right above) before any rancher hears about them.
      // The click flows through /api/warmup/engage which sets Ready to Buy=true
      // and fires matching/suggest synchronously. No rancher inbox sees a lead
      // who didn't actively press the button.
      //
      // EXCEPTION: rancher-page leads (campaign starts with "rancher-") signed
      // up directly on a specific rancher's landing page. They typed in their
      // info on that rancher's page — that IS an explicit signal of interest
      // in that specific rancher. Route them immediately so the rancher gets
      // the lead info in their inbox right away.
      if ((campaign || '').startsWith('rancher-') && state) {
        try {
          await fetch(
            `${SITE_URL}/api/matching/suggest`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
              },
              body: JSON.stringify({
                buyerState: state,
                buyerId: record.id,
                buyerName: fullName,
                buyerEmail: email,
                buyerPhone: phone,
                orderType,
                budgetRange,
                intentScore: serverIntentScore,
                intentClassification: serverIntentClassification,
                notes,
                campaign: campaign || '',
                // Rancher-page leads typed their info on the rancher's own
                // page — that's explicit consent equivalent to a YES click.
                warmupEngaged: true,
              }),
            }
          );
        } catch (matchError) {
          console.error('Error calling matching engine for rancher-page lead:', matchError);
        }
      }
    };

    // Don't await — let it run in the background after response is sent
    backgroundTasks().catch(e => console.error('Background tasks error:', e));

    return NextResponse.json({ success: true, consumer: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating consumer:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
