import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { normalizeStates, stringifyStates } from '@/lib/states';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';
import { MAX_ACTIVE_REFERRALS_FIELD, getLiveCapacity } from '@/lib/rancherCapacity';
import { requireRancher } from '@/lib/rancherAuth';
import { MIN_TIER_PRICE } from '@/lib/pricing';
import { normalizeImageUrl } from '@/lib/imageUrl';
import { validateAccountPatch, ACCOUNT_EDITABLE_KEYS } from '@/lib/accountProfile';

// Fulfillment Types option values — mirrors FULFILLMENT_OPTIONS in the setup
// wizard + the dashboard editor so all three agree on the exact strings the
// Airtable multipleSelects field stores.
const FULFILLMENT_TYPE_VALUES = ['Local Pickup', 'Local Delivery', 'Cold-Chain Shipping'];

// Reject obviously-broken image links (Google Drive / Dropbox / OneDrive share
// URLs) server-side too, so a corrupt Gallery Photos array can never reach
// Airtable even if a client skips the ImageUploader gate. Direct image URLs +
// our own Vercel Blob URLs pass through (after normalizeImageUrl tidy-up).
function isRejectedShareImageUrl(url: string): boolean {
  const u = String(url || '').toLowerCase();
  if (!u) return true;
  return (
    u.includes('drive.google.com') ||
    u.includes('docs.google.com') ||
    u.includes('dropbox.com') ||
    u.includes('1drv.ms') ||
    u.includes('onedrive.live.com') ||
    u.includes('photos.app.goo.gl') ||
    u.includes('photos.google.com')
  );
}

// GET /api/rancher/landing-page — hydrate the "My Page" editor with the
// landing-page fields the main dashboard payload doesn't return (Refund
// Policy, social URLs, Processing Facility, the fulfillment block, FAQ).
// Keeps the read inside this route so the editor agent never has to touch the
// shared dashboard endpoint. Returns the raw stored strings; the client owns
// parsing the JSON arrays (Testimonials / FAQ).
export async function GET(request: Request) {
  try {
    const r = await requireRancher(request);
    if (r instanceof NextResponse) return r;
    const { session } = r;
    const rancher = (await getRecordById(TABLES.RANCHERS, session.rancherId)) as any;
    if (!rancher) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const ft = rancher['Fulfillment Types'];
    return NextResponse.json({
      'Refund Policy': rancher['Refund Policy'] || '',
      'Google Reviews URL': rancher['Google Reviews URL'] || '',
      'Facebook URL': rancher['Facebook URL'] || '',
      'Instagram URL': rancher['Instagram URL'] || '',
      'Processing Facility': rancher['Processing Facility'] || '',
      // Airtable returns multipleSelects as string[] (or [{name}]) — coerce to
      // a flat array of strings for the checkbox editor.
      'Fulfillment Types': Array.isArray(ft)
        ? ft.map((t: any) => (t && typeof t === 'object' ? t.name : String(t)))
        : [],
      'Pickup City': rancher['Pickup City'] || '',
      'Delivery Radius Miles': rancher['Delivery Radius Miles'] ?? '',
      'Shipping Lead Time Days': rancher['Shipping Lead Time Days'] ?? '',
      'Fulfillment Cost Notes': rancher['Fulfillment Cost Notes'] || '',
      // Raw JSON strings — client parses (tolerant of empty/missing).
      'Testimonials': rancher['Testimonials'] || '',
      'FAQ': rancher['FAQ'] || '',
    });
  } catch (error: any) {
    console.error('Landing page GET error:', error);
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }
}

