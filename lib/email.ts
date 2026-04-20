import { Resend } from 'resend';
import { getAllRecords, escapeAirtableValue, TABLES } from './airtable';

const _resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder_for_build');

// In-memory suppression cache. Built lazily on first email send and refreshed
// every SUPPRESSION_TTL_MS. Avoids hitting Airtable on every send while still
// catching new unsubscribes within ~5 minutes. Critical to avoid CAN-SPAM
// violations + deliverability damage from sending to known-bad addresses.
const SUPPRESSION_TTL_MS = 5 * 60 * 1000;
let suppressionCache: { emails: Set<string>; loadedAt: number } | null = null;

async function getSuppressionList(): Promise<Set<string>> {
  const now = Date.now();
  if (suppressionCache && now - suppressionCache.loadedAt < SUPPRESSION_TTL_MS) {
    return suppressionCache.emails;
  }
  const emails = new Set<string>();
  try {
    // Pull from Consumers table — set built lazily on first send.
    const consumers = await getAllRecords(
      TABLES.CONSUMERS,
      `OR({Unsubscribed} = TRUE(), {Bounced} = TRUE(), {Complained} = TRUE())`
    );
    for (const c of consumers as any[]) {
      const e = (c['Email'] || '').toString().trim().toLowerCase();
      if (e) emails.add(e);
    }
    // Also Ranchers — same fields if present.
    try {
      const ranchers = await getAllRecords(
        TABLES.RANCHERS,
        `OR({Unsubscribed} = TRUE(), {Bounced} = TRUE(), {Complained} = TRUE())`
      );
      for (const r of ranchers as any[]) {
        const e = (r['Email'] || '').toString().trim().toLowerCase();
        if (e) emails.add(e);
      }
    } catch {
      // Ranchers table may not have these fields yet — non-fatal
    }
  } catch (e) {
    console.error('Suppression list build failed:', e);
    // Fail-open: if we can't load the list, send anyway. Better to send than
    // to silently block all email — but log loud so this gets fixed.
  }
  suppressionCache = { emails, loadedAt: now };
  return emails;
}

