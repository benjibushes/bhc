# BuyHalfCow -- Full Platform Audit & Operations Manual

**Last updated:** April 1, 2026
**Owner:** Ben (Benjamin)
**Domain:** buyhalfcow.com
**Revenue model:** 10% commission on every beef sale brokered

This is the master document. Everything you need to run, scale, and hand off BuyHalfCow is here.

---

## 1. PLATFORM AUDIT -- CHANGE LOG

Every significant change made across the build sessions, in reverse chronological order.

### Full Autonomy Build (most recent)
- **Auto-approve direct page leads** -- buyers who come through a specific rancher's landing page are auto-approved and instantly matched to that rancher, bypassing the pending queue entirely
- **Auto-send chase-up emails** -- stalled referrals (5+ days idle) get AI-drafted re-engagement emails sent automatically, capped at 3 per referral, then auto-closed as "Closed Lost" with notes
- **Auto-go-live for verified ranchers** -- once a rancher passes verification AND has required content (about text, pricing, at least one payment link), their page goes live automatically without manual approval
- **Rancher agreement drip** -- unsigned ranchers get reminder emails at day 3, day 7, and day 14 after onboarding email was sent. No more manual nagging.
- **24-hour email frequency gate** -- no consumer receives more than one automated email per 24 hours across all sequences. Prevents pile-ups and spam complaints.
- **Cal.com webhook handler** (`/api/webhooks/cal`) -- detects when a rancher books an onboarding call, updates their Airtable status, sends Telegram notification with date/time. Handles BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED.
- **Operations playbook created** -- `BHC_Operations_Playbook.md` for ops handoff

### Admin Dashboard & Verification Overhaul
- **Admin rancher page editor** (`/admin/ranchers/[id]`) -- full CRUD for rancher landing pages from the browser. Edit slug, about text, pricing, payment links, photos, testimonials, delivery states, everything.
- **Verification flow overhaul** -- replaced physical sample shipping with digital proof (photos, certifications, USDA docs). Ranchers upload proof, admin reviews in Telegram, taps approve/reject. Faster, cheaper, scalable.

### Landing Page Social Proof
- **Testimonials section** on rancher pages -- ranchers can add customer testimonials with name, text, and star rating
- **Photo gallery** -- multiple ranch/product photos displayed in a grid
- **Social proof indicators** -- years in business, head count, certifications displayed prominently

### Email Deliverability Fixes
- **Plain text auto-generation** -- every email now includes both HTML and plain text parts. This was the #1 spam filter trigger. The `resend` wrapper in `lib/email.ts` auto-converts HTML to plain text for every send.
- **ReplyTo header** -- every email gets `replyTo: ben@buyhalfcow.com` automatically. Missing replyTo is a spam signal.
- **List-Unsubscribe header** -- RFC 8058 compliant one-click unsubscribe on all marketing/drip emails
- **List-Unsubscribe-Post header** -- enables the Gmail/Apple Mail unsubscribe button in the UI
- **Domain rotation** -- `SEND_DOMAINS` env var supports multiple verified domains. Emails cycle across them to protect sender reputation and warm up new domains.
- **UTM tracking** -- all email links get `utm_source=email&utm_medium=drip&utm_campaign=...` appended for analytics

### Matching Engine Fixes
- **Direct page lead auto-assign** -- if a buyer comes through `/ranchers/rocky-mountain-ranch`, they're assigned to Rocky Mountain Ranch even if that rancher is at capacity. No more leads disappearing into the general queue.
- **Intent scoring** -- AI qualification scores leads on a scale, with approve/reject/watch recommendations
- **Buyer reassignment alerts** -- when a buyer gets reassigned to a different rancher (capacity, geography, etc.), they get an email explaining the change with the new rancher's info

### Rancher Onboarding Improvements
- **Rancher notification on payment clicks** -- when a buyer clicks Quarter/Half/Whole payment link on a rancher's page, the rancher gets an instant Telegram notification with buyer details
- **Self-serve delivery settings** -- ranchers can update their delivery states/radius from their dashboard
- **Validation before go-live** -- system enforces: must have about text, at least one price, at least one payment link before page can go live

### Drip Email Fixes
- **Removed 1-day windows** -- emails used to only fire within a narrow 24-hour window after approval. Now they fire anytime after the threshold (day 3+, day 7+, etc.) as long as the previous stage was completed.
- **50/run rate limit** -- each cron run sends max 50 emails to avoid Resend rate limits and spam flags
- **Unsubscribe filtering** -- all drip sequences skip consumers who have unsubscribed

