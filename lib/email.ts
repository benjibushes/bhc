import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder_for_build');

const FROM_EMAIL = process.env.EMAIL_FROM || 'BuyHalfCow <noreply@buyhalfcow.com>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@buyhalfcow.com';

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
      from: FROM_EMAIL,
      to: data.email,
      subject: 'Application Received — BuyHalfCow',
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
            <p>You'll hear back from us within <strong>24-48 hours</strong> with next steps.</p>
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
    <a href="${data.loginUrl}" class="button">Access Your Dashboard</a>
    <p style="font-size: 13px; color: #A7A29A;">We're matching you with a rancher now. You'll receive an introduction soon.</p>
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
    <a href="${data.loginUrl}" class="button">Explore the Network</a>
    <div class="divider"></div>
    <p><strong>Interested in sourcing beef?</strong></p>
    <p>When you're ready to explore buying direct from a rancher, you can upgrade anytime from your member dashboard. We'll match you personally.</p>
  `;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: data.email,
      subject: isBeef
        ? "You're Approved — Let's Find Your Rancher"
        : 'Welcome to the BHC Network',
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
// RANCHER APPROVAL EMAIL
// =====================================================

export async function sendRancherApproval(data: {
  operatorName: string;
  ranchName: string;
  email: string;
}) {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: data.email,
      subject: 'You\'re Approved — BuyHalfCow Partnership',
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
      from: FROM_EMAIL,
      to: data.email,
      subject: `${typeLabels[data.type]} Application Received — BuyHalfCow`,
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
                <a href="${process.env.CALENDLY_LINK || 'https://calendly.com'}" style="display: inline-block; padding: 16px 32px; background: #F4F1EC; color: #0E0E0E !important; text-decoration: none; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; font-size: 14px; border: 2px solid #F4F1EC;">📅 View My Calendar & Book Now</a>
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
      from: FROM_EMAIL,
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
      from: FROM_EMAIL,
      to: data.rancherEmail,
      replyTo: data.consumerEmail, // Rancher can reply directly to consumer
      subject: `New Inquiry from BuyHalfCow Member`,
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
      from: FROM_EMAIL,
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
}) {
  try {
    const formattedMessage = esc(data.message).replace(/\n/g, '<br>');

    await resend.emails.send({
      from: FROM_EMAIL,
      to: data.to,
      subject: data.subject,
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
              <p style="margin-top: 16px; font-size: 11px; color: #A7A29A;">
                To stop receiving these emails, reply with "unsubscribe" or email ${ADMIN_EMAIL} with subject "Unsubscribe".
              </p>
              <p style="margin-top: 8px; font-size: 10px; color: #ccc;">
                Campaign: ${data.campaignName}
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
// UTILITY FUNCTIONS
// =====================================================

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}) {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error };
  }
}

