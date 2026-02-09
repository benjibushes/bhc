# BuyHalfCow — Live Testing Checklist

**Follow this guide step-by-step to verify you can capture all leads and run the business.**

---

## ✅ **PRE-TEST: Verify Setup**

Before testing, make sure:

- [ ] Airtable is set up with all 6 tables (Consumers, Ranchers, Brands, Land Deals, Inquiries, News)
- [ ] Added campaign fields to Airtable:
  - Consumers: `Source`, `Campaign`, `UTM Parameters`
  - Inquiries: `Source`
  - Created `Campaigns` table
- [ ] `.env.local` file has all keys:
  - `AIRTABLE_API_KEY`
  - `AIRTABLE_BASE_ID`
  - `RESEND_API_KEY`
  - `EMAIL_FROM`
  - `ADMIN_EMAIL`
  - `ADMIN_PASSWORD`
  - `NEXT_PUBLIC_COMMISSION_RATE`
- [ ] Dev server is running: `npm run dev`
- [ ] Resend domain is verified

---

## 🧪 **TEST 1: Consumer Application (Lead Capture)**

**What You're Testing:** Can consumers apply and can you track them?

### Steps:
1. **Open:** http://localhost:3000
2. **Click:** "I Want Beef" card (🥩)
3. **Fill out form:**
   - Full Name: Test Consumer
   - Email: your.email+test@gmail.com
   - Phone: 555-1234
   - State: Texas
   - Interests: Check "Beef"
4. **Click:** "Apply for Access"

### Expected Results:
- ✅ Form submits successfully
- ✅ See "Application Received" confirmation
- ✅ **Check Airtable** → Consumers table → See your entry
- ✅ **Check Email** → Receive confirmation email
- ✅ **Check Admin Email** → Receive application alert

**Did all 3 emails arrive? Check spam if not!**

---

## 🧪 **TEST 2: Rancher Application (Partner Capture)**

**What You're Testing:** Can ranchers apply and can you review them?

### Steps:
1. **Go to:** http://localhost:3000
2. **Click:** "I Sell Beef" card (🤠)
3. **Fill out rancher form:**
   - Ranch Name: Test Ranch
   - Operator Name: John Doe
   - Email: your.email+rancher@gmail.com
   - Phone: 555-5678
   - State: Montana
   - Beef Types: Grass-fed, Organic
   - Monthly Capacity: 25
   - Check commission agreement
4. **Submit**

### Expected Results:
- ✅ Form submits successfully
- ✅ Confirmation message
- ✅ **Check Airtable** → Ranchers table → See entry
- ✅ **Check Email** → Rancher gets confirmation
- ✅ **Check Admin Email** → You get application alert

---

## 🧪 **TEST 3: Admin Dashboard (Management)**

**What You're Testing:** Can you review and approve applications?

### Steps:
1. **Go to:** http://localhost:3000/admin
2. **If redirected to login:**
   - Enter your `ADMIN_PASSWORD`
   - Should redirect to admin dashboard
3. **Verify:**
   - ✅ See test consumer in Consumers tab
   - ✅ See test rancher in Ranchers tab
   - ✅ Stats cards show counts
4. **Approve the consumer:**
   - Find test consumer
   - Change Status to "Approved"
   - Change Membership to "Active"
5. **Certify the rancher:**
   - Click Ranchers tab
   - Find test rancher
   - Click "Not Certified" button to mark as "CERTIFIED"

### Expected Results:
- ✅ Consumer status updated in Airtable
- ✅ Rancher marked as certified in Airtable
- ✅ Changes persist after page refresh

---

## 🧪 **TEST 4: Campaign Tracking (Attribution)**

**What You're Testing:** Can you track where leads come from?

### Steps:
1. **Open a new browser window/incognito**
2. **Visit:** http://localhost:3000/?campaign=test-jan-2026
3. **Press F12 → Console tab**
4. **Type:** `localStorage.getItem('bhc_campaign')`
   - Should show: "test-jan-2026"
5. **Click:** "I Want Beef"
6. **Fill out form and submit**
7. **Check Airtable** → Consumers table → Latest entry should have:
   - **Source:** "email"
   - **Campaign:** "test-jan-2026"

### Expected Results:
- ✅ Campaign parameter captured from URL
- ✅ Stored in localStorage
- ✅ Saved to Airtable with consumer record

**This proves email attribution works!**

---

## 🧪 **TEST 5: Member Inquiry System (Lead Flow)**

**What You're Testing:** Can members contact ranchers? Do you approve inquiries?

### Steps:
1. **Go to:** http://localhost:3000/member
2. **Scroll to ranchers section**
3. **Click:** "Contact This Rancher" on any rancher
4. **Fill out inquiry modal:**
   - Name: Test Member
   - Email: your.email+member@gmail.com
   - Phone: 555-9999
   - Interest: Half Cow
   - Message: "I'm interested in purchasing a half cow for my family"