---

## 2. SYSTEM ARCHITECTURE OVERVIEW

### Stack
| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router) + TypeScript |
| Database | Airtable (9 tables) |
| Email | Resend API |
| Notifications | Telegram Bot API |
| AI | Ollama (local dev) / Anthropic Claude API (production) |
| Scheduling | Cal.com (onboarding calls) |
| Hosting | Vercel Pro |
| Payments | Rancher-owned (Stripe/Square/PayPal -- we redirect, they collect) |

### Airtable Tables
| Table | Purpose |
|-------|---------|
| Consumers | All buyers -- leads, approved, active |
| Ranchers | All ranchers -- pipeline through active |
| Referrals | Buyer-rancher matches (the core transaction) |
| Brands | Brand partnerships and listings |
| Affiliates | Referral partners |
| Campaigns | Email broadcast campaigns |
| Inquiries | General contact form submissions |
| News | Blog/news posts |
| Land Deals | Land listing partnerships |

### Cron Jobs (7 active on Vercel Pro)

| Schedule (UTC) | Local Time (MT) | Job | What It Does |
|---------------|----------------|-----|-------------|
| `0 9 1 * *` | 3am MT, 1st of month | compliance-reminders | Monthly compliance check emails to ranchers |
| `0 * * * *` | Every hour | send-scheduled | Sends any queued/scheduled emails |
| `0 14 * * *` | 8am MT daily | daily-digest | Morning summary + AI brief to Telegram |
| `0 15 * * *` | 9am MT daily | batch-approve | Auto-approves pending consumers, triggers matching |
| `0 15 * * 1` | 9am MT Mondays | rancher-followup | Alerts about ranchers stalled in onboarding |
| `0 16 * * *` | 10am MT daily | email-sequences | Drip emails (consumer + rancher agreement reminders) |
| `0 17 * * *` | 11am MT daily | referral-chasup | Auto-sends chase-ups, auto-closes stale referrals |

### Key File Paths

**Core libraries:**
- `lib/airtable.ts` -- all database CRUD, rate limit retry, field stripping
- `lib/email.ts` -- every email template, domain rotation, spam protection
- `lib/telegram.ts` -- Telegram bot helpers
- `lib/ai.ts` -- shared Claude/Ollama helper (`callClaude()`)

**API routes:**
- `app/api/webhooks/telegram/route.ts` -- Telegram bot commands + all callback handlers (~1800 lines)
- `app/api/webhooks/cal/route.ts` -- Cal.com booking detection
- `app/api/webhooks/stripe/route.ts` -- Stripe payment webhooks
- `app/api/cron/batch-approve/route.ts` -- daily auto-approval + matching
- `app/api/cron/email-sequences/route.ts` -- drip sequences
- `app/api/cron/referral-chasup/route.ts` -- chase-ups + auto-close
- `app/api/cron/daily-digest/route.ts` -- morning digest + AI brief

**Frontend:**
- `app/ranchers/page.tsx` -- public rancher directory (`/ranchers`)
- `app/ranchers/[slug]/page.tsx` -- individual ranch landing pages
- `app/ranchers/[slug]/pay/[tier]/route.ts` -- payment click tracking + redirect
- `app/admin/ranchers/[id]/page.tsx` -- admin rancher page editor

**Setup (run once):**
- `app/api/admin/setup-ai-fields/route.ts` -- creates AI fields in Airtable
- `app/api/admin/setup-rancher-page-fields/route.ts` -- creates 21 rancher page fields

---

## 3. WHAT'S AUTOMATED (NO HUMAN NEEDED)

These systems run 24/7 without intervention. Do not touch them unless something breaks.

### Consumer Pipeline
- **Auto-approval** -- every pending consumer is approved daily at 9am MT. No intent gate. Everyone gets in.
- **Direct page lead instant approval** -- buyers from rancher landing pages are approved and matched immediately (not batched)
- **Magic link emails** -- every approved consumer gets a login link, no passwords
- **Backfill survey** -- consumers missing order details get a follow-up asking what they want

### Matching Engine
- **Rancher matching** -- approved Beef Buyers are matched to ranchers by state, then by capacity, then nationwide fallback
- **Direct page matching** -- buyers from a specific rancher page always go to that rancher, even at capacity
- **Intro emails** -- once matched, buyer and rancher both get introduction emails automatically
- **Buyer reassignment alerts** -- if a buyer gets moved to a different rancher, they're notified

