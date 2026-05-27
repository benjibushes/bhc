import { Resend } from 'resend';
import jwt from 'jsonwebtoken';
import DOMPurify from 'isomorphic-dompurify';
import { getAllRecords, escapeAirtableValue, TABLES } from './airtable';
import { checkFrequencyCap, logEmailSend } from './emailFrequencyGuard';
import { JWT_SECRET } from './secrets';

// DOMPurify allowlist for /admin/broadcast HTML mode. P0 audit fix (C-5):
// operator-supplied HTML was forwarded raw to Resend — compromised template
// could phish under buyhalfcow.com. Strips <script>, event handlers,
// javascript: URIs, and anything not in the allowlist.
const BROADCAST_HTML_ALLOWED_TAGS = [
  'p', 'br', 'a', 'strong', 'em', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
  'blockquote', 'img', 'hr', 'div', 'span', 'table', 'tr', 'td', 'th',
  'tbody', 'thead', 'b', 'i', 'u', 'small', 'code', 'pre', 'figure',
  'figcaption', 'html', 'head', 'body', 'style', 'meta', 'title', 'link',
];
const BROADCAST_HTML_ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'style', 'class', 'target', 'rel', 'width',
  'height', 'border', 'align', 'cellpadding', 'cellspacing', 'bgcolor',
  'colspan', 'rowspan', 'lang',
];

export function sanitizeBroadcastHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: BROADCAST_HTML_ALLOWED_TAGS,
    ALLOWED_ATTR: BROADCAST_HTML_ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(https?:|mailto:|tel:|\/|#)/i,
    WHOLE_DOCUMENT: true,
  });
}

const _resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder_for_build');

// In-memory suppression cache. Built lazily on first email send and refreshed
// every SUPPRESSION_TTL_MS. Avoids hitting Airtable on every send while still
// catching new unsubscribes within ~5 minutes. Critical to avoid CAN-SPAM
// violations + deliverability damage from sending to known-bad addresses.
const SUPPRESSION_TTL_MS = 5 * 60 * 1000;
let suppressionCache: { emails: Set<string>; loadedAt: number } | null = null;

export async function getSuppressionList(): Promise<Set<string>> {
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
//
// REPLY-TO STRATEGY (May 2026 — inbound capture):
// - If caller passes `_replyContext: { type, recordId }`, we generate a
//   tagged address like `ref-recXXX@replies.buyhalfcow.com`. Replies to
//   that address hit /api/webhooks/resend-inbound and get classified +
//   logged to the Conversations Airtable table.
// - If caller passes explicit `replyTo`, we honor it (escape hatch for
//   transactional emails that should reply to a specific person).
// - Otherwise, fall back to ben@<sending-domain> (legacy, lands in Ben's
//   inbox — same as before this change).
//
// IMPORTANT: replyTo domain doesn't have to match the From domain anymore
// for tagged Reply-To. Reply-To: replies.buyhalfcow.com paired with
// From: ben@buyhalfcow.com is fine — both are subdomains of the same
// organizational domain, and SPF/DKIM cover deliverability via the From.
// ── Resend rate-limit guard ─────────────────────────────────────────────
// Default Resend tier is 10 req/sec. Burst signups + cron loops easily
// exceed that, dropping transactional emails with 429s. Token bucket
// limits us to 8/sec (leaves headroom for the rate counter to refresh)
// and serializes via a single global chain. 429 from Resend triggers a
// 1s backoff + one retry.
let _emailGate: Promise<unknown> = Promise.resolve();
const _emailTimestamps: number[] = [];
const EMAIL_MAX_PER_SEC = 8;
async function _gateEmail<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _emailGate;
  let resolve!: () => void;
  _emailGate = new Promise<void>(r => { resolve = r; });
  try {
    await prev;
    const now = Date.now();
    while (_emailTimestamps.length && now - _emailTimestamps[0] > 1000) _emailTimestamps.shift();
    if (_emailTimestamps.length >= EMAIL_MAX_PER_SEC) {
      const waitMs = 1000 - (now - _emailTimestamps[0]) + 5;
      await new Promise(r => setTimeout(r, Math.max(0, waitMs)));
    }
    // Stamp timestamp AFTER the send completes (not before). Stamping
    // before created a window where a slow send extended past 1s but the
    // timestamp aged out — the next queued call read an empty window and
    // skipped the wait, doubling actual send rate during latency spikes.
    try {
      return await fn();
    } finally {
      _emailTimestamps.push(Date.now());
    }
  } finally {
    resolve();
  }
}

// ─────────────────────────────────────────────────────────────────────
// PREHEADER TEXT INJECTION — #2 driver of open rate after From line.
// Injects a hidden preview-text block into HTML emails to improve
// inbox placement. Pattern: hidden div with zero height/opacity right
// after <body> tag.
// ─────────────────────────────────────────────────────────────────────
function injectPreheader(html: string, preheader: string): string {
  if (!preheader || !html) return html;
  // Truncate to 100 chars (preheader sweet spot for most clients)
  const truncated = preheader.slice(0, 100);
  // Hidden preheader block: display:none, zero size, zero opacity, mso-hide
  // for Outlook. The invisible character (U+200C) is a zero-width non-joiner
  // used by some email templates to prevent clients from auto-hiding too-short
  // preview text.
  const preheaderBlock = `<div style="display:none;font-size:1px;color:#fefefe;line-height:1px;font-family:Inter,sans-serif;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">${truncated}‌​‌​‌​</div>`;
  // Inject right after <body> if present, else at start of HTML
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/(<body[^>]*>)/i, `$1${preheaderBlock}`);
  }
  return preheaderBlock + html;
}

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

      // Reply-To resolution priority:
      //   1. Explicit replyTo passed by caller (honored as-is)
      //   2. _replyContext { type, recordId } passed by caller → tagged address
      //   3. Default fallback: inbox@replies.buyhalfcow.com — Resend inbound
      //      catches every reply, lands in Conversations table via webhook.
      //      Used to fall back to ben@<send-domain> which dumped untagged
      //      replies into Ben's inbox and bypassed the inbound pipeline.
      if (!params.replyTo) {
        const { replyToFor, REPLIES_DOMAIN } = await import('./replyAddressing');
        if (params._replyContext) {
          const ctx = params._replyContext as { type: 'ref'|'usr'|'rnc'|'inq'|'thread'; recordId: string };
          params.replyTo = replyToFor(ctx.type, ctx.recordId);
        } else {
          params.replyTo = `inbox@${REPLIES_DOMAIN}`;
        }
      }
      delete params._replyContext;
      // Auto-inject CAN-SPAM footer (physical address + unsubscribe link)
      // into every HTML email unless explicitly opted out via _skipFooter.
      if (params.html && !params._skipFooter) {
        const recipientEmail = Array.isArray(params.to) ? params.to[0] : params.to;
        if (recipientEmail) {
          params.html = params.html + emailFooter(recipientEmail);
        }
      }
      delete params._skipFooter;
      // Preheader text injection — optional field to boost open rate.
      // If preheader not provided, email sends normally without one.
      // (auto-derive from subject is future optimization)
      if (params.preheader && params.html) {
        params.html = injectPreheader(params.html, params.preheader);
      }
      delete params.preheader;
      // Plain text MUST be generated AFTER footer injection (and preheader)
      if (!params.text && params.html) {
        params.text = htmlToPlainText(params.html);
      }
      const firstAttempt: any = await _gateEmail(() => _resend.emails.send(params));
      const errStr = firstAttempt?.error ? JSON.stringify(firstAttempt.error) : '';
      const is429 = firstAttempt?.error && /429|rate.?limit|too.?many/i.test(errStr);
      if (!is429) return firstAttempt;
      // 429: back off 1s, then RETRY THROUGH THE GATE (not bare). The bare
      // retry path skipped _gateEmail entirely so the second send raced
      // every other concurrent caller and could 429 again immediately,
      // defeating the throttle. Going back through the gate respects the
      // token bucket and serializes against in-flight sends.
      console.warn('Resend 429 — backing off 1s then retrying through gate');
      await new Promise(res => setTimeout(res, 1100));
      return _gateEmail(() => _resend.emails.send(params));
    }
  }
};
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const CALENDLY_LINK = process.env.CALENDLY_LINK || 'https://buyhalfcow.com/call';
const MERCH_URL = process.env.MERCH_URL || 'https://www.sackett-ranch.com/pages/buy-half-cow';

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

/**
 * Generate a signed JWT token for unsubscribe links.
 * Token expires in 365 days to handle old email links from inboxes.
 * Reduces PII exposure in URLs (browser history, referrer headers, analytics).
 */
function generateUnsubscribeToken(email: string): string {
  return jwt.sign({ email, type: 'unsubscribe' }, JWT_SECRET, { expiresIn: '365d' });
}

/**
 * Generate unsubscribe link — token-based for PII privacy.
 * Legacy ?email= fallback kept for ~30 days to handle in-flight inbox links.
 */
function getUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email);
  return `${SITE_URL}/unsubscribe?token=${token}`;
}

