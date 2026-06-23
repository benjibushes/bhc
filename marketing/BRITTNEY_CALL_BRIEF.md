# Brittney Collaboration — 11 CT Call Brief

**Status:** Active collaboration launching this week.
**Owner:** Benji
**Last updated:** 2026-05-13

---

## Pre-call prep (5 min before)

1. **Create her affiliate record** (admin only):
   ```bash
   curl -X POST https://www.buyhalfcow.com/api/admin/affiliates \
     -H "Content-Type: application/json" \
     -H "Cookie: bhc-admin-auth=YOUR_ADMIN_JWT" \
     -d '{"name":"Brittney <LAST>","email":"BRITTNEY_EMAIL"}'
   ```
   Response returns `code`, `buyerLink`, `rancherLink`. Save these.

2. **Pull her links** (also available later via her /affiliate dashboard after she sets a magic-link login):
   - Buyer link: `https://www.buyhalfcow.com/access?ref=CODE`
   - Rancher link: `https://www.buyhalfcow.com/partner?ref=CODE`

3. **Merch link:** current Sackett URL (paste before call). Migration to own Shopify is queued.

---

## Call agenda (15–20 min target)

| Time | Topic | Goal |
|---|---|---|
| 0–2 | Warm open, confirm launch window | Lock launch date/time |
| 2–6 | Walk her through affiliate dashboard + how links track | She understands the attribution loop |
| 6–10 | Content plan: post format, IG story sequence, hashtags, CTAs | Aligned creative direction |
| 10–13 | Commission split / barter terms (whatever you agreed) | Written confirmation in follow-up email |
| 13–16 | Tracking + reporting cadence (weekly DM check-in?) | Reporting rhythm set |
| 16–20 | Open questions, asks from her | Surface blockers early |

---

## Talking points

**The hook:** Brittney sells the **mission** — connecting families directly to ranchers — not "cheap beef." Frame: "I cut grocery out of my beef supply and met the rancher behind it. Here's what changed."

**What she gets:**
- Unique affiliate code → 10% commission on any closed deal her audience drives (mirror your rancher commission so unit econ stays clean — confirm exact %)
- Personal rancher-story content angles BHC will supply
- Her own landing in your CRM = trackable lead funnel

**What you ask of her:**
- 1 launch post + 3-day IG story sequence
- Tag @buyhalfcow + use her affiliate buyer link in bio
- Use UTMs (auto-baked in the `?ref=` link)
- Disclose `#partner` or `#ad` per FTC

**Brand guardrails (do NOT let her say):**
- ❌ "Save money on beef" — D2C is quality/ethics play, not price
- ❌ "Guaranteed leads" or "every state"
- ❌ "Investment" if she touches Founding Herd

---

## Post-call follow-up email (send within 1hr)

```
Subject: BHC affiliate live — your links + next steps

Brittney,

Locked in. Here's everything from our call:

Your affiliate links:
- Buyer: https://www.buyhalfcow.com/access?ref={CODE}
- Rancher: https://www.buyhalfcow.com/partner?ref={CODE}

Dashboard (set login via magic link):
https://www.buyhalfcow.com/affiliate

Merch link to drop in stories:
{MERCH_URL}

Commission terms confirmed:
- {X}% on closed buyer deals attributed to your link
- Paid {monthly / on close} via {method}

Launch plan:
- Launch post: {date}
- Story sequence: {dates}
- Tag @buyhalfcow + disclose #partner

Tracking:
- All clicks + conversions land in your /affiliate dashboard
- I'll DM weekly with a quick rollup

Brand rules quick ref:
- Sell the mission (D2C, rancher connection, quality + ethics)
- Don't position as "save money"
- Don't reference Founding Herd as investment

Anything else you need — ranch story angles, b-roll, comp shot ideas — text me.

Benji
```

---

## Tracking sheet structure (Airtable view or Google Sheet)

| Field | Source |
|---|---|
| Affiliate name | Brittney {LAST} |
| Code | from /api/admin/affiliates response |
| Launch post date | manual |
| Post URL | manual |
| Story slot dates | manual |
| Clicks (buyer link) | Airtable Affiliates table filter |
| Buyer leads attributed | Consumers WHERE `Referred By = CODE` |
| Closed deals | Consumers WHERE Status=Closed AND Referred By=CODE |
| Revenue attributed | sum of closed × avg order |
| Commission owed | revenue × {X}% |
| Notes | freeform |

Already supported by `/api/affiliate/dashboard` — just pull weekly screenshot or build a `/admin/affiliates/{id}` view if you want owner-side visibility.

---

## After-call todos

- [ ] Send follow-up email (template above)
- [ ] Add tracking row to weekly review
- [ ] Schedule day-7 check-in DM
- [ ] If she's posting from a 200k account, confirm sweepstakes legal disclaimers ride along (NO PURCHASE NECESSARY etc.) — only relevant if this collab is the sweepstakes vehicle
