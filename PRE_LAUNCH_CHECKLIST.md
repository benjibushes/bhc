# 🚀 Pre-Launch Checklist — DEPLOY READY

## ⏱️ Time Estimate: 45-60 minutes total

---

## ✅ CRITICAL (Must Do Before Launch) — 30 min

### 1. Airtable Fields Setup (10 min)

Go to your Airtable base and add these fields to each table:

**Consumers Table:**
✅ Fields already exist (from previous testing)
- Verify: `Source`, `Campaign`, `UTM Parameters`, `Full Name`, `Email`, `Phone`, `State`, `Interests`, `Status`, `Membership`, `Created`

**Ranchers Table:**
Add these NEW fields:
- `Call Scheduled` (Checkbox)
- `Ranch Tour Interested` (Checkbox)
- `Ranch Tour Availability` (Long text)

Verify existing:
- `Ranch Name`, `Operator Name`, `Email`, `Phone`, `State`, `Beef Types`, `Monthly Capacity`, `Certifications`, `Operation Details`, `Status`, `Certified`, `Created`

**Inquiries Table:**
Verify all fields exist (from previous testing):
- `Consumer Name`, `Consumer Email`, `Consumer Phone`, `Consumer State`
- `Rancher ID`, `Interest Type`, `Message`, `Timeline`
- `Status` (with options: Pending, Approved, Rejected, Sale Completed)
- `Sale Amount` (Number)
- `Commission Amount` (Number)
- `Commission Paid` (Checkbox)
- `Notes` (Long text)
- `Created`

---

### 2. Environment Variables Setup (5 min)

Update your `.env.local` file with production values:

```bash
# Airtable (REQUIRED)
AIRTABLE_API_KEY="your_airtable_api_key"
AIRTABLE_BASE_ID="your_airtable_base_id"

# Resend Email (REQUIRED)
RESEND_API_KEY="your_resend_api_key"
EMAIL_FROM="BuyHalfCow <support@buyhalfcow.com>"
ADMIN_EMAIL="support@buyhalfcow.com"

# Admin Access (REQUIRED)
ADMIN_PASSWORD="bhc-admin-2026"

# Commission Rate (REQUIRED)
NEXT_PUBLIC_COMMISSION_RATE="0.10"

# Calendly (REQUIRED for rancher onboarding)
NEXT_PUBLIC_CALENDLY_LINK="https://calendly.com/your-username/rancher-onboarding"
CALENDLY_LINK="https://calendly.com/your-username/rancher-onboarding"

# Optional (can add later)
# NEXT_PUBLIC_GA_ID="G-XXXXXXXXXX"
```

**Action Items:**
- [ ] Set up business email → Update `EMAIL_FROM` and `ADMIN_EMAIL`
- [ ] Set up Calendly → Update `NEXT_PUBLIC_CALENDLY_LINK` and `CALENDLY_LINK`
- [ ] Verify Airtable API key works
- [ ] Verify Resend API key works

---

### 3. Business Email Setup (10 min)

**Option A: Resend Inbound Forwarding (FASTEST)**
1. Log into Resend dashboard
2. Go to your domain → Inbound tab
3. Create route: `support@buyhalfcow.com` → forwards to your personal email
4. Update `.env.local` with `support@buyhalfcow.com`
5. Test by sending email to `support@buyhalfcow.com`

**Option B: Google Workspace (RECOMMENDED)**
Follow `BUSINESS_EMAIL_SETUP.md` for step-by-step instructions
- Takes 15 min
- Professional, scalable
- Can wait until post-launch if needed

**For Launch Week:** Use Resend inbound (5 min setup, free, works perfectly)

---

### 4. Calendly Setup (15 min)

**Required for rancher onboarding:**

1. Sign up: https://calendly.com/signup (use Google account)
2. Create event type:
   - Name: "Rancher Onboarding Call"
   - Duration: 30 minutes
   - Location: Phone call or Zoom
3. Set availability:
   - Your typical call hours (e.g., Mon-Fri 9am-5pm)
   - Buffer: 15 min between calls
   - Daily limit: 8 calls max
   - Date range: 3-4 weeks out
4. Configure reminders:
   - 24 hours before
   - 1 hour before
5. Copy your link: `https://calendly.com/your-username/rancher-onboarding`
6. Add to `.env.local`
7. Test: Book a test appointment, verify it works, cancel it