### Email Drip Sequences (runs daily at 10am MT)

**For buyers WITH a rancher available:**
| Day | Email | Purpose |
|-----|-------|---------|
| 3 | Beef Day 3 | Nudge to connect with matched rancher |
| 7 | Beef Day 7 | Follow-up on rancher introduction |
| 7 | Community Day 7 | Community members get mission update |
| 14 | Community Day 14 | Deeper community engagement |

**For buyers WITHOUT a rancher available (nurture track):**
| Day | Email | Purpose |
|-----|-------|---------|
| 3 | Nurture Day 3 | Mission update + Instagram follow |
| 10 | Nurture Day 10 | Ben's founder story |
| 21 | Merch Email | "Wear the mission" merch push |
| 35 | Affiliate Ask | Invite to become an affiliate |

**For matched referrals:**
| Trigger | Email | Purpose |
|---------|-------|---------|
| 3 days after intro | Intro Check-in | "Have you connected with your rancher yet?" |
| 30 days after close | Repeat Purchase | "Ready for your next order?" |

### Chase-Up System (runs daily at 11am MT)
- Finds referrals idle 5+ days (status: "Intro Sent" or "Rancher Contacted")
- AI drafts a personalized re-engagement email using buyer/rancher context
- Sends automatically (no human approval needed)
- Caps at 3 chase-ups per referral
- After 3 unanswered chase-ups + 5 more idle days, auto-closes as "Closed Lost"
- Skips unsubscribed consumers

### Rancher Onboarding Automation
- **Agreement drip** -- unsigned ranchers get reminders at day 3, 7, and 14
- **Auto-go-live** -- verified ranchers with complete pages go live automatically
- **Payment click tracking** -- every click on Quarter/Half/Whole payment links is logged in Airtable with UTM data
- **Rancher click notifications** -- ranchers get Telegram alerts when buyers click their payment links

### Other Automations
- **Cal.com booking detection** -- when a rancher books an onboarding call, their status updates and Ben gets a Telegram alert
- **Daily digest** -- morning summary of pipeline state + AI-generated priority brief
- **Monday rancher follow-up** -- weekly alerts about ranchers stalled in onboarding
- **Monthly compliance reminders** -- automated compliance check emails to active ranchers

---

## 4. WHAT NEEDS A HUMAN

### Daily (15-20 min via Telegram)

| Task | Who | When | How |
|------|-----|------|-----|
| Review non-direct referral matches | Ops Manager | As notifications arrive | Tap Approve/Reassign/Reject in Telegram |
| Spot-check AI chase-up quality | Ops Manager | Daily glance at digest | Chase-ups send automatically, but skim the digest numbers |
| Send rancher onboarding emails | Rancher Onboarder | When new rancher is added | Admin dashboard or Telegram `/setuppage` |
| Review rancher verification docs | Ben or Ops Manager | When docs are submitted | Photos/certs arrive via Telegram, tap approve/reject |

### Weekly

| Task | Who | When | How |
|------|-----|------|-----|
| Follow up with stalled ranchers | Rancher Onboarder | Monday (auto-alert) | Call/text ranchers who haven't signed in 7+ days |
| Check capacity levels | Ops Manager | Weekly | `/capacity` in Telegram |
| Review pipeline health | Ben | Weekly | `/stats` in Telegram |

### As-Needed

| Task | Who | How |
|------|-----|-----|
| Content creation (YouTube, social) | Content/Marketing | Record, edit, post |
| Payment/commission reconciliation | Ben | Match Airtable "Closed Won" against rancher payments |
| Edge case handling | Ben | Telegram escalation from Ops Manager |
| Rancher complaints/disputes | Ben | Direct conversation |
| New affiliate setup | Ops Manager | Admin dashboard |
| Broadcast email campaigns | Ops Manager | `/draft campaign` in Telegram |

---

## 5. ANTI-SPAM GUARDRAILS

Every email protection currently active:

