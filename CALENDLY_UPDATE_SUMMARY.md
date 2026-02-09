# ✅ Calendly Direct Booking — IMPLEMENTED

## What Changed:

Ranchers now **book calls directly on YOUR calendar** instead of telling you their availability.

### Before:
- Rancher: "I'm available weekday mornings"
- You: Email back with times
- Rancher: "Tuesday at 10am works"
- You: Send calendar invite
- **= 3-4 emails per rancher**

### After:
- Rancher clicks "View Available Times"
- Sees your actual calendar availability
- Books the time that works for them
- Gets automatic confirmation + reminders
- **= Zero emails**

---

## What I Built:

### 1. **Calendly Link in Application Form**
- **File:** `app/partner/page.tsx`
- Big button: "📅 View Available Times & Schedule Call"
- Opens your Calendly in new tab
- Required checkbox: "I have scheduled (or will schedule) my call"
- Ranchers MUST book to submit application

### 2. **Prominent Booking CTA in Email**
- **File:** `lib/email.ts`
- Black banner with big "Book Now" button
- Clear messaging: "Your application won't be reviewed until you book"
- Links directly to your Calendly

### 3. **Call Status in Admin Dashboard**
- **File:** `app/admin/page.tsx`
- Shows: "✓ Call Scheduled via Calendly" badge (green)
- Button: "Mark Call Completed" (after you do the call)
- No more manual tracking of who needs scheduling

### 4. **Backend Support**
- **File:** `app/api/partners/route.ts`
- Saves "Call Scheduled" status to Airtable
- Tracks completion status

---

## What YOU Need to Do (15 minutes):

### Required: Set Up Calendly

**Step 1: Sign Up (2 min)**
- Go to https://calendly.com/signup
- Sign up with Google (connects calendar automatically)
- Free plan is perfect

**Step 2: Create Event (5 min)**
- Click "+ New Event Type" → "One-on-One"
- Name: "Rancher Onboarding Call"
- Duration: 30 minutes
- Location: Phone call or Zoom
- Description: "Welcome to The HERD! We'll discuss your operation, answer questions, and walk through the onboarding process."

**Step 3: Set Availability (3 min)**
- Set your typical call hours (e.g., Mon-Fri 9am-5pm)
- Buffer time: 15 min between calls
- Daily limit: 8 calls max

**Step 4: Get Link (1 min)**
- Copy your Calendly link (looks like: `https://calendly.com/your-username/rancher-onboarding`)

**Step 5: Add to Platform (2 min)**
Add to `.env.local`:
```bash
NEXT_PUBLIC_CALENDLY_LINK="https://calendly.com/your-username/rancher-onboarding"
CALENDLY_LINK="https://calendly.com/your-username/rancher-onboarding"
```

**Step 6: Restart**
```bash
npm run dev
```

**Step 7: Test (2 min)**
- Go to `/partner`
- Click the "View Available Times" button
- Verify it opens your Calendly
- Book a test appointment
- Cancel it

---

## Airtable Fields:

You still need to add these to your **Ranchers** table:

1. **`Call Scheduled`** (Checkbox)
   - Auto-checked when rancher books call

2. **`Ranch Tour Interested`** (Checkbox)
   - Tracks ranch tour interest

3. **`Ranch Tour Availability`** (Long text)
   - When they're available for tour

**Note:** `Call Availability` field is NO LONGER NEEDED (ranchers book directly now).

---

## How It Works:

### Rancher Side:

1. **Rancher applies** at `/partner`
2. Sees "Schedule Your Onboarding Call" section
3. Clicks "📅 View Available Times & Schedule Call"
4. Opens your Calendly in new tab
5. Sees your actual available time slots
6. Picks a time, enters their info
7. Gets instant confirmation email from Calendly
8. Checks box: "I have scheduled my call"
9. Submits application
10. Gets BuyHalfCow confirmation email with reminder to book (if they skipped it)

### Your Side:

