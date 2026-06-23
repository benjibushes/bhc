---
name: bhc-marketing
description: Generate BuyHalfCow marketing copy — Twitter threads, IG captions, founder letter sections, email bodies, landing-page sections, founder-letter blurbs, brand-partner outreach, rancher onboarding posts, case-study social posts. Use this skill whenever the user asks for any kind of BHC promotional or marketing content, even when they don't say "marketing" — phrases like "write a post about [ranch]", "generate a tweet thread for the founders launch", "draft an IG caption", "write the welcome email for X", "make copy for [campaign]", "/bhc", "/bhc-marketing", "draft a founder letter", "case-study blurb for [ranch]", or any request to produce BuyHalfCow brand voice content all qualify. Pulls voice, audience, funnel stage, anti-patterns, and stats from docs/BHC.md as the single source of truth and applies channel-specific patterns.
---

# BHC Marketing Skill

Generate marketing copy for BuyHalfCow. Single source of truth is
`docs/BHC.md`. Read it first, every time. Voice, audience segments, funnel
stages, NO-words, anti-patterns, stat library, and templates all live there.

The skill is the procedure that turns "write a tweet about Sackett's first
close" into a publish-ready post that follows the brand voice without
drifting. Don't try to remember BHC.md across invocations — each marketing
piece deserves a fresh read because the doc evolves.

## Procedure

### Step 1 — Read BHC.md fresh

Locate the canonical doc. Search order:

1. `docs/BHC.md` (relative to repo root if cwd is inside the repo)
2. `.claude/worktrees/throttle/docs/BHC.md` (when working from a worktree)
3. `/Users/benji.bushes/BHC/untitled folder/bhc/.claude/worktrees/throttle/docs/BHC.md` (absolute fallback)

Read the file. Don't summarize from memory — load the current state.

If you can't find it, ask the user where it is. Don't proceed without it.

### Step 2 — Classify the request

Pull these three from the user's prompt:

- **Audience segment** — `buyer` · `rancher` · `founder` · `brand`
  - "tweet about a rancher closing" → buyer (the audience reading the tweet wants beef)
  - "founder letter draft" → founder (existing backers)
  - "outreach to a brand" → brand
  - "rancher onboarding post" → rancher
- **Funnel stage** — `TOFU` (awareness) · `MOFU` (consideration) · `BOFU` (close)
  - Social discovery posts → TOFU
  - Case studies, comparison content, "see the wall" → MOFU
  - Direct CTAs ("claim your spot", "book the call", "take the quiz") → BOFU
- **Channel** — `Twitter` · `IG` · `email` · `landing-page` · `LinkedIn` · `founder-letter`
  - Default to Twitter if user says "post" with no channel
  - Default to email if user says "draft a follow-up"
  - Ask if genuinely ambiguous

If the user's request mixes segments (e.g., "founder + brand crossover post"),
pick the primary segment and add a note in the output explaining the
secondary read.

### Step 3 — Pull live stats (optional but preferred)

The BHC.md "STAT LIBRARY" section names the live endpoints. If the copy
benefits from a current number ("X verified ranchers", "Y closed deals",
"Z buyers waiting in MT"), fetch it before writing:

```bash
# Live network-wide stats
curl -s https://www.buyhalfcow.com/api/stats/public

# Buyers waiting in a specific state
curl -s "https://www.buyhalfcow.com/api/stats/buyers-by-state?state=MT"
```

Local dev fallback: replace host with `http://localhost:3456` if working
against a dev server.

If the API is unavailable or returns an error, fall back to the most recent
numbers the user has provided in conversation OR explicitly mark the stat
as a placeholder (`[PULL CURRENT COUNT]`) so the user fills it in before
publishing. Never invent numbers.

### Step 4 — Apply channel pattern from BHC.md

`SOCIAL TEMPLATES` and `EMAIL TEMPLATES` sections of BHC.md hold canonical
patterns. Match the channel:

