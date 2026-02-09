# Testing Guide - Email & Attribution System

## Quick Test Checklist

Run through these tests to verify everything works:

---

## 1. Campaign Tracking Test

### Test URL Parameters

```bash
# 1. Visit landing page with campaign parameter
http://localhost:3000/?campaign=test-jan-2026

# 2. Open browser console
localStorage.getItem('bhc_campaign')
# Should return: "test-jan-2026"

localStorage.getItem('bhc_source')
# Should return: "email"

# 3. Navigate to access page
http://localhost:3000/access

# 4. Fill out form and submit

# 5. Check Airtable → Consumers table → Latest record should have:
#    - Source: "email"
#    - Campaign: "test-jan-2026"
```

**Expected Result:** ✅ Campaign tracked from URL → localStorage → Airtable

---

## 2. Broadcast Email Test

### Send Test Email

```bash
# 1. Log into admin
http://localhost:3000/admin/login
# Enter your ADMIN_PASSWORD

# 2. Click "📧 Send Broadcast Email"
http://localhost:3000/admin/broadcast

# 3. Fill out form:
Campaign Name: test-broadcast-2026
Subject: Testing BuyHalfCow Email System
Message: This is a test email. If you receive this, the system works!
Audience: All Consumers
Include CTA: Yes
CTA Text: Test Link
CTA Link: /member

# 4. Check recipient count (should show number of consumers)

# 5. Click "Send"

# 6. Check your email inbox (if you're a consumer in Airtable)
```

**Expected Result:** ✅ Email received with branded template, CTA button, campaign name in footer

### Test Campaign Link

```bash
# 1. Click CTA button in email

# 2. Should redirect to:
http://localhost:3000/member?campaign=test-broadcast-2026

# 3. Check localStorage:
localStorage.getItem('bhc_campaign')
# Should return: "test-broadcast-2026"
```

**Expected Result:** ✅ Campaign tracked from email click

---

## 3. Inquiry Attribution Test

### Create Test Inquiry

```bash
# 1. Go to member area (fake auth for now)
http://localhost:3000/member

# 2. Select a state with ranchers

# 3. Click "Contact Rancher" on any rancher

# 4. Fill out inquiry form:
Interest: Half Cow
Message: Test inquiry from campaign test-broadcast-2026

# 5. Submit form

# 6. Check admin email for inquiry alert

# 7. Check Airtable → Inquiries table → Latest record should have:
#    - Source: "test-broadcast-2026" (inherited from consumer)
#    - Status: "Pending"
```

**Expected Result:** ✅ Inquiry created with campaign attribution

---

## 4. Commission Tracking Test

### Mark Sale as Complete

```bash
# 1. Go to inquiry management
http://localhost:3000/admin/inquiries

# 2. Find the test inquiry

# 3. Click "Approve" if pending
# (Rancher will receive email)

# 4. Click "Edit" on the inquiry

# 5. Change:
Status: Sale Completed
Sale Amount: 1500
Notes: Test sale for commission tracking

# 6. Click "Save"

# 7. Verify:
#    - Commission Amount auto-calculated: $150 (10% of $1,500)
#    - Shows in "Completed Sales" count
#    - Shows in "Total Revenue" ($1,500)
#    - Shows in "Total Commission" ($150)
```

**Expected Result:** ✅ Commission auto-calculated and tracked

---

## 5. Analytics Dashboard Test

### View Campaign Performance

```bash
# 1. Go to analytics
http://localhost:3000/admin/analytics

# 2. Check Overview Cards:
#    - Total Consumers: X
#    - Total Inquiries: X
#    - Sales Closed: 1 (from test)
#    - Total Revenue: $1,500 (from test)
#    - Your Commission: $150 (from test)
#    - Conversion Rate: (inquiries / sales)

# 3. Check Campaign Performance Table:
#    - Should show "test-broadcast-2026" row
#    - Emails sent: X
#    - Sign-ups: (consumers with this campaign)
#    - Inquiries: 1 (from test)
#    - Sales: 1 (from test)
#    - Revenue: $1,500
#    - Commission: $150
#    - ROI: $X per email

# 4. Check Recent Activity Feed:
#    - Should show test sign-up (if campaign matched)
#    - Should show test inquiry
#    - Should show test sale with $150 commission
```

**Expected Result:** ✅ All attribution data visible in analytics

---

## 6. Full Funnel Test (End-to-End)

### Complete Attribution Flow

```bash
# Step 1: Send broadcast email to yourself
# (Use your personal email as a test consumer in Airtable)

# Step 2: Receive email, click CTA link

# Step 3: Land on /access?campaign=your-campaign-name

# Step 4: Fill out access form and submit

# Step 5: Check Airtable → Verify consumer has campaign

# Step 6: Go to /member (fake login)

# Step 7: Submit inquiry to a rancher

# Step 8: Admin approves inquiry

# Step 9: Rancher receives email (check rancher's email)

# Step 10: Admin marks sale complete with amount

# Step 11: Check analytics → Full attribution shown
```