// Force refresh — call after a webhook updates suppression status so the
// cache doesn't lag.
export function invalidateSuppressionCache() {
  suppressionCache = null;
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@buyhalfcow.com';

// Strip HTML to plain text for multipart emails (critical for spam filters)
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract the domain from a sender like "Name <ben@domain.com>" or "ben@domain.com".
// Returns SEND_DOMAINS[0] as a fallback so we never crash on parse failure.
function extractDomain(from: string | undefined): string {
  if (!from) return SEND_DOMAINS[0];
  const match = String(from).match(/<?[^@<>\s]+@([^>\s]+)>?/);
  return match ? match[1] : SEND_DOMAINS[0];
}

// Wrapper that auto-adds replyTo, plain text, and CAN-SPAM footer
// to EVERY email. This is the single enforcement point for deliverability.
// IMPORTANT: replyTo MUST match the sending domain. Gmail/Outlook flag
// emails where From: domain ≠ Reply-To: domain as phishing — and previously
// this code hardcoded Reply-To to SEND_DOMAINS[0] even when From rotated to
// a different domain. That created a domain mismatch on 2/3 of all sends
// when domain rotation was active.
const resend = {
  emails: {
    send: async (params: any) => {
      // ── SUPPRESSION CHECK ────────────────────────────────────────────
      // Block sends to anyone who unsubscribed, hard-bounced, or marked
      // spam. CAN-SPAM violation otherwise + repeat sends destroy sender
      // reputation. Skip for transactional override (e.g., legal notices)
      // by passing _bypassSuppression: true.
      if (!params._bypassSuppression) {
        const recipient = (Array.isArray(params.to) ? params.to[0] : params.to || '')
          .toString()
          .trim()
          .toLowerCase();
        if (recipient) {
          const suppressed = await getSuppressionList();
          if (suppressed.has(recipient)) {
            console.log(`[email] SKIPPED ${recipient} (suppressed: unsubscribed/bounced/complained)`);
            return { data: { id: 'skipped-suppressed' }, error: null };
          }
        }
      }
      delete params._bypassSuppression;

      if (!params.replyTo) {
        // Match Reply-To to the actual sending domain in the From header.
        const fromDomain = extractDomain(params.from);
        params.replyTo = `ben@${fromDomain}`;
      }
      // Auto-inject CAN-SPAM footer (physical address + unsubscribe link)
      // into every HTML email unless explicitly opted out via _skipFooter.
      if (params.html && !params._skipFooter) {
        const recipientEmail = Array.isArray(params.to) ? params.to[0] : params.to;
        if (recipientEmail) {
          params.html = params.html + emailFooter(recipientEmail);
        }
      }
      delete params._skipFooter;
      // Plain text MUST be generated AFTER footer injection
      if (!params.text && params.html) {
        params.text = htmlToPlainText(params.html);
      }
      return _resend.emails.send(params);
    }
  }
};
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const CALENDLY_LINK = process.env.CALENDLY_LINK || 'https://buyhalfcow.com/call';
const MERCH_URL = process.env.MERCH_URL || 'https://buyhalfcow.com/merch';

// =====================================================
// DOMAIN ROTATION — cycle sends across multiple domains
// to protect deliverability and warm up new domains.
// Set SEND_DOMAINS as comma-separated list in env:
//   SEND_DOMAINS=buyhalfcow.com,mail.buyhalfcow.com,bhcbeef.com
// Each domain should be verified in Resend.
// =====================================================
const SEND_DOMAINS = (process.env.SEND_DOMAINS || 'buyhalfcow.com').split(',').map(d => d.trim()).filter(Boolean);
let domainIndex = 0;

function getFromEmail(): string {
  const domain = SEND_DOMAINS[domainIndex % SEND_DOMAINS.length];
  domainIndex++;
  return `BuyHalfCow <ben@${domain}>`;
}

function getUnsubscribeHeaders(email: string) {
  return {
    'List-Unsubscribe': `<${SITE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// Physical address required by CAN-SPAM Act. Update via BUSINESS_ADDRESS env var.
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS || 'BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901';

// Shared email footer — CAN-SPAM compliant: physical address + visible unsubscribe.
// Append this to every outbound email HTML body.
function emailFooter(recipientEmail: string): string {
  const unsubUrl = `${SITE_URL}/unsubscribe?email=${encodeURIComponent(recipientEmail)}`;
  return `
    <div style="margin-top:40px;padding-top:20px;border-top:1px solid #E5E2DC;font-size:12px;color:#A7A29A;line-height:1.6;">
      <p style="margin:0;">${BUSINESS_ADDRESS}</p>
      <p style="margin:8px 0 0;">
        <a href="${unsubUrl}" style="color:#A7A29A;text-decoration:underline;">Unsubscribe</a>
        &nbsp;·&nbsp;
        <a href="${SITE_URL}/privacy" style="color:#A7A29A;text-decoration:underline;">Privacy Policy</a>
      </p>
    </div>`;
}

// =====================================================
// UTM TRACKING — append UTM params to all email links
// =====================================================
function utm(url: string, campaign: string, content?: string): string {
  const sep = url.includes('?') ? '&' : '?';
  let params = `${sep}utm_source=email&utm_medium=drip&utm_campaign=${encodeURIComponent(campaign)}`;
  if (content) params += `&utm_content=${encodeURIComponent(content)}`;
  return url + params;
}

function esc(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =====================================================
// CONSUMER EMAILS
// =====================================================

export async function sendConsumerConfirmation(data: {
  firstName: string;
  email: string;
  state: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'Application Received — BuyHalfCow',
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #6B4F3F; }
            .divider { height: 1px; background: #2A2A2A; margin: 30px 0; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Application Received</h1>
            <p>Hi ${esc(data.firstName)},</p>
            <p>Thanks for your interest in BuyHalfCow. We've received your application and are reviewing it.</p>
            <div class="divider"></div>
            <p>You'll hear back from us within <strong>24 hours</strong> with next steps. We review every application personally.</p>
            <p>Questions? Reply to this email or contact <a href="mailto:${ADMIN_EMAIL}" style="color: #0E0E0E;">${ADMIN_EMAIL}</a></p>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
              <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending consumer confirmation:', error);
    return { success: false, error };
  }
}

export async function sendConsumerApproval(data: {
  firstName: string;
  email: string;
  loginUrl: string;
  segment?: string;
}) {
  const isBeef = data.segment === 'Beef Buyer';

  const loginUtm = utm(data.loginUrl, 'approval', data.segment === 'Beef Buyer' ? 'beef-dashboard' : 'community-dashboard');

  const beefBody = `
    <h1>Welcome to BuyHalfCow</h1>
    <p>Hi ${esc(data.firstName)},</p>
    <p><strong>You're approved.</strong> Welcome to The HERD — a private network that connects you directly with certified local ranchers for bulk beef purchases.</p>
    <div class="divider"></div>
    <p><strong>How It Works:</strong></p>
    <ol style="color: #6B4F3F; line-height: 2;">
      <li><strong>We match you</strong> — Based on your location and preferences, we pair you with a verified rancher in your area</li>
      <li><strong>Personal introduction</strong> — Your rancher will reach out to discuss cuts, pricing, and delivery timeline</li>
      <li><strong>Buy direct</strong> — You purchase directly from the rancher at their price. No middlemen, no markup</li>
    </ol>
    <div class="divider"></div>
    <p><strong>What you get access to:</strong></p>
    <ul style="color: #6B4F3F; line-height: 2;">
      <li>Verified ranchers in your state</li>
      <li>Direct, personal introductions</li>
      <li>Exclusive land deals and brand promotions</li>
      <li>A curated network — no spam, no middlemen</li>
    </ul>
    <a href="${loginUtm}" class="button">See Your Match</a>
    <p style="font-size: 13px; color: #A7A29A;">We're matching you with a rancher now. You'll receive an introduction within 48 hours.</p>
  `;

  const communityBody = `
    <h1>Welcome to the BHC Network</h1>
    <p>Hi ${esc(data.firstName)},</p>
    <p><strong>You're in.</strong> Welcome to the BuyHalfCow community — a curated network built around American agriculture.</p>
    <div class="divider"></div>
    <p><strong>What you have access to:</strong></p>
    <ul style="color: #6B4F3F; line-height: 2;">
      <li>Early access to merch drops and branded gear</li>
      <li>Exclusive brand deals and partner discounts</li>
      <li>Community events and land deal listings</li>
      <li>Weekly updates from the network</li>
    </ul>
    <a href="${loginUtm}" class="button">Explore the Network</a>
    <div class="divider"></div>
    <p><strong>Interested in sourcing beef?</strong></p>
    <p>When you're ready to explore buying direct from a rancher, you can upgrade anytime from your member dashboard. We'll match you personally.</p>
  `;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: isBeef
        ? "You're Approved — Let's Find Your Rancher"
        : 'Welcome to the BHC Network',
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #6B4F3F; }
            .button { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: white !important; text-decoration: none; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; margin: 20px 0; }
            .divider { height: 1px; background: #2A2A2A; margin: 30px 0; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            ${isBeef ? beefBody : communityBody}
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef<br>Questions? Email ${ADMIN_EMAIL}</p>
              <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending consumer approval:', error);
    return { success: false, error };
  }
}

// =====================================================
// BUYER INTRO NOTIFICATION EMAIL
// =====================================================
// (The old two-step flow — sendBuyerMatchNotification then sendBuyerIntroNotification
// — was collapsed into a single intro email. sendBuyerMatchNotification had no
// callers left and was removed for clarity.)

export async function sendBuyerIntroNotification(data: {
  firstName: string;
  email: string;
  rancherName: string;
  rancherEmail: string;
  rancherPhone?: string;
  rancherSlug?: string;
  loginUrl: string;
  scheduledAt?: string; // ISO date string — Resend holds + delivers at this time
  // Optional pricing block — when present, shown in the email so the buyer
  // doesn't have to ask "how much?" before making contact. Big conversion lift.
  quarterPrice?: number;
  quarterLbs?: string;
  halfPrice?: number;
  halfLbs?: string;
  wholePrice?: number;
  wholeLbs?: string;
  nextProcessingDate?: string;
}) {
  // Build pricing block when any tier is configured.
  const pricingRows: string[] = [];
  if (data.quarterPrice && data.quarterPrice > 0) {
    pricingRows.push(
      `<tr><td style="padding:8px 12px;border:1px solid #E5E2DC;font-weight:600;">Quarter Cow</td><td style="padding:8px 12px;border:1px solid #E5E2DC;">$${data.quarterPrice.toLocaleString()}</td><td style="padding:8px 12px;border:1px solid #E5E2DC;color:#6B4F3F;">${esc(data.quarterLbs || '')}${data.quarterLbs ? ' lbs' : ''}</td></tr>`
    );
  }
  if (data.halfPrice && data.halfPrice > 0) {
    pricingRows.push(
      `<tr><td style="padding:8px 12px;border:1px solid #E5E2DC;font-weight:600;">Half Cow</td><td style="padding:8px 12px;border:1px solid #E5E2DC;">$${data.halfPrice.toLocaleString()}</td><td style="padding:8px 12px;border:1px solid #E5E2DC;color:#6B4F3F;">${esc(data.halfLbs || '')}${data.halfLbs ? ' lbs' : ''}</td></tr>`
    );
  }
  if (data.wholePrice && data.wholePrice > 0) {
    pricingRows.push(
      `<tr><td style="padding:8px 12px;border:1px solid #E5E2DC;font-weight:600;">Whole Cow</td><td style="padding:8px 12px;border:1px solid #E5E2DC;">$${data.wholePrice.toLocaleString()}</td><td style="padding:8px 12px;border:1px solid #E5E2DC;color:#6B4F3F;">${esc(data.wholeLbs || '')}${data.wholeLbs ? ' lbs' : ''}</td></tr>`
    );
  }
  const processingLine = data.nextProcessingDate
    ? `<p style="margin-top:12px;font-size:13px;color:#6B4F3F;"><strong>Next processing date:</strong> ${esc(new Date(data.nextProcessingDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }))}</p>`
    : '';
  const pricingBlock = pricingRows.length > 0
    ? `<div style="margin:20px 0;">
    <p style="font-weight:600;margin-bottom:8px;">Current pricing from ${esc(data.rancherName)}:</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      ${pricingRows.join('')}
    </table>
    ${processingLine}
    ${data.rancherSlug ? `<p style="margin-top:12px;"><a href="${utm(`${SITE_URL}/ranchers/${data.rancherSlug}`, 'intro-notification', 'view-ranch')}" style="color:#0E0E0E;">View full ranch page &rarr;</a></p>` : ''}
  </div>`
    : '';

  const contactBlock = data.rancherSlug
    ? `<div class="contact-box">
    <p><strong>${esc(data.rancherName)}</strong></p>
    <p style="margin-top:12px;">
      <a href="${utm(`${SITE_URL}/ranchers/${data.rancherSlug}/contact`, 'intro-notification', 'contact-rancher')}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-size:13px;">Contact ${esc(data.rancherName)} &rarr;</a>
    </p>
  </div>`
    : `<div class="contact-box">
    <p><strong>${esc(data.rancherName)}</strong></p>
    <p>Email: <a href="mailto:${esc(data.rancherEmail)}" style="color:#0E0E0E;">${esc(data.rancherEmail)}</a></p>
    ${data.rancherPhone ? `<p>Phone: <a href="tel:${esc(data.rancherPhone)}" style="color:#0E0E0E;">${esc(data.rancherPhone)}</a></p>` : ''}
  </div>`;

  try {
    const introEmailData: any = {
      from: getFromEmail(),
      to: data.email,
      subject: `Meet your rancher — ${esc(data.rancherName)}`,
      headers: getUnsubscribeHeaders(data.email),
    };
    if (data.scheduledAt) {
      introEmailData.scheduledAt = data.scheduledAt;
    }
    introEmailData.html = `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.contact-box{background:#F4F1EC;border:1px solid #A7A29A;padding:20px 24px;margin:20px 0}.contact-box p{margin:6px 0;color:#0E0E0E}.cta{display:inline-block;padding:16px 32px;background:#0E0E0E;color:#F4F1EC!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:20px 0}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>Your Rancher Introduction</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>I've personally vetted and matched you with <strong>${esc(data.rancherName)}</strong>. They know you're coming — reach out whenever you're ready.</p>
  ${contactBlock}
  ${pricingBlock}
  <p><strong>What to discuss:</strong></p>
  <ul style="color:#6B4F3F;line-height:2">
    <li>What cuts are available and current pricing</li>
    <li>Processing timeline and delivery options</li>
    <li>Any questions about their operation</li>
  </ul>
  <p>They'll walk you through everything. No pressure, no rush — this is a direct relationship between you and your rancher.</p>
  <div class="divider"></div>
  <p style="font-size:13px;">If you don't hear back within 48 hours, reply to this email and I'll follow up on my end.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`;
    await resend.emails.send(introEmailData);
    return { success: true };
  } catch (error) {
    console.error('Error sending buyer intro notification:', error);
    return { success: false, error };
  }
}

// =====================================================
// RANCHER APPROVAL EMAIL
// =====================================================

export async function sendRancherApproval(data: {
  operatorName: string;
  ranchName: string;
  email: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'You\'re Approved — BuyHalfCow Partnership',
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #6B4F3F; }
            .divider { height: 1px; background: #2A2A2A; margin: 30px 0; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>You're In</h1>
            <p>Hi ${esc(data.operatorName)},</p>
            <p><strong>Great news — ${esc(data.ranchName)} has been approved to join the BuyHalfCow network.</strong></p>
            <p>Thanks for taking the time to talk through your operation. We're confident this is a strong fit.</p>
            <div class="divider"></div>
            <p><strong>What Happens Next:</strong></p>
            <ol style="color: #6B4F3F; line-height: 2;">
              <li><strong>Onboarding docs coming soon</strong> — You'll receive the Commission Agreement, Media Agreement, and Rancher Info Packet to review and sign digitally</li>
              <li><strong>Verification</strong> — Provide customer testimonials, operation photos, and/or social proof (Google Reviews, social media, certifications)</li>
              <li><strong>Profile goes live</strong> — Once verified, we activate your profile and start sending you qualified buyers</li>
            </ol>
            <div class="divider"></div>
            <p>Keep an eye on your inbox — the onboarding package will arrive shortly.</p>
            <p>If you have any questions in the meantime, just reply to this email.</p>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef<br>Questions? Email ${ADMIN_EMAIL}</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending rancher approval email:', error);
    return { success: false, error };
  }
}

// =====================================================
// RANCHER GO LIVE EMAIL
// =====================================================

export async function sendRancherGoLiveEmail(data: {
  operatorName: string;
  ranchName: string;
  email: string;
  dashboardUrl?: string;
}) {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
  const dashboardUrl = data.dashboardUrl || `${baseUrl}/rancher`;
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "You're Live — Buyer Leads Are Coming",
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #6B4F3F; }
            .divider { height: 1px; background: #2A2A2A; margin: 30px 0; }
            .button { display: inline-block; padding: 12px 24px; background: #2A2A2A; color: white; text-decoration: none; font-weight: 600; margin: 16px 0; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>You're Live</h1>
            <p>Hi ${esc(data.operatorName)},</p>
            <p><strong>${esc(data.ranchName)} is now live on BuyHalfCow.</strong> Buyer leads will appear in your dashboard as we match approved buyers to your operation.</p>
            <div class="divider"></div>
            <p><strong>How it works:</strong></p>
            <ol style="color: #6B4F3F; line-height: 2;">
              <li>When we find a buyer in your area, we'll send you an intro email with their contact details</li>
              <li>Reach out directly to discuss their order and close the deal</li>
              <li>Mark the referral as "Closed Won" in your dashboard and enter the sale amount — we'll handle the rest</li>
            </ol>
            <div class="divider"></div>
            <p><a href="${esc(dashboardUrl)}" class="button">View Your Dashboard</a></p>
            <p>Questions? Just reply to this email.</p>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef<br>Questions? Email ${ADMIN_EMAIL}</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending rancher go-live email:', error);
    return { success: false, error };
  }
}

// =====================================================
// PARTNER EMAILS
// =====================================================

export async function sendPartnerConfirmation(data: {
  type: 'rancher' | 'brand' | 'land';
  name: string;
  email: string;
}) {
  const typeLabels = {
    rancher: 'Rancher',
    brand: 'Brand Partnership',
    land: 'Land Deal'
  };

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `${typeLabels[data.type]} Application Received — BuyHalfCow`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #6B4F3F; }
            .divider { height: 1px; background: #2A2A2A; margin: 30px 0; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>${typeLabels[data.type]} Application Received</h1>
            <p>Hi ${esc(data.name)},</p>
            <p>Thank you for your interest in ${data.type === 'rancher' ? 'joining The HERD rancher network' : 'partnering with BuyHalfCow'}.</p>
            <p>I've received your application and will review it personally.</p>
            ${data.type === 'rancher' ? `
              <p><strong>You're not joining a platform — you're joining the founding layer.</strong></p>
            ` : ''}
            <div class="divider"></div>
            <p><strong>What Happens Next:</strong></p>
            ${data.type === 'rancher' ? `
              <p><strong>Watch for a second email in the next few minutes</strong> — it contains your Rancher Agreement and info packet. Sign it whenever you're ready; no rush, but we can't go live until it's signed.</p>
              <p>Here's the full process:</p>
              <ol style="line-height: 1.8; color: #6B4F3F;">
                <li><strong>Sign the agreement</strong> — Arrives in a separate email right after this one</li>
                <li><strong>Schedule your call</strong> — Book your 30-minute onboarding call on my calendar (see below)</li>
                <li><strong>Onboarding call</strong> — We discuss your operation, answer questions, explain The HERD network</li>
                <li><strong>Verification</strong> — Share customer testimonials, operation photos, social proof (Google Reviews, social media), and processing facility info</li>
                <li><strong>Certification</strong> — Once verified, your page goes live and you start receiving qualified buyer introductions</li>
              </ol>
              <div style="background: #0E0E0E; color: #F4F1EC; padding: 30px; margin: 30px 0; text-align: center;">
                <h3 style="margin: 0 0 15px 0; font-size: 20px; color: #F4F1EC;">📞 NEXT STEP: Schedule Your Call</h3>
                <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6;">
                  <strong style="color: #F4F1EC;">Your application won't be reviewed until you book your onboarding call.</strong><br>
                  Click below to see my available times and book your 30-minute call:
                </p>
                <a href="${CALENDLY_LINK}" style="display: inline-block; padding: 16px 32px; background: #F4F1EC; color: #0E0E0E !important; text-decoration: none; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; font-size: 14px; border: 2px solid #F4F1EC;">📅 View My Calendar & Book Now</a>
                <p style="margin: 20px 0 0 0; font-size: 12px; color: #A7A29A;">
                  Can't find a time? Reply to this email and we'll figure it out.
                </p>
              </div>
              <p><strong>Important:</strong> I'm traveling through different states conducting ranch tours and certifications. If you're interested in a visit, we'll coordinate timing during our call.</p>
            ` : `
              <p>I manually review every partnership to ensure quality and trust. You'll hear from me within <strong>24-48 hours</strong>.</p>
            `}
            <div class="divider"></div>
            <p>Questions? Reply to this email or contact <a href="mailto:support@buyhalfcow.com" style="color: #0E0E0E;">support@buyhalfcow.com</a></p>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending partner confirmation:', error);
    return { success: false, error };
  }
}

// =====================================================
// BRAND PAYMENT EMAILS
// =====================================================

export async function sendBrandApprovalWithPayment(data: {
  brandName: string;
  contactName: string;
  email: string;
  paymentUrl: string;
  listingPrice: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `You're Approved — Complete Your Brand Listing on BuyHalfCow`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #6B4F3F; }
            .divider { height: 1px; background: #2A2A2A; margin: 30px 0; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>You're Approved</h1>
            <p>Hi ${esc(data.contactName)},</p>
            <p>Great news — <strong>${esc(data.brandName)}</strong> has been approved for the BuyHalfCow partner network.</p>
            <p>Your brand will be featured to our verified beef buyers and rancher network once your listing payment is complete.</p>
            <div class="divider"></div>
            <p><strong>What Your Listing Includes:</strong></p>
            <ul style="line-height: 2; color: #6B4F3F;">
              <li>Featured placement on the member dashboard</li>
              <li>Direct exposure to verified beef buyers and ranch families</li>
              <li>Your exclusive discount displayed to all active members</li>
              <li>Brand profile visible to the entire rancher network</li>
            </ul>
            <div style="background: #0E0E0E; color: #F4F1EC; padding: 30px; margin: 30px 0; text-align: center;">
              <p style="margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 2px;">Annual Listing Fee</p>
              <p style="margin: 0 0 20px 0; font-family: Georgia, serif; font-size: 36px;">${esc(data.listingPrice)}</p>
              <a href="${data.paymentUrl}" style="display: inline-block; padding: 16px 32px; background: #F4F1EC; color: #0E0E0E !important; text-decoration: none; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; font-size: 14px; border: 2px solid #F4F1EC;">Complete Payment &amp; Go Live</a>
              <p style="margin: 20px 0 0 0; font-size: 12px; color: #A7A29A;">Secure checkout powered by Stripe</p>
            </div>
            <p><strong>Note:</strong> Your brand will not be visible to members until payment is completed. This link expires in 30 days.</p>
            <div class="divider"></div>
            <p>Questions? Reply to this email or contact <a href="mailto:support@buyhalfcow.com" style="color: #0E0E0E;">support@buyhalfcow.com</a></p>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending brand approval with payment:', error);
    return { success: false, error };
  }
}

export async function sendBrandListingConfirmation(data: {
  brandName: string;
  email: string;
  amountPaid: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `You're Live — ${data.brandName} is Now on BuyHalfCow`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #6B4F3F; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Your Brand is Live</h1>
            <p>Hi there,</p>
            <p>Payment of <strong>${esc(data.amountPaid)}</strong> has been received. <strong>${esc(data.brandName)}</strong> is now featured across the BuyHalfCow network.</p>
            <div style="background: #F4F1EC; padding: 20px; margin: 20px 0; border-left: 3px solid #0E0E0E;">
              <p style="margin: 0; font-size: 14px;"><strong>Your listing is now visible to:</strong></p>
              <ul style="margin: 8px 0 0 0; color: #6B4F3F; font-size: 14px;">
                <li>All verified beef buyers on the member dashboard</li>
                <li>Certified ranchers in the network benefits section</li>
              </ul>
            </div>
            <p>We'll be in touch with any member engagement updates. If you'd like to update your listing details, discount, or website link at any time, just reply to this email.</p>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending brand listing confirmation:', error);
    return { success: false, error };
  }
}

// =====================================================
// AFFILIATE EMAILS
// =====================================================

export async function sendAffiliateLoginLink(data: {
  email: string;
  loginUrl: string;
  name?: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'Your BuyHalfCow Affiliate Login Link',
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 24px; margin: 0 0 20px 0; }
            .button { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: white !important; text-decoration: none; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; margin: 20px 0; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Your Affiliate Login Link</h1>
            <p>Hi ${esc(data.name || 'there')},</p>
            <p>Click the button below to access your BuyHalfCow affiliate dashboard:</p>
            <a href="${data.loginUrl}" class="button">Log In to Dashboard</a>
            <p style="color: #6B4F3F; font-size: 14px;">This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
            <div class="footer">
              <p>BuyHalfCow — Private Network for American Ranch Beef</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending affiliate login link:', error);
    return { success: false, error };
  }
}

export async function sendAffiliateInvite(data: {
  email: string;
  name: string;
  code: string;
  loginRequestUrl: string;
  buyerLink: string;
  rancherLink: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "You're a BuyHalfCow Affiliate — Here Are Your Links",
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 24px; margin: 0 0 20px 0; }
            .link-box { background: #F4F1EC; padding: 12px 16px; margin: 8px 0; font-size: 14px; word-break: break-all; }
            .button { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: white !important; text-decoration: none; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; margin: 20px 0; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Welcome to the BHC Affiliate Program</h1>
            <p>Hi ${esc(data.name)},</p>
            <p>You're now a BuyHalfCow affiliate. Share your links to refer buyers and ranchers — we'll track every signup.</p>
            <p><strong>Your buyer link:</strong></p>
            <div class="link-box">${esc(data.buyerLink)}</div>
            <p><strong>Your rancher link:</strong></p>
            <div class="link-box">${esc(data.rancherLink)}</div>
            <p>To view your dashboard and referral counts, request a login link:</p>
            <a href="${data.loginRequestUrl}" class="button">Get Your Login Link</a>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending affiliate invite:', error);
    return { success: false, error };
  }
}

// =====================================================
// ADMIN ALERTS
// =====================================================

export async function sendAdminAlert(data: {
  type: 'consumer' | 'rancher' | 'brand' | 'land';
  name: string;
  email: string;
  details: Record<string, any>;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: ADMIN_EMAIL,
      subject: `New ${data.type.charAt(0).toUpperCase() + data.type.slice(1)} Application`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: monospace; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-size: 18px; margin: 0 0 20px 0; font-weight: bold; }
            .field { margin: 8px 0; padding: 8px; background: #F4F1EC; }
            .label { font-weight: bold; display: inline-block; width: 120px; }
            .button { display: inline-block; padding: 12px 24px; background: #0E0E0E; color: white !important; text-decoration: none; margin: 20px 10px 0 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>NEW APPLICATION RECEIVED</h1>
            <p><strong>Type:</strong> ${data.type.toUpperCase()}</p>
            <p><strong>Name:</strong> ${esc(data.name)}</p>
            <p><strong>Email:</strong> ${esc(data.email)}</p>
            <hr>
            <h2>Details:</h2>
            ${Object.entries(data.details).map(([key, value]) => 
              `<div class="field"><span class="label">${esc(key)}:</span> ${esc(String(value))}</div>`
            ).join('')}
            <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com'}/admin" class="button">Review in Admin</a>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending admin alert:', error);
    return { success: false, error };
  }
}

// =====================================================
// INQUIRY EMAILS
// =====================================================

export async function sendInquiryToRancher(data: {
  rancherName: string;
  rancherEmail: string;
  ranchName: string;
  consumerName: string;
  consumerEmail: string;
  consumerPhone: string;
  message: string;
  interestType: string;
  inquiryId: string;
}) {
  const interestLabels: Record<string, string> = {
    half_cow: 'Half Cow',
    quarter_cow: 'Quarter Cow',
    whole_cow: 'Whole Cow',
    custom: 'Custom Order'
  };

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.rancherEmail,
      replyTo: data.consumerEmail, // Rancher can reply directly to consumer
      subject: `New Inquiry from BuyHalfCow Member`,
      headers: getUnsubscribeHeaders(data.rancherEmail),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 24px; margin: 0 0 20px 0; }
            .field { margin: 12px 0; padding: 12px; background: #F4F1EC; }
            .label { font-weight: bold; color: #6B4F3F; }
            .message-box { padding: 16px; background: #F4F1EC; border-left: 3px solid #6B4F3F; margin: 20px 0; }
            .divider { height: 1px; background: #A7A29A; margin: 30px 0; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>New Inquiry for ${esc(data.ranchName)}</h1>
            <p>Hi ${esc(data.rancherName)},</p>
            <p>You have a new inquiry from a BuyHalfCow member:</p>
            
            <div class="divider"></div>
            
            <div class="field">
              <span class="label">Name:</span> ${esc(data.consumerName)}
            </div>
            <div class="field">
              <span class="label">Email:</span> ${esc(data.consumerEmail)}
            </div>
            <div class="field">
              <span class="label">Phone:</span> ${esc(data.consumerPhone)}
            </div>
            <div class="field">
              <span class="label">Interested In:</span> ${esc(interestLabels[data.interestType] || data.interestType)}
            </div>
            
            <div class="message-box">
              <div class="label">Message:</div>
              <p style="margin: 8px 0 0 0;">${esc(data.message)}</p>
            </div>
            
            <div class="divider"></div>
            
            <p><strong>Reply directly to this email</strong> to connect with ${data.consumerName}.</p>
            
            <div class="footer">
              <p>This inquiry was facilitated by BuyHalfCow.<br>
              Inquiry Reference: #${data.inquiryId.slice(0, 8)}<br>
              Remember: 10% commission applies to sales made through the platform.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending inquiry to rancher:', error);
    return { success: false, error };
  }
}

export async function sendInquiryAlertToAdmin(data: {
  ranchName: string;
  rancherEmail: string;
  consumerName: string;
  consumerEmail: string;
  interestType: string;
  message: string;
  inquiryId: string;
}) {
  const interestLabels: Record<string, string> = {
    half_cow: 'Half Cow',
    quarter_cow: 'Quarter Cow',
    whole_cow: 'Whole Cow',
    custom: 'Custom Order'
  };

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: ADMIN_EMAIL,
      subject: `New Inquiry: ${data.consumerName} → ${data.ranchName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: monospace; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-size: 18px; margin: 0 0 20px 0; font-weight: bold; }
            .field { margin: 8px 0; padding: 8px; background: #F4F1EC; }
            .button { display: inline-block; padding: 12px 24px; background: #0E0E0E; color: white !important; text-decoration: none; margin: 20px 10px 0 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>⚠️ NEW INQUIRY REQUIRES APPROVAL</h1>
            
            <div class="field"><strong>Consumer:</strong> ${esc(data.consumerName)} (${esc(data.consumerEmail)})</div>
            <div class="field"><strong>Rancher:</strong> ${esc(data.ranchName)} (${esc(data.rancherEmail)})</div>
            <div class="field"><strong>Interest:</strong> ${esc(interestLabels[data.interestType])}</div>
            <div class="field"><strong>Inquiry ID:</strong> #${esc(data.inquiryId.slice(0, 8))}</div>
            
            <hr>
            
            <p><strong>Message:</strong></p>
            <p style="background: #F4F1EC; padding: 16px;">${esc(data.message)}</p>
            
            <p style="background: #FFF3CD; padding: 16px; border-left: 4px solid #FFC107; margin: 20px 0;">
              <strong>⚠️ ACTION REQUIRED:</strong><br>
              This inquiry is PENDING and has NOT been sent to the rancher yet.<br>
              Review and approve/reject in your admin dashboard.
            </p>
            
            <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com'}/admin/inquiries" class="button">Review & Approve in Admin →</a>
            
            <p style="margin-top: 30px; font-size: 12px; color: #6B4F3F;">
              The rancher will only receive contact info AFTER you approve this inquiry.
            </p>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending inquiry alert to admin:', error);
    return { success: false, error };
  }
}

// =====================================================
// BROADCAST EMAILS
// =====================================================

export async function sendBroadcastEmail(data: {
  to: string;
  name: string;
  subject: string;
  message: string;
  campaignName: string;
  includeCTA: boolean;
  ctaText: string;
  ctaLink: string;
  htmlBody?: string;
}) {
  try {
    if (data.htmlBody) {
      await resend.emails.send({
        from: getFromEmail(),
        to: data.to,
        subject: data.subject,
        headers: getUnsubscribeHeaders(data.to),
        html: data.htmlBody,
      });
      return { success: true };
    }

    const formattedMessage = esc(data.message).replace(/\n/g, '<br>');

    await resend.emails.send({
      from: getFromEmail(),
      to: data.to,
      subject: data.subject,
      headers: getUnsubscribeHeaders(data.to),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 20px 0; }
            p { margin: 16px 0; color: #0E0E0E; }
            .message { margin: 30px 0; }
            .button { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: white !important; text-decoration: none; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; margin: 20px 0; }
            .divider { height: 1px; background: #2A2A2A; margin: 30px 0; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>${esc(data.subject)}</h1>
            <p>Hi ${esc(data.name)},</p>
            <div class="message">
              <p>${formattedMessage}</p>
            </div>
            ${data.includeCTA ? `
              <div class="divider"></div>
              <a href="${data.ctaLink}" class="button">${data.ctaText}</a>
            ` : ''}
            <div class="footer">
              <p>BuyHalfCow — Private Access Network<br>
              Not a marketplace. Not e-commerce.<br>
              Questions? Email ${ADMIN_EMAIL}</p>
              <p style="margin-top: 12px; font-size: 10px; color: #ccc;">
                <a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.to)}" style="color: #ccc;">Unsubscribe</a> | Campaign: ${data.campaignName}
              </p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending broadcast email:', error);
    return { success: false, error };
  }
}

// =====================================================
// AI SEQUENCE EMAILS
// =====================================================

export async function sendSequenceEmail_BeefDay3(data: {
  firstName: string;
  email: string;
  state: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `We're finding your rancher — here's what's happening`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html><html><head>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:16px 0;color:#0E0E0E}.button{display:inline-block;padding:14px 28px;background:#0E0E0E;color:white!important;text-decoration:none;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin:20px 0}.divider{height:1px;background:#2A2A2A;margin:30px 0}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
        </head><body><div class="container">
        <h1>Your match is in progress</h1>
        <p>Hi ${esc(data.firstName)},</p>
        <p>You were approved for BuyHalfCow a few days ago — I wanted to give you a quick update on where things stand.</p>
        <p>We're actively working on finding you the right rancher in ${esc(data.state)}. Our matching process is hands-on: I personally review rancher availability and fit before making any introduction. That's what keeps the quality high.</p>
        <div class="divider"></div>
        <p><strong>What happens next:</strong></p>
        <ul style="color:#0E0E0E;line-height:2">
          <li>We confirm a rancher has capacity and matches your order type</li>
          <li>I make a personal introduction via email</li>
          <li>You connect directly — no middleman in the conversation</li>
        </ul>
        <p>If you have a preference on cut type, quantity, or timing that you didn't share on your application, <strong>just reply to this email</strong> and I'll factor it in.</p>
        <div class="footer"><p>— Benjamin, BuyHalfCow<br>Questions? Reply to this email.</p><p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p></div>
        </div></body></html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending sequence email (beef day 3):', error);
    return { success: false, error };
  }
}

export async function sendSequenceEmail_BeefDay7(data: {
  firstName: string;
  email: string;
  rancherName: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Did you hear from ${esc(data.rancherName)}?`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html><html><head>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:16px 0;color:#0E0E0E}.button{display:inline-block;padding:14px 28px;background:#0E0E0E;color:white!important;text-decoration:none;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin:20px 0}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
        </head><body><div class="container">
        <h1>Quick check-in</h1>
        <p>Hi ${esc(data.firstName)},</p>
        <p>We introduced you to <strong>${esc(data.rancherName)}</strong> earlier this week. I wanted to follow up — did you hear from them? Did you get a chance to connect?</p>
        <p>If you haven't heard back within 24 hours, <strong>reply to this email</strong> and I'll follow up on my end. Every rancher in our network is vetted and responsive — if something isn't working, I want to know.</p>
        <p>If you've already connected, that's great — just ignore this.</p>
        <div class="footer"><p>— Benjamin, BuyHalfCow<br>Reply here if you need anything.</p><p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p></div>
        </div></body></html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending sequence email (beef day 7):', error);
    return { success: false, error };
  }
}

export async function sendSequenceEmail_CommunityDay7(data: {
  firstName: string;
  email: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Inside BHC: what your membership actually gets you`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html><html><head>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:16px 0;color:#0E0E0E}.button{display:inline-block;padding:14px 28px;background:#0E0E0E;color:white!important;text-decoration:none;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin:20px 0}.divider{height:1px;background:#2A2A2A;margin:30px 0}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
        </head><body><div class="container">
        <h1>Welcome to the network</h1>
        <p>Hi ${esc(data.firstName)},</p>
        <p>It's been about a week since you joined BuyHalfCow. I wanted to take a moment to share what being a Community member actually means.</p>
        <div class="divider"></div>
        <p><strong>What we do at BHC:</strong></p>
        <ul style="color:#0E0E0E;line-height:2">
          <li>We verify American ranchers — only operators with real capacity, real beef, and real ethics make the list</li>
          <li>We source exclusive land deals for members interested in owning acreage</li>
          <li>We curate brand partnerships from suppliers we actually trust</li>
          <li>Community members get early access to announcements, drops, and content before anyone else</li>
        </ul>
        <p>This is not a marketplace. We don't take advertising. We don't sell your data. We just connect the right people.</p>
        <a href="${utm(data.loginUrl, 'community-day7', 'member-home')}" class="button">Visit Your Member Home →</a>
        <div class="footer"><p>— Benjamin, BuyHalfCow<br>Reply with questions anytime.</p><p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p></div>
        </div></body></html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending sequence email (community day 7):', error);
    return { success: false, error };
  }
}

export async function sendSequenceEmail_CommunityDay14(data: {
  firstName: string;
  email: string;
  upgradeUrl: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Ready to source beef directly from a rancher?`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html><html><head>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:16px 0;color:#0E0E0E}.button{display:inline-block;padding:14px 28px;background:#0E0E0E;color:white!important;text-decoration:none;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin:20px 0}.divider{height:1px;background:#2A2A2A;margin:30px 0}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
        </head><body><div class="container">
        <h1>The beef buyer path</h1>
        <p>Hi ${esc(data.firstName)},</p>
        <p>You've been part of the BHC community for a couple weeks now. I wanted to check in on something — have you thought about sourcing beef directly from a rancher?</p>
        <div class="divider"></div>
        <p><strong>Here's how it works for Beef Buyers:</strong></p>
        <ol style="color:#0E0E0E;line-height:2">
          <li>Tell us what you want — whole, half, or quarter cow, your budget, your state</li>
          <li>We match you with a verified rancher in your area who has availability</li>
          <li>We make a personal introduction — you buy direct, at the rancher's price</li>
        </ol>
        <p>No subscription, no markup, no middleman in the transaction. Just clean beef from a rancher you know by name.</p>
        <a href="${utm(data.upgradeUrl, 'community-day14', 'upgrade-cta')}" class="button">Become a Beef Buyer →</a>
        <p style="font-size:13px;color:#A7A29A">Already on the beef path? Just <a href="${utm(data.loginUrl, 'community-day14', 'member-home')}" style="color:#0E0E0E">log in</a> to check your match.</p>
        <div class="footer"><p>— Benjamin, BuyHalfCow<br>Reply if you have questions about the process.</p><p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p></div>
        </div></body></html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending sequence email (community day 14):', error);
    return { success: false, error };
  }
}

export async function sendChaseUpEmail(data: {
  firstName: string;
  email: string;
  rancherName: string;
  loginUrl: string;
  aiDraftedMessage: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Quick check-in from BuyHalfCow`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html><html><head>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:16px 0;color:#0E0E0E}.button{display:inline-block;padding:14px 28px;background:#0E0E0E;color:white!important;text-decoration:none;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin:20px 0}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
        </head><body><div class="container">
        <h1>Quick check-in</h1>
        <p>Hi ${esc(data.firstName)},</p>
        ${data.aiDraftedMessage.split('\n').filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}
        <p><strong>Just reply to this email</strong> and let me know where things stand — or if you'd like me to re-match you with a different rancher.</p>
        <div class="footer"><p>— Benjamin, BuyHalfCow<br>Questions? Reply to this email.</p><p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p></div>
        </div></body></html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending chase-up email:', error);
    return { success: false, error };
  }
}

// =====================================================
// MERCH EMAIL
// =====================================================

export async function sendMerchEmail(data: {
  firstName: string;
  email: string;
}) {
  const firstName = esc(data.firstName);
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'Represent American Ranch Beef — BuyHalfCow Merch',
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
p { color: #6B4F3F; margin: 12px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>Wear the Mission</h1>
  <p>Hi ${firstName},</p>
  <p>You're part of the BuyHalfCow community — people who care about where their food comes from and want to support American ranchers directly.</p>
  <p>While we work on building supply in your area, you can rep the movement. Our merch is designed for people who give a damn about real beef from real ranches.</p>
  <div class="divider"></div>
  <div style="text-align: center;">
    <a href="${utm(MERCH_URL, 'nurture-merch', 'shop-cta')}" class="cta">Shop BuyHalfCow Merch</a>
  </div>
  <div class="divider"></div>
  <p>And when ranchers become available in your area, you'll be first to know.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending merch email:', error);
    return { success: false, error };
  }
}

// =====================================================
// AFFILIATE EMAILS
// =====================================================

export async function sendAffiliateWelcome(data: {
  name: string;
  email: string;
  code: string;
  dashboardUrl: string;
  buyerLink: string;
  rancherLink: string;
}) {
  const firstName = esc(data.name.split(' ')[0] || data.name);
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "You're a BuyHalfCow Affiliate — Here Are Your Links",
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
h3 { font-family: Georgia, serif; font-size: 18px; margin: 20px 0 8px; }
p { color: #6B4F3F; margin: 12px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.link-box { background: #F4F1EC; border: 1px solid #A7A29A; padding: 12px 16px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 8px 0; color: #0E0E0E; }
.code-badge { display: inline-block; background: #0E0E0E; color: #F4F1EC; padding: 4px 12px; font-family: monospace; font-size: 18px; letter-spacing: 2px; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>Welcome to the Program, ${firstName}</h1>
  <p>You're now an official BuyHalfCow affiliate. Every buyer or rancher who signs up through your link is tracked to you automatically.</p>
  <div class="divider"></div>
  <p><strong>Your affiliate code:</strong></p>
  <p><span class="code-badge">${esc(data.code)}</span></p>
  <h3>Your Referral Links</h3>
  <p><strong>Buyer link</strong> — share with people who want to buy beef direct:</p>
  <div class="link-box">${esc(data.buyerLink)}</div>
  <p><strong>Rancher link</strong> — share with ranchers who want to sell:</p>
  <div class="link-box">${esc(data.rancherLink)}</div>
  <div class="divider"></div>
  <div style="text-align: center;">
    <a href="${esc(data.dashboardUrl)}" class="cta">View Your Dashboard</a>
  </div>
  <div class="divider"></div>
  <p style="font-size: 13px;">Questions? Just reply to this email.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending affiliate welcome email:', error);
    return { success: false, error };
  }
}

// =====================================================
// AUTOMATION LAYER EMAILS
// =====================================================

export async function sendWaitlistEmail(data: {
  firstName: string;
  email: string;
  state: string;
  loginUrl?: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "You're Approved — We're Expanding to Your Area",
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
p { color: #6B4F3F; margin: 12px 0; }
.highlight { background: #F4F1EC; border-left: 3px solid #0E0E0E; padding: 12px 16px; margin: 20px 0; color: #0E0E0E; }
.cta { display: inline-block; padding: 14px 28px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>You're Approved</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>Your application has been approved — you're in the network. We're actively expanding our rancher partnerships in <strong>${esc(data.state)}</strong> and you're at the front of the line.</p>
  <div class="highlight">
    <strong>You're first in line.</strong> The moment a rancher is ready in your state, we'll email you and make a personal introduction within 24 hours. No action needed on your end.
  </div>
  <p><strong>While you wait, here's what you can do:</strong></p>
  <ul style="color: #6B4F3F; line-height: 2;">
    <li>Follow us on <a href="https://www.instagram.com/buyhalfcow" style="color:#0E0E0E;">Instagram</a> for real-time ranch visit updates</li>
    <li>Know a rancher who sells direct? Send them to <a href="${SITE_URL}/partners" style="color:#0E0E0E;">buyhalfcow.com/partners</a> — it speeds things up in your area</li>
    <li>Tell a friend who wants better beef — more demand in your state = faster supply</li>
  </ul>
  <div class="divider"></div>
  <p style="font-size: 13px;">Questions? Just reply to this email.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending waitlist email:', error);
    return { success: false, error };
  }
}

export async function sendIntroCheckInEmail(data: {
  firstName: string;
  email: string;
  rancherName: string;
  rancherEmail: string;
  rancherPhone: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Did you connect with ${esc(data.rancherName)}?`,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
p { color: #6B4F3F; margin: 12px 0; }
.contact-box { background: #F4F1EC; border: 1px solid #A7A29A; padding: 16px 20px; margin: 20px 0; }
.contact-box p { margin: 6px 0; color: #0E0E0E; }
.cta { display: inline-block; padding: 14px 28px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>Checking in on your rancher intro</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>A few days ago we introduced you to <strong>${esc(data.rancherName)}</strong>. We wanted to check in — did you two connect?</p>
  <p>If you haven't heard from them yet, here's how to reach them directly:</p>
  <div class="contact-box">
    <p><strong>${esc(data.rancherName)}</strong></p>
    ${data.rancherEmail ? `<p>Email: <a href="mailto:${esc(data.rancherEmail)}" style="color:#0E0E0E;">${esc(data.rancherEmail)}</a></p>` : ''}
    ${data.rancherPhone ? `<p>Phone: <a href="tel:${esc(data.rancherPhone)}" style="color:#0E0E0E;">${esc(data.rancherPhone)}</a></p>` : ''}
  </div>
  <p>If there's been an issue or you'd like us to follow up on your behalf, <strong>just reply to this email</strong> and we'll handle it.</p>
  <div class="divider"></div>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending intro check-in email:', error);
    return { success: false, error };
  }
}

export async function sendRancherLeadNudge(data: {
  rancherName: string;
  email: string;
  leads: Array<{ buyerName: string; status: string; daysSince: number }>;
  dashboardUrl: string;
}) {
  const leadRows = data.leads.map(l =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #A7A29A;">${esc(l.buyerName)}</td><td style="padding:8px 12px;border-bottom:1px solid #A7A29A;">${esc(l.status)}</td><td style="padding:8px 12px;border-bottom:1px solid #A7A29A;color:#6B4F3F;">${l.daysSince}d ago</td></tr>`
  ).join('');
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `You have ${data.leads.length} lead${data.leads.length === 1 ? '' : 's'} waiting on an update`,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
p { color: #6B4F3F; margin: 12px 0; }
table { width: 100%; border-collapse: collapse; margin: 20px 0; }
th { text-align: left; padding: 8px 12px; background: #F4F1EC; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6B4F3F; }
.cta { display: inline-block; padding: 14px 28px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>Your leads need a status update</h1>
  <p>Hi ${esc(data.rancherName)},</p>
  <p>You have <strong>${data.leads.length} lead${data.leads.length === 1 ? '' : 's'}</strong> that haven't been updated in over 5 days. A quick status update helps us keep buyers engaged and slots filled.</p>
  <table>
    <thead><tr>
      <th>Buyer</th><th>Status</th><th>Last Updated</th>
    </tr></thead>
    <tbody>${leadRows}</tbody>
  </table>
  <p>Just log in and mark each lead as Closed Won, Closed Lost, or add a note if still in progress.</p>
  <div style="text-align: center;">
    <a href="${esc(data.dashboardUrl)}" class="cta">Update My Leads →</a>
  </div>
  <div class="divider"></div>
  <p style="font-size: 13px;">Questions? Just reply to this email.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending rancher lead nudge email:', error);
    return { success: false, error };
  }
}

export async function sendRepeatPurchaseEmail(data: {
  firstName: string;
  email: string;
  rancherName: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Time for another half, ${esc(data.firstName)}?`,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
p { color: #6B4F3F; margin: 12px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.highlight { background: #F4F1EC; border-left: 3px solid #0E0E0E; padding: 12px 16px; margin: 20px 0; color: #0E0E0E; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>Ready for Another Round?</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>It's been about a month since you picked up beef from <strong>${esc(data.rancherName)}</strong>. If the freezer is running low, now's a great time to lock in another order.</p>
  <div class="highlight">
    <strong>${esc(data.rancherName)}</strong> is still taking buyers. Same quality, same rancher, no middleman markup.
  </div>
  <p>Log in to let us know you want to be matched again — we'll get you connected within 24 hours.</p>
  <div style="text-align: center;">
    <a href="${utm(data.loginUrl, 'repeat-purchase', 'order-again')}" class="cta">Order Again →</a>
  </div>
  <div class="divider"></div>
  <p style="font-size: 13px;">Not ready yet? No worries — you'll stay in our network and we'll check in again when the time is right.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending repeat purchase email:', error);
    return { success: false, error };
  }
}

// =====================================================
// UTILITY FUNCTIONS
// =====================================================

// =====================================================
// PHASE 1 NURTURE SEQUENCE
// =====================================================

const INSTAGRAM_URL = 'https://www.instagram.com/buyhalfcow';
const YOUTUBE_URL = 'https://www.youtube.com/@buyhalfcow';

export async function sendNurtureDay3(data: {
  firstName: string;
  email: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "What's actually happening right now",
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 24px; }
p { color: #3a3a3a; margin: 14px 0; }
.divider { height: 1px; background: #A7A29A; margin: 28px 0; }
.links { display: flex; gap: 12px; margin: 20px 0; }
.link-btn { display: inline-block; padding: 12px 22px; border: 1px solid #0E0E0E; color: #0E0E0E !important; text-decoration: none; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-right: 10px; }
.footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>What's actually happening right now</h1>
  <p>Hey ${esc(data.firstName)},</p>
  <p>Quick update — not marketing, just the real situation.</p>
  <p>I'm on the road right now visiting ranches, signing new partners, and building the supply chain so that when we match you, it's the right rancher — not just whoever's available.</p>
  <p><strong>What's happening this week:</strong></p>
  <ul style="color:#3a3a3a;line-height:2">
    <li>Locking down rancher partnerships across multiple states</li>
    <li>Processing facility tours and agreements</li>
    <li>Brand partners joining the network with member-only deals</li>
  </ul>
  <div class="divider"></div>
  <p><strong>Two things you can do right now:</strong></p>
  <ol style="color:#3a3a3a;line-height:2">
    <li><strong>Follow the build</strong> — I'm documenting everything in real time. Ranch visits, negotiations, the whole thing.</li>
    <li><strong>Help us expand faster</strong> — Know a rancher who sells direct? Send them to <a href="${SITE_URL}/partners" style="color:#0E0E0E;">buyhalfcow.com/partners</a></li>
  </ol>
  <div>
    <a href="${utm(INSTAGRAM_URL, 'nurture-day3', 'instagram')}" class="link-btn">Instagram @buyhalfcow</a>
    <a href="${utm(YOUTUBE_URL, 'nurture-day3', 'youtube')}" class="link-btn">YouTube</a>
  </div>
  <div class="divider"></div>
  <p>You'll hear from me the moment there's a rancher ready in your area. You're already in.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Taking back American ranching, one half cow at a time</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending nurture day-3 email:', error);
    return { success: false, error };
  }
}

export async function sendNurtureDay10(data: {
  firstName: string;
  email: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "The ranchers I'm meeting are the real deal",
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 24px; }
p { color: #3a3a3a; margin: 14px 0; }
.pullquote { border-left: 3px solid #0E0E0E; padding: 12px 20px; margin: 24px 0; font-style: italic; color: #0E0E0E; background: #F4F1EC; }
.divider { height: 1px; background: #A7A29A; margin: 28px 0; }
.link-btn { display: inline-block; padding: 12px 22px; border: 1px solid #0E0E0E; color: #0E0E0E !important; text-decoration: none; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-right: 10px; }
.footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>The ranchers I'm meeting are the real deal</h1>
  <p>Hey ${esc(data.firstName)},</p>
  <p>Quick update from the road. I've been visiting ranches, meeting families who've been raising cattle for generations. These aren't factory farms — these are real operations getting squeezed out by big processors.</p>
  <div class="pullquote">
    "We're gonna take back American ranching and agriculture." That's not a tagline. That's why I'm doing this.
  </div>
  <p>The ranchers I'm partnering with want buyers who care about where their beef comes from. That's you.</p>
  <p><strong>Here's what I need from you:</strong></p>
  <ul style="color:#3a3a3a;line-height:2">
    <li><strong>Reply to this email</strong> and tell me what state you're in and what you're looking for (quarter, half, or whole cow). It helps me prioritize which areas to build supply in first.</li>
    <li><strong>Know a rancher?</strong> Send them to <a href="${SITE_URL}/partners" style="color:#0E0E0E;">buyhalfcow.com/partners</a></li>
  </ul>
  <div class="divider"></div>
  <p>I'm documenting everything — ranch visits, negotiations, the whole build. Follow along:</p>
  <div>
    <a href="${utm(INSTAGRAM_URL, 'nurture-day10', 'instagram')}" class="link-btn">Instagram @buyhalfcow</a>
    <a href="${utm(YOUTUBE_URL, 'nurture-day10', 'youtube')}" class="link-btn">YouTube</a>
  </div>
  <div class="divider"></div>
  <p>We're close. More soon.</p>
  <div class="footer">
    <p>— Benjamin<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending nurture day-10 email:', error);
    return { success: false, error };
  }
}

export async function sendNurtureAffiliate(data: {
  firstName: string;
  email: string;
  referralLink: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "Want to help close this faster?",
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 24px; }
p { color: #3a3a3a; margin: 14px 0; }
.link-box { background: #F4F1EC; border: 1px solid #A7A29A; padding: 14px 18px; margin: 20px 0; font-family: monospace; font-size: 13px; word-break: break-all; color: #0E0E0E; }
.cta { display: inline-block; padding: 14px 28px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.divider { height: 1px; background: #A7A29A; margin: 28px 0; }
.footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>Want to help close this faster?</h1>
  <p>Hey ${esc(data.firstName)},</p>
  <p>I've been on the road building supply. Visiting ranches. Closing partnerships. Doing the hard work to make this real.</p>
  <p>The people who believe in this early are the ones who help it move faster. Not with money — just by sending the right people our way.</p>
  <p>That could be a neighbor who complains about grocery store meat. A farmer who wants guaranteed buyers. A friend who's been talking about buying local but never knew how.</p>
  <p>One link. Send it to whoever comes to mind:</p>
  <div class="link-box">${esc(data.referralLink)}</div>
  <p>Everyone who signs up through your link is tracked to you. I want the people who helped build this to be rewarded when it's running.</p>
  <div style="text-align: center;">
    <a href="${utm(data.loginUrl, 'nurture-affiliate', 'dashboard')}" class="cta">View Your Affiliate Dashboard →</a>
  </div>
  <div class="divider"></div>
  <p style="font-size: 13px; color: #6B4F3F;">Haven't set up your affiliate account yet? Just reply and I'll get you sorted directly.</p>
  <div class="footer">
    <p>— Benjamin<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending nurture affiliate email:', error);
    return { success: false, error };
  }
}

// =====================================================
// TIMELESS NURTURE DRIP — works for any buyer, any time
// =====================================================

export async function sendNurtureWhy(data: {
  firstName: string;
  email: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'Why 10,000 families are ditching the grocery store',
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html><head><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 24px; }
p { color: #3a3a3a; margin: 14px 0; }
.divider { height: 1px; background: #A7A29A; margin: 28px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style></head>
<body><div class="container">
  <h1>Why families are buying beef directly from ranchers</h1>
  <p>Hey ${esc(data.firstName)},</p>
  <p>Here's something most people don't think about: the beef at your grocery store passed through 4-6 middlemen before it hit the shelf. Each one took a cut. By the time you're paying $14/lb for ribeye, the rancher who raised that animal got maybe $2.</p>
  <p><strong>When you buy direct:</strong></p>
  <ul style="color:#3a3a3a;line-height:2">
    <li>You pay $5-8/lb average across all cuts — steaks, roasts, ground, everything</li>
    <li>You know exactly where it came from and how it was raised</li>
    <li>The rancher gets a fair price and can keep doing what they do</li>
    <li>Your freezer is stocked for 6-12 months</li>
  </ul>
  <div class="divider"></div>
  <p>That's what BuyHalfCow is built for — connecting you directly with verified ranchers in your area. No middlemen. No markup.</p>
  <a href="${utm(data.loginUrl, 'nurture-why', 'dashboard')}" class="cta">Browse Ranchers Near You</a>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — From Pasture to Your Freezer</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending nurture-why email:', error);
    return { success: false, error };
  }
}

export async function sendNurtureHow(data: {
  firstName: string;
  email: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "Here's exactly how buying a half cow works",
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html><head><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 24px; }
p { color: #3a3a3a; margin: 14px 0; }
.step { background: #F4F1EC; padding: 16px; margin: 12px 0; border-left: 3px solid #0E0E0E; }
.divider { height: 1px; background: #A7A29A; margin: 28px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style></head>
<body><div class="container">
  <h1>How buying a half cow actually works</h1>
  <p>Hey ${esc(data.firstName)},</p>
  <p>People always ask "do I literally get half a cow?" — here's the real breakdown:</p>
  <div class="step"><strong>Step 1: Choose your share</strong><br>Quarter (~100-120 lbs), Half (~200-250 lbs), or Whole (~400+ lbs). Most families start with a quarter.</div>
  <div class="step"><strong>Step 2: Your rancher processes it</strong><br>The animal goes to a USDA-inspected facility. You choose your cuts — steaks, roasts, ground beef, stew meat. It's custom butchered for you.</div>
  <div class="step"><strong>Step 3: Pick up or delivery</strong><br>Everything comes vacuum-sealed and flash-frozen. Lasts 12+ months in a standard chest freezer.</div>
  <div class="divider"></div>
  <p><strong>What you actually get in a quarter:</strong> ~30 lbs ground beef, ~20 lbs steaks (ribeye, NY strip, sirloin), ~20 lbs roasts, ~15 lbs stew/short ribs, ~15 lbs misc cuts. That's 6-8 months of beef for a family of four.</p>
  <p>All for about $5-8 per pound, all-in. That's grocery store ground beef prices for premium steaks.</p>
  <a href="${utm(data.loginUrl, 'nurture-how', 'dashboard')}" class="cta">Find Your Rancher</a>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — From Pasture to Your Freezer</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending nurture-how email:', error);
    return { success: false, error };
  }
}

export async function sendNurtureUrgency(data: {
  firstName: string;
  email: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'Processing dates fill up fast',
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html><head><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 24px; }
p { color: #3a3a3a; margin: 14px 0; }
.divider { height: 1px; background: #A7A29A; margin: 28px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style></head>
<body><div class="container">
  <h1>Quick heads up — processing dates fill up</h1>
  <p>Hey ${esc(data.firstName)},</p>
  <p>One thing people don't realize about buying direct: ranchers only process a limited number of animals per month. Most small operations do 2-4 head per processing date, and USDA facilities book out weeks in advance.</p>
  <p>That means if you wait until you're "ready," the next available slot might be 4-8 weeks out.</p>
  <p><strong>What I'd suggest:</strong></p>
  <ul style="color:#3a3a3a;line-height:2">
    <li>Browse the ranchers on your dashboard — most show their next processing date</li>
    <li>If one looks right, reserve your spot with a deposit</li>
    <li>You'll pick your exact cuts closer to the date</li>
  </ul>
  <div class="divider"></div>
  <p>No pressure — just want to make sure you don't miss out when you're ready to pull the trigger.</p>
  <a href="${utm(data.loginUrl, 'nurture-urgency', 'dashboard')}" class="cta">Check Available Ranchers</a>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — From Pasture to Your Freezer</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending nurture-urgency email:', error);
    return { success: false, error };
  }
}

export async function sendNurtureReferral(data: {
  firstName: string;
  email: string;
  loginUrl: string;
  referralLink: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'Know someone who would love this?',
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html><head><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 24px; }
p { color: #3a3a3a; margin: 14px 0; }
.divider { height: 1px; background: #A7A29A; margin: 28px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style></head>
<body><div class="container">
  <h1>Know someone who'd love buying direct?</h1>
  <p>Hey ${esc(data.firstName)},</p>
  <p>BuyHalfCow grows best by word of mouth. If you know someone who:</p>
  <ul style="color:#3a3a3a;line-height:2">
    <li>Cares about where their food comes from</li>
    <li>Has a chest freezer (or has been thinking about one)</li>
    <li>Is tired of paying grocery store prices for mediocre beef</li>
    <li>Supports local agriculture</li>
  </ul>
  <p>...send them our way. We're building this network one family at a time.</p>
  <div class="divider"></div>
  <p><strong>Share this link:</strong></p>
  <a href="${utm(data.referralLink, 'nurture-referral', 'share')}" class="cta">Share BuyHalfCow</a>
  <p style="font-size:13px;color:#A7A29A;">Know a rancher who sells direct? Send them to <a href="${SITE_URL}/partner" style="color:#6B4F3F;">buyhalfcow.com/partner</a> — we're always looking for great operations.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — From Pasture to Your Freezer</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending nurture-referral email:', error);
    return { success: false, error };
  }
}

// =====================================================
// UTILITY FUNCTIONS
// =====================================================

export async function sendBackfillEmail(data: {
  firstName: string;
  email: string;
  loginUrl: string;
}) {
  const { firstName, email, loginUrl } = data;
  const subject = `One quick thing before we match you`;
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
p { color: #6B4F3F; margin: 12px 0; }
.cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>One quick thing</h1>
  <p>Hey ${esc(firstName)},</p>
  <p>Your BuyHalfCow account is approved. Before I can match you with a rancher, I need to know what you're looking for.</p>
  <p><strong>Takes 30 seconds:</strong> Tell us whether you want a quarter, half, or whole cow, your budget, and when you want it.</p>
  <div style="text-align: center;">
    <a href="${utm(loginUrl, 'backfill', 'complete-profile')}" class="cta">Complete My Profile →</a>
  </div>
  <div class="divider"></div>
  <p>Not here to buy beef right now? Update your profile anyway — we'll make sure you get the right updates for community members, land deals, and brand partnerships.</p>

  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`;
  await resend.emails.send({ from: getFromEmail(), to: email, subject, html, headers: getUnsubscribeHeaders(email) });
}

// =====================================================
// RANCHER CHECK-IN EMAIL
// Sent to pipeline ranchers to confirm they're still in
// =====================================================

export async function sendRancherCheckIn(data: {
  operatorName: string;
  ranchName: string;
  email: string;
  rancherId: string;
  onboardingStatus: string;
  token: string;
}) {
  const confirmUrl = `${SITE_URL}/api/rancher/checkin-response?token=${data.token}&action=confirm`;
  const callUrl = `${SITE_URL}/api/rancher/checkin-response?token=${data.token}&action=call`;
  const outUrl = `${SITE_URL}/api/rancher/checkin-response?token=${data.token}&action=out`;

  const statusNote = data.onboardingStatus === 'Docs Sent'
    ? "We sent over the partnership agreement — haven't heard back yet."
    : data.onboardingStatus === 'Agreement Signed'
    ? "You've signed the agreement — we're working on getting you verified."
    : data.onboardingStatus === 'Verification Pending'
    ? "Your verification is in progress."
    : "We'd love to get you up and running.";

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Quick check-in — ${data.ranchName} + BuyHalfCow`,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px 0; }
            p { margin: 14px 0; color: #6B4F3F; }
            .divider { height: 1px; background: #A7A29A; margin: 28px 0; }
            .btn { display: inline-block; padding: 14px 32px; text-decoration: none; font-weight: 600; font-size: 14px; letter-spacing: 0.5px; margin: 6px 8px 6px 0; }
            .btn-primary { background: #0E0E0E; color: #F4F1EC; }
            .btn-secondary { background: #F4F1EC; color: #0E0E0E; border: 1px solid #A7A29A; }
            .btn-muted { background: transparent; color: #A7A29A; border: 1px solid #A7A29A; font-size: 12px; padding: 10px 20px; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Quick Check-In</h1>
            <p>Hi ${esc(data.operatorName)},</p>
            <p>Ben here from BuyHalfCow. Just wanted to reach out and see where things stand with ${esc(data.ranchName)} joining the network.</p>
            <p>${statusNote}</p>
            <p>We've got buyers in the pipeline looking for ranchers like you, and I want to make sure we don't lose momentum.</p>

            <div class="divider"></div>

            <p><strong>Click one option below to let me know where you're at:</strong></p>

            <div style="text-align: center; margin: 24px 0;">
              <a href="${confirmUrl}" class="btn btn-primary">I'm Still In — Let's Move Forward</a>
            </div>
            <div style="text-align: center; margin: 12px 0;">
              <a href="${callUrl}" class="btn btn-secondary">I Have Questions — Schedule a Call</a>
            </div>
            <div style="text-align: center; margin: 16px 0;">
              <a href="${outUrl}" class="btn btn-muted">Not interested right now</a>
            </div>

            <div class="divider"></div>

            <p>No pressure either way — just want to stay in the loop so we can send the right buyers to the right ranchers.</p>

            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef<br>Questions? Reply directly or email ${ADMIN_EMAIL}</p>
              <p style="font-size: 10px; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #A7A29A;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending rancher check-in email:', error);
    return { success: false, error };
  }
}

// =====================================================
// PIPELINE BLITZ — personalized update email per stage
// Used by /blitz Telegram command to re-engage ALL
// pipeline ranchers at once with clear next-step CTAs.
// =====================================================
export async function sendPipelineUpdateEmail(data: {
  operatorName: string;
  ranchName: string;
  email: string;
  rancherId: string;
  onboardingStatus: string;
  signingLink?: string;
  dashboardLink?: string;
}) {
  const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const firstName = esc(data.operatorName.split(' ')[0]);
  const ranchName = esc(data.ranchName);
  const status = data.onboardingStatus || '';

  // Stage-specific content
  let subject = '';
  let headline = '';
  let bodyHtml = '';
  let ctaText = '';
  let ctaUrl = '';

  if (!status || status === 'Call Scheduled' || status === 'Call Complete') {
    // Haven't received docs yet — send them the agreement link
    subject = `${firstName}, let's get ${ranchName} live on BuyHalfCow`;
    headline = 'Your Spot Is Waiting';
    bodyHtml = `
      <p>Hi ${firstName},</p>
      <p>We spoke about getting <strong>${ranchName}</strong> listed on BuyHalfCow — a private network connecting independent ranchers directly with qualified beef buyers.</p>
      <p>We have buyers actively looking for ranch-direct beef in your area. Here's what's needed to get you live:</p>
      <div class="step"><strong>1. Sign the Commission Agreement</strong> — 10% on referred sales, no upfront fees, buyers pay you directly</div>
      <div class="step"><strong>2. Set up your ranch page</strong> — Logo, pricing, about text (takes 5 minutes)</div>
      <div class="step"><strong>3. Verification</strong> — Customer testimonials, operation photos, and social proof</div>
      <div class="step"><strong>4. Go live</strong> — Start receiving buyer leads</div>
      <p>The first step is reviewing and signing the agreement. Everything else flows from there.</p>
    `;
    ctaText = 'REVIEW & SIGN AGREEMENT';
    ctaUrl = data.signingLink || `${SITE_URL}/rancher/sign-agreement`;
  } else if (status === 'Docs Sent') {
    // Docs sent but haven't signed — nudge to sign
    subject = `${firstName}, your agreement is ready to sign`;
    headline = 'One Signature Away';
    bodyHtml = `
      <p>Hi ${firstName},</p>
      <p>Just checking in — your BuyHalfCow Commission Agreement for <strong>${ranchName}</strong> is still waiting for your signature.</p>
      <p><strong>Quick recap:</strong></p>
      <ul style="color: #6B4F3F; line-height: 2;">
        <li>10% commission on referred sales only — no upfront fees</li>
        <li>Buyers pay you directly — you control your pricing</li>
        <li>24-month term from first referral</li>
        <li>We handle marketing, you handle the beef</li>
      </ul>
      <p>Once signed, you can immediately start setting up your ranch page. We have buyers looking for ranch-direct beef right now.</p>
    `;
    ctaText = 'SIGN AGREEMENT NOW';
    ctaUrl = data.signingLink || `${SITE_URL}/rancher/sign-agreement`;
  } else if (status === 'Agreement Signed') {
    // Signed but not verified — push them to set up page + start verification
    subject = `${firstName}, set up your ranch page while we verify`;
    headline = 'Agreement Signed — Let\'s Get You Live';
    bodyHtml = `
      <p>Hi ${firstName},</p>
      <p>Your agreement is signed and on file — great! While we handle verification, you can get a head start on your ranch page.</p>
      <p><strong>What you can do right now:</strong></p>
      <div class="step step-done">✅ <strong>Agreement signed</strong> — Done</div>
      <div class="step"><strong>🖥️ Set up your ranch page</strong> — Add logo, tagline, pricing, and payment links</div>
      <div class="step"><strong>🔍 Start verification</strong> — Upload customer testimonials, operation photos, and social proof</div>
      <div class="step"><strong>🟢 Go live</strong> — Once verified, buyers start coming in</div>
      <p>Log in to your dashboard to set up your page and request verification — both can be done in under 10 minutes.</p>
    `;
    ctaText = 'SET UP YOUR RANCH PAGE';
    ctaUrl = data.dashboardLink || `${SITE_URL}/rancher/login`;
  } else if (status === 'Verification Pending') {
    // Waiting on verification — reassure and push page setup
    subject = `${firstName}, verification update for ${ranchName}`;
    headline = 'Verification In Progress';
    bodyHtml = `
      <p>Hi ${firstName},</p>
      <p>Quick update — we're reviewing the verification materials for <strong>${ranchName}</strong>. We'll let you know as soon as it's complete.</p>
      <p><strong>In the meantime:</strong> Make sure your ranch page is fully set up with testimonials, photos, and pricing so we can go live the moment verification clears.</p>
      <div class="step step-done">✅ Agreement signed</div>
      <div class="step">🖥️ <strong>Finish your ranch page</strong> — pricing, photos, testimonials, about text</div>
      <div class="step">🔍 Verification materials under review...</div>
      <div class="step">🟢 Go live — almost there!</div>
      <p>If your page is already set up, sit tight — we're working on getting you live ASAP.</p>
    `;
    ctaText = 'CHECK YOUR DASHBOARD';
    ctaUrl = data.dashboardLink || `${SITE_URL}/rancher/login`;
  } else {
    // Fallback
    subject = `${firstName}, update from BuyHalfCow`;
    headline = 'Quick Update';
    bodyHtml = `
      <p>Hi ${firstName},</p>
      <p>Just checking in on <strong>${ranchName}</strong>. Log in to your dashboard to see your current status and next steps.</p>
    `;
    ctaText = 'GO TO DASHBOARD';
    ctaUrl = data.dashboardLink || `${SITE_URL}/rancher/login`;
  }

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px 0; }
            p { margin: 14px 0; color: #6B4F3F; }
            .divider { height: 1px; background: #A7A29A; margin: 28px 0; }
            .btn { display: inline-block; padding: 16px 40px; background: #0E0E0E; color: #F4F1EC; text-decoration: none; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; }
            .step { padding: 12px 16px; border-left: 3px solid #0E0E0E; margin: 12px 0; background: #F4F1EC; color: #0E0E0E; }
            .step-done { border-left-color: #22c55e; }
            ul { color: #6B4F3F; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>${headline}</h1>
            ${bodyHtml}
            <div style="text-align: center; margin: 32px 0;">
              <a href="${ctaUrl}" class="btn">${ctaText}</a>
            </div>
            <div class="divider"></div>
            <p>Questions? Reply to this email or call me directly.</p>
            <div class="footer">
              <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
              <p style="font-size: 10px; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #A7A29A;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending pipeline update email:', error);
    return { success: false, error };
  }
}

export async function sendRancherNowAvailable(data: {
  firstName: string;
  email: string;
  state: string;
  ranchName: string;
  rancherPageUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `A rancher just went live in ${data.state}`,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
.container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
p { color: #6B4F3F; margin: 12px 0; }
.highlight { background: #F4F1EC; border-left: 3px solid #2D5016; padding: 12px 16px; margin: 20px 0; color: #0E0E0E; }
.cta { display: inline-block; padding: 14px 28px; background: #2D5016; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
.divider { height: 1px; background: #A7A29A; margin: 24px 0; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
</style>
</head>
<body>
<div class="container">
  <h1>A Rancher Is Now Available</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>Great news — <strong>${esc(data.ranchName)}</strong> is now accepting orders in <strong>${esc(data.state)}</strong>. Browse their page and reserve your share.</p>
  <div class="highlight">
    <strong>${esc(data.ranchName)}</strong> just went live on BuyHalfCow. You're one of the first buyers in ${esc(data.state)} to be notified.
  </div>
  <div style="text-align:center;">
    <a href="${utm(data.rancherPageUrl, 'rancher-live', 'waitlist-blast')}" class="cta">View Ranch &amp; Reserve</a>
  </div>
  <div class="divider"></div>
  <p style="font-size: 13px;">We'll also be reaching out to personally introduce you. Questions? Just reply to this email.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending rancher now available email:', error);
    return { success: false, error };
  }
}

// =====================================================
// TRACKED CONTACT EMAIL — buyer messages rancher via platform
// =====================================================

export async function sendTrackedContactEmail(data: {
  rancherName: string;
  rancherEmail: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  message: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.rancherEmail,
      cc: ADMIN_EMAIL,
      replyTo: data.buyerEmail,
      subject: `New message from ${esc(data.buyerName)} via BuyHalfCow`,
      headers: getUnsubscribeHeaders(data.rancherEmail),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.field{margin:12px 0;padding:12px;background:#F4F1EC}.label{font-weight:bold;color:#6B4F3F}.message-box{padding:16px;background:#F4F1EC;border-left:3px solid #6B4F3F;margin:20px 0}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>New Message via BuyHalfCow</h1>
  <p>Hi ${esc(data.rancherName)},</p>
  <p>A buyer has reached out to you through your BuyHalfCow page:</p>
  <div class="divider"></div>
  <div class="field">
    <span class="label">Name:</span> ${esc(data.buyerName)}
  </div>
  <div class="field">
    <span class="label">Email:</span> <a href="mailto:${esc(data.buyerEmail)}" style="color:#0E0E0E;">${esc(data.buyerEmail)}</a>
  </div>
  ${data.buyerPhone ? `<div class="field"><span class="label">Phone:</span> <a href="tel:${esc(data.buyerPhone)}" style="color:#0E0E0E;">${esc(data.buyerPhone)}</a></div>` : ''}
  <div class="message-box">
    <div class="label">Message:</div>
    <p style="margin:8px 0 0 0;white-space:pre-line;">${esc(data.message)}</p>
  </div>
  <div class="divider"></div>
  <p><strong>Reply directly to this email</strong> to respond to ${esc(data.buyerName)}.</p>
  <div class="footer">
    <p>This message was facilitated by BuyHalfCow.<br>
    Remember: 10% commission applies to sales made through the platform.</p>
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending tracked contact email:', error);
    return { success: false, error };
  }
}

// =====================================================
// GENERIC SEND EMAIL
// =====================================================

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
  scheduledAt?: string; // ISO date string — Resend holds + delivers at this time
}) {
  try {
    const emailData: any = {
      from: getFromEmail(),
      to: params.to,
      subject: params.subject,
      html: params.html,
      headers: getUnsubscribeHeaders(params.to),
    };
    if (params.attachments && params.attachments.length > 0) {
      emailData.attachments = params.attachments;
    }
    if (params.scheduledAt) {
      emailData.scheduledAt = params.scheduledAt;
    }
    await resend.emails.send(emailData);
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error };
  }
}

// =====================================================
// MONTHLY COMMISSION INVOICE — sent to ranchers on the 1st
// =====================================================

export async function sendMonthlyCommissionInvoice(data: {
  operatorName: string;
  ranchName: string;
  email: string;
  monthYear: string;
  lineItems: { buyerName: string; orderType: string; saleAmount: number; commissionDue: number }[];
  totalCommissionDue: number;
  runningTotalUnpaid: number;
}) {
  try {
    const rows = data.lineItems
      .map(
        (item) =>
          `<tr>
            <td style="padding:10px 12px;border-bottom:1px solid #E8E5E0;color:#6B4F3F;">${esc(item.buyerName)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #E8E5E0;color:#6B4F3F;">${esc(item.orderType)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #E8E5E0;color:#6B4F3F;text-align:right;">$${item.saleAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #E8E5E0;color:#0E0E0E;text-align:right;font-weight:600;">$${item.commissionDue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
          </tr>`
      )
      .join('');

    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Commission Invoice — ${esc(data.monthYear)} — BuyHalfCow`,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}table{width:100%;border-collapse:collapse;margin:20px 0}th{text-align:left;padding:10px 12px;border-bottom:2px solid #2A2A2A;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#0E0E0E}td{font-size:14px}.totals{background:#F4F1EC;border:1px solid #A7A29A;padding:20px 24px;margin:20px 0}.totals p{margin:6px 0;color:#0E0E0E}</style>
</head><body><div class="container">
  <h1>Commission Invoice</h1>
  <p>Hi ${esc(data.operatorName)},</p>
  <p>Here is your commission summary for <strong>${esc(data.monthYear)}</strong> from BuyHalfCow.</p>

  <div class="divider"></div>

  <p style="color:#0E0E0E;font-weight:600;margin-bottom:4px;">${esc(data.ranchName)}</p>
  <p style="margin-top:0;">Period: ${esc(data.monthYear)}</p>

  <table>
    <thead>
      <tr>
        <th>Buyer</th>
        <th>Order</th>
        <th style="text-align:right;">Sale</th>
        <th style="text-align:right;">Commission</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <div class="totals">
    <p><strong>This Month:</strong> <span style="float:right;font-size:18px;font-weight:700;">$${data.totalCommissionDue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></p>
    <p style="border-top:1px solid #A7A29A;padding-top:8px;margin-top:12px;"><strong>Total Unpaid Balance:</strong> <span style="float:right;font-size:18px;font-weight:700;">$${data.runningTotalUnpaid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></p>
  </div>

  <div class="divider"></div>

  <p><strong>Payment Instructions</strong></p>
  <p>Please remit payment within 15 days via one of the following methods:</p>
  <ul style="color:#6B4F3F;line-height:2;">
    <li><strong>Venmo:</strong> @BuyHalfCow</li>
    <li><strong>Zelle:</strong> ${ADMIN_EMAIL}</li>
    <li><strong>Check:</strong> Payable to BuyHalfCow — reply for mailing address</li>
  </ul>
  <p style="font-size:13px;">Questions about this invoice? Reply to this email.</p>

  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending commission invoice:', error);
    return { success: false, error };
  }
}

// =====================================================
// ABANDONED APPLICATION RECOVERY — 3-email recapture sequence
// =====================================================

/**
 * Sends one of three recovery emails to someone who entered their email on
 * /access but didn't complete the form. Tone gets progressively more direct
 * across the three sends. Each email links back to /access with their email
 * pre-filled to remove friction.
 *
 * stage: 1 = "you started something" (24h after abandon)
 *        2 = "still want in?" (3 days)
 *        3 = "last touch — here's why it matters" (7 days)
 */
export async function sendAbandonedRecoveryEmail(data: {
  email: string;
  firstName?: string;
  stage: 1 | 2 | 3;
}) {
  const firstName = (data.firstName || '').trim();
  const greeting = firstName ? `Hi ${esc(firstName)},` : 'Hey,';
  const accessUrl = utm(`${SITE_URL}/access?email=${encodeURIComponent(data.email)}`, 'abandoned-recovery', `stage-${data.stage}`);

  const subject = data.stage === 1
    ? 'You started something on BuyHalfCow — finish in 60 seconds?'
    : data.stage === 2
      ? 'Still want in? Your spot is held'
      : 'Last touch — what BuyHalfCow actually does';

  const body = data.stage === 1
    ? `
      <p>${greeting}</p>
      <p>You started signing up for BuyHalfCow but didn't finish. No pressure — I just wanted to leave the door open.</p>
      <p>If you tell us what you're looking for (Quarter, Half, or Whole; budget; state), we'll match you with a verified rancher in your area within 24 hours.</p>
      <p>Takes about 60 seconds. We saved your email so you don't have to retype it.</p>`
    : data.stage === 2
      ? `
      <p>${greeting}</p>
      <p>Quick check-in — you signed up for BuyHalfCow a few days ago but didn't finish the application.</p>
      <p>Most of our members find a rancher in their state within 24-48 hours of completing it. The bottleneck is usually budget + cut size — once we have those, we can introduce you to someone who fits.</p>
      <p>If something stopped you (questions about pricing, how it works, what you'd actually get) just reply to this email and I'll answer personally.</p>`
      : `
      <p>${greeting}</p>
      <p>Last note from me — I won't keep emailing.</p>
      <p>BuyHalfCow isn't a marketplace. It's a private network where I personally introduce serious buyers to verified ranchers. Most members save 30-50% vs grocery beef and end up with 6-12 months of premium cuts in their freezer.</p>
      <p>If you're still interested, finishing the form takes a minute. If not, no hard feelings — I'll stop the emails after this one.</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-size:13px;margin:16px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>${subject}</h1>
  ${body}
  <p style="text-align:center;margin-top:24px;"><a href="${accessUrl}" class="cta">Finish My Application →</a></p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Abandoned recovery email error:', error);
    return { success: false, error };
  }
}

// =====================================================
// LEAD RESURRECTION — buyer notification when their match falls through
// =====================================================

/**
 * Sent to a buyer when their previously-matched rancher passes on the lead.
 * Frames the event as "we found you another option" (or "we're searching") —
 * never as rejection. Critical to maintain buyer confidence.
 *
 * Two outcomes:
 *   - newRancherName provided  → "We found you a new match"
 *   - newRancherName missing   → "We're searching for another rancher"
 */
export async function sendRerouteNotification(data: {
  firstName: string;
  email: string;
  state: string;
  newRancherName?: string;
  newRancherEmail?: string;
  newRancherPhone?: string;
  newRancherSlug?: string;
  loginUrl: string;
}) {
  const hasNewMatch = !!data.newRancherName;
  const subject = hasNewMatch
    ? `Quick update — we found you a new rancher match`
    : `Quick update on your rancher search`;

  const matchBlock = hasNewMatch
    ? `
    <p>Good news — we already have your next match lined up:</p>
    <div style="background:#F4F1EC;border-left:3px solid #0E0E0E;padding:16px 20px;margin:20px 0;color:#0E0E0E;">
      <p style="margin:6px 0;"><strong>${esc(data.newRancherName!)}</strong> · ${esc(data.state)}</p>
      ${data.newRancherSlug ? `<p style="margin:12px 0 6px;"><a href="${utm(`${SITE_URL}/ranchers/${data.newRancherSlug}`, 'reroute', 'view-ranch')}" style="color:#0E0E0E;">View their ranch page &rarr;</a></p>` : ''}
    </div>
    <p>You'll receive their full contact details and pricing in a separate email within the next few minutes.</p>`
    : `
    <p>We're working on finding you another rancher in <strong>${esc(data.state)}</strong> right now. As soon as we have a confirmed match, you'll get an introduction email with their contact info and pricing.</p>
    <p>This usually takes 24-48 hours. If we don't have anyone available in your state yet, I'll personally reach out with options.</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>${hasNewMatch ? 'New rancher match incoming' : 'Working on your match'}</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>Quick update on your BuyHalfCow rancher search. The rancher we initially matched you with isn't able to take this order — could be timing, capacity, or a logistical fit. ${hasNewMatch ? "Good news: we already have your next option lined up." : "We're working on your next match now."}</p>
  ${matchBlock}
  <div class="divider"></div>
  <p style="font-size:13px;">Questions or want to talk through what you're looking for? Just reply to this email.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending reroute notification:', error);
    return { success: false, error };
  }
}
