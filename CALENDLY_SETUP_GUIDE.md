# Calendly Setup for Rancher Onboarding (REQUIRED)

## What Changed:

The platform now requires ranchers to **book calls directly on YOUR calendar** using Calendly.

### Old Way (Manual):
- Rancher tells you their availability
- You reach out to schedule
- Back-and-forth emails

### New Way (Automatic):
- Rancher sees your available times
- Rancher books directly on your calendar
- Automatic confirmations + reminders
- **Zero back-and-forth**

---

## Quick Setup (15 minutes)

### Step 1: Sign Up for Calendly (Free)

1. Go to: **https://calendly.com/signup**
2. Click "Sign up with Google" (easiest — auto-connects your Google Calendar)
3. Follow the prompts
4. Free plan is perfect for now

---

### Step 2: Create Your Event Type

1. In Calendly dashboard, click **"+ New Event Type"**
2. Select **"One-on-One"**
3. Configure:

**Event Name:**
```
Rancher Onboarding Call
```

**Duration:**
```
30 minutes
```

**Location:**
- **Phone Call** (your choice) — you'll call them
- OR **Zoom** (Calendly can generate Zoom links automatically)
- OR **Google Meet** (if using Google Calendar)

**Description / Instructions:**
```
Welcome to The HERD! 

This 30-minute call is a casual conversation where we'll:
• Discuss your ranch operation and beef practices
• Answer your questions about The HERD network
• Walk through the onboarding and certification process
• Coordinate ranch tour timing (if applicable)

No prep needed — just come ready to chat about your ranch!

Looking forward to connecting,
— Benji
```

**What questions should invitees answer?**
Add this custom question:
- "What's your biggest question about joining The HERD?" (Optional, 1-2 sentences)

---

### Step 3: Set Your Availability

1. Click **"Availability"** tab in the event
2. Set your typical call hours:

**Example:**
```
Monday: 9:00 AM - 5:00 PM Central
Tuesday: 9:00 AM - 5:00 PM Central
Wednesday: 9:00 AM - 5:00 PM Central
Thursday: 9:00 AM - 5:00 PM Central
Friday: 9:00 AM - 3:00 PM Central
Saturday: OFF
Sunday: OFF
```

**Important Settings:**
- **Start time increments:** 30 minutes (prevents awkward 10am, 10:15am slots)
- **Buffer time:** 15 minutes between meetings (gives you breathing room)
- **Minimum scheduling notice:** 24 hours (prevents last-minute bookings)
- **Date range:** 4 weeks into the future (manageable for launch week)

---

### Step 4: Configure Notifications & Reminders

1. Go to **"Notifications and Cancellation Policy"**

**Email Notifications (to you):**
- ✅ Event scheduled
- ✅ Event canceled/rescheduled
- ✅ 1 hour before event

**Invitee Notifications (to rancher):**
- ✅ Confirmation email (immediately after booking)
- ✅ Email reminder 24 hours before
- ✅ Email reminder 1 hour before

**Cancellation Policy:**
```
At least 24 hours notice required for cancellations or reschedules.
```

---

### Step 5: Customize Confirmation Page

After a rancher books, they see a confirmation page. Customize it:

**Confirmation Page Message:**
```
✅ Your call is booked!

Check your email for:
• Calendar invite
• [Zoom/Phone] details
• What to expect during the call

See you soon!
```

---

### Step 6: Get Your Link & Add to Platform

1. In your event type, click **"Copy Link"**
2. Your link looks like: `https://calendly.com/your-username/rancher-onboarding`
3. Copy that link

4. Add to your **`.env.local`** file:
```bash
NEXT_PUBLIC_CALENDLY_LINK="https://calendly.com/your-username/rancher-onboarding"
CALENDLY_LINK="https://calendly.com/your-username/rancher-onboarding"
```

5. Restart your dev server: `npm run dev`

---

### Step 7: Test It

1. Open your Calendly link in a browser
2. Book a test appointment
3. Verify:
   - You receive email notification
   - Test booking appears in your Google Calendar
   - Confirmation email looks good
4. Cancel the test appointment

---

## How It Works Now:

### 1. Rancher Applies
- Fills out application
- Sees **"Schedule Your Onboarding Call"** section
- Clicks button → opens Calendly in new tab
- Books call directly on your calendar
- Checks box: "I have scheduled my call"
- Submits application

### 2. Rancher Receives Email
- Confirmation email from BuyHalfCow with big "Book Your Call" button
- Also gets Calendly confirmation email with calendar invite
- Gets reminders 24h and 1h before call