| Channel | Pattern reference in BHC.md |
|---------|------------------------------|
| Twitter / X | "Twitter / X — case study post" or "founder backer announcement" |
| Instagram | "Instagram — rancher onboard reel caption" or "buyer testimonial reel" |
| Email | EMAIL TEMPLATES section — extend an existing function in `lib/email.ts`, don't write a new transactional email |
| Landing-page | Match the design-system patterns from `/founders` or `/brand-partners` |
| Founder letter | Long-form, conversational, lowercase opener, mission line once, "— Ben" sign-off |
| LinkedIn | More formal but still founder-led; bullets OK; max 3 paragraphs |

If no pattern in BHC.md fits, write fresh but stay rigidly within voice rules.

### Step 5 — Voice + anti-pattern guard

After drafting, scan the output against BHC.md's "BRAND VOICE" and
"ANTI-PATTERNS" sections. Reject and regenerate if any of these appear:

- **NO-words**: synergy, disrupt, ecosystem, stakeholder, curate, craft (verb), journey, revolutionary (the noun "revolution" is OK), platform-as-a-service, powered by, best-in-class, seamless, holistic
- **Fake scarcity** ("Last chance!" — Founding 100 IS capped at 100, that's the only honest scarcity)
- **"Guaranteed leads"** or any volume promise — routing depends on buyer demand
- **Anti-grocery-chain mass marketing** — the founder voice can frame the Tyson/feedlot model in long-form letters, but mass-market posts stay positive (we're FOR ranchers + families, not against any specific company)
- **"We" when "I" is true** — Ben writes Ben's voice. "We" is OK for the network ("we route them", "we send intros") but never for first-person founder takes ("we believe" → "I believe")
- **ALL CAPS subject lines** or emoji-stuffed openers
- **Buyer real names** — first initial + last initial + state only

### Step 6 — Cite source URL

Every piece of marketing copy points at a conversion surface. Pull the URL
from BHC.md's "KEY URLS" table:

| Asset type | Default URL |
|------------|-------------|
| Buyer-targeted social | `https://www.buyhalfcow.com/access` |
| Rancher-targeted social | `https://www.buyhalfcow.com/map/add-a-rancher` |
| Founder-targeted social | `https://www.buyhalfcow.com/founders` |
| Brand-targeted | `https://www.buyhalfcow.com/brand-partners` |
| Case-study post | `https://www.buyhalfcow.com/ranchers/[slug]` |
| Wins page | `https://www.buyhalfcow.com/wins` |
| Map | `https://www.buyhalfcow.com/map` |

For Instagram captions, write "link in bio" instead of pasting the URL.

### Step 7 — Sign emails

If channel is email, sign `— Ben` (or `— Benjamin` for more formal contexts
like founder letters / brand partner outreach). Never `— The BuyHalfCow
Team`. Always include the existing email infrastructure path:

> Email production code lives in `lib/email.ts`. If this is a transactional
> or recurring email (welcome, drip, intro, invoice), extend an existing
> function — don't ship a new one. List the function name to extend.

For one-off broadcast emails (founder letter, brand outreach), draft as
plain HTML or markdown for Ben to send manually via the broadcast tool or
Telegram `/broadcast` command.

### Step 8 — Deliver + offer iteration

Output the copy in a fenced code block (or markdown for long-form). Then
offer one of:

- "Tighter / shorter / punchier?"
- "Different angle?"
- "Generate a thread / carousel from this?"
- "Translate to email format?"

Don't volunteer an "explanation" of the copy — Ben reads it, ships it.

## Quick references

### Audience segment cheat sheet

If the request mentions… → segment is…
- "ranchers" / "rancher partners" / "operators" → **rancher**
- "buyers" / "families" / "customers" / "members" → **buyer**
- "backers" / "Founding 100" / "Title Founders" / "donors" → **founder**
- "sponsors" / "brands" / "advertisers" → **brand**

### Channel cheat sheet

If the request mentions… → channel is…
- "tweet" / "thread" / "X post" → **Twitter**
- "reel" / "story" / "caption" / "carousel" → **IG**
- "email" / "send" / "blast" / "newsletter" → **email**
- "section for [page]" / "headline" / "hero copy" → **landing-page**
- "letter to backers" / "monthly update" / "drop" → **founder-letter**
- "post for LinkedIn" / "article" → **LinkedIn**

### When to ask for clarification

Ask if:
- The request is ambiguous between two segments (rare — usually clear from context)
- A specific rancher/state/buyer is named but not findable in Airtable
- The user asks for a stat that's not in the live endpoint
- The user requests something the brand explicitly forbids (e.g., "cold email for our 99% guaranteed lead service") — push back politely and offer the on-brand version

### When NOT to ask

Don't ask:
- Channel — pick a sensible default and let the user redirect
- Funnel stage — infer from context
- Length — default to short (Twitter ≤280 chars per tweet, IG ≤220 word caption, email ≤300 words)

## Examples

**Example 1 — Twitter case study post**

User: "write a tweet for AU Beef hitting 5 closed deals"

Output:
```
🎯 AU Beef (GA) just hit 5 closed deals on the network.

4th-generation Black Angus, sold direct to Georgia families who want real beef.

If you're in GA — link below.

https://www.buyhalfcow.com/ranchers/au-beef
```

**Example 2 — IG rancher onboard reel caption**

User: "ig caption for high lonesome going live"

Output:
```
The High Lonesome Ranch just joined the network.

National-park-scale landscape on the spine of the Colorado Rockies. Beef raised the way the Rockies make you raise it — slow, careful, no shortcuts.

If you're in CO and want what families on the front range eat — link in bio.

#realbeef #d2cbeef #coloradobeef #buyhalfcow
```

**Example 3 — founder letter draft**

User: "draft this month's founder letter — focus on the new self-submit flow and 7 verified ranchers"

Output (long-form, founder voice):
```
hey — Ben here.

Quick read this month. Two updates worth your time.

1. We launched the self-submit flow.

Any rancher in America can now drop themselves on the public discover map at /map/add-a-rancher and run through a 5-minute self-serve onboarding wizard. No more 30-min calls required to onboard. They land, fill in their page, sign the agreement inline, and they're live the same session. Boom-boom-bam.

This was the biggest friction point we had. Manual onboarding was eating ~5 days per rancher. Now it's minutes. The fan-flag version is wired too — you can flag a rancher you know and we'll reach out to them directly with your name attached.

2. The map has 7 verified ranchers, growing weekly.

[X] families are searching for beef in those states right now. Every yellow pin we onboard means more closed deals, more commission, more proof.

The food revolution doesn't happen unless ranchers win.

Talk next month.

— Ben
```

Note: `[X]` is a placeholder — pull from `/api/stats/public` before sending.

**Example 4 — brand partner outreach email**

User: "outreach email for a regen-supplement brand"

Output:
```
Subject: brand partnership — buyhalfcow + [brand]

Hey [name],

Ben from BuyHalfCow here. We connect families directly to verified D2C ranchers — beef shares, no middleman, 10% commission only on closed deals.

Saw [brand] doing regen-aligned supplements. Caught my eye because the rancher partners we onboard buy minerals + tonics regularly and our buyer audience overlaps yours hard.

Three brand-partner tiers, simple structure: $99/mo Spotlight, $499/mo Featured, $2,500/quarter Co-marketed. Logo placement, founder-letter inclusions, IG mentions, and (at the top tier) co-branded campaigns + product placement in our rancher photo shoots.

If interested, here's the page: https://www.buyhalfcow.com/brand-partners

Or reply and we can hop on a 20-min call to see if we're a fit. We gate carefully — we've walked away from 2 sponsors already because the fit wasn't right.

— Benjamin
```

(Sign as Benjamin in formal-outbound contexts; Ben in casual.)

## Why this skill exists

BuyHalfCow has a strong brand voice that drifts fast under pressure. When
Ben needs to ship 10 posts in a week, manual brand-policing eats the
gains. This skill encodes the voice + the funnel logic + the anti-patterns
in one repeatable procedure. Output is publish-ready, not "draft for
review."

The skill is intentionally lean. BHC.md does the heavy lifting. SKILL.md
just executes the procedure consistently.