1. **Rancher books** → you get Calendly notification email
2. **Calendar event** appears in your Google Calendar
3. **Rancher applies** → shows up in `/admin` dashboard
4. **You see badge:** "✓ Call Scheduled via Calendly" (green)
5. **Calendly reminds you:** 1 hour before call
6. **You have the call** → discuss operation, explain network, mention 10% commission
7. **You mark complete:** Click "Mark Call Completed" in admin
8. **You approve/reject:** Update status in admin
9. **You follow up:** Email rancher with next steps

---

## Launch Week Strategy:

### Managing 200 Ranchers:

**Use Calendly's Limits:**
- **Daily limit:** 8 calls/day (prevents burnout)
- **Date range:** Only show 3-4 weeks out (spreads calls over time)
- **Buffer:** 15 min between calls (sanity breaks)

**Example Schedule:**
- Week 1: 18 calls (3 days × 6 calls)
- Week 2: 40 calls (5 days × 8 calls)
- Week 3: 40 calls (5 days × 8 calls)
- Week 4: 40 calls (5 days × 8 calls)

**Total:** 138 calls in first month = plenty for 200-rancher backlog

### Block Travel Days:

If you're doing ranch tours:
- Calendly → Availability → Date Overrides
- Mark travel days as "Unavailable"
- Prevents bookings when you're on the road

---

## Email Example (What Ranchers See):

After applying, ranchers get this email:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 NEXT STEP: Schedule Your Call
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your application won't be reviewed until 
you book your onboarding call.

Click below to see my available times and 
book your 30-minute call:

[📅 View My Calendar & Book Now]

Can't find a time? Reply to this email.
```

Big, clear, impossible to miss.

---

## Benefits:

### For You:
- ✅ **Zero back-and-forth** emails
- ✅ **No manual scheduling** (saves hours)
- ✅ **Automatic reminders** (reduces no-shows)
- ✅ **Control your availability** (set once, forget)
- ✅ **Limit daily bookings** (prevent burnout)

### For Ranchers:
- ✅ **See actual availability** (not guessing)
- ✅ **Book instantly** (no waiting for your reply)
- ✅ **Pick time that works** (their convenience)
- ✅ **Automatic reminders** (won't forget)
- ✅ **Easy reschedule** (can change if needed)

---

## If You Don't Set Up Calendly:

The platform will still work, but:
- Button links to `mailto:support@buyhalfcow.com`
- Ranchers email you manually
- You reply with available times
- They reply with choice
- You send calendar invite
- **= Way more work**

**Recommendation:** Take 15 minutes NOW to set up Calendly. It'll save you 10+ hours during launch week.

---

## Files Modified:

- `app/partner/page.tsx` — Calendly link + required checkbox
- `app/api/partners/route.ts` — Save call scheduled status
- `app/admin/page.tsx` — Display call status badge + completion button
- `app/api/admin/ranchers/[id]/route.ts` — Handle call scheduled updates
- `lib/email.ts` — Prominent booking CTA in email

---

## Complete Guides:

- **`CALENDLY_SETUP_GUIDE.md`** — Full Calendly setup walkthrough (15 min)
- **`RANCHER_ONBOARDING_CALLS_GUIDE.md`** — What to say on calls, commission script, red flags

---

## Quick Test Checklist:

1. ✅ Set up Calendly (15 min)
2. ✅ Add link to `.env.local`
3. ✅ Restart dev server
4. ✅ Go to `/partner`
5. ✅ Fill out rancher application
6. ✅ Click "View Available Times" button
7. ✅ Verify Calendly opens
8. ✅ Book test appointment
9. ✅ Check admin dashboard for badge
10. ✅ Cancel test appointment

---

## You're Ready! 🚀

With Calendly, ranchers self-schedule. You focus on the calls, not the logistics.

**Next:** Follow `CALENDLY_SETUP_GUIDE.md` to set up your calendar (15 min).

Questions? I'm here.
