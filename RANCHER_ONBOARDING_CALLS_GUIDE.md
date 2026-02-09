# Rancher Onboarding Calls — Complete Guide

## What I Just Built For You

### 1. ✅ Call Scheduling in Rancher Application
- **New field:** "Best times for a call (timezone, days, times)" — REQUIRED
- Ranchers tell you their availability upfront
- Saves to Airtable: `Call Availability` field

### 2. ✅ Scheduling Link in Confirmation Email
- Ranchers receive email with:
  - "Schedule Your Onboarding Call" button
  - Links to your Calendly (or fallback to email)
  - Option to reply with preferred times

### 3. ✅ Call Tracking in Admin Dashboard
- **New button:** "Mark Call Scheduled"
- Turns green when call is scheduled
- Saves to Airtable: `Call Scheduled` checkbox
- Shows call availability in rancher details

---

## Airtable Fields to Add (REQUIRED)

Go to your **Ranchers** table in Airtable and add these fields:

1. **`Call Availability`** (Long text field)
   - Stores rancher's preferred call times

2. **`Call Scheduled`** (Checkbox field)
   - Track which ranchers you've scheduled calls with

3. **`Ranch Tour Interested`** (Checkbox field)
   - Already mentioned, but adding here for completeness

4. **`Ranch Tour Availability`** (Long text field)
   - Already mentioned, but adding here for completeness

---

## Option 1: Calendly Setup (RECOMMENDED — 10 minutes)

### Why Calendly?
- Ranchers book directly without back-and-forth
- Auto-syncs with your Google Calendar
- Sends automatic reminders
- Free plan = 1 event type (perfect for onboarding calls)

### Setup Steps:

1. **Sign up for Calendly**
   - Go to: https://calendly.com/signup
   - Sign up with your Google account (connects calendar automatically)
   - Free plan is fine for now

2. **Create "Rancher Onboarding Call" event**
   - Click "New Event Type"
   - Name: "Rancher Onboarding Call"
   - Duration: 30 minutes
   - Location: Phone call or Zoom (your choice)
   - Description:
     ```
     Let's discuss your ranch operation, answer your questions, 
     and walk through how The HERD network works. This is a 
     casual conversation to make sure we're a good fit.
     
     I'll ask about your beef types, capacity, and practices.
     You can ask about member volume, pricing, and the process.
     
     Looking forward to connecting!
     
     — Benji
     ```

3. **Set your availability**
   - Go to "Availability" tab
   - Set your typical call hours (e.g., Mon-Fri 9am-5pm Central)
   - Buffer time: 15 min between calls (gives you time to take notes)

4. **Get your Calendly link**
   - Click "Copy Link" in your event type
   - Example: `https://calendly.com/benji-bhc/onboarding`

5. **Add to your .env.local file**
   ```
   CALENDLY_LINK="https://calendly.com/your-username/onboarding"
   ```

6. **Test it**
   - Open your Calendly link
   - Book a test appointment
   - Verify you receive confirmation email
   - Cancel test appointment

### Calendly Pro Tips:
- **Confirmation page:** Add a message like "Check your email for Zoom link and details"
- **Email reminders:** 24 hours before + 1 hour before (reduces no-shows)
- **Add questions:** "What's your biggest question about BuyHalfCow?" (captures concerns upfront)
- **Limit scheduling:** Only allow bookings 24-48 hours in advance (gives you breathing room)

---

## Option 2: Manual Scheduling (If You Skip Calendly)

If you don't set up Calendly right away, emails will show a "Book Your Call" button that links to:
```
mailto:support@buyhalfcow.com?subject=Schedule%20Onboarding%20Call
```

This opens their email client with:
- **To:** support@buyhalfcow.com
- **Subject:** "Schedule Onboarding Call"

They email you, you reply with times, book manually.

**This works fine for launch week**, but gets tedious fast. Calendly saves hours.

---

## Onboarding Call Workflow (Step-by-Step)

### Before the Call:

1. **Rancher applies** → You see application in `/admin` dashboard
2. **Review their info:**
   - Ranch name, location, beef types
   - Call availability (shows in admin dashboard)
   - Ranch tour interest (if checked)