function getUnsubscribeHeaders(email: string) {
  const token = generateUnsubscribeToken(email);
  return {
    'List-Unsubscribe': `<${SITE_URL}/api/unsubscribe?token=${token}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Wrap a Resend send call with the frequency guard + audit log.
 * Returns {success, suppressed?, reason?} for callers that want to
 * surface suppression to their cron summary.
 */
async function guardedSend(opts: {
  templateName: string;
  recipientEmail: string;
  recipientConsumerId?: string;
  subject: string;
  send: () => Promise<unknown>;
}): Promise<{ success: boolean; suppressed?: boolean; reason?: string }> {
  const gate = await checkFrequencyCap(opts.recipientEmail, opts.templateName);
  if (!gate.ok) {
    await logEmailSend({
      recipientEmail: opts.recipientEmail,
      recipientConsumerId: opts.recipientConsumerId,
      templateName: opts.templateName,
      subject: opts.subject,
      status: 'suppressed',
      suppressionReason: gate.reason || 'unknown',
    });
    return { success: false, suppressed: true, reason: gate.reason };
  }
  try {
    const result: any = await opts.send();
    // Detect the internal resend wrapper's short-circuit for suppressed
    // recipients (Unsubscribed/Bounced/Complained). The wrapper returns
    // { data: { id: 'skipped-suppressed' } } instead of actually sending.
    // Without this check, we'd log status='sent' for blocked sends —
    // poisoning the audit log + frequency-cap denominators.
    const isSuppressed = result?.data?.id === 'skipped-suppressed';
    await logEmailSend({
      recipientEmail: opts.recipientEmail,
      recipientConsumerId: opts.recipientConsumerId,
      templateName: opts.templateName,
      subject: opts.subject,
      status: isSuppressed ? 'suppressed' : 'sent',
      suppressionReason: isSuppressed ? 'unsubscribed-bounced-or-complained' : undefined,
    });
    if (isSuppressed) {
      return { success: false, suppressed: true, reason: 'unsubscribed-bounced-or-complained' };
    }
    return { success: true };
  } catch (error: any) {
    // Don't log to Email Sends as 'sent' if Resend threw — that would
    // poison the cap calc. Let the caller see the error.
    throw error;
  }
}

// Physical address required by CAN-SPAM Act. Update via BUSINESS_ADDRESS env var.
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS || 'BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901';

// Shared email footer — CAN-SPAM compliant: physical address + visible unsubscribe.
// Append this to every outbound email HTML body.
function emailFooter(recipientEmail: string): string {
  const unsubUrl = getUnsubscribeUrl(recipientEmail);
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
  const subject = 'Application Received — BuyHalfCow';
  return guardedSend({
    templateName: 'sendConsumerConfirmation',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      preheader: 'Welcome to BuyHalfCow. Here\'s what happens next.',
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
              <p>— Benjamin, Founder<br>BuyHalfCow</p>
              <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
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
    <p><strong>You're approved.</strong> Welcome — we connect you directly with a verified rancher in your state for bulk beef purchases (quarter, half, or whole cow).</p>
    <div class="divider"></div>
    <p><strong>How It Works:</strong></p>
    <ol style="color: #6B4F3F; line-height: 2;">
      <li><strong>Confirm timing</strong> — In a separate email I'll ask if you're ready to buy in the next 1–2 months. One click on "Yes — Ready to Buy" is all it takes.</li>
      <li><strong>Personal introduction</strong> — As soon as you click yes, I match you with a verified rancher in your state. They'll reach out within 24–48 hours.</li>
      <li><strong>Buy direct</strong> — You purchase directly from the rancher at their price. No middlemen, no markup.</li>
    </ol>
    <div class="divider"></div>
    <p><strong>What you get access to:</strong></p>
    <ul style="color: #6B4F3F; line-height: 2;">
      <li>Verified ranchers in your state</li>
      <li>Direct, personal introductions</li>
      <li>Exclusive land deals and brand promotions</li>
      <li>A curated network — no spam, no middlemen</li>
    </ul>
    <a href="${loginUtm}" class="button">Go to Your Dashboard</a>
    <p style="font-size: 13px; color: #A7A29A;">Watch for the "Ready to buy?" email coming next — your one-click YES is what triggers the rancher introduction. Not ready yet? No pressure — you stay on the list and we check back when timing fits.</p>
  `;

  const communityBody = `
    <h1>Welcome to BuyHalfCow</h1>
    <p>Hi ${esc(data.firstName)},</p>
    <p><strong>You're in.</strong> Welcome — a curated network built around American agriculture, real ranches, and direct relationships.</p>
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

  const subject = isBeef
    ? "You're Approved — Let's Find Your Rancher"
    : 'Welcome to BuyHalfCow';
  return guardedSend({
    templateName: 'sendConsumerApproval',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
              <p>— Benjamin, Founder<br>BuyHalfCow<br>Questions? Email ${ADMIN_EMAIL}</p>
              <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
}


// =====================================================
// READY-TO-BUY PROMPT — sent right after the welcome email so every signup
// goes through the same explicit "are you ready to purchase?" gate the
// waitlist warmup uses. Click of the YES button:
//   1. Sets Ready to Buy = true on their consumer record
//   2. Triggers immediate matching/suggest (handled by /api/warmup/engage)
//   3. Buyer + matched rancher receive the intro within seconds
// Buyers who don't click stay on nurture and can convert later.
// =====================================================

export async function sendWelcomeAndReadyToBuy(data: {
  firstName: string;
  email: string;
  state: string;
  rancherAvailable: boolean;
  engageUrl?: string;  // required when rancherAvailable=true
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const stateLabel = data.state || 'your state';

  const ctaBlock = data.rancherAvailable && data.engageUrl
    ? `
      <div class="q"><strong>One question:</strong> are you ready to buy in the next 1–2 months?</div>
      <p>If yes, click below. I'll personally match you with a verified rancher in ${esc(stateLabel)} and they'll reach out within 24–48 hours with current pricing, processing date, and how to lock in your order.</p>
      <div style="text-align:center;margin:30px 0;">
        <a href="${data.engageUrl}" class="cta">Yes — Ready to Buy</a>
        <p style="font-size:13px;color:#A7A29A;margin-top:10px;">One click confirms. We only introduce ranchers to confirmed buyers — keeps quality high on both sides.</p>
      </div>
      <p style="font-size:14px;color:#6B4F3F;">Not ready yet? Just don't click. You stay on the list, no pressure.</p>
    `
    : `
      <p>Right now we don't have a verified rancher in ${esc(stateLabel)} yet — but I'm working on it. Every week I'm signing new ranchers state by state. The moment one goes live in your area, you'll be one of the first to hear.</p>
      <p>While you wait, I'll send you a short note once a month — what I'm seeing on the road, which states are about to launch, the actual numbers. Not marketing. Just the real situation.</p>
      <p style="font-size:14px;color:#6B4F3F;">Know a rancher in ${esc(stateLabel)} who sells direct? Reply with their name and I'll reach out personally.</p>
      <div style="text-align:center;margin:30px 0;">
        <a href="${SITE_URL}/member/login" class="cta">View Your Dashboard</a>
        <p style="font-size:12px;color:#A7A29A;margin-top:10px;">Log in any time to update preferences or check status.</p>
      </div>
    `;

  const subject = data.rancherAvailable
    ? `${first}, you're in — quick question to lock in your match`
    : `${first}, you're in — what's happening in ${stateLabel}`;
  return guardedSend({
    templateName: 'sendWelcomeAndReadyToBuy',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 18px}p{margin:14px 0;color:#2A2A2A}.cta{display:inline-block;padding:16px 36px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px}.q{background:#FAF8F4;border:1px solid #A7A29A;padding:18px 22px;margin:24px 0;font-family:Georgia,serif;font-size:18px;color:#0E0E0E}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>You're in, ${esc(first)}.</h1>
  <p>You applied to BuyHalfCow and I just approved you. Quick what-this-is: I personally connect families to a single verified rancher in their state for a quarter, half, or whole cow. No middleman. Direct relationship. Real beef.</p>
  ${ctaBlock}
  <div class="divider"></div>
  <p style="font-size:12px;color:#A7A29A;">— Benjamin<br>BuyHalfCow</p>
  <div class="footer">
    <p>BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901</p>
    <p style="font-size:10px;color:#ccc;margin-top:8px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
}

// ── WAITING + Day 7 / monthly: founder letter ────────────────────────────────
// Built from the rescued Day3 + Day10 founder copy (lib/_rescued-copy.md). One
// function, three letter variants based on which letter in the rolling cadence
// they're getting. Rolling cadence: Day 7, Day 30, Day 60, Day 90, ...
//
// Voice: "Hey {firstName}, quick update — not marketing, just the real
// situation." First-person, founder on the road, asks for the buyer's help
// (forward to a rancher). The mission line — "We're gonna take back American
// ranching and agriculture" — anchors the letter once a quarter.
export async function sendFounderLetterWaiting(data: {
  firstName: string;
  email: string;
  state: string;
  letterNumber: number; // 1 = Day 7, 2 = Day 30, 3+ = monthly
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const stateLabel = data.state || 'your state';
  const n = data.letterNumber;

  // Letter 1 (Day 7) — "what's actually happening" framing
  // Letter 2 (Day 30) — "the ranchers I'm meeting" + mission line
  // Letter 3+ (monthly) — "month {N} update" rolling
  const subject = n === 1
    ? `what's actually happening — month one update`
    : n === 2
    ? `the ranchers I'm meeting are the real deal`
    : `month ${n} update — ${stateLabel} status`;

  const body = n === 1 ? `
  <p>Hey ${esc(first)},</p>
  <p>Quick update — not marketing, just the real situation.</p>
  <p>I'm on the road right now visiting ranches, signing new partners, and building the supply chain so that when we match you, it's the right rancher — not just whoever's available.</p>
  <p><strong>What's happening this week:</strong></p>
  <ul style="color:#2A2A2A;line-height:2;">
    <li>Locking down rancher partnerships across multiple states</li>
    <li>Processing facility tours and agreements</li>
    <li>Working on getting a verified rancher live in ${esc(stateLabel)}</li>
  </ul>
  <p><strong>Two things you can do right now:</strong></p>
  <ol style="color:#2A2A2A;line-height:2;">
    <li><strong>Follow the build</strong> — I'm documenting everything in real time. Ranch visits, negotiations, the whole thing.</li>
    <li><strong>Help us expand faster</strong> — Know a rancher in ${esc(stateLabel)} who sells direct? Reply with their name.</li>
  </ol>
  <p>You'll hear from me the moment there's a rancher ready in ${esc(stateLabel)}. You're already in.</p>
  ` : n === 2 ? `
  <p>Hey ${esc(first)},</p>
  <p>Quick update from the road. I've been visiting ranches, meeting families who've been raising cattle for generations. These aren't factory farms — these are real operations getting squeezed out by big processors.</p>
  <div style="border-left:3px solid #0E0E0E;padding:12px 20px;margin:24px 0;font-style:italic;color:#0E0E0E;background:#FAF8F4;">
    "We're gonna take back American ranching and agriculture." That's not a tagline. That's why I'm doing this.
  </div>
  <p>The ranchers I'm partnering with want buyers who care about where their beef comes from. That's you.</p>
  <p><strong>Here's what I need from you:</strong></p>
  <ul style="color:#2A2A2A;line-height:2;">
    <li><strong>Reply to this email</strong> — tell me what cut you're looking for (quarter, half, whole). Helps me prioritize ${esc(stateLabel)}.</li>
    <li><strong>Know a rancher in ${esc(stateLabel)}?</strong> Reply with their name. I'll reach out personally.</li>
  </ul>
  <p>We're close. More soon.</p>
  ` : `
  <p>Hey ${esc(first)},</p>
  <p>Month ${n} update. ${esc(stateLabel)} is still in the build phase. Here's where things are:</p>
  <p><strong>What I'm working on this month:</strong></p>
  <ul style="color:#2A2A2A;line-height:2;">
    <li>Active conversations with ranchers in your area</li>
    <li>Scaling the operation in states already live</li>
    <li>Building the case studies that recruit the next wave of ranchers</li>
  </ul>
  <p>If you've gotten this far, you're committed — and I appreciate it. The wait is real, but so is the network we're building. Reply if you have questions or know a rancher I should meet.</p>
  `;

  return guardedSend({
    templateName: 'sendFounderLetterWaiting',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#2A2A2A}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  ${body}
  <p style="margin-top:32px;">— Benjamin<br>Founder, BuyHalfCow</p>
  <div class="footer">
    <p>BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901</p>
    <p style="font-size:10px;color:#ccc;margin-top:8px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
}

// ── MATCHED + Day 4: did-you-connect check-in ────────────────────────────────
// Replaces the previous duplicate sendIntroCheckInEmail + sendSequenceEmail_BeefDay7
// pair (both asked the same question). Single email, single CTA: reply.
// Asks honestly — "did you talk to {rancher}? if not, what's happening?"
export async function sendMatchedDay4CheckIn(data: {
  firstName: string;
  email: string;
  rancherName: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const subject = `did you connect with ${data.rancherName}?`;
  return guardedSend({
    templateName: 'sendMatchedDay4CheckIn',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#2A2A2A}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <p>Hey ${esc(first)},</p>
  <p>Quick check-in — I introduced you to ${esc(data.rancherName)} a few days ago. Did you connect?</p>
  <p>If yes: how'd it go? Any feedback for me?</p>
  <p>If not yet: just hit reply and tell me what's up. If you didn't see their email, I'll resend it. If you've got cold feet, totally fine — tell me what changed and I'll work on a different fit.</p>
  <p>Either way, I want to hear from you. This network only works if both sides actually talk.</p>
  <p style="margin-top:32px;">— Ben</p>
  <div class="footer">
    <p>BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901</p>
    <p style="font-size:10px;color:#ccc;margin-top:8px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
}

// ── CLOSED Day 0: post-purchase welcome ─────────────────────────────────────
// Fires from rancher close handler when status flips to Closed Won. The
// "handshake" moment — sets expectations for the 4-week gap before beef
// arrives. Practical, not aspirational: freezer prep, what to expect.
export async function sendPostPurchaseWelcome(data: {
  firstName: string;
  email: string;
  rancherName: string;
  orderType: string; // "Quarter" | "Half" | "Whole" | "Not Sure"
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const tier = data.orderType?.toLowerCase().includes('quarter') ? 'quarter'
    : data.orderType?.toLowerCase().includes('half') ? 'half'
    : data.orderType?.toLowerCase().includes('whole') ? 'whole'
    : 'share';
  const lbsApprox = tier === 'quarter' ? '~85 lbs' : tier === 'half' ? '~170 lbs' : tier === 'whole' ? '~340 lbs' : '85–340 lbs';
  const cuFt = tier === 'quarter' ? '~3–4 cu ft' : tier === 'half' ? '~6–8 cu ft' : tier === 'whole' ? '~12–16 cu ft' : '3–16 cu ft';

  const subject = `welcome to your first ranch order — what to expect`;
  return guardedSend({
    templateName: 'sendPostPurchaseWelcome',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 18px}p{margin:14px 0;color:#2A2A2A}.box{background:#FAF8F4;border-left:3px solid #0E0E0E;padding:16px 20px;margin:18px 0}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>You did it, ${esc(first)}.</h1>
  <p>Closing day with ${esc(data.rancherName)} is officially in the books. Welcome to ranch-direct beef.</p>
  <p>Here's what's next, in order:</p>
  <div class="box">
    <p style="margin:0;"><strong>Now → 2-4 weeks:</strong> ${esc(data.rancherName)} processes your ${tier}. Cattle goes to the USDA-certified processor, hangs to age, gets cut to your specs, vacuum-sealed, frozen.</p>
  </div>
  <div class="box">
    <p style="margin:0;"><strong>1 week before pickup:</strong> ${esc(data.rancherName)} confirms the date. Get your freezer ready — you'll need ${cuFt} of clean freezer space. A standalone chest freezer is the move if you don't have one yet (~$200 used on Marketplace).</p>
  </div>
  <div class="box">
    <p style="margin:0;"><strong>Pickup day:</strong> ${esc(lbsApprox)} of vacuum-sealed beef goes from ranch processor straight to your freezer. Stack it in flat — easier to find cuts later.</p>
  </div>
  <p style="margin-top:24px;"><strong>What I'm sending you over the next month:</strong></p>
  <ul style="color:#2A2A2A;line-height:2;">
    <li>In ~2 weeks: cuts education + first-cook playbook (most people get a quarter and don't know what to do with the oxtail)</li>
    <li>Monthly check-ins from me on what's happening across the network</li>
    <li>~5 months from now: I'll ping you about reserving the next ${tier} from ${esc(data.rancherName)} or the next rancher in your area</li>
  </ul>
  <p>Reply anytime. I read every reply.</p>
  <p style="margin-top:32px;">— Benjamin</p>
  <div class="footer">
    <p>BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901</p>
    <p style="font-size:10px;color:#ccc;margin-top:8px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
}

// ── CLOSED Day 14: cuts education + first-cook playbook ──────────────────────
// Premium DTC food's strongest retention move (per research — ButcherBox,
// Wild Idea pattern). The buyer just got 200lbs of beef and doesn't know
// what to do with the oxtail. Our content moat — nobody else can write
// this for them.
export async function sendCutsEducation(data: {
  firstName: string;
  email: string;
  orderType: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const tier = data.orderType?.toLowerCase().includes('quarter') ? 'quarter'
    : data.orderType?.toLowerCase().includes('half') ? 'half'
    : data.orderType?.toLowerCase().includes('whole') ? 'whole'
    : 'share';

  const subject = `your ${tier} cheat sheet — what to cook first`;
  return guardedSend({
    templateName: 'sendCutsEducation',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 18px}h2{font-family:Georgia,serif;font-size:18px;margin:24px 0 8px;color:#0E0E0E}p{margin:14px 0;color:#2A2A2A}ul{color:#2A2A2A;line-height:2}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>Your ${tier} cheat sheet, ${esc(first)}.</h1>
  <p>Most people get their first ranch order, look at 200 lbs of frozen vacuum-sealed packages, and freeze (no pun intended). Here's the field guide.</p>

  <h2>Cook these first (the unfamiliar ones)</h2>
  <ul>
    <li><strong>Chuck roast (3-4 lbs):</strong> Dutch oven, 6-8 hours at 225°F with onion, garlic, broth. Falls apart with a fork. Best ranch beef you'll cook.</li>
    <li><strong>Short ribs:</strong> Same braise as chuck. The cut grocery stores price out of reach is in your freezer for free.</li>
    <li><strong>Oxtail:</strong> Don't toss this. Slow-braise 4 hours with red wine and root veg. The richest beef stew on earth.</li>
    <li><strong>Tongue:</strong> Boil 3 hours with bay + onion, peel, slice thin. Tacos al pastor at home for $3.</li>
  </ul>

  <h2>The reliable everyday cuts</h2>
  <ul>
    <li><strong>Ground beef</strong> — the workhorse. Tacos, burgers, chili, bolognese.</li>
    <li><strong>Stew meat</strong> — beef stew, beef and broccoli, fajitas if you slice thin.</li>
    <li><strong>Sirloin / round steaks</strong> — fast hot pan, don't overcook (medium-rare = pink center).</li>
    <li><strong>Ribeye / NY strip</strong> — these are the steaks. Cast iron, salt, butter. Don't sauce them.</li>
  </ul>

  <h2>Two rules that matter</h2>
  <ul>
    <li><strong>Thaw in fridge, not microwave.</strong> 24-48 hrs for steaks, 2-3 days for roasts. The vacuum seal protects flavor — don't undo it with a thaw shortcut.</li>
    <li><strong>Stack flat in the freezer.</strong> Standing up makes finding the cut you want a treasure hunt. Keep similar cuts together.</li>
  </ul>

  <p>Reply with what you've cooked so far — I'm collecting first-cook stories.</p>
  <p style="margin-top:32px;">— Ben</p>
  <div style="border-top: 1px solid #A7A29A; margin-top: 30px; padding-top: 24px;">
    <p style="color: #6B4F3F; font-size: 14px;">
      p.s. — bhc patches just shipped to the print shop. founder backers get first pick when they hit my desk. <a href="${SITE_URL}/shop" style="color: #0E0E0E; font-weight: 700;">shop bhc merch</a>
    </p>
  </div>
  <div class="footer">
    <p>BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901</p>
    <p style="font-size:10px;color:#ccc;margin-top:8px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
}

// ── CLOSED Day 60: monthly long-quiet letter ────────────────────────────────
// The "make-or-break window" per research — Patagonia Provisions pattern.
// One letter a month. Ranch news, new states going live, what's hard.
// Content IS the relationship.
export async function sendClosedMonthlyLetter(data: {
  firstName: string;
  email: string;
  monthNumber: number;
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const subject = `month ${data.monthNumber} — what's happening in the network`;
  return guardedSend({
    templateName: 'sendClosedMonthlyLetter',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#2A2A2A}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <p>Hey ${esc(first)},</p>
  <p>Month ${data.monthNumber} since your first order. Quick update from across the network — not a sales pitch, just what's happening.</p>
  <p><strong>What's new:</strong></p>
  <ul style="color:#2A2A2A;line-height:2;">
    <li>New ranchers going live — you'll see them on the homepage if you check</li>
    <li>New states opening up that we couldn't serve before</li>
    <li>Existing partners scaling up to take more volume</li>
  </ul>
  <p>In a few months I'll ping you about the next round. For now, hope your freezer's still well-stocked.</p>
  <p>Reply anytime — I read every one.</p>
  <p style="margin-top:32px;">— Benjamin</p>
  <div class="footer">
    <p>BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901</p>
    <p style="font-size:10px;color:#ccc;margin-top:8px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
}

// ── CLOSED Month 5: re-engagement / repeat purchase ─────────────────────────
// Replaces sendRepeatPurchaseEmail. Anticipates the buyer instead of reacting.
// Uses the rancher's name, not BHC's. The "Tovala / ButcherBox cadence"
// pattern from research.
export async function sendRepeatPurchaseAsk(data: {
  firstName: string;
  email: string;
  rancherName: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const subject = `running low? want me to ping ${data.rancherName}?`;
  return guardedSend({
    templateName: 'sendRepeatPurchaseAsk',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#2A2A2A}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <p>Hey ${esc(first)},</p>
  <p>Five months since your last order with ${esc(data.rancherName)}. Most of our buyers are running low about now.</p>
  <p>Want me to reach out to ${esc(data.rancherName)} about reserving the next ${esc(first === 'there' ? 'share' : 'one')} from their fall harvest? Just reply with "yes" and I'll set it up.</p>
  <p>Want to try a different rancher this round? Also fine — reply with "different" and I'll match you with someone new.</p>
  <p>Don't need anything? Reply with "not yet" and I'll check back in a few months.</p>
  <p style="margin-top:32px;">— Ben</p>
  <div class="footer">
    <p>BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901</p>
    <p style="font-size:10px;color:#ccc;margin-top:8px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
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
  // When true, the buyer has explicitly confirmed they're ready to purchase
  // in the next 1-2 months. Subject line gets a 🔥 prefix so the buyer
  // recognizes urgency, and the body adds a "you confirmed ready-to-buy"
  // reminder so they remember why they're hearing from us.
  readyToBuy?: boolean;
  // Referral ID — when present, sets a tagged Reply-To address so any reply
  // the buyer sends gets captured + classified by /api/webhooks/resend-inbound.
  // Without this, replies go to ben@buyhalfcow.com and miss the data layer.
  referralId?: string;
  // tier_v2 ranchers only. Full magic-link URL to /api/auth/member/verify with
  // `next=/checkout/<refId>/deposit` so the buyer arrives at the deposit page
  // already authed. When unset (legacy ranchers), the email falls back to the
  // tap-any-tier copy that points at the rancher landing page payment links.
  depositMagicLinkUrl?: string;
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

  // Reserve-your-share callout. Two flavors:
  //
  //   - tier_v2 (depositMagicLinkUrl present): prominent button-CTA that
  //     deep-links into /checkout/<refId>/deposit via the magic-link verify
  //     endpoint. Buyer is one tap away from a Stripe-Connect direct charge.
  //
  //   - legacy (depositMagicLinkUrl absent): keep the existing tap-any-tier
  //     copy that points at the rancher landing page's per-tier Payment Links.
  //     Renders only when at least one tier price + slug is configured.
  //
  // Open-ended on timing because ranchers process on a rolling cycle, not a
  // single fixed date. Drives the buyer to convert NOW with a deposit instead
  // of "I'll think about it" → drift to inactive.
  const hasMagicLink = !!data.depositMagicLinkUrl;
  const hasAnyPayLink = !!(
    pricingRows.length > 0 && data.rancherSlug
  );
  let reserveBlock = '';
  if (hasMagicLink) {
    // Inline-styled button matches BHC design tokens (bg-#0E0E0E text-white).
    // The href is the verify endpoint, NOT the deposit page directly — verify
    // sets the cookie then 302s to /checkout/<refId>/deposit so the buyer
    // arrives authed. Without the cookie hop, the deposit page 401s.
    reserveBlock = `<div style="border:2px solid #0E0E0E;background:#FAF8F4;padding:18px 22px;margin:20px 0;">
    <p style="margin:0 0 6px 0;font-family:Georgia,serif;font-size:16px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#0E0E0E;">Reserve Your Share Now</p>
    <p style="margin:8px 0;font-size:14px;color:#2A2A2A;">${esc(data.rancherName)} processes on a rolling cycle — your deposit puts you on the books for the next available slot. Spots fill first-come, first-served.</p>
    <p style="margin:16px 0 4px 0;text-align:center;">
      <a href="${data.depositMagicLinkUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FFFFFF!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-size:13px;">Reserve your share — secure deposit &rarr;</a>
    </p>
    <p style="margin:8px 0 0 0;font-size:12px;color:#6B4F3F;text-align:center;"><strong>No deposit, no slot held.</strong></p>
  </div>`;
  } else if (hasAnyPayLink) {
    reserveBlock = `<div style="border:2px solid #0E0E0E;background:#FAF8F4;padding:18px 22px;margin:20px 0;">
    <p style="margin:0 0 6px 0;font-family:Georgia,serif;font-size:16px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#0E0E0E;">Reserve Your Share Now</p>
    <p style="margin:8px 0;font-size:14px;color:#2A2A2A;">${esc(data.rancherName)} processes on a rolling cycle — your deposit puts you on the books for the next available slot. Spots fill first-come, first-served.</p>
    <p style="margin:8px 0;font-size:14px;color:#2A2A2A;">Tap any tier above to lock in your share. <strong>No deposit, no slot held.</strong></p>
  </div>`;
  }

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

  // Subject prefix when this buyer confirmed Ready-to-Buy. Tells the recipient
  // (and the rancher when they reply-all) this is a high-priority match that
  // both sides have explicitly opted into.
  // 2026-05-20: dropped '🔥 READY TO BUY · ' prefix — emoji + ALL-CAPS is
  // textbook spam-classifier trigger (Spamassassin UPPERCASE_25_50 +
  // Gmail's emoji-in-subject penalty for unestablished domains). Plain
  // lowercase founder-voice keeps inbox placement.
  const readyPrefix = data.readyToBuy ? 'ready to buy — ' : '';
  const readyBlock = data.readyToBuy
    ? `<p style="background:#FFF6E0;border:1px solid #C99A2E;padding:12px 16px;font-size:14px;color:#0E0E0E;"><strong>You confirmed you're ready to buy in the next 1–2 months.</strong> ${esc(data.rancherName)} has been notified and will reach out within 24–48 hours.</p>`
    : '';
  const introSubject = `${readyPrefix}Meet your rancher — ${esc(data.rancherName)}`;
  return guardedSend({
    templateName: 'sendBuyerIntroNotification',
    recipientEmail: data.email,
    subject: introSubject,
    send: () => {
      const introEmailData: any = {
        from: getFromEmail(),
        to: data.email,
        subject: introSubject,
        preheader: `Meet your rancher match: ${esc(data.rancherName)}`,
        headers: getUnsubscribeHeaders(data.email),
      };
      if (data.scheduledAt) {
        introEmailData.scheduledAt = data.scheduledAt;
      }
      // Tag Reply-To so any buyer reply lands in /api/webhooks/resend-inbound
      // and gets classified + logged to the Conversations table. Without
      // referralId we fall through to the default ben@<domain> Reply-To.
      if (data.referralId) {
        introEmailData._replyContext = { type: 'ref', recordId: data.referralId };
      }
      introEmailData.html = `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.contact-box{background:#F4F1EC;border:1px solid #A7A29A;padding:20px 24px;margin:20px 0}.contact-box p{margin:6px 0;color:#0E0E0E}.cta{display:inline-block;padding:16px 32px;background:#0E0E0E;color:#F4F1EC!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:20px 0}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>Your Rancher Introduction</h1>
  <p>Hi ${esc(data.firstName)},</p>
  ${readyBlock}
  <p>I've personally vetted and matched you with <strong>${esc(data.rancherName)}</strong>. They know you're coming — reach out whenever you're ready.</p>
  ${contactBlock}
  ${pricingBlock}
  ${reserveBlock}
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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
    <p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`;
      return resend.emails.send(introEmailData);
    },
  });
}

// =====================================================
// RANCHER APPROVAL EMAIL
// =====================================================

export async function sendRancherApproval(data: {
  operatorName: string;
  ranchName: string;
  email: string;
}) {
  const subject = "You're Approved — BuyHalfCow Partnership";
  return guardedSend({
    templateName: 'sendRancherApproval',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
              <p>— Benjamin, Founder<br>BuyHalfCow<br>Questions? Email ${ADMIN_EMAIL}</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
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
  const subject = "You're Live — Buyer Leads Are Coming";
  return guardedSend({
    templateName: 'sendRancherGoLiveEmail',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
              <p>— Benjamin, Founder<br>BuyHalfCow<br>Questions? Email ${ADMIN_EMAIL}</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
}

// =====================================================
// PILOT UPSELL EMAIL
//
// Fires once per rancher when their lifetime Closed Won count reaches
// Pilot Closes Goal. Sent alongside the Telegram alert that pings Ben.
// Goal: rancher books the upsell call directly via the Calendly link
// instead of waiting on Ben to chase them.
// One-shot: guarded by Pilot Upsell Notified At in the close handlers.
// =====================================================
export async function sendPilotUpsellEmail(data: {
  operatorName: string;
  ranchName: string;
  email: string;
  closesHit: number;
  pilotGoal: number;
}) {
  const firstName = String(data.operatorName || '').trim().split(/\s+/)[0] || 'there';
  const subject = `you just hit ${data.closesHit}. let's run it.`;
  return guardedSend({
    templateName: 'sendPilotUpsellEmail',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      // Reply-To deliberately omitted — wrapper auto-fills with
      // inbox@replies.buyhalfcow.com (Resend inbound webhook captures the
      // reply into Conversations). Previously routed to ADMIN_EMAIL which
      // polluted Ben's personal Gmail with rancher replies.
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:24px;}
.container{max-width:580px;margin:0 auto;background:#fff;padding:36px 32px;border:1px solid #A7A29A;}
p{margin:14px 0;color:#2A2A2A;font-size:15px;}
h2{font-family:Georgia,serif;font-size:20px;margin:26px 0 8px;color:#0E0E0E;}
.cta{display:inline-block;padding:18px 34px;background:#0E0E0E;color:#F4F1EC !important;
  text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;
  font-size:14px;margin:18px 0;border:2px solid #0E0E0E;}
.box{background:#F8F5F0;border-left:3px solid #0E0E0E;padding:14px 18px;margin:14px 0;font-size:15px;}
.footer{margin-top:32px;padding-top:18px;border-top:1px solid #E5E2DC;font-size:11px;color:#A7A29A;line-height:1.5;}
</style></head><body><div class="container">

<p>Hi ${esc(firstName)},</p>

<p>That's <strong>${data.closesHit} closed deals</strong> through BuyHalfCow. The pilot's done — you proved you can close our leads, and we've proved we can deliver them. Time to talk about what's next.</p>

<h2>The white-glove transition</h2>
<div class="box">
<p style="margin:0;">Now we move ${esc(data.ranchName)} onto our <strong>full white-glove marketing service</strong> — flat monthly retainer, no commissions, ever. We become your direct-to-consumer growth team: lead generation, email campaigns, paid ads, content. You stay focused on the cattle, we handle everything else.</p>
</div>

<p>I'd like to walk you through it on a 15-min call. Pick whatever works:</p>

<div style="text-align:center;">
<a href="${esc(CALENDLY_LINK)}" class="cta">Book the upsell call</a>
</div>

<p>If those slots don't fit, just hit reply with what does and we'll make it work. Either way — congrats on the milestone. Most ranchers we onboard never make it past lead #1. You blew through 4. Let's keep the momentum.</p>

<p style="margin-top:22px;">— Benjamin<br>
<span style="color:#6B4F3F;font-size:13px;">Founder, BuyHalfCow · ${esc(ADMIN_EMAIL)}</span></p>

<div class="footer">
<p style="margin:0;">BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901</p>
<p style="margin:6px 0 0;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#A7A29A;">Unsubscribe</a></p>
</div>

</div></body></html>`,
    }),
  });
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

  const subject = `${typeLabels[data.type]} Application Received — BuyHalfCow`;
  return guardedSend({
    templateName: 'sendPartnerConfirmation',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
            <p>Thank you for your interest in ${data.type === 'rancher' ? 'joining the BuyHalfCow rancher network' : 'partnering with BuyHalfCow'}.</p>
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
                <li><strong>Onboarding call</strong> — We discuss your operation, answer questions, walk through how the network operates</li>
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
              <p>— Benjamin, Founder<br>BuyHalfCow</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
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
  const subject = `You're Approved — Complete Your Brand Listing on BuyHalfCow`;
  return guardedSend({
    templateName: 'sendBrandApprovalWithPayment',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
              <p>— Benjamin, Founder<br>BuyHalfCow</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
}

export async function sendBrandListingConfirmation(data: {
  brandName: string;
  email: string;
  amountPaid: string;
}) {
  const subject = `You're Live — ${data.brandName} is Now on BuyHalfCow`;
  return guardedSend({
    templateName: 'sendBrandListingConfirmation',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
              <p>— Benjamin, Founder<br>BuyHalfCow</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
}

// =====================================================
// FOUNDING HERD — Project 3 (capital raise)
// =====================================================
//
// Tier-aware welcome email — fires from Stripe webhook on
// `checkout.session.completed` for any of the 5 paid backer tiers. This is
// the entire post-purchase product (no /founders/dashboard in v1), so it
// has to carry its weight: thank, contextualize what they bought, point at
// the Founders Wall + a call link, and for numbered tiers stamp the Founder
// Number. NO Telegram — backers wanted email, not yet another group chat.
//
// Voice anchors (Stage 1 changelog Section 10): sendMerchEmail,
// sendWelcomeAndReadyToBuy, sendFounderLetterWaiting. Lowercase opener,
// lowercase conversational subject, single CTA, signed `— Ben` /
// `— Benjamin`, address-line footer (no "Private Network").
export async function sendFoundingHerdWelcome(data: {
  tier: 'Herd' | 'Outlaw' | 'Steward' | 'Founding 100' | 'Title Founder';
  firstName: string;
  email: string;
  founderNumber?: number;
  amountPaid: number;
}): Promise<{ success: boolean; error?: any }> {
  const first = esc(data.firstName || 'there');
  const dollars = `$${(data.amountPaid || 0).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })}`;
  const numberLine =
    data.founderNumber && (data.tier === 'Founding 100' || data.tier === 'Title Founder')
      ? `you're founder #${data.founderNumber}.`
      : '';

  const WALL_URL = `${SITE_URL}/founders#wall`;

  // Per-tier dynamic block — what they actually bought, what to expect.
  let dynamicBlock = '';
  let subject = '';

  switch (data.tier) {
    case 'Herd':
      subject = `welcome to the founding herd, ${first}`;
      dynamicBlock = `
        <p>You're in at <strong>Herd</strong> tier — ${dollars} a year toward
        building something that puts ranchers back in front of families. Quiet
        backing, real impact.</p>
        <p>What you get: monthly founder letter from the road, early heads-up
        when a new rancher goes live in your state, and a first-print
        BuyHalfCow patch in the mail. Your name stays private unless you reply
        to this email asking to be on the public Wall.</p>
      `;
      break;
    case 'Outlaw':
      subject = `welcome to the founding herd, outlaw ${first}`;
      dynamicBlock = `
        <p>You're in at <strong>Outlaw</strong> tier — ${dollars}. The name
        fits: people backing this from a place of conviction, not convenience.</p>
        <p>What you get: everything Herd gets, plus your name on the public
        Founders Wall, quarterly behind-the-scenes drops by email, and first
        dibs on any limited rancher batches that come through.</p>
      `;
      break;
    case 'Steward':
      subject = `welcome to the founding herd, steward ${first}`;
      dynamicBlock = `
        <p>You're in at <strong>Steward</strong> tier — ${dollars}. This is
        the level where you start showing up in my decision-making. A
        Steward's vote weighs more than a survey response.</p>
        <p>What you get: Outlaw perks plus a quarterly office-hours video
        call (small group, real questions), public placement on the Founders
        Wall, and a direct email line to me — flag a rancher to add or a
        state to prioritize and I'll act on it.</p>
      `;
      break;
    case 'Founding 100':
      subject = `welcome to the founding herd, founder #${data.founderNumber || ''}`.trim();
      dynamicBlock = `
        <p>You're <strong>Founding 100 — ${numberLine}</strong> ${dollars} one-time.
        Only 100 of these exist. You're getting in at the price the next
        100 won't.</p>
        <p>What you get: numbered placement on the public Founders Wall,
        lifetime priority routing on every rancher we onboard in your state,
        a first-print BuyHalfCow patch with your number on it, and a 30-min
        call with me when you're ready to use it (calendar below).</p>
        <p>Practical: you don't need to do anything else right now. I'll
        ship the patch within ~3 weeks. The wall placement is live tonight.</p>
      `;
      break;
    case 'Title Founder':
      subject = `welcome to the founding herd, title founder ${first}`;
      dynamicBlock = `
        <p>You're a <strong>Title Founder — ${numberLine}</strong> ${dollars}
        one-time. There are 10 of these. You're one of them.</p>
        <p>What you get: top of the public Founders Wall with name + logo
        treatment, co-build access (I'll loop you in on the next-rancher /
        next-state / next-product calls before they're public), lifetime
        everything, and a direct line to me — reply to any email and it lands
        with me personally.</p>
        <p>Practical: I'll reach out within 48 hours to get your wall
        treatment dialed in. Pin the calendar link below — that's how you
        skip the queue any time you want to talk.</p>
      `;
      break;
  }

  // Mission line is the once-per-letter anchor — uses the rescued copy.
  const missionLine = `
    <p style="font-style:italic;color:#6B4F3F;font-family:Georgia,serif;font-size:16px;border-left:3px solid #0E0E0E;padding-left:14px;margin:24px 0;">
      We're gonna take back American ranching and agriculture. One family,
      one rancher, one freezer at a time.
    </p>
  `;

  return guardedSend({
    templateName: 'sendFoundingHerdWelcome',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:24px;}
.container{max-width:600px;margin:0 auto;background:#fff;padding:40px 36px;border:1px solid #A7A29A;}
h1{font-family:Georgia,serif;font-size:26px;margin:0 0 16px;}
p{margin:14px 0;color:#2A2A2A;font-size:15px;}
a{color:#0E0E0E;}
.cta{display:inline-block;padding:16px 36px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;}
.footer{margin-top:32px;padding-top:18px;border-top:1px solid #E5E2DC;font-size:11px;color:#A7A29A;line-height:1.5;}
</style></head><body><div class="container">
  <p>Hey ${esc(first)},</p>
  <p>Quick note — your Founding Herd backing just landed. Receipt's already
  in your inbox from Stripe; this is the human follow-up.</p>
  ${dynamicBlock}
  ${missionLine}
  <p>One thing today: take a look at the Founders Wall. Your name (and
  number, if you got one) is up there as of right now. That's the proof —
  every backer listed in real time so nobody has to take my word for any
  of this.</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${WALL_URL}" class="cta">See the wall</a>
  </p>
  <p style="font-size:14px;color:#6B4F3F;">
    Want to talk live? My calendar's at
    <a href="${CALENDLY_LINK}">${CALENDLY_LINK}</a>. Reply to this email
    works too — it lands directly with me.
  </p>
  <p style="margin-top:28px;">— Ben</p>
  <div style="border-top: 1px solid #A7A29A; margin-top: 30px; padding-top: 24px;">
    <p style="color: #6B4F3F; font-size: 14px;">
      p.s. — bhc patches just shipped to the print shop. founder backers get first pick when they hit my desk. <a href="${SITE_URL}/shop" style="color: #0E0E0E; font-weight: 700;">shop bhc merch</a>
    </p>
  </div>
  <div class="footer">
    <p style="margin:0;">${BUSINESS_ADDRESS}</p>
    <p style="margin:6px 0 0;">
      <a href="${getUnsubscribeUrl(data.email)}" style="color:#A7A29A;">Unsubscribe</a>
    </p>
  </div>
</div></body></html>`,
    }),
  });
}

// Backer monthly letter — fulfills /founders explicit promise of "monthly
// founder letter". Sent to every Consumer row with a non-empty Founder Tier
// once per calendar month (cron: backer-monthly-letter).
//
// Voice: lowercase, plainspoken, founder-on-the-road. Honest stats only —
// no fabricated metrics. Receives live stats payload from cron.
export async function sendBackerMonthlyLetter(data: {
  firstName: string;
  email: string;
  tier?: string;
  founderNumber?: number;
  // Live stats pulled from /api/stats/public at cron-run time.
  stats: {
    rancherCount?: number;
    buyerCount?: number;
    stateCount?: number;
    monthClosedWon?: number;
    monthNewRanchers?: number;
    foundingHundredClaimed?: number;
  };
}) {
  const first = esc(data.firstName || 'there');
  const monthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }).toLowerCase();
  const subject = `bhc ${monthLabel} — founder letter`;

  const ranchers = data.stats.rancherCount ?? 0;
  const buyers = data.stats.buyerCount ?? 0;
  const states = data.stats.stateCount ?? 0;
  const closedThisMonth = data.stats.monthClosedWon ?? 0;
  const newRanchers = data.stats.monthNewRanchers ?? 0;
  const f100 = data.stats.foundingHundredClaimed ?? 0;

  const numberLine = data.founderNumber ? `founder #${data.founderNumber} —` : '';

  return guardedSend({
    templateName: 'sendBackerMonthlyLetter',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:24px;}
.container{max-width:600px;margin:0 auto;background:#fff;padding:40px 36px;border:1px solid #A7A29A;}
h1{font-family:Georgia,serif;font-size:24px;margin:0 0 14px;}
p{margin:14px 0;color:#2A2A2A;font-size:15px;}
.stat{padding:14px 18px;background:#F4F1EC;border-left:3px solid #0E0E0E;margin:18px 0;}
.stat strong{font-size:22px;font-family:Georgia,serif;}
a{color:#0E0E0E;}
.footer{margin-top:32px;padding-top:18px;border-top:1px solid #E5E2DC;font-size:11px;color:#A7A29A;line-height:1.5;}
</style></head><body><div class="container">
  <p>hey ${first} —</p>
  <p>monthly letter from the road. ${numberLine} this is the part i committed to when you backed bhc — no skipping a month, no PR fluff. just where we are.</p>
  <h1>this month</h1>
  <div class="stat">
    <strong>${closedThisMonth}</strong> deal${closedThisMonth === 1 ? '' : 's'} closed
    ${newRanchers > 0 ? `· <strong>${newRanchers}</strong> new rancher${newRanchers === 1 ? '' : 's'} live` : ''}
  </div>
  <p>cumulative across the network: <strong>${ranchers}</strong> ranchers, <strong>${buyers}</strong> buyers, <strong>${states}</strong> state${states === 1 ? '' : 's'} active. every count above is a real row in airtable — i don't round up.</p>
  ${f100 > 0 ? `<p>founding 100: <strong>${f100}/100</strong> claimed. when this fills, the wall closes and the next tier opens.</p>` : ''}
  <h1>what's next</h1>
  <p>the rebuild keeps going. if you have a rancher you want me to chase, a state you think we should open, or just want to talk — reply to this email and it lands directly with me.</p>
  <p style="font-style:italic;color:#6B4F3F;font-family:Georgia,serif;font-size:16px;border-left:3px solid #0E0E0E;padding-left:14px;margin:24px 0;">
    we're gonna take back american ranching and agriculture. one family, one rancher, one freezer at a time.
  </p>
  <p style="margin-top:28px;">— ben</p>
  <div class="footer">
    <p style="margin:0;">${BUSINESS_ADDRESS}</p>
    <p style="margin:6px 0 0;">
      <a href="${getUnsubscribeUrl(data.email)}" style="color:#A7A29A;">unsubscribe</a>
    </p>
  </div>
</div></body></html>`,
    }),
  });
}

// =====================================================
// AFFILIATE EMAILS
// =====================================================

export async function sendAffiliateLoginLink(data: {
  email: string;
  loginUrl: string;
  name?: string;
}) {
  const subject = 'Your BuyHalfCow Affiliate Login Link';
  return guardedSend({
    templateName: 'sendAffiliateLoginLink',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
              <p>BuyHalfCow</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
}

export async function sendAffiliateInvite(data: {
  email: string;
  name: string;
  code: string;
  loginRequestUrl: string;
  buyerLink: string;
  rancherLink: string;
}) {
  const affiliateInviteSubject = "You're a BuyHalfCow Affiliate — Here Are Your Links";
  return guardedSend({
    templateName: 'sendAffiliateInvite',
    recipientEmail: data.email,
    subject: affiliateInviteSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: affiliateInviteSubject,
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
              <p>— Benjamin, Founder<br>BuyHalfCow</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
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
  const subject = `New ${data.type.charAt(0).toUpperCase() + data.type.slice(1)} Application`;
  return guardedSend({
    templateName: 'sendAdminAlert',
    recipientEmail: ADMIN_EMAIL,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: ADMIN_EMAIL,
      subject,
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
            <a href="${SITE_URL}/admin" class="button">Review in Admin</a>
          </div>
        </body>
        </html>
      `,
    }),
  });
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

  const inquirySubject = `New Inquiry from BuyHalfCow Member`;
  return guardedSend({
    templateName: 'sendInquiryToRancher',
    recipientEmail: data.rancherEmail,
    subject: inquirySubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.rancherEmail,
      replyTo: data.consumerEmail, // Rancher can reply directly to consumer
      subject: inquirySubject,
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
            
            <p><strong>Reply directly to this email</strong> to connect with ${esc(data.consumerName)}.</p>
            
            <div class="footer">
              <p>This inquiry was facilitated by BuyHalfCow.<br>
              Inquiry Reference: #${data.inquiryId.slice(0, 8)}<br>
              Remember: 10% commission applies to sales made through the platform.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
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

  const adminInquirySubject = `New Inquiry: ${data.consumerName} → ${data.ranchName}`;
  return guardedSend({
    templateName: 'sendInquiryAlertToAdmin',
    recipientEmail: ADMIN_EMAIL,
    subject: adminInquirySubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: ADMIN_EMAIL,
      subject: adminInquirySubject,
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
            
            <a href="${SITE_URL}/admin/inquiries" class="button">Review & Approve in Admin →</a>
            
            <p style="margin-top: 30px; font-size: 12px; color: #6B4F3F;">
              The rancher will only receive contact info AFTER you approve this inquiry.
            </p>
          </div>
        </body>
        </html>
      `,
    }),
  });
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
  const formattedMessage = esc(data.message).replace(/\n/g, '<br>');
  return guardedSend({
    templateName: 'sendBroadcastEmail',
    recipientEmail: data.to,
    subject: data.subject,
    send: () => {
      if (data.htmlBody) {
        // P0 audit fix (C-5): sanitize operator-supplied HTML before Resend.
        // Strips <script>, on* event handlers, javascript: URIs, and any tag
        // outside the allowlist (see BROADCAST_HTML_ALLOWED_TAGS above).
        const cleanHtml = sanitizeBroadcastHtml(data.htmlBody);
        return resend.emails.send({
          from: getFromEmail(),
          to: data.to,
          subject: data.subject,
          headers: getUnsubscribeHeaders(data.to),
          html: cleanHtml,
        });
      }
      return resend.emails.send({
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
              <p>BuyHalfCow<br>
              1001 S. Main St. Ste 600, Kalispell, MT 59901<br>
              Questions? Email ${ADMIN_EMAIL}</p>
              <p style="margin-top: 12px; font-size: 10px; color: #6B4F3F;">
                <a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.to)}" style="color: #6B4F3F;">Unsubscribe</a> | Campaign: ${data.campaignName}
              </p>
            </div>
          </div>
        </body>
        </html>
      `,
      });
    },
  });
}

// =====================================================
// AI SEQUENCE EMAILS
// =====================================================

export async function sendMerchEmail(data: {
  firstName: string;
  email: string;
}) {
  const firstName = esc(data.firstName);
  const subject = 'quick story behind the hat';
  return guardedSend({
    templateName: 'sendMerchEmail',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      // Lowercase, personal-feeling subject avoids the marketing-spam pattern
      // and consistently outperforms title-case "Represent American..." style
      // subjects (~2-3x open rate in our tests).
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:24px;}
.container{max-width:580px;margin:0 auto;background:#fff;padding:36px 32px;border:1px solid #A7A29A;}
p{margin:14px 0;color:#2A2A2A;font-size:15px;}
a{color:#0E0E0E;}
.link{display:inline-block;margin:18px 0;font-weight:600;text-decoration:underline;color:#0E0E0E;word-break:break-all;}
.footer{margin-top:32px;padding-top:18px;border-top:1px solid #E5E2DC;font-size:11px;color:#A7A29A;line-height:1.5;}
</style></head><body><div class="container">
<p>Hi ${esc(firstName)},</p>
<p>When I started BuyHalfCow, the goal was bigger than helping you find a freezer of beef. The goal was to put a dent in how American families think about food — to swing them away from sterile grocery aisles and back toward the ranchers who've been doing it right for generations.</p>
<p>One family at a time, one hat at a time.</p>
<p>That's why the merch exists. Every cap, every shirt, every patch you wear is a quiet billboard for ranch-direct beef. A stranger in line at the coffee shop asks about the logo, and now another family knows there's a better way to feed their kids than ground chuck wrapped in plastic.</p>
<p>The hat isn't the point. The conversation it starts is.</p>
<p>If you've been thinking about a cap or shirt:</p>
<p style="text-align:center;margin:22px 0;"><a href="${utm(MERCH_URL, 'nurture-merch', 'mission-link')}" class="link">${MERCH_URL}</a></p>
<p>Wear it loud — that's the entire mission.</p>
<p style="margin-top:22px;">— Benjamin</p>
<div class="footer">
<p style="margin:0;">BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901</p>
<p style="margin:6px 0 0;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#A7A29A;">Unsubscribe</a></p>
</div>
</div></body></html>`,
    }),
  });
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
  const affiliateWelcomeSubject = "You're a BuyHalfCow Affiliate — Here Are Your Links";
  return guardedSend({
    templateName: 'sendAffiliateWelcome',
    recipientEmail: data.email,
    subject: affiliateWelcomeSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: affiliateWelcomeSubject,
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
  <h1>Welcome to the Program, ${esc(firstName)}</h1>
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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
  </div>
</div>
</body>
</html>`,
    }),
  });
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
  const subject = "You're Approved — We're Expanding to Your Area";
  return guardedSend({
    templateName: 'sendWaitlistEmail',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    }),
  });
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
  const subject = `You have ${data.leads.length} lead${data.leads.length === 1 ? '' : 's'} waiting on an update`;
  return guardedSend({
    templateName: 'sendRancherLeadNudge',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
  </div>
</div>
</body>
</html>`,
    }),
  });
}

export async function sendRepeatPurchaseEmail(data: {
  firstName: string;
  email: string;
  rancherName: string;
  loginUrl: string;
}) {
  const subject = `Time for another half, ${esc(data.firstName)}?`;
  return guardedSend({
    templateName: 'sendRepeatPurchaseEmail',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`,
    }),
  });
}

// =====================================================
// UTILITY FUNCTIONS
// =====================================================

// =====================================================
// PHASE 1 NURTURE SEQUENCE
// =====================================================

const INSTAGRAM_URL = 'https://www.instagram.com/buyhalfcow';
const YOUTUBE_URL = 'https://www.youtube.com/@buyhalfcow';

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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
    <p style="font-size: 10px; color: #ccc; margin-top: 12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color: #ccc;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`;
  await guardedSend({
    templateName: 'sendBackfillEmail',
    recipientEmail: email,
    subject,
    send: () => resend.emails.send({ from: getFromEmail(), to: email, subject, html, headers: getUnsubscribeHeaders(email) }),
  });
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

  const checkInSubject = `Quick check-in — ${data.ranchName} + BuyHalfCow`;
  return guardedSend({
    templateName: 'sendRancherCheckIn',
    recipientEmail: data.email,
    subject: checkInSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: checkInSubject,
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
              <p>— Benjamin, Founder<br>BuyHalfCow<br>Questions? Reply directly or email ${ADMIN_EMAIL}</p>
              <p style="font-size: 10px; margin-top: 12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color: #A7A29A;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
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
      <p>Hi ${esc(firstName)},</p>
      <p>We spoke about getting <strong>${esc(ranchName)}</strong> listed on BuyHalfCow — a private network connecting independent ranchers directly with qualified beef buyers.</p>
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
      <p>Hi ${esc(firstName)},</p>
      <p>Just checking in — your BuyHalfCow Commission Agreement for <strong>${esc(ranchName)}</strong> is still waiting for your signature.</p>
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
      <p>Hi ${esc(firstName)},</p>
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
      <p>Hi ${esc(firstName)},</p>
      <p>Quick update — we're reviewing the verification materials for <strong>${esc(ranchName)}</strong>. We'll let you know as soon as it's complete.</p>
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
      <p>Hi ${esc(firstName)},</p>
      <p>Just checking in on <strong>${esc(ranchName)}</strong>. Log in to your dashboard to see your current status and next steps.</p>
    `;
    ctaText = 'GO TO DASHBOARD';
    ctaUrl = data.dashboardLink || `${SITE_URL}/rancher/login`;
  }

  return guardedSend({
    templateName: 'sendPipelineUpdateEmail',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
              <p>— Benjamin, Founder<br>BuyHalfCow</p>
              <p style="font-size: 10px; margin-top: 12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color: #A7A29A;">Unsubscribe</a></p>
            </div>
          </div>
        </body>
        </html>
      `,
    }),
  });
}

export async function sendTrackedContactEmail(data: {
  rancherName: string;
  rancherEmail: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  message: string;
}) {
  const trackedSubject = `New message from ${esc(data.buyerName)} via BuyHalfCow`;
  return guardedSend({
    templateName: 'sendTrackedContactEmail',
    recipientEmail: data.rancherEmail,
    subject: trackedSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.rancherEmail,
      cc: ADMIN_EMAIL,
      replyTo: data.buyerEmail,
      subject: trackedSubject,
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
    }),
  });
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
  // Tagged Reply-To: when present, sets Reply-To to <type>-<recordId>@replies.buyhalfcow.com
  // so any reply lands in /api/webhooks/resend-inbound for classification + logging.
  _replyContext?: { type: 'ref' | 'usr' | 'rnc' | 'inq' | 'thread'; recordId: string };
}) {
  return guardedSend({
    templateName: 'sendEmail',
    recipientEmail: params.to,
    subject: params.subject,
    send: () => {
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
      if (params._replyContext) {
        emailData._replyContext = params._replyContext;
      }
      return resend.emails.send(emailData);
    },
  });
}

// =====================================================
// INSTANT COMMISSION INVOICE — fires the moment a rancher marks Closed Won
// in their dashboard. Single sale, single line item. Concrete proof of
// the deal that just closed + clear payment instructions. Monthly cron
// still runs as a backstop summary for any unpaid balances rolled forward.
// =====================================================

export async function sendInstantCommissionInvoice(data: {
  operatorName: string;
  ranchName: string;
  email: string;
  buyerName: string;
  orderType: string;
  saleAmount: number;
  commissionDue: number;
  closedAt: string; // ISO date string
  /**
   * Stripe-hosted invoice URL. If present, the email surfaces a one-click
   * "Pay this invoice" CTA pointing at the hosted page instead of the
   * legacy "reply for a Stripe link / Venmo / mail a check" fallback.
   */
  stripeInvoiceUrl?: string;
}) {
  const first = (data.operatorName || '').split(' ')[0] || 'there';
  const closedDateLabel = new Date(data.closedAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const invoiceNum = `BHC-${new Date(data.closedAt)
    .toISOString()
    .slice(2, 10)
    .replace(/-/g, '')}-${data.email.slice(0, 4).toUpperCase()}`;
  const invoiceSubject = `Commission invoice: ${data.buyerName} — ${data.ranchName}`;
  return guardedSend({
    templateName: 'sendInstantCommissionInvoice',
    recipientEmail: data.email,
    subject: invoiceSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: invoiceSubject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:24px;}
.container{max-width:600px;margin:0 auto;background:#fff;padding:36px;border:1px solid #A7A29A;}
h1{font-family:Georgia,serif;font-size:22px;margin:0 0 8px;}
table{width:100%;border-collapse:collapse;margin:18px 0;}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #E5E2DC;font-size:14px;}
th{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6B4F3F;font-weight:600;}
.total{background:#F4F1EC;font-weight:700;font-size:16px;}
.meta{font-size:12px;color:#6B4F3F;}
</style></head><body><div class="container">
  <p class="meta">Invoice #${esc(invoiceNum)} · ${esc(closedDateLabel)}</p>
  <h1>Commission invoice — ${esc(data.ranchName)}</h1>
  <p>Hey ${esc(first)}, congrats on closing <strong>${esc(data.buyerName)}</strong>. Here's the commission breakdown:</p>
  <table>
    <thead><tr><th>Buyer</th><th>Order</th><th style="text-align:right;">Sale</th><th style="text-align:right;">Commission (10%)</th></tr></thead>
    <tbody>
      <tr>
        <td>${esc(data.buyerName)}</td>
        <td>${esc(data.orderType)}</td>
        <td style="text-align:right;">$${data.saleAmount.toFixed(2)}</td>
        <td style="text-align:right;">$${data.commissionDue.toFixed(2)}</td>
      </tr>
      <tr class="total">
        <td colspan="3" style="text-align:right;">Amount due</td>
        <td style="text-align:right;">$${data.commissionDue.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>
  ${
    data.stripeInvoiceUrl
      ? `<div style="text-align:center;margin:28px 0;"><a href="${esc(data.stripeInvoiceUrl)}" style="display:inline-block;padding:14px 36px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;">Pay invoice</a></div>
  <p style="font-size:13px;color:#6B4F3F;text-align:center;">Pay by card or ACH on the hosted Stripe invoice. Due in 30 days.</p>
  <p style="font-size:13px;color:#6B4F3F;text-align:center;margin-top:8px;">Stripe also sent you the invoice email directly — same link, either works.</p>`
      : `<p style="font-size:14px;">Pay any of these ways within 30 days:</p>
  <ul style="font-size:14px;color:#2A2A2A;line-height:1.8;">
    <li>Reply to this email — I'll send you a Stripe payment link</li>
    <li>Venmo: @buyhalfcow</li>
    <li>Check: BuyHalfCow · Kalispell, MT 59901</li>
  </ul>`
  }
  <p style="font-size:13px;color:#6B4F3F;">This is sent automatically when you mark a deal Closed Won. Monthly statement still arrives on the 1st as a rollup of any unpaid balance.</p>
  <p style="font-size:12px;color:#A7A29A;">— Ben<br>BuyHalfCow</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
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

  const monthlyInvoiceSubject = `Commission Invoice — ${esc(data.monthYear)} — BuyHalfCow`;
  return guardedSend({
    templateName: 'sendMonthlyCommissionInvoice',
    recipientEmail: data.email,
    subject: monthlyInvoiceSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: monthlyInvoiceSubject,
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
  <p>Please remit payment within 15 days. Easiest option:</p>
  ${process.env.COMMISSION_PAYMENT_URL ? `
  <div style="text-align:center;margin:24px 0;">
    <a href="${process.env.COMMISSION_PAYMENT_URL}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px;border:2px solid #0E0E0E;">Pay $${data.runningTotalUnpaid.toLocaleString('en-US', { minimumFractionDigits: 2 })} Now</a>
    <p style="font-size:12px;color:#A7A29A;margin-top:8px;">Secure card payment via Stripe</p>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">Or pay manually:</p>
  ` : ''}
  <ul style="color:#6B4F3F;line-height:2;">
    <li><strong>Venmo:</strong> @BuyHalfCow</li>
    <li><strong>Zelle:</strong> ${ADMIN_EMAIL}</li>
    <li><strong>Check:</strong> Payable to BuyHalfCow — reply for mailing address</li>
  </ul>
  <p style="font-size:13px;">Questions about this invoice? Reply to this email.</p>

  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
    <p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${getUnsubscribeUrl(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    }),
  });
}

// =====================================================
// RANCHER LAUNCH WARMUP — re-engages Waitlisted buyers when a
// rancher goes live in their state. Single touch + Day 7 nudge.
// =====================================================

export async function sendRancherLaunchWarmup(data: {
  email: string;
  firstName: string;
  ranchName: string;
  buyerState: string;
  engageUrl: string;
}) {
  const first = data.firstName || 'there';
  const subject = `${data.ranchName} just went live in ${data.buyerState} — ready to buy?`;
  return guardedSend({
    templateName: 'sendRancherLaunchWarmup',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:16px 36px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px}.divider{height:1px;background:#A7A29A;margin:24px 0}.q{background:#FAF8F4;border:1px solid #A7A29A;padding:16px 20px;margin:24px 0;font-family:Georgia,serif;font-size:18px;color:#0E0E0E}</style>
</head><body><div class="container">
  <h1>Good news — we found you a rancher</h1>
  <p>Hi ${esc(first)},</p>
  <p>When you signed up for BuyHalfCow, there wasn't a verified rancher in ${esc(data.buyerState)} yet. That just changed.</p>
  <p><strong>${esc(data.ranchName)}</strong> just passed our verification and is opening their first round of buyers this week. Since you've been waiting, I want to introduce you first.</p>
  <div class="q"><strong>One question first:</strong> Are you looking to buy in the next 1–2 months?</div>
  <p>If yes, click below — I'll send the rancher's full info (pricing, processing date, contact) right after, and they'll reach out to you directly within 24–48 hours.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${data.engageUrl}" class="cta">Yes — Ready to Buy</a>
    <p style="font-size:13px;color:#A7A29A;margin-top:10px;">Clicking confirms you're ready to purchase in the next 1–2 months. Only confirmed buyers are introduced — keeps quality high for ranchers.</p>
  </div>
  <div class="divider"></div>
  <p style="font-size:14px;">Not ready yet? Just don't click — you stay on the list and we'll check back when timing fits. No pressure, no hard feelings.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
</div></body></html>`,
    }),
  });
}

export async function sendRancherLaunchWarmupNudge(data: {
  email: string;
  firstName: string;
  ranchName: string;
  engageUrl: string;
}) {
  const first = data.firstName || 'there';
  const nudgeSubject = `Last call — ${data.ranchName} still has slots`;
  return guardedSend({
    templateName: 'sendRancherLaunchWarmupNudge',
    recipientEmail: data.email,
    subject: nudgeSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: nudgeSubject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px}</style>
</head><body><div class="container">
  <h1>Quick follow-up</h1>
  <p>Hi ${esc(first)},</p>
  <p>I sent you a note last week about <strong>${esc(data.ranchName)}</strong> opening spots. Didn't hear back, so this is my last nudge.</p>
  <p><strong>Are you ready to buy in the next 1–2 months?</strong> If yes, tap below and I'll send the rancher's info right after. Otherwise I'll drop you off the active list — you won't get more about this rancher until you tell me to.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${data.engageUrl}" class="cta">Yes — Ready to Buy</a>
  </div>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
</div></body></html>`,
    }),
  });
}


// =====================================================
// RANCHER LEAD REMINDER — fires at Day 2 of Intro Sent without rancher action
// =====================================================

export async function sendRancherLeadReminder(data: {
  rancherEmail: string;
  operatorName: string;
  buyerName: string;
  buyerState: string;
  buyerPhone: string;
  buyerEmail: string;
  orderType: string;
  budgetRange: string;
  daysSinceIntro: number;
  dashboardUrl: string;
}) {
  const firstName = data.operatorName.split(' ')[0] || 'there';
  const reminderSubject = `Reminder — ${data.buyerName} is waiting (${data.daysSinceIntro}d since intro)`;
  return guardedSend({
    templateName: 'sendRancherLeadReminder',
    recipientEmail: data.rancherEmail,
    subject: reminderSubject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.rancherEmail,
      subject: reminderSubject,
      headers: getUnsubscribeHeaders(data.rancherEmail),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.divider{height:1px;background:#A7A29A;margin:24px 0}.lead-box{background:#F4F1EC;border-left:3px solid #0E0E0E;padding:16px 20px;margin:20px 0}.lead-box p{margin:6px 0;color:#0E0E0E;font-size:14px}.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px;margin:10px 0}</style>
</head><body><div class="container">
  <h1>Quick reminder</h1>
  <p>Hi ${esc(firstName)},</p>
  <p>${data.daysSinceIntro} days ago I introduced you to <strong>${esc(data.buyerName)}</strong> in ${esc(data.buyerState)}. They're a verified buyer and they're waiting to hear from you.</p>
  <div class="lead-box">
    <p><strong>Buyer:</strong> ${esc(data.buyerName)}</p>
    <p><strong>State:</strong> ${esc(data.buyerState)}</p>
    <p><strong>Phone:</strong> ${esc(data.buyerPhone || 'Email only')}</p>
    <p><strong>Email:</strong> ${esc(data.buyerEmail)}</p>
    <p><strong>Looking for:</strong> ${esc(data.orderType || 'Beef share')} · ${esc(data.budgetRange || 'Budget TBD')}</p>
  </div>
  <p>Reach out today if you can — buyers cool off fast. Even a quick "hey, here's what I have available" text or email keeps the deal alive.</p>
  <p style="text-align:center;"><a href="${data.dashboardUrl}" class="cta">Open Your Dashboard</a></p>
  <div class="divider"></div>
  <p style="font-size:13px;">If you've already reached out, log into your dashboard and update the status to <strong>Rancher Contacted</strong> so I stop nudging you.</p>
  <p style="font-size:13px;">If you can't take this lead, just reply to this email with "pass" and I'll route them to another rancher.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
</div></body></html>`,
    }),
  });
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
      <p>If you tell us what you're looking for (Quarter, Half, or Whole; budget; state), I'll send a one-click "ready to buy?" prompt right after — and the moment you tap YES, you get matched with a verified rancher in your state.</p>
      <p>Takes about 60 seconds. We saved your email so you don't have to retype it.</p>`
    : data.stage === 2
      ? `
      <p>${greeting}</p>
      <p>Quick check-in — you signed up for BuyHalfCow a few days ago but didn't finish the application.</p>
      <p>The flow is simple: finish the form (Quarter/Half/Whole + budget + state), then I send you a one-click "Ready to Buy in 1–2 months?" prompt. The moment you click YES, I match you with a verified rancher in your state — they reach out within 24–48 hours.</p>
      <p>If something stopped you (questions about pricing, how it works, what you'd actually get) just reply to this email and I'll answer personally.</p>`
      : `
      <p>${greeting}</p>
      <p>Last note from me — I won't keep emailing.</p>
      <p>BuyHalfCow isn't a marketplace. It's a private network where I personally introduce serious buyers to verified ranchers. Most members save 30-50% vs grocery beef and end up with 6-12 months of premium cuts in their freezer.</p>
      <p>If you're still interested, finishing the form takes a minute. If not, no hard feelings — I'll stop the emails after this one.</p>`;

  return guardedSend({
    templateName: 'sendAbandonedRecoveryEmail',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
  </div>
</div></body></html>`,
    }),
  });
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

  return guardedSend({
    templateName: 'sendRerouteNotification',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
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
    <p>— Benjamin, Founder<br>BuyHalfCow</p>
  </div>
</div></body></html>`,
    }),
  });
}

// =====================================================
// PROJECT 1 — DISCOVER MAP · prospect claim magic link
// =====================================================
//
// Sent when a prospect (someone listed on /map who hasn't claimed yet) submits
// the claim form. The link is a one-time-use magic link that flips Claim Status
// to claim-pending when clicked. Founder voice — lowercase, single CTA.
export async function sendProspectClaimMagicLink(data: {
  to: string;
  ranchName: string;
  operatorName: string;
  link: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = (data.operatorName || '').split(' ')[0] || 'there';
  const subject = `confirm your ${data.ranchName} listing on BuyHalfCow`;
  return guardedSend({
    templateName: 'sendProspectClaimMagicLink',
    recipientEmail: data.to,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.to,
      subject,
      headers: getUnsubscribeHeaders(data.to),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 18px}p{margin:14px 0;color:#2A2A2A}.cta{display:inline-block;padding:14px 30px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px}.divider{height:1px;background:#A7A29A;margin:24px 0}</style>
</head><body><div class="container">
  <h1>Hey ${esc(first)},</h1>
  <p>Quick one — someone (probably you) just submitted a claim for ${esc(data.ranchName)} on BuyHalfCow's discover map.</p>
  <p>If that was you, click the button below to confirm. Once you do, I'll reach out personally within 24–48 hours to walk you through the onboarding — quick call, simple agreement, your listing goes live.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${data.link}" class="cta">Confirm — I'm ${esc(data.ranchName)}</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">If that wasn't you, just ignore this email — nothing changes.</p>
  <div class="divider"></div>
  <p style="font-size:13px;color:#2A2A2A;">A bit of context: I'm Ben, founder of BuyHalfCow. We're building the public hit list of every direct-to-consumer rancher in America so families can find you instead of buying mystery beef from a grocery chain. Your listing was discovered from public info — it's currently a "prospect" pin (grey, no pricing) until you claim it.</p>
  <p style="font-size:12px;color:#A7A29A;">— Ben<br>BuyHalfCow</p>
</div></body></html>`,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-submit + community-submit welcome emails (Project 1 — Discover Map)
//
// Both fired from /api/prospects/self-submit. Per founder direction:
// NO subscription tiers, NO pricing breakdown — Ben closes on the call.
// Only ask: "book the 15-minute call." That's it.
//
// These are plain transactional emails (one-shot, not part of a sequence yet —
// the drip lives in app/api/cron/rancher-onboarding-drip/route.ts which fires
// follow-ups on Day 2, Day 5, and Day 14 if the rancher hasn't booked yet).
// ─────────────────────────────────────────────────────────────────────────────

export async function sendRancherSelfSubmitWelcome(data: {
  to: string;
  ranchName: string;
  operatorName: string;
  rancherId?: string; // optional — when present, mints a setup magic link
}): Promise<{ success: boolean; error?: any }> {
  const first = (data.operatorName || '').split(' ')[0] || 'there';

  // Mint a 60-day setup magic link. The link points at the self-serve
  // wizard at /rancher/setup which lets the rancher fill in their page
  // (logo, prices, about, etc.) and request the agreement WITHOUT a manual
  // call. Falls back gracefully — if rancherId not passed, we just hide
  // the wizard CTA and the email is still useful (Calendly fallback).
  let setupUrl = '';
  if (data.rancherId) {
    try {
      // Lazy import to avoid pulling jsonwebtoken into other call sites.
      const jwt = await import('jsonwebtoken');
      const { JWT_SECRET } = await import('@/lib/secrets');
      const token = jwt.default.sign(
        { type: 'rancher-setup', rancherId: data.rancherId },
        JWT_SECRET,
        { expiresIn: '60d' }
      );
      setupUrl = `${SITE_URL}/rancher/setup?token=${token}`;
    } catch (e) {
      console.error('[self-submit-welcome] setup link mint failed:', e);
    }
  }

  const subject = `${data.ranchName} is on the map — set up your page`;
  return guardedSend({
    templateName: 'sendRancherSelfSubmitWelcome',
    recipientEmail: data.to,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.to,
      subject,
      headers: getUnsubscribeHeaders(data.to),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 18px}p{margin:14px 0;color:#2A2A2A}.cta{display:inline-block;padding:14px 30px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px}.cta-secondary{display:inline-block;padding:14px 30px;border:1px solid #0E0E0E;color:#0E0E0E !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px}.divider{height:1px;background:#A7A29A;margin:24px 0}</style>
</head><body><div class="container">
  <h1>Hey ${esc(first)},</h1>
  <p>You just put <strong>${esc(data.ranchName)}</strong> on the BuyHalfCow discover map. Yellow pin. Live now.</p>
  <p>Quick context on what this is &mdash; I'm Ben, founder of BuyHalfCow. We help direct-to-consumer ranchers reach more families and sell more beef without the middleman. Public map, buyer routing, marketing services, the whole stack.</p>
  <p>You're not getting routed customers yet &mdash; that flips after you sign the partner agreement. Yellow pin = "we know about you, we haven't onboarded you yet."</p>
  ${setupUrl ? `
  <p><strong>The fastest way through:</strong> our self-serve wizard. Five minutes, four steps, no call needed unless you want one.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${utm(setupUrl, 'self-submit-welcome', 'wizard')}" class="cta">Set up your page →</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;text-align:center;">Want to talk first? <a href="${utm(CALENDLY_LINK, 'self-submit-welcome', 'calendly')}">Book a 15-min call</a> instead.</p>
  ` : `
  <p><strong>One next step:</strong> book a 15-minute call. I'll show you what we do, ask a few questions about how you sell today, and we figure out together if it's a fit.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${utm(CALENDLY_LINK, 'self-submit-welcome', 'cta')}" class="cta">Book the 15-min call</a>
  </div>
  `}
  <div class="divider"></div>
  <p style="font-size:13px;color:#2A2A2A;">We're running the food revolution &mdash; getting families off mystery grocery beef and onto real ranches like yours. The map is how they find you. The marketing services are how you stay full.</p>
  <p style="font-size:12px;color:#A7A29A;">&mdash; Ben<br>Founder, BuyHalfCow</p>
  ${emailFooter(data.to)}
</div></body></html>`,
    }),
  });
}

export async function sendRancherCommunityIntro(data: {
  to: string;
  ranchName: string;
  operatorName: string;
  submitterName: string;
  relationship?: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = (data.operatorName || '').split(' ')[0] || 'there';
  const relationLine = data.relationship
    ? ` ${esc(data.submitterName)} described the connection as: "${esc(data.relationship)}".`
    : '';
  const subject = `${data.submitterName} thinks you should know about us`;
  return guardedSend({
    templateName: 'sendRancherCommunityIntro',
    recipientEmail: data.to,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.to,
      subject,
      headers: getUnsubscribeHeaders(data.to),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 18px}p{margin:14px 0;color:#2A2A2A}.cta{display:inline-block;padding:14px 30px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px}.divider{height:1px;background:#A7A29A;margin:24px 0}</style>
</head><body><div class="container">
  <h1>Hey ${esc(first)},</h1>
  <p>Cold email, sorry &mdash; but worth your three minutes.</p>
  <p><strong>${esc(data.submitterName)}</strong> just put <strong>${esc(data.ranchName)}</strong> on the BuyHalfCow discover map and asked us to reach out.${relationLine}</p>
  <p>I'm Ben, founder of BuyHalfCow. We help direct-to-consumer ranchers like you reach more families &mdash; the public map, marketing services, intros to buyers in your area. No middleman, no commodity pricing, you keep your margin.</p>
  <p>You're a yellow pin on the map right now: visible, but not getting routed customers. That only flips after a 15-minute call and a partner agreement. The call is free, low-pressure, and you'll know in 15 minutes whether it's a fit.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${utm(CALENDLY_LINK, 'community-intro', 'cta')}" class="cta">Book the 15-min call</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">If you'd rather we take you off the map, just reply with "remove" and you're gone. No questions.</p>
  <div class="divider"></div>
  <p style="font-size:13px;color:#2A2A2A;">${esc(data.submitterName)} flagged you because they think families should be buying from a real rancher instead of a grocery chain. We agree. The food revolution doesn't happen without ranchers like you on the map.</p>
  <p style="font-size:12px;color:#A7A29A;">&mdash; Ben<br>Founder, BuyHalfCow</p>
  ${emailFooter(data.to)}
</div></body></html>`,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Drip emails fired by /api/cron/rancher-onboarding-drip
// (Day 2 nudge, Day 5 case-study, Day 14 last-call)
// ─────────────────────────────────────────────────────────────────────────────

export async function sendRancherOnboardingDripDay2(data: {
  to: string;
  ranchName: string;
  operatorName: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = (data.operatorName || '').split(' ')[0] || 'there';
  const subject = `Re: ${data.ranchName} on the map`;
  return guardedSend({
    templateName: 'sendRancherOnboardingDripDay2',
    recipientEmail: data.to,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.to,
      subject,
      headers: getUnsubscribeHeaders(data.to),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#2A2A2A}.cta{display:inline-block;padding:14px 30px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px}</style>
</head><body><div class="container">
  <p>Hey ${esc(first)},</p>
  <p>Following up on my note from a couple days back &mdash; ${esc(data.ranchName)} is sitting on the map as a yellow pin and I haven't heard from you yet.</p>
  <p>The 15-minute call is the only way to flip you from yellow ("on the map") to green ("getting routed real customers"). I'll come in with a couple of buyer profiles already in your area so we have something concrete to look at.</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${utm(CALENDLY_LINK, 'self-submit-drip', 'day2')}" class="cta">Grab a slot</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">Reply with a phone number if email isn't your thing. I'll call.</p>
  <p style="font-size:12px;color:#A7A29A;">&mdash; Ben</p>
  ${emailFooter(data.to)}
</div></body></html>`,
    }),
  });
}

export async function sendRancherOnboardingDripDay5(data: {
  to: string;
  ranchName: string;
  operatorName: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = (data.operatorName || '').split(' ')[0] || 'there';
  const subject = `What we actually do for ranchers like you`;
  return guardedSend({
    templateName: 'sendRancherOnboardingDripDay5',
    recipientEmail: data.to,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.to,
      subject,
      headers: getUnsubscribeHeaders(data.to),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#2A2A2A}ul{margin:14px 0;padding-left:22px}li{margin:6px 0}.cta{display:inline-block;padding:14px 30px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px}</style>
</head><body><div class="container">
  <p>Hey ${esc(first)},</p>
  <p>I haven't bombarded you with a sales deck because that's not what we do. Two-line version of what BuyHalfCow does for D2C ranchers:</p>
  <ul>
    <li><strong>Public map + listing</strong> &mdash; families searching for real beef in your county find you, not Walmart.</li>
    <li><strong>Buyer matching</strong> &mdash; we route pre-screened families with confirmed budgets and timing directly to ranchers we've vetted.</li>
    <li><strong>Marketing services</strong> &mdash; story-driven email, content, and outreach so families understand why your beef is worth $7/lb instead of $4/lb.</li>
  </ul>
  <p>One 15-minute call, no slide deck, you tell me how you sell today and I tell you whether we'd actually move the needle for ${esc(data.ranchName)}.</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${utm(CALENDLY_LINK, 'self-submit-drip', 'day5')}" class="cta">Book the call</a>
  </div>
  <p style="font-size:12px;color:#A7A29A;">&mdash; Ben<br>Founder, BuyHalfCow</p>
  ${emailFooter(data.to)}
</div></body></html>`,
    }),
  });
}

export async function sendRancherOnboardingDripDay14(data: {
  to: string;
  ranchName: string;
  operatorName: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = (data.operatorName || '').split(' ')[0] || 'there';
  const subject = `Last note from me`;
  return guardedSend({
    templateName: 'sendRancherOnboardingDripDay14',
    recipientEmail: data.to,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.to,
      subject,
      headers: getUnsubscribeHeaders(data.to),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}p{margin:14px 0;color:#2A2A2A}.cta{display:inline-block;padding:14px 30px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px}</style>
</head><body><div class="container">
  <p>Hey ${esc(first)},</p>
  <p>Last note from me unless I hear back &mdash; I don't want to be that guy who emails forever.</p>
  <p>${esc(data.ranchName)} stays on the map as a yellow pin either way. If timing isn't right now, that's fine. Pin's there when you're ready.</p>
  <p>If you DO want to talk:</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${utm(CALENDLY_LINK, 'self-submit-drip', 'day14')}" class="cta">Pick a slot</a>
  </div>
  <p>If you want OFF the map, just reply "remove" and you're gone, same day.</p>
  <p style="font-size:12px;color:#A7A29A;">&mdash; Ben</p>
  ${emailFooter(data.to)}
</div></body></html>`,
    }),
  });
}

// =====================================================
// ROUTING-SEGMENT TEMPLATES — drives /api/cron/email-sequences branching
// per lib/routingSegment.ts. Each template targets one segment + one JTBD.
// =====================================================

/**
 * MATCH_NOW segment — buyer clicked "Ready to Buy" and there's a covered-
 * state rancher with capacity. This email is sent BEFORE the system stages
 * a Pending Approval referral, so the buyer knows an intro is coming.
 *
 * Cadence: 1 lifetime send.
 */
export async function sendMatchNowRescue(data: {
  email: string;
  firstName: string;
  buyerState: string;
}) {
  const first = data.firstName || 'there';
  const subject = `your rancher is lined up — intro coming in 24 hours`;
  return guardedSend({
    templateName: 'sendMatchNowRescue',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}</style>
</head><body><div class="container">
  <h1>Your rancher is lined up</h1>
  <p>Hi ${esc(first)},</p>
  <p>You clicked "ready to buy" — thanks for the signal. I've matched you with a verified rancher in ${esc(data.buyerState)} who's got capacity for you this season.</p>
  <p>You'll get a second email within the next 24 hours with their name, pricing (Quarter / Half / Whole), processing date, and direct contact info. They'll also reach out to you within 48 hours.</p>
  <p>From there it's between you and the ranch — pickup date, cut sheet, payment method. We take 10% only when the deal closes. The rancher keeps 90.</p>
  <p>If anything changes, reply to this email and I'll handle it.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
}

/**
 * NUDGE_TO_ENGAGE segment — buyer is qualified + in a covered state but
 * has never engaged with a warmup. This is the second-touch nudge with a
 * sharper R2B button.
 *
 * Cadence: up to 2 lifetime sends, 7d apart.
 */
export async function sendNudgeToEngage(data: {
  email: string;
  firstName: string;
  buyerState: string;
  engageUrl: string;
}) {
  const first = data.firstName || 'there';
  const subject = `quick question on your ${data.buyerState} beef timing`;
  return guardedSend({
    templateName: 'sendNudgeToEngage',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px}.q{background:#FAF8F4;border:1px solid #A7A29A;padding:16px 20px;margin:24px 0;font-family:Georgia,serif;font-size:18px}</style>
</head><body><div class="container">
  <h1>One question on timing</h1>
  <p>Hi ${esc(first)},</p>
  <p>You signed up for BuyHalfCow a while back and we've got verified ranchers in ${esc(data.buyerState)} with capacity right now. Before I introduce you, I want to make sure the timing is right.</p>
  <div class="q"><strong>Are you ready to buy in the next 1–2 months?</strong></div>
  <p>If yes, tap below and I'll send the rancher's full info within 24 hours. They reach out to you direct. No middleman, no markup — we take 10% only when the deal closes.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${data.engageUrl}" class="cta">Yes — Ready to Buy</a>
  </div>
  <p style="font-size:14px;">If not yet, just don't click. You stay on the list and we'll check back in a couple weeks. No pressure.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
}

/**
 * WARM_LEAD segment — buyer clicked YES on warmup ("I'm interested") but
 * has NOT clicked "Ready to Buy" yet. Bi-weekly "ready yet?" nudge with a
 * sharper R2B button.
 *
 * Cadence: up to 4 lifetime sends, 14d apart.
 */
export async function sendWarmLeadReadyCheck(data: {
  email: string;
  firstName: string;
  buyerState: string;
  engageUrl: string;
}) {
  const first = data.firstName || 'there';
  const subject = `ready to buy yet? quick check-in`;
  return guardedSend({
    templateName: 'sendWarmLeadReadyCheck',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px}</style>
</head><body><div class="container">
  <h1>Ready yet?</h1>
  <p>Hi ${esc(first)},</p>
  <p>You said you were interested in beef from a ${esc(data.buyerState)} rancher. We've still got capacity and I want to make sure I introduce you at the right time.</p>
  <p><strong>If you're ready to buy in the next 1–2 months</strong>, tap below and I'll send rancher info within 24 hours. If timing isn't right yet, just sit tight — I'll check back in a couple weeks.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${data.engageUrl}" class="cta">Yes — Ready to Buy</a>
  </div>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
}

/**
 * INCOMPLETE_PROFILE segment — buyer signed up but Order Type or Budget
 * is missing/ambiguous. Without those signals matching can't route them.
 * One-question email asks them to pick Quarter/Half/Whole inline so the
 * next reclassify-buyers run can promote them into the funnel.
 *
 * Cadence: 1 lifetime send.
 */
export async function sendIncompleteProfileAsk(data: {
  email: string;
  firstName: string;
  buyerState: string;
}) {
  const first = data.firstName || 'there';
  const accessUrl = `${SITE_URL}/access`;
  const subject = `two questions on your beef — 30 seconds`;
  return guardedSend({
    templateName: 'sendIncompleteProfileAsk',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px}.q{background:#FAF8F4;border:1px solid #A7A29A;padding:16px 20px;margin:16px 0;font-family:Georgia,serif;font-size:16px}</style>
</head><body><div class="container">
  <h1>Two quick questions</h1>
  <p>Hi ${esc(first)},</p>
  <p>You signed up for BuyHalfCow but I don't have enough info to match you with the right rancher in ${esc(data.buyerState)}. Two questions, 30 seconds.</p>
  <div class="q"><strong>1.</strong> How much beef do you want? <em>(Quarter ≈ 90 lbs, Half ≈ 180 lbs, Whole ≈ 360 lbs)</em></div>
  <div class="q"><strong>2.</strong> What's your budget?</div>
  <p>Tap below to update your profile — takes less than a minute and gets you matched.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${accessUrl}" class="cta">Finish my profile</a>
  </div>
  <p style="font-size:14px;">If you'd rather just talk it through, reply to this email and I'll help you figure out what makes sense.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
}

/**
 * NO_BUDGET_FOUNDER_PITCH segment — buyer signed up wanting BHC beef but
 * their budget is under share-cost (<$500). They care about the mission
 * but can't drop $1k+ on a Quarter this year. Pitch them the Founding
 * Herd — back the platform for $100, get a numbered patch, quarterly
 * ledger, founders-wall placement. Works in any state.
 *
 * Cadence: 1 lifetime send, then monthly community letter.
 */
export async function sendNoBudgetFounderPitch(data: {
  email: string;
  firstName: string;
  buyerState: string;
}) {
  const first = data.firstName || 'there';
  const FOUNDERS_URL = `${SITE_URL}/founders`;
  const subject = `beef's not in the budget? back the mission for $100`;
  return guardedSend({
    templateName: 'sendNoBudgetFounderPitch',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px}.divider{height:1px;background:#A7A29A;margin:24px 0}</style>
</head><body><div class="container">
  <h1>Beef this year isn't in the budget? I get it.</h1>
  <p>Hi ${esc(first)},</p>
  <p>You signed up for BuyHalfCow. You care about how cattle gets raised. You're on the right side of the food fight. But buying a Quarter is $650–$1,000 — that's not in the budget for a lot of people this year. I won't pretend otherwise.</p>
  <p>Here's another way to be part of this without the freezer commitment.</p>
  <div class="divider"></div>
  <p><strong>The Founding Herd.</strong> 100 numbered spots. Back the platform from $100 (Herd) to $1k (Outlaw+) to $15k (Title Founder). You get:</p>
  <ul style="color:#6B4F3F;padding-left:20px;">
    <li>Numbered embroidered patch shipped to your door</li>
    <li>Quarterly expense ledger in your inbox — see exactly where every dollar went</li>
    <li>Name on the public Founders Wall (opt-in)</li>
    <li>First-pick access when a rancher comes online in your state</li>
    <li>Voting rights on platform direction decisions</li>
  </ul>
  <p>I'm not selling equity. I'm not running a crowdfund I'm going to disappear from. I'm building a marketplace I'd want to use, and the Founding Herd capital is what funds the recruiting team that brings ranchers + buyers together.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${FOUNDERS_URL}" class="cta">See the Founding Herd</a>
  </div>
  <p style="font-size:14px;">If $100 isn't in the budget either, no worries — you stay on the list and I'll email when ${esc(data.buyerState)} comes online. The work continues either way.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
}

/**
 * STATE_WAITLIST segment — buyer is qualified (budget + Order Type set,
 * not no-budget) but lives in an uncovered state. They CAN afford the
 * beef, we just don't have a rancher in their state yet. Soft "we're
 * scouting [state]" letter w/ no hard CTA. Monthly cadence keeps them
 * warm until a local rancher signs.
 *
 * Cadence: 1 lifetime send, then monthly community letter takes over.
 */
// =====================================================
// TESTIMONIAL ASK — post-purchase quote request
// Sent ~14 days after Closed Won. Asks for one sentence
// for the marketing pages. Reply lands in Conversations
// via tagged Reply-To; operator pastes into Referrals.Testimonial.
// =====================================================
export async function sendTestimonialAsk(data: {
  email: string;
  firstName: string;
  ranchName: string;
  orderType: string;
  referralId: string;
}) {
  const first = data.firstName || 'there';
  const cut = (data.orderType || 'beef').toLowerCase();
  const cutPhrase = /half|whole|quarter/.test(cut) ? `a ${cut}` : 'beef';
  const subject = `quick favor — one sentence about your ${cut}?`;
  // Mint review-submit JWT — 120d so late repliers still land. Verified by
  // /api/reviews/submit which writes Buyer Rating + Buyer Review onto the
  // Referrals row. Buyer can still hit reply for free-form (Conversations
  // table) — the magic link is just the 30-second express lane.
  const reviewToken = jwt.sign(
    { type: 'review-submit', referralId: data.referralId },
    JWT_SECRET,
    { expiresIn: '120d' }
  );
  const reviewUrl = `${SITE_URL}/reviews/submit?token=${reviewToken}`;
  return guardedSend({
    templateName: 'sendTestimonialAsk',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      _replyContext: { type: 'ref', recordId: data.referralId },
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.cta{text-align:center;margin:28px 0}.cta a{display:inline-block;background:#0E0E0E;color:#F4F1EC;padding:14px 32px;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;text-decoration:none}</style>
</head><body><div class="container">
  <h1>Quick favor, ${esc(first)}.</h1>
  <p>Hey ${esc(first)} — Ben here, founder of BuyHalfCow.</p>
  <p>You got ${cutPhrase} from ${esc(data.ranchName)} a couple weeks back. How is it?</p>
  <p>If you have 30 seconds, click below to leave a quick rating + one sentence. Real words, your voice. I'd like to share it on the site (first name + state only — no last name, no email).</p>
  <div class="cta"><a href="${reviewUrl}">Leave a quick review</a></div>
  <p>Or just hit reply with one sentence — like:</p>
  <p style="border-left:3px solid #A7A29A;padding-left:14px;color:#6B4F3F;font-style:italic;">"freezer's full, family's fed, talked to the rancher direct."</p>
  <p>If you'd rather not, totally fine — no follow-up.</p>
  <p>Thanks for backing real ranchers.</p>
  <p style="font-size:13px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
</div></body></html>`,
    }),
  });
}

export async function sendStateWaitlistLetter(data: {
  email: string;
  firstName: string;
  buyerState: string;
}) {
  const first = data.firstName || 'there';
  const subject = `scouting ranchers in ${data.buyerState} — you're on the list`;
  return guardedSend({
    templateName: 'sendStateWaitlistLetter',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}</style>
</head><body><div class="container">
  <h1>We're scouting ${esc(data.buyerState)}</h1>
  <p>Hi ${esc(first)},</p>
  <p>Thanks for signing up. Straight read: we don't have a verified rancher in ${esc(data.buyerState)} yet. You're on the waitlist.</p>
  <p>I cold-email D2C ranchers in uncovered states every week. ${esc(data.buyerState)} is on the list. When one signs the agreement + goes live, you're one of the first I match them to.</p>
  <p>I'll email when it happens. No spam in the meantime — just one short monthly note so you know the platform is still building.</p>
  <p>Thanks for being patient w/ a small platform doing it right.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Ben<br>BuyHalfCow</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
}

// ── Stage-3 Task 9: rancher confirmed fulfillment → buyer receives "your beef is here" ──
// Sent to the buyer when the rancher hits "Confirm Fulfillment" on the
// dashboard. Closes the loop — the buyer knows BHC + the rancher have
// reconciled the deal. For tier_v2 deposits the funds already settled at
// charge time via Connect direct charge, so this email is purely a status
// confirmation (no payment action needed from the buyer).
export async function sendBuyerFulfillmentConfirmation(data: {
  email: string;
  firstName: string;
  rancherName: string;
  ranchName: string;
  orderType: string;
  rancherNote?: string;
}): Promise<{ success: boolean; error?: any }> {
  const first = data.firstName || 'there';
  const subject = `${data.ranchName} confirmed your beef is in your hands`;
  const noteBlock = data.rancherNote && data.rancherNote.trim()
    ? `<div class="box"><p style="margin:0;"><strong>Note from ${esc(data.rancherName)}:</strong></p><p style="margin:8px 0 0;color:#2A2A2A;">${esc(data.rancherNote)}</p></div>`
    : '';
  return guardedSend({
    templateName: 'sendBuyerFulfillmentConfirmation',
    recipientEmail: data.email,
    subject,
    send: () => resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 18px}p{margin:14px 0;color:#2A2A2A}.box{background:#FAF8F4;border-left:3px solid #0E0E0E;padding:16px 20px;margin:18px 0}.footer{margin-top:36px;padding-top:18px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>Beef received — you're set, ${esc(first)}.</h1>
  <p>${esc(data.rancherName)} from ${esc(data.ranchName)} just confirmed your ${esc(data.orderType || 'share')} is in your hands. The deal is officially closed.</p>
  ${noteBlock}
  <p><strong>What now:</strong></p>
  <ul style="color:#2A2A2A;line-height:2;">
    <li>Stack the vacuum-sealed packs flat in your freezer — easier to find cuts later.</li>
    <li>In ~2 weeks I'll send you a cuts education email — what to do with the oxtail, the shanks, the trim that becomes burger.</li>
    <li>Around the 5-month mark I'll ping you about reserving the next share — from ${esc(data.rancherName)} again or another rancher in your area if their next harvest fits your timing better.</li>
  </ul>
  <p>If anything was off about pickup/delivery, reply to this email. I read every reply.</p>
  <p style="margin-top:32px;">— Benjamin</p>
  ${emailFooter(data.email)}
</div></body></html>`,
    }),
  });
}
