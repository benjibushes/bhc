# Email Marketing & Revenue Attribution System

## ✅ COMPLETE - ALL FEATURES IMPLEMENTED

You now have a **fully functional email marketing and revenue attribution system** that tracks every customer from first click to final sale, with complete commission tracking tied back to your lead generation efforts.

---

## 🎯 What You Can Do Now

### 1. **Send Blast Emails** → `/admin/broadcast`
- Compose subject + message
- Select audience (all consumers, by state, or ranchers)
- Name your campaign (e.g., "january-texas-beef")
- Add CTA button with tracking link
- See recipient count before sending
- Sends via Resend with branded template

### 2. **Track Campaign Performance** → `/admin/analytics`
- See which campaigns drive sign-ups, inquiries, and sales
- Calculate ROI per email sent
- Track total revenue and commission earned
- View recent activity feed
- Full attribution from email → sign-up → inquiry → sale

### 3. **Manage Commissions** → `/admin/inquiries`
- Approve/reject inquiries before rancher contact
- Mark inquiries as "Sale Completed"
- Enter sale amount (auto-calculates 10% commission)
- Track paid vs unpaid commissions
- See commission totals

### 4. **Automatic Campaign Tracking**
- Landing page captures `?campaign=xyz` from URLs
- Stores in localStorage
- Passes to signup form
- Saves in Airtable (Consumers + Inquiries)
- Full funnel attribution

---

## 📊 Complete Attribution Flow

```
1. Admin sends email → Campaign: "january-texas-beef"
2. Email includes link: buyhalfcow.com/access?campaign=january-texas-beef
3. Consumer clicks → Campaign stored in browser
4. Consumer signs up → Campaign saved to Airtable
5. Consumer makes inquiry → Campaign inherited from consumer
6. Admin approves inquiry → Rancher contacted
7. Rancher reports sale → Admin marks "Sale Completed" + enters $1,500
8. System calculates commission → $150 (10%)
9. Analytics dashboard shows:
   - Campaign: "january-texas-beef"
   - Emails: 45
   - Sign-ups: 8
   - Inquiries: 3
   - Sales: 1
   - Revenue: $1,500
   - Commission: $150
   - ROI: $3.33 per email
```

---

## 🗄️ Airtable Setup Required

### Add These Fields to Existing Tables:

#### Consumers Table:
- `Source` (Single line text) - e.g., "email", "organic", "referral"
- `Campaign` (Single line text) - e.g., "january-texas-beef"
- `UTM Parameters` (Long text) - Full UTM string (optional)

#### Inquiries Table:
- `Source` (Single line text) - Inherited from consumer's campaign

### Create New Table: Campaigns

1. Click "+ Add or import" → "Create empty table"
2. Name it: **Campaigns**
3. Add these fields:
   - **Campaign Name** (primary field)
   - **Subject Line** (Single line text)
   - **Message Body** (Long text)
   - **Audience Filter** (Single line text)
   - **Sent Date** (Date)
   - **Recipients Count** (Number)
   - **Link Clicks** (Number)

**📄 Full instructions:** See `AIRTABLE_CAMPAIGN_FIELDS.md`

---

## ⚙️ Environment Variables

Add to your `.env.local`:

```bash
# Commission rate (percentage) - used for auto-calculating commissions
NEXT_PUBLIC_COMMISSION_RATE=10
```

All other env vars (Resend, Airtable, Admin Password) remain the same.

---

## 🚀 How to Use This System

### Scenario: You onboard a new Texas rancher

1. **Send Broadcast Email**
   - Go to `/admin/broadcast`
   - Subject: "New Texas Rancher - Half Cows Available"
   - Message: "We just partnered with a certified rancher in Austin..."
   - Campaign name: "texas-rancher-jan-2026"
   - Audience: Consumers in TX
   - Click "Send to X Recipients"

2. **Track Results**
   - Consumers click the email link
   - Campaign "texas-rancher-jan-2026" is automatically tracked
   - They sign up → Source: "texas-rancher-jan-2026"
   - They browse ranchers → Make inquiry
   - Inquiry inherits source: "texas-rancher-jan-2026"

3. **Approve Inquiries**
   - Go to `/admin/inquiries`
   - See pending inquiries with campaign source
   - Click "Approve" → Rancher gets notified

4. **Track Sales**
   - Rancher emails you: "Got a sale! $1,500 half cow"
   - Edit inquiry → Status: "Sale Completed"
   - Enter sale amount: 1500
   - System auto-calculates commission: $150
   - Mark as paid when rancher pays commission

5. **View ROI**
   - Go to `/admin/analytics`
   - See "texas-rancher-jan-2026" performance:
     - 45 emails sent
     - 8 sign-ups
     - 3 inquiries
     - 1 sale
     - $1,500 revenue
     - $150 commission earned
     - **$3.33 per email = your ROI**

---

## 📧 Email Template

All broadcast emails use your branded template:
- BHC colors and fonts
- Clean, professional layout
- Dynamic subject line
- Custom message (supports line breaks)
- Optional CTA button with campaign tracking
- Footer with campaign name for tracking
- Reply-to: your admin email

Example email:

```
Subject: New Texas Rancher - Half Cows Available

Hi John,

We just partnered with a certified rancher in Austin with grass-fed 
beef ready for pickup in February.

Limited half cows available at $1,450 (butcher included).

[Browse Ranchers] → Links to: /member?campaign=texas-rancher-jan-2026

---
BuyHalfCow — Private Access Network
Campaign: texas-rancher-jan-2026
```