| Protection | Implementation | Why It Matters |
|-----------|---------------|---------------|
| Plain text auto-generation | `resend` wrapper in `lib/email.ts` strips HTML to text | Emails without a text part get flagged as spam by Gmail/Outlook |
| ReplyTo header | Auto-added to every email: `ben@buyhalfcow.com` | Missing replyTo = spam signal |
| List-Unsubscribe | RFC 8058 compliant, both mailto and URL methods | Required by Gmail bulk sender rules (Feb 2024) |
| List-Unsubscribe-Post | One-click unsubscribe support | Enables the unsubscribe button in Gmail/Apple Mail UI |
| 24-hour frequency gate | `Sequence Sent At` field checked before every send | No consumer gets 2 automated emails in 24 hours |
| 50 emails/run cap | `MAX_EMAILS_PER_RUN = 50` in email-sequences cron | Prevents Resend rate limit hits and volume-based spam flags |
| 3 chase-up cap | `MAX_CHASE_UPS = 3` in referral-chasup cron | Prevents harassment, auto-closes stale leads |
| Unsubscribe filtering | All drip sequences check `Unsubscribed` field | Never email someone who opted out |
| Domain rotation | `SEND_DOMAINS` env var cycles across verified domains | Protects primary domain reputation, warms up new domains |
| Escape/sanitize all user input | `esc()` function in email templates | Prevents XSS in emails |
| UTM tracking (not inline tracking pixels) | UTM params appended to links | Analytics without triggering pixel-based spam detectors |
| DKIM/SPF | Configured per domain in Resend + DNS | Email authentication -- without it, emails go to spam |

### Domain setup checklist for new send domains:
1. Add domain in Resend dashboard
2. Add DKIM records (3 CNAME records) to DNS
3. Add SPF record: `v=spf1 include:amazonses.com ~all`
4. Wait 24-48 hours for DNS propagation
5. Verify in Resend dashboard
6. Add to `SEND_DOMAINS` env var (comma-separated)
7. Start with low volume, ramp up over 2-4 weeks

---

## 6. ROLES FOR SCALING

### Role 1: Operations Manager
**Hours:** 15-20/week
**Pay range:** $20-35/hr (or $1,500-2,500/mo part-time)

**Daily tasks:**
- Check Telegram for pending approvals (5 min)
- Review daily digest, act on flagged items (5 min)
- Approve/reassign buyer-rancher matches (5 min)
- Handle escalations from other roles (as needed)

**Weekly tasks:**
- Pipeline health review with Ben
- Capacity check across all ranchers
- Commission reconciliation assist

**Tools needed:** Telegram, Admin dashboard, Airtable (view only)

**KPIs:**
- Pending matches cleared same-day: target 100%
- Average time-to-match: target < 4 hours
- Stalled referrals: target < 10% of active pipeline
- Chase-up success rate (responses after re-engagement)

---

### Role 2: Rancher Onboarder
**Hours:** 10-15/week
**Pay range:** $18-30/hr (or $800-1,800/mo part-time)

**Daily tasks:**
- Send onboarding emails to new ranchers in pipeline
- Follow up with ranchers who haven't signed agreements (call/text after 7 days)
- Help ranchers set up their pages (via Telegram `/setuppage` or admin dashboard)
- Review verification documents when submitted

**Weekly tasks:**
- Monday stall check (auto-alerted)
- Pipeline progress report to Ben

**Tools needed:** Telegram, Admin dashboard, Phone (for direct calls)

**KPIs:**
- Ranchers onboarded per month: target 5-10
- Time from pipeline to live: target < 14 days
- Agreement sign rate: target > 70%
- Page completion rate: target > 80%

---

### Role 3: Customer Success
**Hours:** 5-10/week
**Pay range:** $15-25/hr (or $500-1,000/mo part-time)