// PATCH /api/rancher/landing-page — rancher updates their own landing page fields
export async function PATCH(request: Request) {
  try {
    const r = await requireRancher(request);
    if (r instanceof NextResponse) return r;
    const { session } = r;

    const body = await request.json();

    // Only allow landing page fields — never let ranchers write to status/commission/auth fields
    const allowed = [
      'Slug',
      'Logo URL',
      'Tagline',
      'About Text',
      'Video URL',
      'Quarter Price',
      'Quarter Deposit',
      'Quarter Processing Fee',
      'Quarter lbs',
      'Quarter Payment Link',
      'Half Price',
      'Half Deposit',
      'Half Processing Fee',
      'Half lbs',
      'Half Payment Link',
      'Whole Price',
      'Whole Deposit',
      'Whole Processing Fee',
      'Whole lbs',
      'Whole Payment Link',
      'Next Processing Date',
      'Reserve Link',
      'Custom Notes',
      'States Served',
      // Preferred States = rancher-REQUESTED service area. Distinct from
      // "Routing States" (admin-controlled, what actually drives matching).
      // Edits here pop a Telegram alert so Ben can review + promote.
      'Preferred States',
      'Ships Nationwide',
      'Beef Types',
      'Cal.com Slug',
      'Certifications',
      'Testimonials',
      'Gallery Photos',
      'Custom Products',
      'Google Reviews URL',
      'Facebook URL',
      'Instagram URL',
      'Processing Facility',
      // Page-completeness / fulfillment fields — previously wizard-only or
      // trapped in the Submit-Verification modal; now editable from the
      // dashboard "My Page" tab (editor↔page parity, 2026-06-23).
      'Refund Policy',
      'Fulfillment Types',
      'Pickup City',
      'Delivery Radius Miles',
      'Shipping Lead Time Days',
      'Fulfillment Cost Notes',
      // FAQ — JSON array of {q,a}. New long-text field; repeater editor in
      // the dashboard serializes to valid JSON (parsed by the public page).
      'FAQ',
      // Multi-user: comma/newline list of additional emails allowed to log
      // into this rancher's dashboard. Login flow matches against this.
      'Team Emails',
      // WAVE 3b (2026-06-30): account/profile fields — operator name, ranch
      // name, login email, phone. Previously NOT editable (only a password
      // modal existed). Allowed through here but their VALUES are validated +
      // normalized below via validateAccountPatch (email format, phone digits,
      // non-empty names) — they are NOT trusted as raw pass-through.
      ...ACCOUNT_EDITABLE_KEYS,
    ];

    // Handle special actions
    if (body._action === 'update-capacity') {
      const maxReferrals = parseInt(body.maxActiveReferrals);
      if (isNaN(maxReferrals) || maxReferrals < 1 || maxReferrals > 50) {
        return NextResponse.json({ error: 'Capacity must be between 1 and 50' }, { status: 400 });
      }

      // Audit #8 + #3 (2026-05-28): read LIVE capacity (Redis-aware), not the
      // stale Airtable mirror. Previously a buyer signup mid-edit could have
      // INCR'd Redis without the Airtable mirror catching up — rancher raises
      // cap by 1 thinking they're at 5/5, actually at 6/5; status stuck At
      // Capacity.
      const liveCurrent = await getLiveCapacity(session.rancherId);
      const rancher = await getRecordById(TABLES.RANCHERS, session.rancherId) as any;

      // Audit #8 (2026-05-28): BLOCK LOWERING BELOW CURRENT ACTIVE COUNT.
      // Previously unguarded — rancher could drop max from 10 → 3 while
      // currently routing 7 active deals. Matching/suggest gate would then
      // keep routing UP TO the new max (i.e. zero new leads) but rancher
      // wouldn't flip to At Capacity. Over-routing in flight + UX confusion.
      //
      // New behavior: block the lower if it would put them OVER the new
      // ceiling. Tell them to wait for active deals to close first.
      if (maxReferrals < liveCurrent) {
        return NextResponse.json(
          {
            error: `Can't lower capacity below your current ${liveCurrent} active deals. Either close some leads first or set the cap to ${liveCurrent} or higher.`,
            currentActive: liveCurrent,
          },
          { status: 400 }
        );
      }

      await updateRecord(TABLES.RANCHERS, session.rancherId, {
        [MAX_ACTIVE_REFERRALS_FIELD]: maxReferrals,
      });

      // Capacity flip logic — read fresh state after the max write:
      //   • lowered to current ceiling exactly → force At Capacity (no new
      //     leads until one closes)
      //   • raised above current while At Capacity → flip back to Active +
      //     fire launch warmup so waitlisted buyers get the YES email
      if (maxReferrals === liveCurrent && rancher['Active Status'] !== 'At Capacity') {
        await updateRecord(TABLES.RANCHERS, session.rancherId, { 'Active Status': 'At Capacity' });
      } else if (rancher['Active Status'] === 'At Capacity' && liveCurrent < maxReferrals) {
        await updateRecord(TABLES.RANCHERS, session.rancherId, { 'Active Status': 'Active' });
        triggerLaunchWarmup(`landing-page-capacity-raise:${session.rancherId}`);
      }
      return NextResponse.json({ success: true, currentActive: liveCurrent, newMax: maxReferrals });
    }

    if (body._action === 'request-verification') {
      const rancher = await getRecordById(TABLES.RANCHERS, session.rancherId) as any;
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown';
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
      const slug = rancher['Slug'] || '';

      // Save any verification materials submitted with the request
      const updates: Record<string, any> = {
        'Verification Requested At': new Date().toISOString(),
      };
      // Support both old field names and new form field names
      if (body.testimonials) updates['Testimonials'] = body.testimonials;
      if (body.customerReferences) updates['Customer References'] = body.customerReferences;
      if (body.galleryPhotos) updates['Gallery Photos'] = body.galleryPhotos;
      if (body.googleReviewsUrl || body.reviewsLink) updates['Google Reviews URL'] = body.googleReviewsUrl || body.reviewsLink;
      if (body.facebookUrl) updates['Facebook URL'] = body.facebookUrl;
      if (body.instagramUrl || body.socialMedia) {
        const social = body.instagramUrl || body.socialMedia;
        if (social.includes('facebook')) updates['Facebook URL'] = social;
        else updates['Instagram URL'] = social;
      }
      if (body.processingFacility || body.processorName) updates['Processing Facility'] = body.processingFacility || body.processorName;
      if (body.certifications) updates['Certifications'] = body.certifications;

      // Build verification method summary
      const methods: string[] = [];
      if (body.customerReferences || body.testimonials) methods.push('Customer References');
      if (body.galleryPhotos) methods.push('Photos');
      if (body.reviewsLink || body.googleReviewsUrl) methods.push('Reviews Link');
      if (body.socialMedia || body.facebookUrl || body.instagramUrl) methods.push('Social Media');
      if (body.processorName || body.processingFacility) methods.push('USDA Processor');
      if (body.certifications) methods.push('Certifications');
      updates['Verification Method'] = methods.join(', ') || 'Digital Proof';

      // AUTO-VERIFICATION: if the rancher submitted strong social proof (at
      // least 3 independent verification signals), auto-approve. Otherwise
      // fall through to the 1-tap Ben review. This eliminates the manual step
      // for the 80% of ranchers who have proper credentials while keeping
      // human judgment for the edge cases.
      //
      // Strong signals (each counts as 1):
      //   - 2+ customer references OR testimonials
      //   - Google Reviews URL
      //   - At least one social profile (Facebook OR Instagram)
      //   - USDA processing facility named
      //   - Certifications listed
      //   - Gallery photos provided
      const hasReferences = !!(body.customerReferences || body.testimonials);
      const hasReviews = !!(body.googleReviewsUrl || body.reviewsLink);
      const hasSocial = !!(body.facebookUrl || body.instagramUrl || body.socialMedia);
      const hasProcessor = !!(body.processingFacility || body.processorName);
      const hasCerts = !!body.certifications;
      const hasPhotos = !!body.galleryPhotos;
      const signalCount = [hasReferences, hasReviews, hasSocial, hasProcessor, hasCerts, hasPhotos]
        .filter(Boolean).length;

      // Lowered 3→2 to match the dashboard submit floor + unblock small ranchers
      // (no website/reviews/social commonly have <3 signals). The nightly
      // auto-verify-stale cron clears anything still Pending >24h, so a 100-wave
      // never waits on a manual rverify_ tap. Spot-check provisional ones after.
      const autoApprove = signalCount >= 2;

      if (autoApprove) {
        updates['Onboarding Status'] = 'Verification Complete';
        updates['Verification Status'] = 'Verified';
        updates['Verification Notes'] = `Auto-verified ${new Date().toISOString().slice(0, 10)} — ${signalCount}/6 signals (${methods.join(', ')})`;
      } else {
        updates['Onboarding Status'] = 'Verification Pending';
      }

      await updateRecord(TABLES.RANCHERS, session.rancherId, updates);

      try {
        if (autoApprove) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `✅ <b>AUTO-VERIFIED</b>\n\n🤠 ${name}\n📋 Signals: ${signalCount}/6 (${methods.join(', ')})\n${slug ? `Preview: ${siteUrl}/ranchers/${slug}` : ''}\n\n<i>Auto-approved — batch-approve cron will flip Page Live at next 9am MT run if slug + prices are set. Revert manually if needed.</i>`
          );
        } else {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🔍 <b>VERIFICATION REQUEST</b> (low signal — ${signalCount}/6)\n\n🤠 ${name}\n📋 Proof: ${methods.join(', ') || 'Submitted'}\nEmail: ${rancher['Email'] || 'N/A'}\nPhone: ${rancher['Phone'] || 'N/A'}\n${slug ? `Preview: ${siteUrl}/ranchers/${slug}` : ''}\n\nReview their materials and approve.`,
            {
              inline_keyboard: [
                [{ text: '✅ Approve Verification', callback_data: `rverify_${session.rancherId}` }],
              ],
            }
          );
        }
      } catch (e) {
        console.error('Telegram verification notification error:', e);
      }

      return NextResponse.json({
        success: true,
        autoApproved: autoApprove,
        message: autoApprove
          ? 'Verified! Your profile will go live within 24 hours once prices are set.'
          : 'Verification request submitted. We\'ll review within 24-48 hours.',
      });
    }

    if (body._action === 'request-go-live') {
      const rancher = await getRecordById(TABLES.RANCHERS, session.rancherId) as any;
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown';
      const slug = rancher['Slug'] || '';
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

      // SELF-PUBLISH when the rancher is genuinely eligible — same predicate the
      // go-live safety-net cron uses (#66). No more waiting on an admin tap; the
      // rancher who finished everything goes live the moment they ask. Falls back
      // to a Telegram ping (and tells the rancher exactly what's left) otherwise.
      const signed = !!rancher['Agreement Signed'];
      const hasSlug = !!rancher['Slug'];
      const hasPrice = !!(rancher['Quarter Price'] || rancher['Half Price'] || rancher['Whole Price']);
      const isTierV2 = String(rancher['Pricing Model'] || 'legacy').toLowerCase() === 'tier_v2';
      const connectActive = String(rancher['Stripe Connect Status'] || '').toLowerCase() === 'active';
      const hasPaymentLink = !!(rancher['Quarter Payment Link'] || rancher['Half Payment Link'] || rancher['Whole Payment Link']);
      const canCollect = isTierV2 ? connectActive : hasPaymentLink;
      const alreadyLive = String(rancher['Active Status']) === 'Active' && rancher['Page Live'] === true;

      if (alreadyLive) return NextResponse.json({ success: true, live: true, message: "You're already live." });

      if (signed && hasSlug && hasPrice && canCollect) {
        await updateRecord(TABLES.RANCHERS, session.rancherId, {
          'Active Status': 'Active', 'Onboarding Status': 'Live', 'Page Live': true,
        });
        try {
          const { triggerLaunchWarmup } = await import('@/lib/triggerLaunchWarmup');
          triggerLaunchWarmup(`request-go-live:${session.rancherId}`);
        } catch (e: any) { console.warn('[request-go-live] warmup trigger failed:', e?.message); }
        try {
          await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, `🟢 <b>${name} is now LIVE</b> (self-published)\n${siteUrl}/ranchers/${slug}`);
        } catch { /* non-fatal */ }
        return NextResponse.json({ success: true, live: true, message: "You're live! Buyers in your state can now find you." });
      }

      const missing: string[] = [];
      if (!signed) missing.push('sign the agreement');
      if (!hasSlug) missing.push('set your page link');
      if (!hasPrice) missing.push('set at least one price');
      if (!canCollect) missing.push(isTierV2 ? 'finish Stripe Connect' : 'add a payment link');
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🟡 <b>GO LIVE REQUEST</b> (not auto-eligible)\n\n🤠 ${name}\nStill needs: ${missing.join(', ') || 'unknown'}\n${slug ? `Preview: ${siteUrl}/ranchers/${slug}` : ''}`,
          { inline_keyboard: [[{ text: '🟢 Force Live', callback_data: `rgolive_${session.rancherId}` }]] },
        );
      } catch (e) {
        console.error('Telegram go-live notification error:', e);
      }
      return NextResponse.json({ success: false, live: false, message: `Almost there — you still need to: ${missing.join(', ')}.` });
    }

    const fields: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) {
        const val = body[key];
        fields[key] = val === '' ? null : val;
      }
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 });
    }

    // Convert Ships Nationwide to boolean for Airtable
    if ('Ships Nationwide' in fields) {
      fields['Ships Nationwide'] = fields['Ships Nationwide'] === 'true' || fields['Ships Nationwide'] === true;
    }

    // Cal.com Slug — normalize + validate. Mirror of /api/rancher/setup so the
    // wizard + dashboard apply the same gate. Strip the cal.com URL prefix,
    // leading/trailing slashes. Reject anything that would render as a broken
    // cal.com link in every buyer intro email. Empty is OK (clear field).
    if ('Cal.com Slug' in fields) {
      const raw = String(fields['Cal.com Slug'] || '')
        .trim()
        .replace(/^https?:\/\/(www\.)?cal\.com\//i, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
      if (raw.length === 0) {
        fields['Cal.com Slug'] = null;
      } else {
        if (raw.length > 120) {
          return NextResponse.json({
            error: 'Cal.com slug looks too long — paste just the part after cal.com/ (e.g. "yourname/buyhalfcow-intro").',
          }, { status: 400 });
        }
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(raw)) {
          return NextResponse.json({
            error: 'Cal.com slug can only contain letters, numbers, dashes, underscores, dots, and slashes. Paste just the part after cal.com/.',
          }, { status: 400 });
        }
        fields['Cal.com Slug'] = raw;
      }
    }

    // Validate slug: lowercase alphanumeric + hyphens only.
    // MISMATCH FIX: enforce uniqueness across ranchers. Two ranchers picking
    // the same slug would silently overwrite each other in Airtable; whichever
    // record Airtable returned first from getRancherBySlug would steal all the
    // direct-page traffic for that URL. Now a duplicate is rejected with 409 +
    // a suggested alternative (slug-2, slug-3, …). Empty/blank slugs skip the
    // check (rancher clearing their slug back to unset is allowed).
    if (fields['Slug'] !== undefined && fields['Slug'] !== null) {
      const slug = String(fields['Slug']).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      fields['Slug'] = slug;

      if (slug) {
        try {
          const safeSlug = escapeAirtableValue(slug);
          const collisions: any[] = await getAllRecords(
            TABLES.RANCHERS,
            `LOWER({Slug}) = "${safeSlug}"`
          );
          // OK if the only match is the calling rancher's own record.
          const otherOwners = collisions.filter((r: any) => r.id !== session.rancherId);
          if (otherOwners.length > 0) {
            // Suggest the next available numbered variant.
            let suffix = 2;
            let candidate = `${slug}-${suffix}`;
            while (suffix < 50) {
              const safeCandidate = escapeAirtableValue(candidate);
              const taken: any[] = await getAllRecords(
                TABLES.RANCHERS,
                `LOWER({Slug}) = "${safeCandidate}"`
              );
              if (taken.length === 0) break;
              suffix++;
              candidate = `${slug}-${suffix}`;
            }
            return NextResponse.json(
              {
                error: `Slug "${slug}" is already taken by another rancher. Try "${candidate}" or a different name.`,
                suggested: candidate,
              },
              { status: 409 }
            );
          }
        } catch (slugErr: any) {
          console.warn('[landing-page] slug uniqueness check failed (allowing through):', slugErr?.message);
          // Fail-open: if the uniqueness query fails (Airtable hiccup), let the
          // write through. Worst case we get a duplicate; the nightly audit
          // can surface it.
        }
      }
    }

    // Validate URL fields
    const urlFields = ['Logo URL', 'Video URL', 'Quarter Payment Link', 'Half Payment Link', 'Whole Payment Link', 'Reserve Link'];
    for (const key of urlFields) {
      if (fields[key] !== undefined && fields[key] !== null) {
        const url = String(fields[key]).trim();
        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
          fields[key] = `https://${url}`;
        }
      }
    }

    // Validate price fields are numbers
    const priceFields = ['Quarter Price', 'Half Price', 'Whole Price'];
    for (const key of priceFields) {
      if (fields[key] !== undefined && fields[key] !== null) {
        const num = parseFloat(fields[key]);
        if (isNaN(num) || num < 0) {
          return NextResponse.json({ error: `${key} must be a valid positive number` }, { status: 400 });
        }
        fields[key] = num;
      }
    }

    // Per-lb mis-entry floor. A positive tier PRICE below MIN_TIER_PRICE is almost
    // certainly a per-pound value typed into a total field (DD Ranch published a
    // $7.40 "whole cow" this way — the buyer would be charged ~$7.40 for a whole
    // animal). Reject so broken pricing can never publish from the dashboard. 0/
    // blank was normalized to null above (= "not set", allowed). Mirrors the floor
    // in app/api/rancher/setup/route.ts; shares the MIN_TIER_PRICE constant with
    // the wizard helper + the deposit charge guard (lib/pricing.ts).
    for (const priceKey of priceFields) {
      const v = fields[priceKey];
      if (typeof v === 'number' && v > 0 && v < MIN_TIER_PRICE) {
        return NextResponse.json({
          error: `${priceKey} of $${v} looks like a per-pound price, not a total. Whole/half/quarter shares start around $${MIN_TIER_PRICE}+. If you price per pound, multiply by the hanging weight to get the total.`,
        }, { status: 400 });
      }
    }

    // ── Refund Policy (20–500 chars) ─────────────────────────────────────
    // Buyers see this verbatim on the public page. Mirrors the setup-wizard
    // gate so the dashboard can't save a too-short/too-long policy. Blank was
    // normalized to null above (= "not set", allowed — the field is optional
    // until go-live, where the completeness meter nudges it).
    if (typeof fields['Refund Policy'] === 'string') {
      const len = fields['Refund Policy'].trim().length;
      if (len > 0 && len < 20) {
        return NextResponse.json({ error: 'Refund policy must be at least 20 characters — buyers see this verbatim.' }, { status: 400 });
      }
      if (len > 500) {
        return NextResponse.json({ error: 'Refund policy must be 500 characters or fewer.' }, { status: 400 });
      }
      fields['Refund Policy'] = fields['Refund Policy'].trim();
    }

    // ── Fulfillment Types (multipleSelects) ──────────────────────────────
    // Accept an array of option strings OR a comma-separated string; keep only
    // the known option values (Airtable rejects unknown choices). Empty → null.
    if ('Fulfillment Types' in fields && fields['Fulfillment Types'] !== null) {
      const raw = fields['Fulfillment Types'];
      const arr: string[] = Array.isArray(raw)
        ? raw.map((s) => String(s).trim())
        : String(raw).split(',').map((s) => s.trim());
      const clean = arr.filter((v) => FULFILLMENT_TYPE_VALUES.includes(v));
      fields['Fulfillment Types'] = clean.length ? clean : null;
    }

    // ── Fulfillment numerics ─────────────────────────────────────────────
    for (const numKey of ['Delivery Radius Miles', 'Shipping Lead Time Days']) {
      if (fields[numKey] !== undefined && fields[numKey] !== null) {
        const n = parseFloat(fields[numKey]);
        if (isNaN(n) || n < 0) {
          return NextResponse.json({ error: `${numKey} must be a valid positive number` }, { status: 400 });
        }
        fields[numKey] = n;
      }
    }

    // ── Gallery Photos — sanitize URLs server-side ───────────────────────
    // Defense-in-depth for the broken-cover bug: normalize known share-link
    // forms, then DROP any entry that's still a rejected share link or not a
    // string. The first photo is the public-page cover hero, so a single bad
    // URL here is what produced the broken hero. Accepts a JSON-string array
    // (what the dashboard sends) or a real array.
    if ('Gallery Photos' in fields && fields['Gallery Photos'] !== null) {
      let arr: any[] = [];
      const raw = fields['Gallery Photos'];
      if (Array.isArray(raw)) arr = raw;
      else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
        try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch { arr = []; }
      }
      const clean = arr
        .map((s) => normalizeImageUrl(String(s || '')))
        .filter((s) => s && !isRejectedShareImageUrl(s));
      fields['Gallery Photos'] = clean.length ? JSON.stringify(clean) : null;
    }

    // ── Logo URL — normalize share links to a direct form ────────────────
    if (typeof fields['Logo URL'] === 'string' && fields['Logo URL'].trim()) {
      const normalized = normalizeImageUrl(fields['Logo URL']);
      if (isRejectedShareImageUrl(normalized)) {
        return NextResponse.json({
          error: 'That logo link is a Google Drive / cloud share page, not a direct image. Upload the actual image file from the dashboard instead.',
        }, { status: 400 });
      }
      fields['Logo URL'] = normalized;
    }

    // ── Testimonials — must be a VALID JSON array ────────────────────────
    // BUGFIX (2026-06-23): the dashboard previously wrote Testimonials as a
    // raw string, corrupting the JSON the public page parses (JSON.parse threw
    // → testimonials silently dropped). Now we require a JSON array of
    // {name, location?, quote} objects; anything else is rejected so a corrupt
    // value can never persist. Empty array → null (clears the field).
    if ('Testimonials' in fields && fields['Testimonials'] !== null) {
      const raw = fields['Testimonials'];
      let arr: any[] | null = null;
      if (Array.isArray(raw)) arr = raw;
      else if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t) arr = [];
        else {
          try { const p = JSON.parse(t); if (Array.isArray(p)) arr = p; } catch { arr = null; }
        }
      }
      if (arr === null) {
        return NextResponse.json({ error: 'Testimonials must be a valid list. Use the add/remove rows editor in My Page.' }, { status: 400 });
      }
      const clean = arr
        .filter((r) => r && typeof r === 'object')
        .map((r: any) => ({
          name: String(r.name || '').trim(),
          location: String(r.location || '').trim(),
          quote: String(r.quote || '').trim(),
        }))
        .filter((r) => r.quote || r.name);
      fields['Testimonials'] = clean.length ? JSON.stringify(clean) : null;
    }

    // ── FAQ — must be a VALID JSON array of {q,a} ────────────────────────
    if ('FAQ' in fields && fields['FAQ'] !== null) {
      const raw = fields['FAQ'];
      let arr: any[] | null = null;
      if (Array.isArray(raw)) arr = raw;
      else if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t) arr = [];
        else {
          try { const p = JSON.parse(t); if (Array.isArray(p)) arr = p; } catch { arr = null; }
        }
      }
      if (arr === null) {
        return NextResponse.json({ error: 'FAQ must be a valid list. Use the add/remove rows editor in My Page.' }, { status: 400 });
      }
      const clean = arr
        .filter((r) => r && typeof r === 'object')
        .map((r: any) => ({ q: String(r.q || '').trim(), a: String(r.a || '').trim() }))
        .filter((r) => r.q || r.a);
      fields['FAQ'] = clean.length ? JSON.stringify(clean) : null;
    }

    // Normalize States Served — accept array of codes from new multi-select UI,
    // OR comma-separated string (with full names or codes) from legacy callers.
    // Always saves canonical "MT, WY, ID" 2-letter codes joined with ", ".
    if ('States Served' in fields && fields['States Served'] !== null) {
      const codes = normalizeStates(fields['States Served']);
      fields['States Served'] = codes.length > 0 ? stringifyStates(codes) : '';
    }
    // Same normalization for Preferred States (rancher-requested service area).
    if ('Preferred States' in fields && fields['Preferred States'] !== null) {
      const codes = normalizeStates(fields['Preferred States']);
      fields['Preferred States'] = codes.length > 0 ? stringifyStates(codes) : '';
      // Mirror Preferred → States Served so the public landing page reflects
      // what the rancher SAYS they serve. Routing States stays admin-only.
      if (!('States Served' in fields)) {
        fields['States Served'] = fields['Preferred States'];
      }
    }

    // If Preferred States changed, snapshot the prior value so we can alert
    // Ben with the diff. Routing States is admin-controlled — rancher edits
    // here only request a change; Ben promotes by editing Routing States.
    let preferredChanged: { before: string; after: string } | null = null;
    if ('Preferred States' in fields) {
      try {
        const prior = await getRecordById(TABLES.RANCHERS, session.rancherId) as any;
        const before = String(prior?.['Preferred States'] || '').trim();
        const after = String(fields['Preferred States'] || '').trim();
        if (before !== after) {
          preferredChanged = { before, after };
        }
      } catch {
        // Non-fatal — proceed without the alert.
      }
    }

    // ── Account / profile fields (WAVE 3b) ───────────────────────────────
    // Operator Name / Ranch Name / Email / Phone are allowlisted above but
    // must be validated + normalized, never written raw. Run the pure gate on
    // the keys actually present in the body; on success, OVERWRITE the
    // pass-through copies in `fields` with the normalized values. A blank email
    // or malformed phone is a hard 400.
    const accountInBody = ACCOUNT_EDITABLE_KEYS.some((k) => k in body);
    if (accountInBody) {
      const acct = validateAccountPatch(body);
      if (!acct.ok) {
        return NextResponse.json({ error: acct.error }, { status: 400 });
      }
      Object.assign(fields, acct.fields);
    }

    await updateRecord(TABLES.RANCHERS, session.rancherId, fields);

    // Fire admin alert AFTER successful write so we never alert on a failed save.
    if (preferredChanged) {
      try {
        const rancher = await getRecordById(TABLES.RANCHERS, session.rancherId) as any;
        const name = rancher?.['Operator Name'] || rancher?.['Ranch Name'] || 'Unknown';
        const routing = String(rancher?.['Routing States'] || rancher?.['States Served'] || '').trim();
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🗺️ <b>PREFERRED STATES CHANGED</b>\n\n🤠 ${name}\nBefore: <code>${preferredChanged.before || '(empty)'}</code>\nAfter: <code>${preferredChanged.after || '(empty)'}</code>\nCurrently routing: <code>${routing || '(empty)'}</code>\n\n<i>Review and promote into Routing States if approved.</i>`
        );
      } catch (e) {
        console.error('Telegram preferred-states alert error:', e);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Landing page update error:', error);
    return NextResponse.json({ error: 'Failed to save changes' }, { status: 500 });
  }
}