### 3. You See Application in Admin
- Go to `/admin` → Ranchers tab
- See which ranchers have **"✓ Call Scheduled via Calendly"** badge
- See which ranchers still need to book (no badge)
- After completing call, click **"Mark Call Completed"** button

### 4. You Have the Call
- Calendar reminder fires 1 hour before
- Follow the guide in `RANCHER_ONBOARDING_CALLS_GUIDE.md`
- Discuss operation, explain network, mention 10% commission
- Coordinate ranch tour if interested

### 5. Post-Call
- Mark call as completed in admin dashboard
- Approve or reject application
- Send follow-up email with next steps

---

## Launch Week Scheduling Strategy

You're onboarding **200 ranchers**. Here's how to manage volume:

### Use Calendly's Limits:

**Daily Event Limit:**
- Set max 8 calls per day (Settings → Event Type → Advanced)
- Prevents burnout

**Date Range:**
- Only allow bookings 3-4 weeks out
- Spreads the calls over time
- Prevents all 200 ranchers trying to book Week 1

**Buffer Time:**
- 15 minutes between calls
- Gives you time for notes + bathroom breaks

### Block Specific Days:

If you're traveling for ranch tours:
- Go to Calendly → Availability → Date Overrides
- Mark specific days as unavailable
- Prevents bookings when you're on the road

### Example Availability for Launch Week:

**Week 1:** 6 calls/day × 3 days = 18 calls
**Week 2:** 8 calls/day × 5 days = 40 calls
**Week 3:** 8 calls/day × 5 days = 40 calls
**Week 4:** 8 calls/day × 5 days = 40 calls

**Total:** 138 calls in first month (plenty for 200 rancher backlog)

---

## Pro Tips:

### 1. **Add a Pre-Call Questionnaire**
In Calendly, add custom questions:
- "What's your biggest question about The HERD?" (helps you prep)
- "Have you sold beef direct-to-consumer before?" (gives you context)

### 2. **Set Realistic Buffer**
15-minute buffer between calls = time for:
- Quick bathroom break
- Add notes to Airtable
- Grab water/coffee
- Breathe

### 3. **Block Lunch**
Add a "busy" block from 12-1pm every day in Google Calendar. Calendly respects it.

### 4. **Weekend Calls (Optional)**
If ranchers work weekdays, offer Saturday morning slots (9am-12pm). Many will appreciate it.

### 5. **Phone vs Zoom**
- **Phone calls** = simpler, less tech issues, ranchers like it
- **Zoom** = can see their face, screen share if needed
- **Recommendation:** Phone calls for launch week (faster, easier)

---

## Troubleshooting:

**"My Calendly link doesn't work in the app"**
- Check `.env.local` has `NEXT_PUBLIC_CALENDLY_LINK="..."`
- Restart dev server: `npm run dev`
- Hard refresh browser: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)

**"Ranchers aren't booking"**
- Test your link directly — does it open?
- Check Calendly availability settings — are slots showing?
- Make sure event type is "Active" (not draft)

**"I'm getting double-booked"**
- Calendly should sync with Google Calendar automatically
- Check: Calendly → Account → Calendar Connections
- Make sure your Google Calendar is connected

**"How do I block out travel days?"**
- Calendly → Availability → Date Overrides
- Add specific dates as "Unavailable"
- Or just block them in Google Calendar (Calendly respects it)

---

## What If You Don't Set Up Calendly?

If you skip Calendly setup:
- Emails will show a "Book Your Call" button
- It links to: `mailto:support@buyhalfcow.com`
- Ranchers email you to schedule manually
- You reply with available times
- More work, more back-and-forth

**Recommendation:** Take 15 minutes NOW to set up Calendly. It'll save you hours during launch week.

---

## Calendly Pricing:

**Free Plan:**
- 1 event type (perfect — you only need "Rancher Onboarding")
- Unlimited bookings
- Calendar connections
- Email reminders
- **Everything you need for launch**

**Paid Plans ($12-16/month):**
- Multiple event types
- Team scheduling
- Advanced integrations
- Payment collection
- **Not needed yet**

Stick with free for now. Upgrade later if needed.

---

## You're Ready!

Once Calendly is set up:
1. Copy your link
2. Add to `.env.local`
3. Restart dev server
4. Test the rancher application form
5. Verify button links to your Calendly

Then ranchers can self-schedule. Zero back-and-forth. 🤠

**Questions?** Calendly's support is excellent: https://help.calendly.com
