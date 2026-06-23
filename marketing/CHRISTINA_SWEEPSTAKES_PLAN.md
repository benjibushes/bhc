# BHC Half-Cow + Freezer Sweepstakes — Execution Plan

**Lead collaborator:** Christina ({200k IG, confirm handle})
**Trigger:** Christina's 200k follower celebration
**Sponsor of record:** Buy Half Cow LLC
**Status:** Draft v1 — pending Christina sign-off + final asset/date inputs

---

## TL;DR

- **Prize:** 1× half cow (~150 lbs, ~$1,200 ARV) + 1× chest freezer (~$500–1,500 ARV). Total ARV: **~$1,700–$2,700.**
- **Entry mechanic:** BHC hat purchase = 1 entry. **AMOE (free entry) required** to keep this legal — free online form at `/sweepstakes/enter` (1 entry per person per day).
- **Promo window:** {start} → {end} (recommend 30 days)
- **Eligibility:** US 50 states + DC, 18+, void where prohibited
- **Winner draw:** random selection from all eligible entries within 7 days of close. 1099 issued (ARV > $600).
- **Compliance carrier:** every promo asset displays short rules + "No purchase necessary."

---

## Why this works for Christina's 200k celebration

- **Gift to her audience** = retention play, not transactional
- BHC absorbs prize cost (half cow via partner rancher trade-for-exposure; freezer either sponsored or BHC-bought)
- Christina's flat-fee or commission is a separate line, doesn't touch sweepstakes mechanics
- Her audience converts on two fronts: hat sales (revenue) + AMOE entries (email leads → marketplace funnel @ $120 avg commission per closed deal)

---

## Legal foundation (recap)

**The rule:** In US sweepstakes law, a promo with **prize + chance + consideration** = a lottery (illegal). Requiring a hat purchase to enter = consideration. Fix: offer an **Alternative Method of Entry (AMOE)** — free, equally-weighted entry path.

**AMOE for this campaign:**
- Free online form at `/sweepstakes/enter`
- One entry per person per day (matches paid entry weight; 1 hat = 1 entry)
- No purchase, no fee, no data sale required for AMOE entry

**ARV math keeps us out of state registration:**
- NY, FL, RI require sweepstakes registration only above $5k ARV
- We're at $1.7–2.7k → no registration needed
- Still must publish Official Rules + offer AMOE

**Instagram-specific:** Christina's post must:
- Disclose `#ad` or `#partner` (FTC)
- Include "NO PURCHASE NECESSARY. See rules at buyhalfcow.com/sweepstakes/rules"
- Note "Not affiliated with or endorsed by Instagram/Meta"

---

## Mechanics

### Entry methods (both run concurrently)

| Method | Action | Entries |
|---|---|---|
| Paid | Buy 1× BHC hat at `{merch URL}` | 1 entry per hat purchased |
| AMOE | Submit free form at `buyhalfcow.com/sweepstakes/enter` | 1 entry per day per person |

Both methods feed the same Airtable table → single random draw.

### Eligibility

- US residents, 50 states + DC
- 18+ at time of entry
- Excluded: employees of Buy Half Cow LLC, immediate family, anyone living in same household
- Void where prohibited by law

### Winner selection

- Random draw within 7 days of promo close
- Random.org or `Math.random()` over indexed entry list (document the method)
- Winner notified via email + IG DM
- Must claim within 7 days or alternate winner drawn
- Winner provides W-9 for 1099 (ARV > $600)

### Prize fulfillment

