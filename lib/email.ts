import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder_for_build');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@buyhalfcow.com';
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
  return `BuyHalfCow <noreply@${domain}>`;
}

function getUnsubscribeHeaders(email: string) {
  return {
    'List-Unsubscribe': `<mailto:unsubscribe@${SEND_DOMAINS[0]}?subject=Unsubscribe%20${encodeURIComponent(email)}>, <${SITE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
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
    <a href="${loginUtm}" class="button">Access Your Dashboard</a>
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
// BUYER MATCH + INTRO NOTIFICATION EMAILS
// =====================================================

export async function sendBuyerMatchNotification(data: {
  firstName: string;
  email: string;
  rancherName: string;
  ranchState: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `We found your rancher — ${esc(data.rancherName)}`,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.highlight{background:#F4F1EC;border-left:3px solid #0E0E0E;padding:16px 20px;margin:20px 0;color:#0E0E0E}.cta{display:inline-block;padding:16px 32px;background:#0E0E0E;color:#F4F1EC!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:20px 0}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>We Found Your Rancher</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>Great news — we've matched you with a rancher who fits your preferences.</p>
  <div class="highlight">
    <strong>${esc(data.rancherName)}</strong> — ${esc(data.ranchState)}<br>
    <span style="font-size:14px;color:#6B4F3F;">Verified and certified by BuyHalfCow</span>
  </div>
  <p><strong>What happens next:</strong></p>
  <ol style="color:#6B4F3F;line-height:2">
    <li>I'm reviewing the match to make sure it's the right fit</li>
    <li>Once confirmed, I'll make a personal introduction via email</li>
    <li>You and your rancher connect directly — no middleman</li>
  </ol>
  <p>You should receive your introduction within <strong>24-48 hours</strong>. Keep an eye on your inbox.</p>
  <div style="text-align:center;">
    <a href="${utm(data.loginUrl, 'match-notification', 'dashboard')}" class="cta">View Your Dashboard</a>
  </div>
  <div class="divider"></div>
  <p style="font-size:13px;">Questions? Reply to this email.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending buyer match notification:', error);
    return { success: false, error };
  }
}

export async function sendBuyerIntroNotification(data: {
  firstName: string;
  email: string;
  rancherName: string;
  rancherEmail: string;
  rancherPhone?: string;
  loginUrl: string;
}) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `Meet your rancher — ${esc(data.rancherName)}`,
      headers: getUnsubscribeHeaders(data.email),
      html: `<!DOCTYPE html><html><head>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px}.container{max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A}h1{font-family:Georgia,serif;font-size:26px;margin:0 0 20px}p{margin:14px 0;color:#6B4F3F}.contact-box{background:#F4F1EC;border:1px solid #A7A29A;padding:20px 24px;margin:20px 0}.contact-box p{margin:6px 0;color:#0E0E0E}.cta{display:inline-block;padding:16px 32px;background:#0E0E0E;color:#F4F1EC!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:20px 0}.divider{height:1px;background:#A7A29A;margin:24px 0}.footer{margin-top:30px;padding-top:20px;border-top:1px solid #A7A29A;font-size:12px;color:#A7A29A}</style>
</head><body><div class="container">
  <h1>Your Rancher Introduction</h1>
  <p>Hi ${esc(data.firstName)},</p>
  <p>I've personally vetted and matched you with <strong>${esc(data.rancherName)}</strong>. They know you're coming — reach out whenever you're ready.</p>
  <div class="contact-box">
    <p><strong>${esc(data.rancherName)}</strong></p>
    <p>Email: <a href="mailto:${esc(data.rancherEmail)}" style="color:#0E0E0E;">${esc(data.rancherEmail)}</a></p>
    ${data.rancherPhone ? `<p>Phone: <a href="tel:${esc(data.rancherPhone)}" style="color:#0E0E0E;">${esc(data.rancherPhone)}</a></p>` : ''}
  </div>
  <p><strong>What to discuss:</strong></p>
  <ul style="color:#6B4F3F;line-height:2">
    <li>What cuts are available and current pricing</li>
    <li>Processing timeline and delivery options</li>
    <li>Any questions about their operation</li>
  </ul>
  <p>They'll walk you through everything. No pressure, no rush — this is a direct relationship between you and your rancher.</p>
  <div style="text-align:center;">
    <a href="${utm(data.loginUrl, 'intro-notification', 'dashboard')}" class="cta">View Your Dashboard</a>
  </div>
  <div class="divider"></div>
  <p style="font-size:13px;">If you don't hear back within 48 hours, reply to this email and I'll follow up on my end.</p>
  <div class="footer">
    <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
    <p style="font-size:10px;color:#ccc;margin-top:12px;"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(data.email)}" style="color:#ccc;">Unsubscribe</a></p>
  </div>
</div></body></html>`,
    });
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
              <li><strong>Verification</strong> — Product sample shipment or scheduled ranch visit (we discussed this on the call)</li>
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
              <p>I'm personally reviewing and certifying every rancher in the network. Here's the process:</p>
              <ol style="line-height: 1.8; color: #6B4F3F;">
                <li><strong>Schedule your call</strong> — Book your 30-minute onboarding call on my calendar (see below)</li>
                <li><strong>Onboarding call</strong> — We discuss your operation, answer questions, explain The HERD network</li>
                <li><strong>Ranch tour</strong> — I'll visit your ranch in person for verification (if you indicated interest)</li>
                <li><strong>Certification</strong> — Once verified, you start receiving qualified buyer introductions</li>
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
        <a href="${utm(data.loginUrl, 'beef-day3', 'dashboard')}" class="button">Check Your Dashboard →</a>
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
        <p>If you haven't heard back within 24 hours, reply to this email and I'll follow up on my end. Every rancher in our network is vetted and responsive — if something isn't working, I want to know.</p>
        <p>If you've already connected, that's great — just ignore this.</p>
        <a href="${utm(data.loginUrl, 'beef-day7', 'dashboard')}" class="button">View Your Dashboard →</a>
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
        <a href="${utm(data.loginUrl, 'community-day7', 'dashboard')}" class="button">Explore Your Dashboard →</a>
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
        <p style="font-size:13px;color:#A7A29A">Or <a href="${utm(data.loginUrl, 'community-day14', 'dashboard')}" style="color:#0E0E0E">log in to your dashboard</a> if you've already done this.</p>
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
        <a href="${utm(data.loginUrl, 'chase-up', 'dashboard')}" class="button">View Your Dashboard →</a>
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
  ${data.loginUrl ? `<div style="text-align:center;"><a href="${utm(data.loginUrl, 'waitlist', 'dashboard')}" class="cta">Explore Your Dashboard</a></div>` : ''}
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
  <p>If there's been an issue or you'd like us to follow up on your behalf, just reply to this email and we'll handle it.</p>
  <div style="text-align: center;">
    <a href="${utm(data.loginUrl, 'intro-checkin', 'dashboard')}" class="cta">View Your Dashboard →</a>
  </div>
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
      <div class="step"><strong>3. Verification</strong> — Product sample or ranch visit</div>
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
      <div class="step"><strong>🔍 Start verification</strong> — Ship a product sample or request a ranch visit</div>
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
      <p>Quick update — your verification for <strong>${ranchName}</strong> is in progress. We'll let you know as soon as it's complete.</p>
      <p><strong>In the meantime:</strong> Make sure your ranch page is fully set up so we can go live the moment verification clears.</p>
      <div class="step step-done">✅ Agreement signed</div>
      <div class="step">🖥️ <strong>Finish your ranch page</strong> — pricing, photos, about text</div>
      <div class="step">🔍 Verification in progress...</div>
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

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
}) {
  try {
    const emailData: any = {
      from: getFromEmail(),
      to: params.to,
      subject: params.subject,
      html: params.html,
    };
    if (params.attachments && params.attachments.length > 0) {
      emailData.attachments = params.attachments;
    }
    await resend.emails.send(emailData);
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error };
  }
}