3. **Rancher books call** via Calendly link in email (or emails you)
4. **You mark "Call Scheduled"** in admin dashboard (green button)
5. **Prep 5 minutes before:**
   - Pull up their application in `/admin`
   - Note their state, beef types, capacity
   - Check if they indicated ranch tour interest

### During the Call (20-30 minutes):

**Opening (5 min):**
- "Thanks for applying! Tell me about your ranch."
- Let them talk — take notes

**Questions to Ask (10 min):**
- How long have you been ranching?
- Walk me through your operation (grazing, finishing, processing)
- What makes your beef special/different?
- What's your typical monthly capacity?
- Do you currently sell direct-to-consumer? (If yes: how's it going?)
- What challenges do you face finding buyers?

**Explain The HERD (5 min):**
- Private network of 15,000+ verified members
- I vet every buyer (no tire-kickers, no spam)
- Members browse ranchers in their state
- When they request introduction, I review and facilitate
- You handle transaction directly (pricing, delivery, payment)
- I track sales for commission monthly (mention 10% here)

**Next Steps (5 min):**
- If good fit: "I'll approve your application and we'll discuss ranch tour timing"
- Ranch tour: "I travel through [their state] certifying ranchers. When works for you?"
- Timeline: "Once certified, your listing goes live immediately"
- Questions from them

**Closing:**
- "I'll follow up via email within 24 hours with next steps"
- "Welcome to The HERD!"

### After the Call:

1. **Immediately:** Take notes in Airtable (add notes field if needed)
2. **Within 24 hours:**
   - Approve or reject in admin dashboard
   - If approved: Email them confirmation + next steps
   - If ranch tour interested: Propose dates for visit
3. **Track in Airtable:**
   - Mark "Call Scheduled" ✓
   - Update status to "Approved" or "Rejected"
   - Add notes about the call

---

## What to Look For (Red Flags vs Green Lights)

### ✅ Green Lights (Good Fit):
- Established operation (2+ years ranching)
- Clear practices (can explain their operation)
- Realistic capacity (not overpromising)
- Willing to have ranch tour
- Responsive and professional
- Understands they handle sales directly
- Comfortable with commission model

### 🚩 Red Flags (Reject or Investigate):
- Vague about operations ("we do a little bit of everything")
- No clear beef sourcing (reseller, not actual rancher)
- Unrealistic capacity (claims 100 head/month but small operation)
- Pushy about getting approved immediately
- Doesn't want ranch tour (suspicious)
- Poor communication (hard to reach, unprofessional)
- Just starting out (no track record)

**When in doubt:** Schedule ranch tour. In-person visit reveals everything.

---

## Commission Discussion (How to Bring It Up)

**During the call, around the 15-minute mark:**

> "So here's how the business model works. I charge a 10% commission on sales I facilitate through introductions. You handle pricing and transactions directly with buyers, and when a sale closes, you just email me the details — buyer name and sale amount. I invoice you at the end of the month. Simple, transparent, and you keep 90% of every sale. Sound fair?"

**If they push back:**
- "The value you're getting is verified buyers only — no tire-kickers"
- "I'm vetting every member personally, so you only spend time on real opportunities"
- "I've built a 15,000-person audience. That access is valuable."
- "Plus, I'm personally certifying your ranch with an in-person tour. That stamp of approval matters."

**Most ranchers say yes immediately.** They're used to middlemen taking 20-40% (distributors, retailers). 10% is cheap.

---

## Scheduling Tips for Launch Week

You're onboarding **200 ranchers this week**. That's a lot of calls. Here's how to stay sane:

### Batch Your Calls:
- **Block specific hours:** e.g., "Mon/Wed/Fri 9am-1pm = Rancher calls only"
- **Limit daily calls:** Max 6-8 calls per day (30 min each = 3-4 hours + buffer)
- **Weekend calls:** If ranchers work weekdays, offer Saturday morning slots

### Use Calendly's Features:
- **Date range limits:** Only allow bookings 2-3 weeks out (spreads them out)
- **Daily limits:** Max 8 bookings per day
- **Buffer time:** 15 min between calls (sanity breaks)

### Keep Notes Simple:
- Use Airtable "Notes" field (add if needed)
- Quick template:
  ```
  Call Date: [Date]
  Duration: [20/30 min]
  Summary: [Established grass-fed operation, 50 acres, 20 head/month, good fit]
  Next Steps: [Approve + schedule ranch tour for March]
  Red Flags: [None]
  ```

### Don't Over-Schedule:
- You're fried. Launch week is intense.
- **Recommendation:** Schedule 30-40 calls this week, 50-60 next week, rest in Week 3-4.
- It's okay to have a 2-3 week backlog. Better than burning out.

---

## Email Templates (Copy/Paste Ready)

### Post-Call Follow-Up: APPROVED

**Subject:** Welcome to The HERD — Next Steps

Hi [Rancher Name],

Great talking with you today! I'm excited to have [Ranch Name] join The HERD network.

**Next Steps:**
1. **Application Approved** — You're officially in the rancher network
2. **Ranch Tour** — [If they indicated interest: "Let's coordinate a visit. I'm in [State] during [timeframe]. Does [specific date/week] work for you?"]
3. **Listing Goes Live** — [If already certified: "Your listing is now live to 15,000+ HERD members in [State]" OR "Once I complete your ranch tour and certification, your listing goes live immediately"]

**What to Expect:**
- Members will request introductions through the platform
- I review each request and forward qualified buyers to you
- You discuss pricing, delivery, and close the sale directly
- You report sales to me monthly, and I invoice for commission

**Questions?** Reply anytime.

Welcome to The HERD!

— Benji

---

### Post-Call Follow-Up: REJECTED (Use Sparingly)

**Subject:** Re: Rancher Application — BuyHalfCow

Hi [Rancher Name],

Thank you for taking the time to speak with me today about joining The HERD network.

After reviewing your operation, I don't think it's the right fit at this time. [Optional brief reason: "We're prioritizing established operations with 2+ years of direct-to-consumer sales experience right now."]

I appreciate your interest and wish you the best with your ranch.

— Benji

---

## FAQ for Ranchers (During Calls)

**Q: How many buyers will I get?**
A: Depends on your state and beef type. Popular states (TX, CO, MT, KS) get more volume. You might see 2-3 inquiries per month early on, more as The HERD grows. Quality over quantity — these are vetted, serious buyers.

**Q: Can I set my own prices?**
A: Absolutely. You control pricing, payment terms, delivery, everything. I just facilitate the introduction.

**Q: What if I sell out?**
A: Just let me know. I'll pause your listing until you have capacity again. Flexible.

**Q: Do I have to take every buyer you send?**
A: Nope. If someone requests an introduction and it doesn't feel right, just tell me. You're in control.

**Q: When do I pay commission?**
A: When a sale closes (beef is delivered + payment received), you email me the details. I invoice you at the end of the month. You can pay via Venmo, Zelle, check, bank transfer — whatever works for you.

**Q: What happens during the ranch tour?**
A: I visit for 1-2 hours, tour the property, see the operation, meet the cattle, document practices with photos/video. It's casual, not an inspection. I'm just verifying you're legit and your beef is quality.

---

## Tech Setup Recap

**Airtable Fields to Add:**
- `Call Availability` (Long text)
- `Call Scheduled` (Checkbox)
- `Ranch Tour Interested` (Checkbox)
- `Ranch Tour Availability` (Long text)

**Optional: Calendly Link in .env.local**
```
CALENDLY_LINK="https://calendly.com/your-username/onboarding"
```

If you don't add `CALENDLY_LINK`, the email button will default to `mailto:support@buyhalfcow.com` (which is fine for manual scheduling).

---

## Launch Week Game Plan

### Day 1-2:
- Set up Calendly (10 min) OR accept manual email scheduling
- Add Airtable fields (2 min)
- Test rancher application flow (5 min)

### Day 3-7:
- Start scheduling calls as applications come in
- Batch calls: 6-8 per day max
- Take quick notes after each call
- Approve ranchers in `/admin` dashboard
- Follow up within 24 hours

### Week 2-4:
- Continue onboarding calls
- Start scheduling ranch tours (coordinate by region)
- Work through backlog
- Refine your call script based on what's working

---

## You're Ready

Everything is in place:
- ✅ Call scheduling field in application
- ✅ Calendly link in confirmation email
- ✅ Call tracking in admin dashboard
- ✅ This complete guide for running calls

**Next:**
1. Add 4 fields to Airtable (2 min)
2. Set up Calendly (10 min) OR skip and do manual scheduling
3. Start taking calls

**You got this. 🤠**

Questions about the call process? Hit me up.