- **Half cow:** delivered via partner rancher (confirm: who? ZK? HL? Renick?). Sponsor coordinates ship to winner's location (excluding AK/HI for logistics — note in rules)
- **Freezer:** ship from {Home Depot / Lowe's / Amazon} to winner's address — model `{TBD, ~7 cu ft chest}` ARV $X

---

## Assets to build

### 1. `/sweepstakes` landing page (Next.js route)

**URL:** `https://www.buyhalfcow.com/sweepstakes`

**Sections:**
- Hero: "Win a Year of Beef. Plus the Freezer to Hold It."
- Prize breakdown (half cow + freezer w/ ARV)
- 2 entry paths: "Buy a Hat" (CTA → merch) + "Free Entry" (CTA → /sweepstakes/enter)
- How it works (3-step visual)
- Christina's intro video or quote block
- FAQ (5 questions)
- Short rules + link to Official Rules
- Footer disclaimers

### 2. `/sweepstakes/enter` AMOE form route

- Fields: name, email, zip, age confirm (18+), checkbox: "I have read and agree to Official Rules"
- POST to `/api/sweepstakes/enter`
- Rate limit: 1 entry per email per 24hr (server-side enforcement)
- Confirmation: "You're in. One entry recorded. Come back tomorrow for another."
- Email confirmation via Resend

### 3. `/sweepstakes/rules` Official Rules page

- Full Official Rules doc (template below) — static page, indexable

### 4. `/api/sweepstakes/enter` API route

- Validate input + rate limit
- Write to Airtable table `Sweepstakes Entries` (new table — see schema below)
- Send confirmation email
- Return 200 / 429 / 400

### 5. Airtable schema: `Sweepstakes Entries`

| Field | Type | Notes |
|---|---|---|
| Entry ID | Autonumber | PK |
| Name | Single line | |
| Email | Email | indexed |
| Zip | Single line | |
| Age Confirm | Checkbox | must be true |
| Entry Method | Single select | `AMOE` / `Hat Purchase` |
| Hat Order ID | Single line | nullable, links to merch order |
| Source | Single line | UTM/ref code (Christina = `christina200k`) |
| Created At | Created time | |
| IP Hash | Single line | optional, for fraud dedupe |
| Eligible | Checkbox | default true, manual flag if disqualified |
| Drawn | Checkbox | for winner tracking |
| Winner | Checkbox | |

### 6. Shopify (or Sackett until migrated) webhook

- On hat order completion: POST entry to `/api/sweepstakes/enter` with `Entry Method = Hat Purchase`, hat order ID, customer email
- Until Shopify migration: weekly CSV import from Sackett

### 7. Promo asset stack

| Asset | Owner | Notes |
|---|---|---|
| Christina launch post (single + carousel) | Christina | Disclosure + short rules in caption |
| Christina IG story sequence (4-7 frames) | Christina | Day 1 reveal, day 3 reminder, day 7 final |
| BHC mirror posts (3) | Benji | Repost Christina + 2 originals |
| Email blast to BHC list | Benji | Day 1 + day 21 reminder |
| ManyChat flow trigger | Benji | "Sweepstakes" keyword → entry CTA |
| Press / podcast outreach | optional | "200k creator running ethical beef giveaway" angle |

---

## Promo copy (drafts)

### Christina launch post caption (short)

> Hit 200k. So I'm giving one of you a literal *year of beef.* 🐄
>
> @buyhalfcow + I are putting up:
> - 1× half cow from a verified D2C ranch (150 lbs, freezer-ready)
> - 1× chest freezer to keep it in
>
> Two ways in:
> 1. Cop a BHC hat (link in bio) — every hat = 1 entry
> 2. Free entry at buyhalfcow.com/sweepstakes/enter — daily
>
> Winner drawn {date}. US 18+. No purchase necessary. See official rules at buyhalfcow.com/sweepstakes/rules. Not affiliated with Instagram.
>
> #partner #buyhalfcow

### BHC mirror caption (announcement)

> Christina @{handle} just hit 200k — and she wanted to give back to the people who got her here.
>
> So we're putting up:
> - A half cow, sourced direct from a verified rancher
> - The freezer to hold it
>
> Hat = entry. Or enter free at the link in bio.
>
> Christina built her audience on real food + real stories. This is what that looks like delivered.
>
> #partner #buyhalfcow

### Email blast subject lines (A/B)

- A: "We're giving away a year of beef. (And the freezer.)"
- B: "Christina hit 200k. Here's the prize."

### ManyChat trigger

- Keyword: `sweepstakes`, `giveaway`, `half cow`, `freezer`
- Reply: "🐄 Win a half cow + freezer. Tap below for two ways to enter — no purchase needed for free entry. [Enter Free] [Get a Hat]"

---

## Official Rules — template

```
OFFICIAL RULES — BUY HALF COW × CHRISTINA HALF COW + FREEZER SWEEPSTAKES

NO PURCHASE NECESSARY TO ENTER OR WIN. A PURCHASE WILL NOT INCREASE
YOUR CHANCES OF WINNING. VOID WHERE PROHIBITED.

1. SPONSOR. Buy Half Cow LLC, {street address}, {city, state ZIP}
   ("Sponsor").

2. ELIGIBILITY. Open to legal residents of the 50 United States and
   the District of Columbia who are 18 years of age or older at the
   time of entry. Employees, officers, directors, and immediate family
   members of Sponsor are not eligible. Void in Puerto Rico and where
   prohibited by law.

3. PROMOTION PERIOD. Begins {start date+time TZ} and ends {end
   date+time TZ} ("Promotion Period"). Sponsor's clock is the official
   timekeeper.

4. HOW TO ENTER.
   (a) PURCHASE ENTRY: Purchase one (1) BHC hat at {merch URL} during
       the Promotion Period. Each hat purchased = one (1) entry.
   (b) FREE METHOD OF ENTRY (AMOE): Visit
       https://www.buyhalfcow.com/sweepstakes/enter during the
       Promotion Period and complete the entry form (name, email,
       ZIP, age confirmation). One (1) free entry per person per
       24-hour period.

   Limit: A maximum of one (1) free entry per person per day. Hat
   purchases are not limited. Each entry method has equal weight in
   the winner drawing.

5. PRIZE. One (1) Grand Prize: half cow (~150 lbs frozen beef cuts;
   ARV $1,200) plus one (1) chest freezer (model {TBD}; ARV ${TBD}).
   Total ARV: approximately ${TOTAL}.

   Prize is non-transferable. No cash or substitution except by
   Sponsor due to availability, in which case a prize of equal or
   greater value will be substituted.

6. WINNER SELECTION. Within seven (7) days after the Promotion Period
   ends, Sponsor will conduct a random drawing from among all
   eligible entries received.

7. WINNER NOTIFICATION. Potential winner will be notified by email
   and direct message. Potential winner must respond within seven (7)
   days to claim. If potential winner does not respond, Sponsor may
   draw an alternate winner.

8. CLAIM REQUIREMENTS. Winner must complete and return an Affidavit
   of Eligibility, Liability Release, and (where lawful) Publicity
   Release, and IRS Form W-9, within fourteen (14) days of
   notification. Failure to comply = forfeiture; alternate winner
   may be drawn.

9. TAXES. Winner is responsible for all federal, state, and local
   taxes. Sponsor will issue IRS Form 1099-MISC for the ARV of the
   prize.

10. PUBLICITY. Except where prohibited by law, acceptance of the
    prize constitutes consent for Sponsor to use winner's name,
    likeness, voice, hometown, and entry for advertising purposes
    without further notice or compensation.

11. RELEASE. By entering, each entrant releases Sponsor, its
    affiliates, employees, agents, and representatives from any
    liability arising from participation in the promotion or
    acceptance/use of the prize.

12. INSTAGRAM DISCLAIMER. This promotion is in no way sponsored,
    endorsed, administered by, or associated with Instagram or Meta.
    Each entrant releases Instagram and Meta from any and all
    liability.

13. WINNER LIST. For the name of the winner, send a self-addressed
    stamped envelope to: Buy Half Cow LLC, Attn: Sweepstakes Winner,
    {address}, after {end date + 30 days}.

14. GOVERNING LAW. This promotion is governed by the laws of the
    State of {state of formation} without regard to its conflict of
    laws principles.

15. PRIVACY. Information collected from entrants is subject to
    Sponsor's privacy policy at https://www.buyhalfcow.com/privacy.
```

---

## Timeline (assumes 30-day window)

| Day | Action | Owner |
|---|---|---|
| T-7 | Christina sign-off on plan + draft assets | Christina + Benji |
| T-5 | Build `/sweepstakes`, `/sweepstakes/enter`, `/sweepstakes/rules` pages | Eng |
| T-4 | Airtable Sweepstakes Entries table created | Benji |
| T-3 | Hat order webhook → entry API wired | Eng |
| T-2 | Email confirm template in Resend | Benji |
| T-1 | Soft test: enter from staff email, confirm Airtable row + email | Benji |
| T-0 | Christina launch post | Christina |
| T+0 | BHC mirror posts + email blast | Benji |
| T+3 | Story reminder | Christina |
| T+7 | BHC week-1 update post | Benji |
| T+15 | Mid-promo email + ManyChat boost | Benji |
| T+21 | Final-week countdown content | Both |
| T+28 | "Last 48 hours" push | Both |
| T+30 | Close. Pull entries from Airtable. | Benji |
| T+33 | Random draw. Notify winner. | Benji |
| T+37 | Winner W-9 + claim form in. | Benji |
| T+40 | Schedule shipments (half cow + freezer) | Benji + rancher |
| T+45 | Winner announcement post (Christina + BHC) | Both |
| Q+ | 1099 issued at year-end | Benji + CPA |

---

## What I need from you before this ships

1. ✅ Confirm Christina is the 200k collaborator
2. Her IG handle
3. Final launch date
4. Freezer model + supplier (sponsor / BHC buys / Amazon link)
5. Which rancher fulfills the half cow (ZK / HL / Renick / other)
6. Christina's compensation structure (flat / commission / barter) — separate from sweepstakes legal but I need to keep her affiliate code line clean
7. Hat product page final URL
8. BHC LLC mailing address (for Official Rules block)
9. State of LLC formation (governing law clause)
10. Christina's preferred level of involvement in copy review

Once those are in, I can finalize the rules doc + ship the pages to dev.