---

## 🎨 Admin Navigation

Your admin dashboard now has 3 main actions:

1. **📧 Send Broadcast Email** → `/admin/broadcast`
2. **📊 View Analytics & ROI** → `/admin/analytics`
3. **💰 Manage Inquiries** → `/admin/inquiries`

Plus the existing tabs:
- Consumers
- Ranchers
- Brands
- Land Deals

---

## 🔍 Analytics Dashboard Features

### Overview Cards:
- Total Consumers
- Total Inquiries
- Sales Closed
- Total Revenue (all sales)
- Your Commission (your cut)
- Conversion Rate (inquiries → sales)

### Campaign Performance Table:
Shows for each campaign:
- Emails sent
- Sign-ups generated
- Inquiries generated
- Sales closed
- Revenue generated
- Commission earned
- ROI per email

### Recent Activity Feed:
- Latest sign-ups (with campaign source)
- Latest inquiries (with attribution)
- Latest sales (with commission amounts)

---

## 🧪 Testing the System

### 1. Test Campaign Tracking
```bash
# Visit with campaign parameter
http://localhost:3000/?campaign=test-campaign-123

# Fill out access form
# Check Airtable → Consumers → Should see:
#   Source: "email"
#   Campaign: "test-campaign-123"
```

### 2. Test Broadcast Email
```bash
# Go to /admin/broadcast
# Send test email to yourself
# Click link in email
# Should capture campaign in localStorage
# Sign up → Verify campaign saved
```

### 3. Test Commission Tracking
```bash
# Create test inquiry
# Mark as "Sale Completed"
# Enter sale amount: 1500
# Should auto-calculate: $150 commission (10%)
# Check analytics → Should show in totals
```

---

## 🔮 What's Tracked Automatically

### For Every Consumer:
- Source (organic, email, referral, etc.)
- Campaign name (if from email campaign)
- Full UTM parameters (optional)
- Sign-up date

### For Every Inquiry:
- Source (inherited from consumer's campaign)
- Status (Pending → Approved → Sale Completed)
- Sale amount (entered by admin)
- Commission amount (auto-calculated)
- Commission paid (yes/no)
- Notes (admin tracking)

### For Every Campaign:
- Subject line
- Message content
- Audience filter
- Send date
- Recipients count
- Sign-ups attributed
- Inquiries attributed
- Sales attributed (via analytics API)

---

## 💡 Key Benefits

1. **Full Attribution**
   - Know exactly which emails drive revenue
   - Track ROI per campaign
   - See what messaging works

2. **Commission Tracking**
   - Auto-calculate 10% commission
   - Track paid vs unpaid
   - See total revenue generated

3. **Campaign Management**
   - Send to specific states
   - Target consumers or ranchers
   - Branded, professional emails

4. **Data-Driven Decisions**
   - See which campaigns convert
   - Optimize messaging
   - Focus on high-ROI channels

5. **Manual Control**
   - You approve every inquiry
   - You mark sales complete
   - You stay in the loop

---

## 🚨 Important Notes

1. **Airtable Setup is Required**
   - System will fail without the new fields
   - Takes 5 minutes to add
   - See `AIRTABLE_CAMPAIGN_FIELDS.md`

2. **Commission Rate is Configurable**
   - Default: 10% (set in .env.local)
   - Change `NEXT_PUBLIC_COMMISSION_RATE=15` for 15%
   - Applies to all new sales

3. **Campaign Names**
   - Use lowercase with dashes
   - No spaces or special characters
   - Examples: "january-beef", "texas-promo", "merch-launch"

4. **Attribution is Automatic**
   - Once set up, requires no manual work
   - Campaign tracking happens automatically
   - Analytics update in real-time

---

## 📁 New Files Created

**Pages:**
- `app/admin/broadcast/page.tsx` - Send broadcast emails
- `app/admin/analytics/page.tsx` - View analytics dashboard

**API Routes:**
- `app/api/admin/broadcast/route.ts` - Send emails
- `app/api/admin/broadcast/stats/route.ts` - Get audience counts
- `app/api/admin/analytics/route.ts` - Aggregate analytics data

**Modified Files:**
- `app/page.tsx` - Campaign tracking on landing page
- `app/access/page.tsx` - Pass campaign to API
- `app/api/consumers/route.ts` - Store campaign in Airtable
- `app/api/inquiries/route.ts` - Inherit campaign from consumer
- `app/admin/page.tsx` - Navigation links
- `app/admin/inquiries/page.tsx` - Commission calculator
- `lib/email.ts` - Broadcast email function
- `lib/airtable.ts` - Added CAMPAIGNS table
- `env.example` - Added commission rate config

---

## 🎉 You're Ready!

Your platform now has:

✅ Campaign tracking (URL → localStorage → Airtable)
✅ Broadcast email system (compose → send → track)
✅ Commission tracking (sale → auto-calculate → track paid)
✅ Analytics dashboard (campaigns → ROI → revenue)
✅ Full attribution (email → sign-up → inquiry → sale)

**Next Steps:**

1. Add the Airtable fields (5 min)
2. Send yourself a test broadcast email
3. Click the link and sign up with test data
4. Check analytics to see attribution working
5. Start sending real campaigns! 🚀

---

**Questions or Issues?**

All the pieces are connected:
- Landing page captures campaigns
- Forms send campaigns to API
- API saves to Airtable
- Broadcast emails send with tracking
- Analytics aggregate everything
- You see complete ROI

**Happy selling!** 🥩📧💰


