# Payment & Commission Tracking Guide

## Payment Flow (Manual System for Launch)

### Option A: Fully Manual (Recommended for Launch Week)

**How it works:**
1. Consumer pays rancher directly (Venmo/Zelle/check/bank transfer)
2. Rancher reports sale via email to you after beef is delivered
3. You track sale in Airtable (Inquiries table - "Sale Completed" status + sale amount)
4. You invoice rancher for 10% commission monthly
5. Rancher pays you commission

**Pros:**
- Zero setup required
- No payment processing fees (2.9%)
- Ranchers comfortable with direct payment
- Simple for launch week

**Cons:**
- Relies on rancher reporting (honor system)
- Manual invoicing required
- Potential tax implications

---

## Step-by-Step: Manual Payment Tracking

### When Rancher Reports a Sale:

1. **Go to Admin Dashboard → Inquiries & Commissions**
   `/admin/inquiries`

2. **Find the inquiry for that buyer + rancher**
   - Search by consumer name or rancher name
   - Status should be "Approved" (inquiry was forwarded)

3. **Update the inquiry:**
   - Status: Change to "Sale Completed"
   - Sale Amount: Enter total sale price (e.g., $1,500)
   - Commission Amount: Auto-calculates at 10% (e.g., $150)
   - Notes: Add any details about the sale

4. **Commission tracking:**
   - Leave "Commission Paid" unchecked until rancher pays you
   - Add invoice number or payment method in Notes
   - Check "Commission Paid" once you receive payment

5. **Monthly invoicing:**
   - Filter inquiries by "Sale Completed" + "Commission Paid = false"
   - Invoice ranchers for outstanding commissions
   - Update "Commission Paid" when received

---

## Business Email Setup

### Recommended Email: `benji@buyhalfcow.com` or `support@buyhalfcow.com`

**Option 1: Google Workspace (Professional)**
- Cost: $6/month per user
- Setup: 10 minutes via Namecheap/GoDaddy DNS
- Pros: Professional, full Gmail features, mobile apps
- [Setup Guide](https://workspace.google.com)

**Option 2: Resend Inbound Email (Free)**
- Cost: Free with existing Resend account
- Setup: 5 minutes in Resend dashboard
- Forwards to your personal email
- Pros: Instant, no cost, integrated with platform

**Option 3: Zoho Mail (Budget)**
- Cost: Free for 1 user (5GB storage)
- Setup: 10 minutes
- Pros: Free, professional features
- [Setup Guide](https://www.zoho.com/mail/)

### Recommended for Launch Week:
Use **Resend inbound forwarding** to `support@buyhalfcow.com` → forwards to your personal email.
Upgrade to Google Workspace post-launch for professionalism.

---

## What to Tell Ranchers About Payments

**During onboarding call:**

> "When a sale closes through a BuyHalfCow introduction, just email me the details — buyer name and sale amount. I'll update my records and invoice you for the commission at the end of the month. You handle payment directly with the buyer using whatever method you prefer — check, Venmo, Zelle, whatever works for your operation."

**Keep commission % private:**
- Don't advertise the 10% on the website
- Discuss commission terms during private onboarding calls
- Include in rancher application terms (they agree during signup)

---

## Invoicing Template

**Subject:** BuyHalfCow Commission Invoice — [Month Year]

Hi [Rancher Name],

Hope sales are going well! Here's your commission invoice for [Month]:

**Sales facilitated by BuyHalfCow:**
- [Buyer Name] — $[Sale Amount] → Commission: $[10% Amount]
- [Buyer Name] — $[Sale Amount] → Commission: $[10% Amount]

**Total Commission Due:** $[Total]

**Payment Methods:**
- Venmo: @[your-venmo]
- Zelle: [your-email/phone]
- Check: [Mailing Address]

Let me know if you have questions!

Benji
BuyHalfCow

---

## Future: Automated Payment Processing (Post-Launch)

### Stripe Connect (Best Long-Term)

**How it works:**
1. Consumer pays through BuyHalfCow platform (Stripe)
2. Platform holds funds (split payment)
3. Rancher receives 90% directly to their bank
4. BuyHalfCow receives 10% commission automatically
5. Payouts weekly or monthly

**Pros:**
- Fully automated, transparent
- Professional, secure payment handling
- No invoicing required
- Trust & escrow built-in

**Cons:**
- 2.9% + 30¢ Stripe fee
- 2-3 days setup (Stripe Connect + rancher onboarding)
- More technical complexity

**When to implement:**
After you have 20-30 ranchers live and manual invoicing becomes time-consuming. Not urgent for launch week.

---

## Commission Privacy Strategy

✅ **DO:**
- Include commission terms in rancher application (checkbox agreement)
- Discuss commission during 1-on-1 onboarding calls
- Reference "commission terms" generically on the website
- Keep commission % in private partnership agreements

❌ **DON'T:**
- Display "10%" or "90%" on public-facing pages
- Mention commission % in consumer-facing copy
- Include commission details in public FAQs

**Why?**
- Protects your business model
- Keeps focus on value (verification, quality, trust)
- Avoids price anchoring or negotiation
- Industry standard for facilitators/brokers

---

## Launch Week Workflow

1. **Consumer applies** → You approve → They see ranchers
2. **Consumer requests introduction** → You review + approve → Email both parties
3. **Consumer + Rancher connect directly** → Discuss pricing, terms, delivery
4. **Transaction happens** → Consumer pays rancher directly
5. **Rancher emails you** → "Sold $1,500 half cow to [Buyer Name]"
6. **You update Airtable** → Inquiry status "Sale Completed", add sale amount
7. **End of month** → Invoice all ranchers for outstanding commissions
8. **Rancher pays you** → Mark "Commission Paid" in Airtable

Simple, manual, works at scale for launch week and the first few months.

---

## Questions?

Email yourself at: `support@buyhalfcow.com` (once set up) 😉

---

## Airtable Fields to Add (If Not Already Added):

Go to your **Ranchers** table in Airtable and add:
- `Ranch Tour Interested` — Checkbox
- `Ranch Tour Availability` — Long text

These fields were just added to the rancher application form.
