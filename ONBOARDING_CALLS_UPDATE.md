# ✅ Rancher Onboarding Calls — IMPLEMENTED

## What I Just Added:

### 1. **Call Scheduling Field in Application**
- **File:** `app/partner/page.tsx`
- New required field: "Best times for a call (timezone, days, times)"
- Shows in highlighted box explaining the 20-30 minute onboarding call
- Saves to Airtable: `Call Availability`

---

### 2. **Scheduling Button in Confirmation Email**
- **File:** `lib/email.ts`
- Ranchers receive email with prominent "Schedule Your Onboarding Call" section
- Button links to Calendly (or falls back to email if not set up)
- Explains 4-step onboarding process including the call

---

### 3. **Call Tracking in Admin Dashboard**
- **File:** `app/admin/page.tsx`
- Shows call availability in rancher details (📞 highlighted box)
- New button: "Mark Call Scheduled" (turns green when clicked)
- Saves to Airtable: `Call Scheduled` checkbox
- Also displays ranch tour interest if checked

---

### 4. **Backend API Support**
- **Files:** `app/api/partners/route.ts`, `app/api/admin/ranchers/[id]/route.ts`
- Handles `Call Availability` field during application
- Handles `Call Scheduled` checkbox updates from admin

---

### 5. **Complete Onboarding Guide**
- **File:** `RANCHER_ONBOARDING_CALLS_GUIDE.md`
- Calendly setup (10 min, recommended)
- Call workflow (before, during, after)
- What to ask, what to look for (red flags vs green lights)
- How to discuss commission (exact script)
- Launch week scheduling tips (batch calls, limits)
- Email templates (approved/rejected follow-ups)
- FAQ answers for common rancher questions

---

## What YOU Need to Do:

### Required (5 minutes):

**Add 4 Airtable Fields to Ranchers Table:**

1. **`Call Availability`** (Long text)
   - Rancher's preferred call times

2. **`Call Scheduled`** (Checkbox)
   - Track which ranchers have calls scheduled

3. **`Ranch Tour Interested`** (Checkbox)
   - Track ranch tour interest

4. **`Ranch Tour Availability`** (Long text)
   - When they're available for ranch tour

---

### Optional but Recommended (10 minutes):

**Set Up Calendly:**

1. Sign up: https://calendly.com/signup (free)
2. Create "Rancher Onboarding Call" event (30 min)
3. Set your availability (e.g., Mon/Wed/Fri 9am-5pm)
4. Copy your link (e.g., `https://calendly.com/benji-bhc/onboarding`)
5. Add to `.env.local`:
   ```
   CALENDLY_LINK="https://calendly.com/your-username/onboarding"
   ```

**If you skip Calendly:** Emails will show a button that opens their email client to schedule manually. Works fine for launch week, but Calendly saves hours.

---

## How It Works:

### 1. Rancher Applies
- Fills out application including "Best times for a call"
- Submits application

### 2. Rancher Receives Email
- Confirmation email with 4-step process
- Prominent "Schedule Your Onboarding Call" button
- Links to Calendly or email

### 3. You See Application in Admin
- Go to `/admin` → Ranchers tab
- See call availability in highlighted box: 📞 "Weekday mornings 9am-12pm Central"
- See ranch tour interest if checked: 🤠 "Interested in ranch tour"

### 4. Rancher Books Call
- Either via Calendly or emails you
- You get notification

### 5. You Mark Call Scheduled
- Click "Mark Call Scheduled" button in admin dashboard
- Turns green: ✓ Call Scheduled
- Saves to Airtable

### 6. You Have the Call
- Follow the guide in `RANCHER_ONBOARDING_CALLS_GUIDE.md`
- Ask about their operation
- Explain The HERD network
- Discuss 10% commission
- Coordinate ranch tour if interested

### 7. Post-Call Follow-Up
- Approve or reject in admin dashboard
- Email them next steps (use templates in guide)
- Schedule ranch tour if applicable

---

## Launch Week Tips:

### You're Onboarding 200 Ranchers
That's a LOT of calls. Here's how to stay sane:

**Batch Your Calls:**
- Block specific hours (e.g., Mon/Wed/Fri 9am-1pm)
- Max 6-8 calls per day (3-4 hours with buffer)
- Leave room between calls for notes

**Spread Them Out:**
- Don't try to do all 200 calls in Week 1
- Week 1: 30-40 calls
- Week 2: 50-60 calls
- Week 3-4: Finish the rest

**Use Calendly Limits:**
- Max 8 bookings per day
- 15-minute buffer between calls
- Only allow bookings 2-3 weeks out

---

## Commission Discussion Script

Around 15 minutes into the call:

> "So here's how the business model works. I charge a 10% commission on sales I facilitate through introductions. You handle pricing and transactions directly with buyers, and when a sale closes, you just email me the details — buyer name and sale amount. I invoice you at the end of the month. Simple, transparent, and you keep 90% of every sale. Sound fair?"

**Most ranchers say yes immediately.** They're used to middlemen taking 20-40%. 10% is cheap.

---

## Files Modified/Created:

**Modified:**
- `app/partner/page.tsx` — Call scheduling field
- `app/api/partners/route.ts` — Backend for call availability
- `app/admin/page.tsx` — Call tracking button + display
- `app/api/admin/ranchers/[id]/route.ts` — Call scheduled checkbox
- `lib/email.ts` — Scheduling button in confirmation email

**Created:**
- `RANCHER_ONBOARDING_CALLS_GUIDE.md` — Complete guide with scripts, tips, templates
- `ONBOARDING_CALLS_UPDATE.md` — This file

---

## Quick Test:

1. Go to `/partner`
2. Fill out rancher application
3. Include call availability: "Weekdays 10am-2pm EST"
4. Submit
5. Check confirmation email (should have scheduling button)
6. Go to `/admin` → Ranchers
7. See call availability displayed
8. Click "Mark Call Scheduled"
9. Verify button turns green

---

## You're Ready to Start Scheduling Calls! 🤠

Add those 4 Airtable fields, optionally set up Calendly, and start booking calls.

**Questions?** Read `RANCHER_ONBOARDING_CALLS_GUIDE.md` — it's got everything.