**Daily tasks:**
- Monitor buyer inquiries and complaints
- Help buyers navigate the platform
- Follow up on stalled purchases (buyers who clicked payment but didn't complete)

**Weekly tasks:**
- Reach out to recent buyers for testimonials
- Update FAQ/help content
- Report common issues to Ops Manager

**Tools needed:** Email (Resend dashboard for monitoring), Telegram, Airtable (view only)

**KPIs:**
- Response time to inquiries: target < 4 hours
- Buyer satisfaction (post-purchase survey): target > 4.5/5
- Testimonials collected per month: target 5+
- Repeat purchase rate: target > 30%

---

### Role 4: Growth / Sales
**Hours:** 15-20/week
**Pay range:** $25-50/hr (or commission-based: $200-500 per rancher brought live)

**Daily tasks:**
- Cold outreach to ranchers (email, phone, DM)
- Follow up on inbound rancher leads
- Attend local ag events, farmers markets

**Weekly tasks:**
- Research new markets/states to expand into
- Affiliate partner recruitment
- Partnership outreach (ag associations, 4H, FFA)

**Tools needed:** Email, Phone, LinkedIn, Instagram DMs, CRM (can use Airtable Ranchers table)

**KPIs:**
- New rancher leads per week: target 10+
- Rancher conversion rate (lead to live): target > 20%
- New states covered per quarter: target 2-3
- Affiliate sign-ups per month: target 5+

---

### Role 5: Content / Marketing
**Hours:** 10-20/week
**Pay range:** $20-40/hr (or $1,000-3,000/mo part-time)

**Daily tasks:**
- Post to Instagram/TikTok (1 post/day target)
- Engage with comments and DMs
- Share rancher stories and behind-the-scenes content

**Weekly tasks:**
- 1 YouTube video (ranch visit, buyer story, educational)
- 1 blog post for SEO
- Email broadcast to subscriber list (monthly)
- Photography/video at ranch visits

**Tools needed:** Canva, video editing software, Instagram/TikTok/YouTube accounts, Camera/phone

**KPIs:**
- Social media followers growth: target 10%/month
- YouTube subscribers: target 1,000 in first 6 months
- Email list growth: target 200+ new subscribers/month
- Website organic traffic growth: target 20%/month

---

## 7. HOW TO MAKE CHANGES

### For Non-Technical People

#### Edit a rancher's page
1. Go to `buyhalfcow.com/admin`
2. Enter the admin password
3. Click on the rancher you want to edit
4. Change any field: slug, about text, pricing, payment links, photos, testimonials
5. Click Save
6. Changes are live immediately

#### Send onboarding to a new rancher
1. Go to admin dashboard
2. Find the rancher in the list
3. Click "Send Onboarding"
4. They receive: agreement link + document downloads
5. OR in Telegram: when you see a new rancher notification, tap "Send Onboarding"

#### Approve/reject in Telegram
- **New buyer match:** you get a notification with buyer details and suggested rancher. Tap Approve, Reassign, or Reject.
- **Rancher verification:** you get photos/docs. Tap Approve or Reject.
- **AI qualification:** use `/qualify` to have AI review 3 pending leads with recommendations.

#### Broadcast to email list
1. In Telegram, type: `/draft campaign [segment] [topic]`
   - Example: `/draft campaign "Beef Buyer" "Holiday pricing special"`
2. AI drafts the email
3. Review it, tap Send or Edit
4. Email goes to all consumers in that segment

#### Create an affiliate
1. Go to admin dashboard
2. Navigate to Affiliates section
3. Add name, email, and commission structure
4. System generates their unique referral link
5. Share the link with the affiliate

---

### For Technical People

#### How to deploy
```
git push origin main
```
That's it. Vercel auto-deploys on push to main. Build takes ~60 seconds. Zero-downtime deployments.

#### Environment variables
All env vars live in Vercel dashboard: Settings > Environment Variables.

**Required:**
| Variable | Purpose |
|----------|---------|
| `AIRTABLE_API_KEY` | Airtable personal access token |
| `AIRTABLE_BASE_ID` | Airtable base ID (starts with `app`) |
| `RESEND_API_KEY` | Resend email API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_ADMIN_CHAT_ID` | Chat ID for admin notifications |
| `ANTHROPIC_API_KEY` | Claude API key (production AI) |
| `JWT_SECRET` | Secret for magic link tokens |
| `CRON_SECRET` | Auth token for cron job endpoints |
| `ADMIN_PASSWORD` | Admin dashboard password |

**Optional:**
| Variable | Purpose |
|----------|---------|
| `SEND_DOMAINS` | Comma-separated list of verified send domains |
| `OLLAMA_BASE_URL` | Ollama URL for local dev (e.g., `http://localhost:11434`) |
| `OLLAMA_MODEL` | Ollama model name (e.g., `llama3.2`) |
| `ADMIN_EMAIL` | Override default admin email |
| `CALENDLY_LINK` | Cal.com booking link |
| `MERCH_URL` | Merch store URL |
| `NEXT_PUBLIC_SITE_URL` | Site URL override |

#### How to add a new email template
1. Open `lib/email.ts`
2. Add a new exported async function following the existing pattern:
```typescript
export async function sendMyNewEmail(data: { firstName: string; email: string }) {
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: 'Your subject here',
      headers: getUnsubscribeHeaders(data.email),
      html: `<div>Your HTML here</div>`,
      // plain text is auto-generated by the resend wrapper
    });
  } catch (error) {
    console.error('Failed to send my new email:', error);
  }
}
```
3. Import and call it wherever needed (cron job, webhook handler, API route)

#### How to add a new Telegram command
1. Open `app/api/webhooks/telegram/route.ts`
2. Find the command handler section (look for `if (text.startsWith('/'))`)
3. Add your command block:
```typescript
if (text.startsWith('/mycommand')) {
  // Your logic here
  await sendTelegramMessage(chatId, 'Response text', { parse_mode: 'HTML' });
  return NextResponse.json({ ok: true });
}
```
4. If it has callback buttons, add the callback handler in the `callback_query` section using a unique prefix (e.g., `mycmd_`)

#### How to add a new cron job
1. Create `app/api/cron/my-job/route.ts` with a handler function
2. Add CRON_SECRET auth check (copy from any existing cron)
3. Add to `vercel.json`:
```json
{ "path": "/api/cron/my-job", "schedule": "0 18 * * *" }
```
4. Note: Vercel Pro plan allows max 10 cron jobs (currently using 7)

#### Key file sizes for context
- `app/api/webhooks/telegram/route.ts` -- ~1800 lines. This is the monolith. Be careful editing it.
- `lib/email.ts` -- ~800 lines. All email templates live here.
- `lib/airtable.ts` -- ~400 lines. Database layer with retry logic.

---

## 8. GROWTH STRATEGIES

### Rancher Acquisition (1 to 50 live ranchers)

**Direct outreach (highest conversion):**
- Search Instagram/Facebook for small ranches selling direct-to-consumer beef
- Look for ranches with their own website but no real marketing
- Pitch: "We bring you buyers. You keep your pricing. We take 10%."
- Target ranches already selling at farmers markets -- they understand direct sales
- States to prioritize: Texas, Colorado, Montana, Wyoming, Nebraska, Oklahoma, Missouri

**Farmers market strategy:**
- Attend farmers markets in target states
- Talk to beef vendors directly -- they're already selling direct
- Bring printed one-pagers with QR code to sign up
- Offer first 3 months at 5% commission as an intro

**Ag association partnerships:**
- State cattlemen's associations (every state has one)
- Young Farmers Coalition
- American Grassfed Association
- Contact their executive directors, offer to present at meetings

**4H / FFA / County Fair pipeline:**
- 4H and FFA kids raise cattle. Their parents often run ranches.
- Sponsor youth livestock shows in exchange for a table/banner
- County fairs are gold -- every beef producer in the county attends

**Referral incentive:**
- Offer live ranchers $200 for every rancher they refer who goes live
- Ranchers know other ranchers. Word of mouth is the #1 channel in agriculture.

**Content-driven inbound:**
- YouTube videos featuring each live rancher (ranch tour, interview)
- Share on Instagram/TikTok -- ranchers see their peers on the platform and want in
- Blog posts: "How [Ranch Name] doubled their direct sales"

---

### Buyer Acquisition (270 to 5,000)

**SEO plays (long game, highest ROI):**
- State-specific landing pages: "Buy Half a Cow in Colorado," "Bulk Beef in Texas"
- Every rancher page is an SEO page -- optimize slugs, meta descriptions, alt text
- Blog content targeting: "how much does half a cow cost," "bulk beef near me," "where to buy grass-fed beef"
- Rancher directory page (`/ranchers`) should rank for "local ranchers near me" and similar

**Social media (Instagram + TikTok):**
- Short-form video: unboxing beef deliveries, ranch visits, cooking tutorials
- Before/after: grocery store prices vs. BHC prices (the savings angle wins every time)
- User-generated content: ask buyers to post their deliveries, repost them
- Target hashtags: #bulkbeef #halfsideof beef #ranchtoplate #grassfedbeef #buylocal

**YouTube (medium game, builds authority):**
- "I Bought Half a Cow -- Here's What I Got" (mass appeal, curiosity-driven)
- Ranch visit vlogs
- "Grocery Store vs. Ranch-Direct: Price Comparison"
- Educational: "How to Store 200 lbs of Beef"

**Facebook Groups:**
- Join and contribute to: homesteading groups, meal prep groups, bulk buying groups, local food co-ops
- Don't spam -- answer questions, be helpful, link to BHC when relevant
- Create a BHC Facebook Group for community (buyers sharing recipes, tips, ranch stories)

**Referral/affiliate program:**
- Current affiliate system works -- needs promotion
- Offer $50 per buyer who purchases through an affiliate link
- Recruit food bloggers, homesteading influencers, hunting/outdoor content creators
- Give affiliates a custom landing page URL they can share

**PR/media angles:**
- Story: "This 20-something is disrupting the beef industry from his phone"
- Pitch to: local news stations, ag publications, food/sustainability blogs
- Hook: rising grocery prices, supporting local farmers, transparency in food sourcing
- Podcasts: homesteading, food, entrepreneurship, agriculture

**Paid ads (when unit economics are proven):**
- Facebook/Instagram ads targeting: homeowners, families, rural/suburban, interest in organic/local food
- Google Ads on "buy half a cow near me," "bulk beef online"
- Start with $500/month, target $30 cost per acquisition, 10% commission on $2,000 avg order = $200 revenue per buyer

---

### Revenue Optimization

**Tiered commissions:**
- Standard ranchers: 10% commission
- Premium listing (featured on homepage, top of directory): 12-15% commission
- New rancher discount: 5% for first 3 months to drive onboarding

**Upsell opportunities:**
- Branded boxes / custom packaging for ranchers (charge ranchers, add brand value)
- "Ranch Club" subscription for buyers (monthly/quarterly auto-ship)
- Add-ons: seasonings, sauces, cooking accessories (merch already started)

**Brand partnerships:**
- Charge brands for listings in the directory
- Sponsored content: "Featured Ranch of the Month"
- Cross-promote with complementary products (seasonings, grills, freezers)

---

## 9. KEY METRICS DASHBOARD

### Daily Check (via Telegram `/stats` and `/brief`)
| Metric | Target | Where to Find |
|--------|--------|--------------|
| Pending matches | 0 by end of day | `/pending` in Telegram |
| New buyers today | Track trend | Daily digest |
| Emails sent (drip) | < 50/day per domain | Resend dashboard |
| Chase-ups sent | Monitor | Daily digest |
| Payment clicks | Any = good | Telegram notifications |

### Weekly Review
| Metric | Target | Where to Find |
|--------|--------|--------------|
| Buyers approved this week | 20+ | Airtable Consumers view |
| Referrals created | 10+ | Airtable Referrals view |
| Referrals closed won | Track conversion rate | Airtable Referrals filtered |
| Stalled referrals | < 10% of active | `/chasup` in Telegram |
| Rancher capacity | No rancher at 100% | `/capacity` in Telegram |
| Ranchers onboarded | 2+ per week | Airtable Ranchers view |

### Monthly Review
| Metric | Target | Where to Find |
|--------|--------|--------------|
| Total revenue (commissions) | Track growth | Manual: rancher payments x 10% |
| Total active buyers | Growing | Airtable count |
| Total live ranchers | Growing | Airtable count |
| Email deliverability rate | > 95% | Resend dashboard |
| Email open rate | > 30% | Resend dashboard |
| Email click rate | > 5% | Resend dashboard |
| Bounce rate | < 2% | Resend dashboard |
| Spam complaint rate | < 0.1% | Resend dashboard |
| Website traffic | Growing | Vercel Analytics |
| SEO rankings | Track key terms | Google Search Console |
| Affiliate referrals | Track | Airtable Affiliates view |
| Repeat purchase rate | > 30% | Airtable: buyers with 2+ closed referrals |

### Rancher Health Metrics
| Metric | Healthy | Warning | Action |
|--------|---------|---------|--------|
| Days in pipeline | < 14 | 14-30 | Call them directly |
| Agreement signed | Yes | No after 7 days | Send reminder / call |
| Page completeness | All fields filled | Missing payment links | Help them via /setuppage |
| Verification | Approved | Pending > 7 days | Follow up on docs |
| Active referrals | 1-10 | 0 (no leads) or 10+ (near capacity) | Adjust matching |
| Payment click rate | > 5% of page views | < 2% | Review page quality |

---

## 10. POST-DEPLOY CHECKLIST

Run these steps right now, in order.

### Step 1: Create Airtable fields
```
GET https://buyhalfcow.com/api/admin/setup-ai-fields?password=YOUR_ADMIN_PASSWORD
```
Creates: Sequence Stage, Sequence Sent At, Approved At, AI Qualification Summary, AI Recommended Action, AI Email Draft, AI Email Draft Subject

```
GET https://buyhalfcow.com/api/admin/setup-rancher-page-fields?password=YOUR_ADMIN_PASSWORD
```
Creates: 21 rancher page fields including Slug, Page Live, Logo URL, pricing, payment links, click counters

### Step 2: Set environment variables in Vercel
Go to Vercel dashboard > Settings > Environment Variables. Confirm these are set:
- [ ] `AIRTABLE_API_KEY`
- [ ] `AIRTABLE_BASE_ID`
- [ ] `RESEND_API_KEY`
- [ ] `TELEGRAM_BOT_TOKEN`
- [ ] `TELEGRAM_ADMIN_CHAT_ID`
- [ ] `ANTHROPIC_API_KEY`
- [ ] `JWT_SECRET` (change from default)
- [ ] `CRON_SECRET`
- [ ] `ADMIN_PASSWORD`
- [ ] `SEND_DOMAINS` (e.g., `buyhalfcow.com`)

### Step 3: Set up Cal.com webhook
1. Go to Cal.com > Settings > Webhooks
2. Add new webhook URL: `https://buyhalfcow.com/api/webhooks/cal`
3. Subscribe to events: `BOOKING_CREATED`, `BOOKING_CANCELLED`, `BOOKING_RESCHEDULED`
4. Save

### Step 4: Verify DNS / Email Authentication
For each domain in `SEND_DOMAINS`:
1. Go to Resend dashboard > Domains
2. Check DKIM status: should show 3 green checkmarks
3. Check SPF record in DNS: `v=spf1 include:amazonses.com ~all`
4. If DKIM shows pending, wait 24-48 hours and recheck

**Test DKIM propagation:**
```bash
dig CNAME resend._domainkey.buyhalfcow.com
```
Should return a CNAME pointing to Resend's DKIM key.

### Step 5: Test email deliverability
1. Send yourself a test email from the admin dashboard
2. Check: did it land in inbox or spam?
3. Check email headers for: DKIM pass, SPF pass, replyTo present, List-Unsubscribe present
4. Use mail-tester.com: send to the test address they give you, score should be 9/10 or higher

### Step 6: Test the full flow
1. Submit a test buyer form on buyhalfcow.com
2. Wait for batch-approve cron (or trigger manually)
3. Verify: approval email received, magic link works, drip sequence starts
4. Check Telegram: notification came through
5. Approve the match in Telegram
6. Verify: intro email sent to both buyer and rancher

### Step 7: Verify cron jobs are running
Go to Vercel dashboard > Crons tab. Confirm all 7 crons show recent execution times and no errors.

---

## APPENDIX: TELEGRAM COMMAND QUICK REFERENCE

| Command | Description |
|---------|------------|
| `/pending` | Show all pending buyer-rancher matches |
| `/stats` | Pipeline overview: total buyers, ranchers, referrals, revenue |
| `/capacity` | Show ranchers near or at capacity |
| `/qualify` | AI reviews 3 pending leads with approve/reject/watch buttons |
| `/brief` | AI-generated priority action list for today |
| `/chasup` | Find stalled referrals, draft re-engagement emails |
| `/draft followup [name]` | AI drafts follow-up email for a specific buyer |
| `/draft campaign [segment] [topic]` | AI drafts broadcast email for a segment |
| `/setuppage [name or email]` | Interactive rancher landing page wizard |

## APPENDIX: TELEGRAM CALLBACK PREFIXES

For anyone debugging the Telegram bot, these are all active callback prefixes:

| Prefix | Purpose |
|--------|---------|
| `approve_` | Approve buyer-rancher match |
| `reject_` | Reject buyer lead |
| `reassign_` | Reassign buyer to different rancher |
| `assignto_` | Pick specific rancher for reassignment |
| `details_` | View buyer details |
| `capprove_` | Approve consumer directly |
| `creject_` | Reject consumer |
| `cdetails_` | Consumer details |
| `ronboard_` | Send rancher onboarding |
| `qapprove_` | AI qualify: approve |
| `qreject_` | AI qualify: reject |
| `qwatch_` | AI qualify: watch list |
| `chasend_` | Send chase-up email |
| `chaskip_` | Skip chase-up |
| `draftfollowup_` | Email draft actions |
| `bcsend_` | Send broadcast email |
| `bccancel` | Cancel broadcast |
| `spf_` | Setup page field edit |
| `spgolive` | Setup page: go live |
| `sppreview` | Setup page: preview |
| `spdone` | Setup page: done |

---

*This document is the single source of truth for BuyHalfCow operations. Keep it updated as the platform evolves.*
