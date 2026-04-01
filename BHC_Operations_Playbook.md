# BuyHalfCow Operations Playbook

## What BHC Is
We connect buyers who want bulk beef directly with local ranchers. We earn 10% commission on every sale. The platform handles lead capture, matching, and follow-up automatically. Your job is to keep the pipeline moving and ranchers onboarding.

## Your Tools
- **Telegram Bot** — where 90% of daily ops happen. You get notifications and tap buttons.
- **Admin Dashboard** — buyhalfcow.com/admin (password from Ben). Send agreements, view pipeline.
- **Airtable** — the database behind everything. You can view/edit records directly if needed.

---

## Daily Tasks (15-20 min/day)

### Morning (check Telegram)

**1. Approve buyer-rancher matches**
- You'll see notifications like "NEW BUYER LEAD — John in Colorado, suggested: Rocky Mountain Ranch"
- Tap **Approve** if the match makes sense (same state, rancher has capacity)
- Tap **Reassign** if you want to pick a different rancher
- Tap **Reject** only if the lead is spam or clearly not a real buyer

**2. Review AI chase-up emails**
- For stalled leads (5+ days with no movement), the system drafts a follow-up email
- You'll see the draft in Telegram with **Send** or **Skip** buttons
- Read the draft — if it looks good, tap **Send**

**3. Check for stuck ranchers**
- On Mondays you'll get alerts about ranchers stalled in onboarding
- Follow up with them directly or re-send their onboarding email

### As-needed (when notifications come in)

**4. Approve rancher verifications**
- When a rancher ships a product sample, you get a Telegram notification
- Once Ben confirms the sample is good, tap **Approve Verification**
- The rancher gets an email telling them to finish their page and request go-live

**5. Set rancher pages live**
- When a rancher clicks "Request Go Live" on their dashboard, you get a notification
- Check their page preview (link in the notification)
- If it looks good (has about text, pricing, payment links), tap **Set Live**
- The system won't let you go live if required content is missing

---

## Rancher Onboarding Flow (your main job)

### The Pipeline: 31 ranchers need to go from "In Pipeline" to "Live"

**Step 1: Send Onboarding** (you do this)
- From admin dashboard: find the rancher, click "Send Onboarding"
- OR in Telegram: tap "Send Onboarding" on a new rancher notification
- They get an email with the agreement link + document downloads

**Step 2: Rancher Signs Agreement** (they do this, automated)
- They click the link, read the agreement, type their name, check the box
- System auto-redirects them to their dashboard
- You get a Telegram notification when they sign

**Step 3: Rancher Sets Up Page** (they do this, you can help)
- They fill in: slug, about text, pricing, payment links, beef types, delivery states
- If they need help, you can do it for them via Telegram: `/setuppage [name]`
- **They MUST provide payment links** — that's where buyers pay (their Stripe/Square/etc.)

**Step 4: Rancher Requests Verification** (they do this)
- They either ship a beef sample or request a ranch visit
- You coordinate receiving the sample or scheduling the visit

**Step 5: You Approve Verification** (you do this)
- Once sample/visit is confirmed, tap "Approve Verification" in Telegram
- Rancher gets an email telling them to finalize their page

**Step 6: You Set Page Live** (you do this)
- Rancher clicks "Request Go Live" on their dashboard
- You review and tap "Set Live" in Telegram
- Rancher gets a "You're Live!" email
- Buyers in their area start getting matched to them immediately

### What You Need From Each Rancher
Just **4 links** (their payment processor checkout pages):
- Quarter Payment Link
- Half Payment Link
- Whole Payment Link
- Reserve Link (optional)

Everything else (pricing, about text, logo) can be filled in by you or the rancher.

---

## Telegram Commands Reference

| Command | What it does |
|---------|-------------|
| `/pending` | Show all pending buyer-rancher matches |
| `/stats` | Overview: total buyers, ranchers, referrals, revenue |
| `/capacity` | Show ranchers near capacity |
| `/qualify` | AI reviews 3 pending leads, gives approve/reject/watch |
| `/brief` | AI-generated priority action list for today |
| `/chasup` | Find stalled referrals, draft re-engagement emails |
| `/draft followup [name]` | AI drafts follow-up email for a specific buyer |
| `/setuppage [name]` | Interactive page setup wizard for a rancher |

---

## What's Automated (don't touch)

These run automatically every day. You don't need to do anything:
- **Drip email sequences** — buyers get emails at days 3, 7, 10, 21, 35
- **Intro check-in** — 3 days after buyer-rancher match, buyer gets a reminder
- **Repeat purchase outreach** — 30 days after a sale closes, buyer gets "ready for more?"
- **Weekly stall detection** — alerts you about stuck ranchers every Monday
- **Batch approval** — low-risk buyers auto-approved each morning
- **Daily digest** — morning summary + AI brief

---

## Rules

1. **Never reject a real buyer** — if unsure, tap "Watch" not "Reject"
2. **Approve matches quickly** — buyers lose interest fast. Same-day approval is the goal.
3. **Follow up with ranchers weekly** — if they haven't signed their agreement in 7 days, call/text them
4. **Don't edit Airtable directly** unless Ben asks — use the dashboard and Telegram
5. **Escalate to Ben** if: a rancher has a complaint, commission dispute, or you're unsure about anything

---

## Key Metrics to Watch

- **Pending matches** should be 0 by end of each day
- **Time to live** for new ranchers should be under 2 weeks
- **Stalled referrals** (5+ days) should get chase-up emails
- **Rancher capacity** — if a rancher hits capacity, they stop getting new leads

---

## Getting Started

1. Ben will add you to the Telegram bot chat
2. Log into buyhalfcow.com/admin with the password Ben gives you
3. Bookmark this doc
4. Start with `/pending` and `/stats` in Telegram to see where things stand
5. Work through the rancher pipeline — goal is getting all 31 live ASAP