**See `CALENDLY_SETUP_GUIDE.md` for detailed walkthrough**

---

## 🧪 TESTING (Must Do) — 10 min

### 5. End-to-End Platform Test

Run through the entire user flow:

**Test 1: Consumer Application (3 min)**
- [ ] Go to `/access`
- [ ] Fill out form with test data
- [ ] Submit
- [ ] Check email received
- [ ] Check `/admin` → see application
- [ ] Approve application
- [ ] Verify status changes

**Test 2: Rancher Application (3 min)**
- [ ] Go to `/partner`
- [ ] Fill out rancher form
- [ ] Click Calendly link → verify it opens
- [ ] Check "I have scheduled my call" checkbox
- [ ] Submit
- [ ] Check email received
- [ ] Check `/admin` → Ranchers tab
- [ ] See "Call Scheduled" badge
- [ ] Approve rancher

**Test 3: Member Inquiry (2 min)**
- [ ] Log into `/member` (use test consumer credentials OR temporarily bypass paywall)
- [ ] Browse ranchers
- [ ] Submit inquiry to rancher
- [ ] Check `/admin/inquiries` → see pending inquiry
- [ ] Approve inquiry
- [ ] Verify rancher receives email

**Test 4: Commission Tracking (2 min)**
- [ ] Go to `/admin/inquiries`
- [ ] Update inquiry: Status "Sale Completed", Sale Amount `1500`
- [ ] Verify commission auto-calculates: $150
- [ ] Mark "Commission Paid"
- [ ] Verify status updates

---

## 📋 OPTIONAL (Recommended but Can Do Post-Launch) — 15 min

### 6. Service Plan Verification

**Airtable:**
- Free plan: 1,200 records/base
- With 20K launch email: Expect 500-1,000 consumer apps, 200 rancher apps, 50-100 inquiries
- **Total Week 1:** ~700-1,300 records (within free tier)
- **Action:** Monitor usage, upgrade if needed ($20/mo Pro = 50K records)

**Resend:**
- Free plan: 3,000 emails/month, 100/day
- With 20K launch: Need paid plan for broadcast email
- **Action:** Upgrade to $20/mo (50K emails/month) BEFORE launch email
- Or use Mailchimp/ConvertKit for broadcast, Resend for transactional

**Hosting (Vercel/Netlify):**
- Free tier handles 100K+ page views/month
- **Action:** Deploy on free tier, monitor bandwidth

---

### 7. Analytics Setup (Optional)

**Google Analytics 4:**
1. Create GA4 property: https://analytics.google.com
2. Get tracking ID: `G-XXXXXXXXXX`
3. Add to `.env.local`: `NEXT_PUBLIC_GA_ID="G-XXXXXXXXXX"`
4. Deploy

**Can skip for Week 1, add later.**

---

### 8. Domain & DNS Configuration

**If using custom domain:**
- [ ] Point domain to Vercel/Netlify
- [ ] Configure DNS (A record or CNAME)
- [ ] Add domain in hosting dashboard
- [ ] Wait for SSL certificate (auto-generated)
- [ ] Test: `https://buyhalfcow.com` loads

**If using Vercel subdomain:**
- [ ] Deploy to `your-project.vercel.app`
- [ ] Test it works
- [ ] Can add custom domain later

---

## 🚢 DEPLOYMENT — 10 min

### 9. Deploy to Production

**Option A: Deploy to Vercel (Recommended)**

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel

# Follow prompts:
# - Link to existing project? No
# - Project name: bhc
# - Directory: ./bhc
# - Build command: (leave default)
# - Output directory: (leave default)

# Add environment variables in Vercel dashboard:
# Settings → Environment Variables → Add all from .env.local

# Deploy to production
vercel --prod
```

**Vercel will give you a URL:** `https://bhc.vercel.app` or your custom domain

---

**Option B: Deploy to Netlify**

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Login
netlify login

# Deploy
netlify deploy --prod

