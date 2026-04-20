import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail, sendBuyerIntroNotification } from '@/lib/email';
import { normalizeState, normalizeStates } from '@/lib/states';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(request: Request) {
  try {
    // Maintenance short-circuit: don't match anyone while the platform is paused.
    // Callers (signup, reorder, waitlist retry) all early-return in maintenance mode,
    // so hitting this is a bug — return 503 so it's visible in logs.
    if (isMaintenanceMode()) {
      return NextResponse.json({
        success: false,
        paused: true,
        error: 'Matching is paused while the platform is in maintenance mode.',
      }, { status: 503 });
    }

    // Allow admin (via cookie) or internal calls (via shared secret header)
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const authHeader = request.headers.get('x-internal-secret') || '';
    const cookieStore = await cookies();
    const adminCookie = cookieStore.get('bhc-admin-auth');
    const isAdmin = adminCookie?.value === 'authenticated';
    const isInternal = internalSecret && authHeader === internalSecret;

    if (!isAdmin && !isInternal) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      buyerState, buyerId, buyerName, buyerEmail, buyerPhone,
      orderType, budgetRange, intentScore, intentClassification, notes,
      campaign,
      // When re-routing a lead a rancher passed on, the calling code passes
      // the previous rancher's ID(s) so the matching engine doesn't recommend
      // them again. Without this, lead resurrection sends the same lead back
      // to the rancher who just rejected it.
      excludeRancherIds,
    } = body;
    const excludeIds = new Set<string>(Array.isArray(excludeRancherIds) ? excludeRancherIds : []);

    if (!buyerState || !buyerId) {
      return NextResponse.json({ error: 'buyerState and buyerId are required' }, { status: 400 });
    }

    // Normalize buyer state to canonical 2-letter code (handles "Montana" → "MT")
    const normalizedBuyerState = normalizeState(buyerState);
    if (!normalizedBuyerState) {
      return NextResponse.json({ error: `Unrecognized buyer state: ${buyerState}` }, { status: 400 });
    }

    // ── Guard: skip if buyer already has an active referral ────────────────
    // Prevents duplicate referrals when waitlisted retry re-calls this endpoint.
    if (buyerEmail) {
      try {
        const existingRefs = await getAllRecords(
          TABLES.REFERRALS,
          `AND({Buyer Email} = "${buyerEmail.trim().toLowerCase()}", OR({Status} = "Intro Sent", {Status} = "Rancher Contacted", {Status} = "Negotiation"))`
        ) as any[];
        if (existingRefs.length > 0) {
          return NextResponse.json({
            success: true,
            matchFound: true,
            alreadyActive: true,
            referralId: existingRefs[0].id,
            message: `Buyer already has an active referral (${existingRefs[0]['Status']})`,
          });
        }
      } catch (e) {
        console.error('Error checking existing referrals:', e);
        // Continue anyway — better a duplicate than a missed lead
      }
    }

    const allRanchers: any[] = await getAllRecords(TABLES.RANCHERS);

    // Helper: check if rancher is active, signed, and under capacity.
    // Also excludes any rancher in `excludeRancherIds` — used when re-routing
    // a lead that a rancher just passed on, so the same rancher doesn't get
    // the lead bounced right back to them.
    const isEligibleBase = (r: any) => {
      if (excludeIds.has(r.id)) return false;
      const activeStatus = r['Active Status'] || '';
      const agreementSigned = r['Agreement Signed'] || false;
      const onboardingStatus = r['Onboarding Status'] || '';
      const maxReferrals = r['Max Active Referalls'] || 5;
      const currentReferrals = r['Current Active Referrals'] || 0;
      if (activeStatus !== 'Active') return false;
      if (!agreementSigned) return false;
      if (onboardingStatus && onboardingStatus !== 'Live') return false;
      if (currentReferrals >= maxReferrals) return false;
      return true;
    };

    // Parse a buyer budget range like "<$500", "$500-$1000", "$1000-$2000", "$2000+", "Unsure"
    // into a numeric ceiling. Unknown/unparseable → Infinity (no filter applied).
    const parseBudgetCeiling = (range: string): number => {
      if (!range) return Infinity;
      const r = range.trim().toLowerCase();
      if (r === 'unsure' || r === 'not sure' || r === '') return Infinity;
      if (r.startsWith('<')) {
        const n = parseInt(r.replace(/[^0-9]/g, ''), 10);
        return isFinite(n) ? n : Infinity;
      }
      if (r.endsWith('+')) return Infinity; // e.g. "$2000+"
      // Range like "$500-$1000" — take the upper bound.
      const parts = r.split('-');
      if (parts.length === 2) {
        const upper = parseInt(parts[1].replace(/[^0-9]/g, ''), 10);
        if (isFinite(upper)) return upper;
      }
      const single = parseInt(r.replace(/[^0-9]/g, ''), 10);
      return isFinite(single) ? single : Infinity;
    };

    // Helper: does the rancher's pricing fit the buyer's order type + budget?
    // - If the rancher hasn't set prices at all, don't block (still a valid match —
    //   they handle pricing in conversation).
    // - If the buyer wants a specific tier, check THAT tier's price against their budget.
    // - If the buyer hasn't picked a tier, check the cheapest configured tier.
    // - If the buyer's budget can't fit ANY configured tier, filter the rancher out.
    const budgetCeiling = parseBudgetCeiling(budgetRange || '');
    const normalizedOrderType = (orderType || '').toString().toLowerCase();
    const isPriceFit = (r: any): boolean => {
      const q = Number(r['Quarter Price']) || 0;
      const h = Number(r['Half Price']) || 0;
      const w = Number(r['Whole Price']) || 0;
      const anyPriced = q > 0 || h > 0 || w > 0;
      // Rancher has no pricing configured yet — don't filter out.
      if (!anyPriced) return true;
      // Budget is unbounded — any priced rancher fits.
      if (!isFinite(budgetCeiling)) return true;

      const tierPrice = (() => {
        if (normalizedOrderType.includes('quarter')) return q;
        if (normalizedOrderType.includes('half')) return h;
        if (normalizedOrderType.includes('whole')) return w;
        // "Not Sure" / blank — use cheapest configured tier.
        const configured = [q, h, w].filter(p => p > 0);
        return configured.length > 0 ? Math.min(...configured) : 0;
      })();

      // If the specifically-requested tier isn't priced, fall back to cheapest configured.
      const effective = tierPrice > 0
        ? tierPrice
        : Math.min(...[q, h, w].filter(p => p > 0));
      return effective <= budgetCeiling;
    };

    // ── PRIORITY: If lead came from a specific rancher's page, assign to THAT rancher ──
    // Always assign to the page rancher — even at capacity. They clicked "Buy" on THIS rancher.
    // Only require Active + Agreement Signed (skip capacity check for direct page leads).
    let directMatchRancher: any = null;
    let matchType: string | null = null;
    if (campaign && campaign.startsWith('rancher-')) {
      const rancherSlug = campaign.replace('rancher-', '');
      directMatchRancher = allRanchers.find((r: any) => {
        const slug = r['Slug'] || '';
        const activeStatus = r['Active Status'] || '';
        const agreementSigned = r['Agreement Signed'] || false;
        const onboardingStatus = r['Onboarding Status'] || '';
        return slug === rancherSlug && activeStatus === 'Active' && agreementSigned &&
          (!onboardingStatus || onboardingStatus === 'Live');
      });
      if (directMatchRancher) {
        matchType = 'direct';
      }
    }

    let topMatch: any = null;

    if (directMatchRancher) {
      // Lead came from this rancher's page — assign directly to them
      topMatch = directMatchRancher;
    } else {
      // Standard matching: local first, then nationwide.
      // Price-fit filter runs AFTER state/capacity so we still know *why* a
      // match didn't happen (we can fall back to unfiltered pool for a
      // "no priced rancher in budget" log-only outcome below).
      const localEligibleAll = allRanchers.filter((r: any) => {
        if (!isEligibleBase(r)) return false;
        // Normalize rancher's primary state + every "States Served" entry to
        // 2-letter codes BEFORE comparing. Old behavior just uppercased, so
        // "Montana" never matched buyer state "MT". This is the root cause
        // that left waitlisted customers stranded forever.
        const rState = normalizeState(r['State']);
        const served = normalizeStates(r['States Served']);
        return rState === normalizedBuyerState || served.includes(normalizedBuyerState);
      });
      const localEligible = localEligibleAll.filter(isPriceFit);

      const nationwideEligibleAll = allRanchers.filter((r: any) => {
        if (!isEligibleBase(r)) return false;
        return r['Ships Nationwide'] === true || r['Ships Nationwide'] === 1;
      });
      const nationwideEligible = nationwideEligibleAll.filter(isPriceFit);

      // If price-fit eliminated all candidates but there WERE state-eligible
      // ranchers, log so we can see the budget-gap pattern over time.
      const priceFiltered = localEligibleAll.length > 0 && localEligible.length === 0;
      if (priceFiltered) {
        console.log(`[match] Price filter removed all ${localEligibleAll.length} local ranchers for ${buyerName || buyerId} (budget=${budgetRange}, orderType=${orderType})`);
      }

      const eligible = localEligible.length > 0 ? localEligible : nationwideEligible;
      matchType = localEligible.length > 0 ? 'local' : nationwideEligible.length > 0 ? 'nationwide' : null;

      eligible.sort((a: any, b: any) => {
        const aRefs = a['Current Active Referrals'] || 0;
        const bRefs = b['Current Active Referrals'] || 0;
        if (aRefs !== bRefs) return aRefs - bRefs;

        const aDate = a['Last Assigned At'] ? new Date(a['Last Assigned At']).getTime() : 0;
        const bDate = b['Last Assigned At'] ? new Date(b['Last Assigned At']).getTime() : 0;
        if (aDate !== bDate) return aDate - bDate;

        const aScore = a['Performance Score'] || 50;
        const bScore = b['Performance Score'] || 50;
        return bScore - aScore;
      });

      topMatch = eligible.length > 0 ? eligible[0] : null;
    }

    const referralFields: Record<string, any> = {
      'Buyer': [buyerId],
      'Status': 'Pending Approval',
      'Buyer Name': buyerName || '',
      'Buyer Email': buyerEmail || '',
      'Buyer Phone': buyerPhone || '',
      'Buyer State': normalizedBuyerState,
      'Order Type': orderType || '',
      'Budget Range': budgetRange || '',
      'Intent Score': intentScore || 0,
      'Intent Classification': intentClassification || '',
      'Notes': notes || '',
    };

    if (topMatch) {
      referralFields['Suggested Rancher'] = [topMatch.id];
      referralFields['Suggested Rancher Name'] = topMatch['Operator Name'] || topMatch['Ranch Name'] || '';
      referralFields['Suggested Rancher State'] = topMatch['State'] || '';
      if (matchType === 'direct') {
        referralFields['Match Type'] = 'Direct (Rancher Page)';
      } else if (matchType === 'nationwide') {
        referralFields['Match Type'] = 'Nationwide';
      } else {
        referralFields['Match Type'] = 'Local';
      }
    }

    let referral: any;
    try {
      referral = await createRecord(TABLES.REFERRALS, referralFields);
    } catch (e: any) {
      console.warn('Could not create referral record:', e?.message);
      return NextResponse.json({
        success: false,
        error: 'Referrals table not accessible. Please check Airtable API token permissions.',
        matchFound: !!topMatch,
        suggestedRancher: topMatch ? {
          id: topMatch.id,
          name: topMatch['Operator Name'] || topMatch['Ranch Name'],
          state: topMatch['State'],
        } : null,
      }, { status: 503 });
    }

    // Increment rancher's active referral count so capacity limit works in real-time
    const now = new Date().toISOString();
    if (topMatch) {
      try {
        const currentRefs = topMatch['Current Active Referrals'] || 0;
        const newRefs = currentRefs + 1;
        await updateRecord(TABLES.RANCHERS, topMatch.id, {
          'Current Active Referrals': newRefs,
          'Last Assigned At': now,
        });

        // Capacity alerts
        const maxRefs = topMatch['Max Active Referalls'] || 5;
        const rancherName = topMatch['Operator Name'] || topMatch['Ranch Name'] || 'Unknown';
        const rancherState = topMatch['State'] || 'Unknown';
        if (maxRefs > 0) {
          const capacityPct = newRefs / maxRefs;
          if (newRefs >= maxRefs) {
            // 100% — at capacity
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `🔴 <b>AT CAPACITY:</b> ${rancherName} in ${rancherState} is FULL (${newRefs}/${maxRefs}). New leads in ${rancherState} will waitlist until capacity frees up.`
              );
            } catch (e) {
              console.error('Error sending capacity-full Telegram alert:', e);
            }
          } else if (capacityPct >= 0.8) {
            // 80%+ — warning
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `⚠️ <b>CAPACITY ALERT:</b> ${rancherName} in ${rancherState} is at ${newRefs}/${maxRefs} referrals (80%+). Consider recruiting another rancher in ${rancherState}.`
              );
            } catch (e) {
              console.error('Error sending capacity-warning Telegram alert:', e);
            }
          }
        }
      } catch (e) {
        console.error('Error incrementing rancher referral count:', e);
      }
    }

    // ── AUTO-APPROVE: ALL matches get instant intro (no Telegram wait) ──
    // If a rancher matched, fire intros immediately. No manual approval friction.
    if (topMatch) {
      try {
        // Update referral to Intro Sent immediately
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'Status': 'Intro Sent',
          'Rancher': [topMatch.id],
          'Approved At': now,
          'Intro Sent At': now,
        });

        // Update consumer status
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Referral Status': 'Intro Sent',
        });

        const rancherName = topMatch['Operator Name'] || topMatch['Ranch Name'] || '';
        const rancherEmail = topMatch['Email'] || '';
        const rancherPhone = topMatch['Phone'] || '';
        const matchTypeLabel = matchType === 'direct' ? 'Direct Page Lead' : matchType === 'local' ? 'Local Match' : 'Nationwide Match';

        // Send rancher the buyer's info
        if (rancherEmail) {
          await sendEmail({
            to: rancherEmail,
            subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
              <h1 style="font-family:Georgia,serif;">New Qualified Buyer Lead</h1>
              <p>Hi ${rancherName},</p>
              <p>A qualified buyer in your area just came through BuyHalfCow and has been connected to you:</p>
              <p><strong>Buyer:</strong> ${buyerName}</p>
              <p><strong>Email:</strong> ${buyerEmail}</p>
              ${buyerPhone ? `<p><strong>Phone:</strong> ${buyerPhone}</p>` : ''}
              <p><strong>State:</strong> ${buyerState}</p>
              <p><strong>Order:</strong> ${orderType || 'Not specified'}</p>
              ${budgetRange ? `<p><strong>Budget:</strong> ${budgetRange}</p>` : ''}
              ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
              <p>Reach out within 24 hours to close the sale. Reply-all to keep me in the loop.</p>
              <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow</p>
            </div>`,
          });
        }

        // Send buyer the rancher's info
        if (buyerEmail) {
          const buyerToken = jwt.sign(
            { type: 'member-login', consumerId: buyerId, email: buyerEmail.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const buyerLoginUrl = `${SITE_URL}/member/verify?token=${buyerToken}`;
          const buyerFirstName = (buyerName || '').split(' ')[0] || 'there';
          await sendBuyerIntroNotification({
            firstName: buyerFirstName,
            email: buyerEmail,
            rancherName,
            rancherEmail,
            rancherPhone,
            rancherSlug: topMatch['Slug'] || '',
            loginUrl: buyerLoginUrl,
            // Pricing surfaced in-email so the buyer doesn't need to ask
            // "how much?" before reaching out. Big conversion friction remover.
            quarterPrice: Number(topMatch['Quarter Price']) || undefined,
            quarterLbs: topMatch['Quarter lbs'] || undefined,
            halfPrice: Number(topMatch['Half Price']) || undefined,
            halfLbs: topMatch['Half lbs'] || undefined,
            wholePrice: Number(topMatch['Whole Price']) || undefined,
            wholeLbs: topMatch['Whole lbs'] || undefined,
            nextProcessingDate: topMatch['Next Processing Date'] || undefined,
          });
        }

        // Telegram noise reduction: per-match notifications were creating
        // dozens of pings/day with no required action. Routine matches now
        // roll into the morning digest only. The actionable moments
        // (sales, passes, hot leads, capacity issues, ready-to-buy) keep
        // their own loud alerts elsewhere in the codebase.
        // (intentionally no Telegram message here)
      } catch (e) {
        console.error('Error auto-approving match:', e);
      }
    } else {
      // No match found — waitlist the buyer
      try {
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Referral Status': 'Waitlisted',
        });
      } catch (e) {
        console.error('Error updating consumer referral status:', e);
      }

      // Telegram noise reduction: routine no-match events roll into the
      // morning digest. Only ping in real-time when the buyer is high-intent
      // (score >= 70) — that's when "no rancher available" is actually a
      // problem worth waking Ben up about.
      const isHighIntentNoMatch = (intentScore || 0) >= 70;
      try {
        if (isHighIntentNoMatch) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `⏳ <b>HIGH-INTENT BUYER WAITLISTED</b>\n\n` +
          `👤 ${buyerName} in ${buyerState}\n` +
          `📦 ${orderType || 'Not specified'}\n` +
          `Buyer waitlisted — will auto-match when a rancher goes live in ${buyerState}.`
          );
        }
      } catch (e) {
        console.error('Error sending no-match Telegram notification:', e);
      }
    }

    return NextResponse.json({
      success: true,
      referralId: referral.id,
      matchFound: !!topMatch,
      matchType,
      suggestedRancher: topMatch ? {
        id: topMatch.id,
        name: topMatch['Operator Name'] || topMatch['Ranch Name'],
        state: topMatch['State'],
        shipsNationwide: topMatch['Ships Nationwide'] === true,
        activeReferrals: topMatch['Current Active Referrals'] || 0,
        maxReferrals: topMatch['Max Active Referalls'] || 5,
      } : null,
    });
  } catch (error: any) {
    console.error('Matching engine error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