5. **Click:** "Send Inquiry"

### Expected Results:
- ✅ Form submits successfully
- ✅ See "Inquiry Sent!" confirmation
- ✅ **Check Admin Email** → Receive inquiry alert saying "REQUIRES APPROVAL"
- ✅ **Check Rancher Email** → Should NOT receive email yet (pending your approval)
- ✅ **Check Airtable** → Inquiries table → See entry with Status: "Pending"

---

## 🧪 **TEST 6: Inquiry Gatekeeping (Your Control)**

**What You're Testing:** Does the gatekeeping work? Can you control who gets through?

### Steps:
1. **Go to:** http://localhost:3000/admin/inquiries
2. **Find the test inquiry** (should have yellow "PENDING" badge)
3. **Verify:**
   - Shows consumer name, email, phone
   - Shows rancher name, email
   - Shows full message
   - Has green "✓ Approve" button
   - Has red "✗ Reject" button
4. **Click:** "✓ Approve"

### Expected Results:
- ✅ Alert: "Inquiry approved! Rancher has been notified."
- ✅ Status changes to "Approved" (green badge)
- ✅ **Check Rancher Email** → NOW receives the inquiry with consumer's contact info
- ✅ Rancher email has "Reply-To" set to consumer's email (direct connection)

**This proves you control every connection!**

---

## 🧪 **TEST 7: Broadcast Email System (Marketing)**

**What You're Testing:** Can you send blast emails to your audience?

### Steps:
1. **Go to:** http://localhost:3000/admin/broadcast
2. **Fill out form:**
   - Campaign Name: `test-broadcast`
   - Subject: "Testing BuyHalfCow Email System"
   - Message: "This is a test broadcast email. If you receive this, everything works!"
   - Audience: "All Consumers"
   - Include CTA: Yes
   - CTA Text: "View Ranchers"
   - CTA Link: "/member"
3. **Check recipient count** (should match number of consumers in Airtable)
4. **Click:** "Send to X Recipients"
5. **Confirm** the send