# Add environment variables in Netlify dashboard:
# Site settings → Environment variables → Add all from .env.local
```

---

### 10. Post-Deployment Testing (5 min)

**Test on production URL:**
- [ ] Homepage loads
- [ ] `/access` loads and submits
- [ ] `/partner` loads and submits
- [ ] Emails send correctly (test with your email)
- [ ] `/admin/login` works
- [ ] Admin dashboard loads data from Airtable
- [ ] Calendly link works in rancher form

**If anything breaks:**
- Check Vercel/Netlify logs
- Verify environment variables are set
- Check Airtable API key
- Check Resend API key

---

## 📧 LAUNCH EMAIL PREP (If Sending to 20K)

### 11. Upgrade Resend or Use Broadcast Tool

**Problem:** Resend free tier = 100 emails/day, 3,000/month

**Solution A: Upgrade Resend**
- Go to Resend dashboard → Billing
- Upgrade to $20/mo (50K emails/month)
- Use `/admin/broadcast` page to send launch email

**Solution B: Use Mailchimp/ConvertKit**
- Import 20K email list
- Send broadcast email from there
- Use Resend for transactional emails (confirmations, approvals)
- **Recommended for launch week** (more reliable for bulk sends)

**Solution C: Segment Launch Email**
- Day 1: Send to 3,000 people (Resend free tier)
- Day 2: Send to next 3,000
- Etc.
- **Not ideal but works**

---

## 🎯 FINAL CHECKLIST BEFORE YOU HIT SEND

**Pre-Launch:**
- [ ] Airtable tables + fields configured
- [ ] `.env.local` fully updated (email, Calendly, API keys)
- [ ] Business email working (`support@buyhalfcow.com`)
- [ ] Calendly set up and tested
- [ ] Platform tested end-to-end (consumer, rancher, inquiry, commission)
- [ ] Deployed to production (Vercel/Netlify)
- [ ] Production site tested and working
- [ ] Email service upgraded or broadcast tool ready (for 20K send)

**On Launch Day:**
- [ ] Monitor `/admin` for new applications
- [ ] Respond to inquiries within 24 hours
- [ ] Check email inbox for direct questions
- [ ] Monitor Airtable for record limits
- [ ] Check Resend for email delivery issues

---

## 🚨 Common Issues & Fixes

**Issue: Emails not sending**
- Check Resend API key in production environment variables
- Verify domain is verified in Resend
- Check Resend dashboard for errors

**Issue: Airtable not connecting**
- Check API key in production environment variables
- Verify base ID is correct
- Check field names match exactly (case-sensitive)

**Issue: Admin login not working**
- Check `ADMIN_PASSWORD` in production environment variables
- Clear cookies and try again

**Issue: Calendly link not working**
- Check `NEXT_PUBLIC_CALENDLY_LINK` in production (must have `NEXT_PUBLIC_` prefix)
- Verify Calendly link is public (not draft)

**Issue: Member dashboard shows no ranchers**
- Approve at least one rancher in `/admin`
- Mark rancher as "Certified"
- Verify rancher's state matches test consumer's state

---

## 📊 Launch Week Monitoring

**Daily (5-10 min):**
- Check `/admin` → Consumer applications (approve/reject)
- Check `/admin` → Rancher applications (review)
- Check `/admin/inquiries` → Approve/reject requests
- Check email for direct questions

**Weekly:**
- Check Airtable record usage (Settings → Usage)
- Check Resend email usage (Dashboard → Usage)
- Review Calendly bookings (Dashboard → Events)

**Monthly:**
- Invoice ranchers for commissions
- Track sales in `/admin/inquiries`
- Review analytics (if configured)

---

## 🎉 YOU'RE READY TO LAUNCH!

Once this checklist is complete:
- ✅ Platform is production-ready
- ✅ All systems tested
- ✅ Email/Calendly configured
- ✅ Deployed and live
- ✅ Ready for 20K launch email

**Time to launch. 🚀**

---

## Quick Reference Documents:

- `BUSINESS_EMAIL_SETUP.md` — Business email options
- `CALENDLY_SETUP_GUIDE.md` — Calendly setup walkthrough
- `PAYMENT_TRACKING_GUIDE.md` — Commission tracking workflow
- `RANCHER_ONBOARDING_CALLS_GUIDE.md` — How to run onboarding calls
- `TESTING_COMPLETE_SUMMARY.md` — All tests passed
- `LAUNCH_READY_SUMMARY.md` — Full feature summary

---

**Questions? Issues?** Check the guides above or DM me.

**Let's gooooo. 🤠**
