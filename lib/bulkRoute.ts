import { getAllRecords, updateRecord, createRecord, escapeAirtableValue, TABLES } from './airtable';
import { sendEmail, sendBuyerIntroNotification } from './email';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export type BulkRouteSummary = {
  state: string;
  targetRancher: string;
  dryRun: boolean;
  scheduledAt?: string;
  totalConsumers: number;
  processed: number;
  skipped_already_intro_sent: number;
  updated_stuck_referral: number;
  created_new_referral: number;
  canceled_duplicates: number;
  emails_sent_rancher: number;
  emails_sent_buyer: number;
  errors: string[];
  details: any[];
};

export type BulkRouteResult =
  | { ok: true; summary: BulkRouteSummary }
  | { ok: false; error: string; status: number };

// Routes all stuck consumers in a given state to a target rancher.
//   - Cancels duplicate Pending Approval referrals (keeps latest per consumer)
//   - Updates the latest stuck referral to Intro Sent, points at target rancher, sends intro emails
//   - Creates fresh Intro Sent referrals for Unmatched/Waitlisted consumers, sends intro emails
// If `scheduledAt` is provided (ISO date), Resend holds and delivers emails at that time.
export async function bulkRouteStateToRancher(opts: {
  state: string;
  rancherSlug: string;
  dryRun?: boolean;
  scheduledAt?: string;
}): Promise<BulkRouteResult> {
  const state = (opts.state || '').toUpperCase();
  const slug = opts.rancherSlug;
  const dryRun = !!opts.dryRun;
  const scheduledAt = opts.scheduledAt;

  if (!state || !slug) {
    return { ok: false, error: 'state and rancherSlug are required', status: 400 };
  }

  // 1. Find target rancher
  const allRanchers: any[] = await getAllRecords(TABLES.RANCHERS);
  const rancher = allRanchers.find((r: any) => (r['Slug'] || '') === slug);
  if (!rancher) {
    return { ok: false, error: `Rancher with slug "${slug}" not found`, status: 404 };
  }
  const rancherId = rancher.id;
  const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
  const rancherEmail = rancher['Email'] || '';
  const rancherPhone = rancher['Phone'] || '';
  const rancherSlug = rancher['Slug'] || '';

  // Validate the rancher is actually live
  if (rancher['Active Status'] !== 'Active') {
    return { ok: false, error: `Rancher "${rancherName}" is not Active`, status: 400 };
  }

  // 2. Find all consumers in the state with Status=Approved
  const consumers: any[] = await getAllRecords(
    TABLES.CONSUMERS,
    `AND({State} = "${escapeAirtableValue(state)}", {Status} = "Approved")`
  );

  // 3. Find all existing referrals in the state
  const referrals: any[] = await getAllRecords(
    TABLES.REFERRALS,
    `{Buyer State} = "${escapeAirtableValue(state)}"`
  );

  // Index referrals by consumer email
  const refsByEmail: Record<string, any[]> = {};
  for (const r of referrals) {
    const email = (r['Buyer Email'] || '').toLowerCase().trim();
    if (!email) continue;
    if (!refsByEmail[email]) refsByEmail[email] = [];
    refsByEmail[email].push(r);
  }

  const now = new Date().toISOString();
  const summary: BulkRouteSummary = {
    state,
    targetRancher: rancherName,
    dryRun,
    scheduledAt,
    totalConsumers: consumers.length,
    processed: 0,
    skipped_already_intro_sent: 0,
    updated_stuck_referral: 0,
    created_new_referral: 0,
    canceled_duplicates: 0,
    emails_sent_rancher: 0,
    emails_sent_buyer: 0,
    errors: [],
    details: [],
  };

  for (const consumer of consumers) {
    try {
      const buyerId = consumer.id;
      const buyerEmail = (consumer['Email'] || '').toLowerCase().trim();
      const buyerName = consumer['Full Name'] || '';
      const buyerPhone = consumer['Phone'] || '';
      const buyerState = consumer['State'] || state;
      const orderType = consumer['Order Type'] || '';
      const budgetRange = consumer['Budget'] || '';
      const notes = consumer['Notes'] || '';
      const intentScore = consumer['Intent Score'] || 0;
      const intentClassification = consumer['Intent Classification'] || '';
      const referralStatus = consumer['Referral Status'] || '';

      if (!buyerEmail) continue;

      // If they already have an active Intro Sent referral, skip
      const myRefs = refsByEmail[buyerEmail] || [];
      const activeIntroSent = myRefs.find((r: any) =>
        ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Closed Won'].includes(r['Status'])
      );
      if (activeIntroSent) {
        summary.skipped_already_intro_sent++;
        continue;
      }

      summary.processed++;

      const pendingRefs = myRefs.filter((r: any) => r['Status'] === 'Pending Approval');

      let targetReferralId: string;

      if (pendingRefs.length > 0) {
        targetReferralId = pendingRefs[0].id;
        if (!dryRun) {
          await updateRecord(TABLES.REFERRALS, targetReferralId, {
            'Status': 'Intro Sent',
            'Rancher': [rancherId],
            'Suggested Rancher': [rancherId],
            'Suggested Rancher Name': rancherName,
            'Suggested Rancher State': rancher['State'] || state,
            'Match Type': 'Local',
            'Approved At': now,
            'Intro Sent At': now,
          });
        }
        summary.updated_stuck_referral++;

        for (let i = 1; i < pendingRefs.length; i++) {
          if (!dryRun) {
            try {
              await updateRecord(TABLES.REFERRALS, pendingRefs[i].id, {
                'Status': 'Closed Lost',
                'Closed At': now,
                'Notes': `${pendingRefs[i]['Notes'] || ''}\n[Auto-closed duplicate — primary referral routed to ${rancherName}]`.trim(),
              });
            } catch (e: any) {
              summary.errors.push(`Close duplicate ${pendingRefs[i].id}: ${e.message}`);
            }
          }
          summary.canceled_duplicates++;
        }
      } else {
        if (!dryRun) {
          const newRef: any = await createRecord(TABLES.REFERRALS, {
            'Buyer': [buyerId],
            'Status': 'Intro Sent',
            'Buyer Name': buyerName,
            'Buyer Email': buyerEmail,
            'Buyer Phone': buyerPhone,
            'Buyer State': buyerState,
            'Order Type': orderType,
            'Budget Range': budgetRange,
            'Intent Score': intentScore,
            'Intent Classification': intentClassification,
            'Notes': notes,
            'Rancher': [rancherId],
            'Suggested Rancher': [rancherId],
            'Suggested Rancher Name': rancherName,
            'Suggested Rancher State': rancher['State'] || state,
            'Match Type': 'Local',
            'Approved At': now,
            'Intro Sent At': now,
          });
          targetReferralId = newRef.id;
        } else {
          targetReferralId = 'dry-run';
        }
        summary.created_new_referral++;
      }

      // Update consumer referral status
      if (!dryRun) {
        try {
          await updateRecord(TABLES.CONSUMERS, buyerId, {
            'Referral Status': 'Intro Sent',
          });
        } catch (e: any) {
          summary.errors.push(`Update consumer ${buyerId} status: ${e.message}`);
        }
      }

      // Send rancher intro email (scheduled if scheduledAt provided)
      if (!dryRun && rancherEmail) {
        try {
          await sendEmail({
            to: rancherEmail,
            subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
            scheduledAt,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
              <h1 style="font-family:Georgia,serif;">New Qualified Buyer Lead</h1>
              <p>Hi ${rancherName},</p>
              <p>A qualified buyer in your area came through BuyHalfCow and has been connected to you:</p>
              <p><strong>Buyer:</strong> ${buyerName}</p>
              <p><strong>Email:</strong> ${buyerEmail}</p>
              ${buyerPhone ? `<p><strong>Phone:</strong> ${buyerPhone}</p>` : ''}
              <p><strong>State:</strong> ${buyerState}</p>
              <p><strong>Order:</strong> ${orderType || 'Not specified'}</p>
              ${budgetRange ? `<p><strong>Budget:</strong> ${budgetRange}</p>` : ''}
              ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
              <p>Reach out within 24 hours to close the sale. Reply-all to keep me in the loop.</p>
              <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow | 10% commission on BHC referral sales.</p>
            </div>`,
          });
          summary.emails_sent_rancher++;
        } catch (e: any) {
          summary.errors.push(`Rancher email for ${buyerEmail}: ${e.message}`);
        }
      }

      // Send buyer intro email (scheduled if scheduledAt provided)
      if (!dryRun && buyerEmail) {
        try {
          const buyerToken = jwt.sign(
            { type: 'member-login', consumerId: buyerId, email: buyerEmail },
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
            rancherSlug,
            loginUrl: buyerLoginUrl,
            scheduledAt,
          });
          summary.emails_sent_buyer++;
        } catch (e: any) {
          summary.errors.push(`Buyer email for ${buyerEmail}: ${e.message}`);
        }
      }

      summary.details.push({
        name: buyerName,
        email: buyerEmail,
        order: orderType,
        budget: budgetRange,
        intent: intentClassification,
        prev_referral_status: referralStatus,
        action: pendingRefs.length > 0 ? 'updated_stuck' : 'created_new',
        referralId: targetReferralId,
      });
    } catch (e: any) {
      summary.errors.push(`Consumer ${consumer.id}: ${e.message}`);
    }
  }

  // Increment rancher's active referral count
  if (!dryRun) {
    try {
      const netNew = summary.updated_stuck_referral + summary.created_new_referral;
      if (netNew > 0) {
        const currentRefs = rancher['Current Active Referrals'] || 0;
        await updateRecord(TABLES.RANCHERS, rancherId, {
          'Current Active Referrals': currentRefs + netNew,
          'Last Assigned At': now,
        });
      }
    } catch (e: any) {
      summary.errors.push(`Increment rancher count: ${e.message}`);
    }
  }

  return { ok: true, summary };
}

// Returns the list of states a rancher serves: their primary `State` plus
// anything in `States Served` (comma-separated string OR array).
export function getRancherServedStates(rancher: any): string[] {
  const out = new Set<string>();
  const primary = (rancher['State'] || '').toString().trim().toUpperCase();
  if (primary) out.add(primary);
  const served = rancher['States Served'];
  if (typeof served === 'string') {
    served.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((s) => out.add(s));
  } else if (Array.isArray(served)) {
    served.map((s: any) => String(s).trim().toUpperCase()).filter(Boolean).forEach((s) => out.add(s));
  }
  return Array.from(out);
}