**Expected Result:** ✅ Complete funnel tracked from email → sign-up → inquiry → sale → commission

---

## 7. Edge Cases to Test

### Test Without Campaign

```bash
# 1. Visit landing page without parameters
http://localhost:3000/

# 2. Sign up for access

# 3. Check Airtable → Consumer should have:
#    - Source: "organic"
#    - Campaign: (empty)
```

**Expected Result:** ✅ Works without campaign, defaults to "organic"

### Test Different Sources

```bash
# 1. Visit with source parameter
http://localhost:3000/?source=referral

# 2. Sign up

# 3. Check Airtable → Consumer should have:
#    - Source: "referral"
#    - Campaign: (empty)
```

**Expected Result:** ✅ Source parameter captured

### Test State-Based Broadcast

```bash
# 1. Go to /admin/broadcast

# 2. Select audience: "Consumers by State"

# 3. Select states: TX, CA

# 4. Check recipient count
# Should only count consumers in TX and CA

# 5. Send email

# 6. Verify only TX and CA consumers received it
```

**Expected Result:** ✅ State filtering works

---

## 8. Commission Rate Test

### Change Commission Rate

```bash
# 1. Edit .env.local:
NEXT_PUBLIC_COMMISSION_RATE=15

# 2. Restart dev server

# 3. Create test inquiry

# 4. Mark as sale with amount: $1,000

# 5. Verify commission: $150 (15% of $1,000)
```

**Expected Result:** ✅ Commission rate configurable

---

## 9. Data Validation Tests

### Verify Required Fields

```bash
# Test Broadcast Email:
# - Try sending without campaign name → Should show error
# - Try sending without subject → Should show error
# - Try sending with 0 recipients → Should show error

# Test Inquiry:
# - Submit without message → Should validate

# Test Commission:
# - Enter invalid sale amount → Should handle gracefully
```

**Expected Result:** ✅ Form validation works

---

## 10. Performance Test

### Large Dataset

```bash
# 1. Add 100+ test consumers to Airtable

# 2. Go to /admin/broadcast

# 3. Select "All Consumers"

# 4. Check recipient count loads quickly

# 5. Send broadcast (or cancel)

# 6. Go to /admin/analytics

# 7. Check dashboard loads with large dataset
```

**Expected Result:** ✅ System handles scale

---

## Test Results Checklist

After running all tests, you should be able to check these boxes:

- [ ] Campaign tracking captures URL parameters
- [ ] Campaign data persists in localStorage
- [ ] Consumer signup stores campaign in Airtable
- [ ] Broadcast emails send successfully
- [ ] Email template is branded correctly
- [ ] CTA links include campaign tracking
- [ ] Inquiries inherit campaign from consumer
- [ ] Commission auto-calculates at 10% (or configured rate)
- [ ] Analytics dashboard shows campaign performance
- [ ] Full attribution works (email → sale)
- [ ] Recent activity feed updates
- [ ] State-based audience filtering works
- [ ] System handles missing campaigns gracefully
- [ ] Admin authentication works
- [ ] All API routes respond correctly

---

## Troubleshooting

### Campaign Not Tracked

**Problem:** Consumer signup doesn't have campaign

**Check:**
1. Did you visit the page with `?campaign=xyz`?
2. Open console → Check `localStorage.getItem('bhc_campaign')`
3. Did you submit the form on the same session?
4. Check browser privacy settings (localStorage enabled?)

### Email Not Sending

**Problem:** Broadcast email fails

**Check:**
1. Is `RESEND_API_KEY` set in `.env.local`?
2. Is your domain verified in Resend?
3. Check server logs for error messages
4. Test with your own email first

### Commission Not Calculating

**Problem:** Commission shows $0 or wrong amount

**Check:**
1. Is `NEXT_PUBLIC_COMMISSION_RATE` set?
2. Did you enter a valid sale amount?
3. Refresh the page after saving
4. Check console for errors

### Analytics Not Showing Campaign

**Problem:** Campaign table is empty

**Check:**
1. Did you create the Campaigns table in Airtable?
2. Did you send at least one broadcast email?
3. Do consumers have the campaign field populated?
4. Check API logs for errors

---

## Quick Smoke Test (2 minutes)

```bash
# 1. Visit landing with campaign
http://localhost:3000/?campaign=quick-test

# 2. Sign up for access

# 3. Check Airtable → Consumer has campaign ✓

# 4. Send broadcast to yourself

# 5. Receive email ✓

# 6. Create inquiry

# 7. Mark as sale with $1,000

# 8. Check analytics → $100 commission shown ✓
```

**If all 3 checks pass: System is working!** ✅

---

## Support

If tests fail:

1. Check console for JavaScript errors
2. Check server logs for API errors
3. Verify Airtable fields are set up correctly
4. Verify all environment variables are set
5. Try `npm run build` to catch TypeScript errors
6. Clear localStorage and try again

**Everything tested and working?** 

🎉 **You're ready to launch!** 🚀