### Expected Results:
- ✅ Success message appears
- ✅ Shows how many emails were sent
- ✅ **Check your email** (if you're a consumer) → Receive broadcast
- ✅ **Check Airtable** → Campaigns table → See entry for "test-broadcast"
- ✅ **Click CTA in email** → Opens /member?campaign=test-broadcast

**This proves you can market to your audience!**

---

## 🧪 **TEST 8: Commission Tracking (Revenue)**

**What You're Testing:** Can you track sales and calculate commissions?

### Steps:
1. **Go to:** http://localhost:3000/admin/inquiries
2. **Find an approved inquiry** (or approve the test one)
3. **Click:** "Edit"
4. **Change:**
   - Status: "Sale Completed"
   - Sale Amount: 1500
   - Notes: "Test sale for commission tracking"
5. **Click:** "Save"

### Expected Results:
- ✅ Commission auto-calculated: **$150** (10% of $1,500)
- ✅ Appears in "Completed Sales" count
- ✅ Appears in "Total Commission" ($150)
- ✅ **Check Airtable** → Inquiries → Sale Amount: $1,500, Commission Amount: $150

**This proves you can track revenue!**

---

## 🧪 **TEST 9: Analytics Dashboard (ROI)**

**What You're Testing:** Can you see complete attribution and ROI?

### Steps:
1. **Go to:** http://localhost:3000/admin/analytics
2. **Review Overview Cards:**
   - Total Consumers (should match your test data)
   - Total Inquiries
   - Sales Closed (1 from test)
   - Total Revenue ($1,500 from test)
   - Your Commission ($150 from test)
   - Conversion Rate

3. **Review Campaign Performance Table:**
   - Should show "test-broadcast" row (if you sent one)
   - Shows emails sent, sign-ups, inquiries, sales
   - Shows revenue and commission attributed
   - Shows ROI per email

4. **Review Recent Activity:**
   - Shows test sign-up (with campaign if tracked)
   - Shows test inquiry (with source)
   - Shows test sale (with $150 commission)

### Expected Results:
- ✅ All data is aggregated correctly
- ✅ Campaign attribution is working
- ✅ Revenue totals are accurate
- ✅ You can see ROI per campaign

**This proves you have full business intelligence!**

---

## 🧪 **TEST 10: State-Based Filtering (Targeting)**

**What You're Testing:** Can you send emails to specific states only?

### Steps:
1. **Add test consumers in multiple states to Airtable:**
   - 1 in Texas
   - 1 in California
   - 1 in Montana
2. **Go to:** http://localhost:3000/admin/broadcast
3. **Select:** "Consumers by State"
4. **Check only:** TX and CA
5. **Check recipient count**
   - Should show 2 (TX + CA only, not MT)

### Expected Results:
- ✅ Recipient count matches selected states
- ✅ Only consumers in those states would receive email

**This proves you can target by region!**

---

## ✅ **Final System Verification**

After all tests, verify:

### Lead Capture:
- [ ] Consumer applications save to Airtable
- [ ] Rancher applications save to Airtable
- [ ] Brand & land deal applications work
- [ ] Email confirmations send automatically
- [ ] Admin alerts arrive for every application

### Gatekeeping:
- [ ] Admin login works (password protection)
- [ ] Inquiries start as "Pending" (require approval)
- [ ] Ranchers only get contact info AFTER you approve
- [ ] You can reject inquiries (silent, no rancher contact)

### Attribution:
- [ ] Landing page captures campaign parameters
- [ ] Consumer records store Source + Campaign
- [ ] Inquiries inherit campaign from consumers
- [ ] Full funnel tracking works (email → sign-up → inquiry → sale)

### Revenue Tracking:
- [ ] Can mark inquiries as "Sale Completed"
- [ ] Sale amount can be entered
- [ ] Commission auto-calculates at configured rate
- [ ] Commissions marked paid/unpaid
- [ ] Totals aggregate correctly

### Marketing:
- [ ] Can compose broadcast emails
- [ ] Can select audience (all, by state, ranchers)
- [ ] Emails send with branded template
- [ ] Campaign links include tracking parameters
- [ ] Campaigns log to Airtable

### Analytics:
- [ ] Dashboard shows total metrics
- [ ] Campaign performance table shows attribution
- [ ] Recent activity feed updates
- [ ] ROI calculations are correct

---

## 🎯 **Business Operations Test**

**Scenario: Real-world workflow**

1. **You certify a new rancher in Texas**
   - Add/approve in admin → Mark as certified

2. **You send email to Texas consumers**
   - Broadcast: "New Texas rancher with grass-fed beef!"
   - Campaign: "texas-grass-fed-jan"
   - Audience: Consumers in TX

3. **Track who clicks and signs up**
   - Analytics shows sign-ups from "texas-grass-fed-jan"

4. **Approve inquiries to that rancher**
   - See inquiries in admin
   - Check Source: "texas-grass-fed-jan"
   - Approve → Rancher gets lead

5. **Rancher confirms sale**
   - Rancher emails you: "Sold $1,400 half cow"
   - You mark inquiry as sale
   - Commission: $140

6. **See complete attribution**
   - Analytics shows "texas-grass-fed-jan" campaign:
   - Email → Sign-up → Inquiry → Sale → $140 commission
   - **You know that email generated that $140!**

---

## 🚨 **Critical System Checks**

### 1. Nothing Bypasses You
- [ ] All consumer applications require your approval
- [ ] All rancher applications require your certification
- [ ] **All inquiries require your approval** (critical!)
- [ ] Ranchers only get leads you approve

### 2. Full Lead Tracking
- [ ] You can see every application
- [ ] You can see every inquiry
- [ ] You can see inquiry status (pending/approved/sale)
- [ ] You can see which campaigns drive activity

### 3. Commission Accountability
- [ ] Every inquiry has a unique ID
- [ ] You can track sale amounts
- [ ] Commissions auto-calculate
- [ ] You can mark as paid/unpaid
- [ ] Full audit trail in Airtable

### 4. Marketing Attribution
- [ ] Email campaigns track clicks
- [ ] Sign-ups track campaign source
- [ ] Inquiries track campaign source
- [ ] Sales track campaign source
- [ ] ROI is calculated per campaign

---

## 🎊 **If All Tests Pass:**

**✅ YOU'RE READY TO LAUNCH!**

You can now:
1. **Capture leads** (consumers, ranchers, brands, land)
2. **Send marketing emails** (broadcast to audience)
3. **Approve connections** (inquiry gatekeeping)
4. **Track commissions** (sale → auto-calculate)
5. **Measure ROI** (email → revenue attribution)
6. **Run your business** (full CRM + analytics)

---

## 🚀 **Next Steps:**

### If Tests Pass:
1. Add admin password to .env.local
2. Set up Resend API key
3. Deploy to Vercel
4. Start onboarding real ranchers
5. Send your first campaign!

### If Tests Fail:
Tell me:
- Which test failed?
- What error message did you see?
- What should have happened vs what did happen?

I'll help you troubleshoot immediately.

---

## 📞 **Questions to Confirm:**

Before we declare victory, answer these:

1. **Did the consumer form submission work?**
   - Data in Airtable? ✅ or ❌
   - Email received? ✅ or ❌

2. **Did the inquiry gatekeeping work?**
   - Inquiry started as "Pending"? ✅ or ❌
   - Rancher didn't get email until you approved? ✅ or ❌

3. **Did the commission calculator work?**
   - Auto-calculated 10% correctly? ✅ or ❌

4. **Can you see everything in one place?**
   - Admin dashboard shows all data? ✅ or ❌

---

**Start testing and let me know what happens!** 🧪

I'll be here to troubleshoot anything that doesn't work.

**Your goal:** All ✅ checks = ready to launch!
