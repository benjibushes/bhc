# BHC Copy Style Guide

Canonical brand-voice rules for every customer-facing string. Distilled from `docs/BHC.md` (marketing throttle reference). Used by the full-site audit (`docs/superpowers/plans/2026-05-20-fullsite-audit-and-remediation.md`).

## Voice rules

**Tone:** Direct, founder-talking-to-rancher. Plain English. No hype words. Rancher-aligned, never coastal-startup. Founder-first signature.

**Sentence patterns:**
- Lead with the verb when possible.
- Two-sentence paragraphs. Three max.
- Numbers concrete: "10%", not "ten percent". "$1,200", not "twelve hundred dollars".
- One CTA per email.
- Sign every email `— Ben` or `— Benjamin`. Never `— The BuyHalfCow Team`.

## YES words

real · direct · family · raised · cut · pasture · grass-fed · network · proof · routed · closed · freezer · ranch · partner · honest

## NO words (never use)

synergy · disrupt · ecosystem · stakeholder · curate · craft (verb) · journey · revolutionary (the noun "revolution" is OK) · platform-as-a-service · powered by · best-in-class · seamless · holistic · delve · robust · comprehensive · foster · multifaceted · leverage (as verb) · unlock · empower · transform · streamline

## Terminology canon

| Use | Not |
|---|---|
| Rancher | Farmer (BHC ranchers raise beef cattle) |
| Buyer | Customer (we're matching, not selling) |
| Half cow | Half a cow |
| Closed Won | Won, sold, completed (Airtable status — never paraphrase) |
| Closed Lost | Lost, ghosted, dead |
| Founding Herd | Founding 100 program — capitalized, always |
| Founders Wall | The public wall — capitalized |
| Title Founder | Tier name — capitalized |
| Outlaw / Steward / Herd | Other tier names — capitalized |
| Quarter / Half / Whole | Share sizes — capitalized when standalone |
| BHC | BuyHalfCow shorthand — only after first mention |

## Sender + signature

- Every transactional email signs `— Ben` or `— Benjamin, BuyHalfCow`.
- Never `— The BuyHalfCow Team`.
- Never `— Sincerely`.
- Sender domain: `ben@buyhalfcow.com` (Resend default) or `hello@buyhalfcow.com` for system-side.

## Subject lines

**Lowercase. Sentence-fragment OK. Specific over clever.**

Good examples (from `docs/BHC.md`):
- `welcome to the founding herd, [name]`
- `[ranch] is on the map — set up your page`
- `commission invoice: [buyer] — [ranch]`
- `your sackett ranch order is ready`
- `we routed sarah k. to you`

Forbidden patterns:
- ALL CAPS
- 🎉 emoji-stuffed openers (one emoji max, only when meaningful)
- "Don't miss out" / "Last chance" / fake urgency
- Anything that sounds like a SaaS launch announcement
- Question marks unless it's a real question to the recipient

## Error messages — canonical pattern

**`<what happened> — <why> — <what to do>`**

Bad: `An error occurred.`
Good: `Couldn't save your changes — Airtable rate-limited us. Try again in 30 seconds.`

Bad: `Invalid input.`
Good: `Email looks malformed — check for typos and re-enter.`

Bad: `Stripe failed.`
Good: `Stripe couldn't process this card — try a different card or contact your bank.`

## Empty states — canonical pattern

**`<what would be here> — <how to make it appear>`**

Bad: `No data.`
Good: `No closed deals yet. When a rancher reports a sale, it shows up here within 5 minutes.`

Bad: `Nothing to show.`
Good: `No ranchers in your state yet. We're working on it — you'll get an email the moment one goes live.`

Bad: `Empty.`
Good: `Your dashboard fills in as deals move through stages. Right now you have 0 referrals.`

## Loading states — canonical pattern

Loading copy should be contextual, not generic.

Bad: `Loading...`
Good: `Pulling your referrals...` / `Fetching the latest from Airtable...` / `Matching you to ranchers...`

## CTA buttons

- Verb + object: `Send the invoice` not `Submit` · `Claim your spot` not `Confirm`
- Title case only on the CTA itself — the line above stays lowercase
- One CTA per card. Secondary action = small text link below.

## One-line pitches (use verbatim where possible)

- **Generic / press:** "BuyHalfCow is the private network connecting families directly to verified ranchers. Real beef, no middleman, 10% commission only on closed deals."
- **Buyer-facing:** "Source beef directly from a real ranch in your state. Quarter, half, or whole. The way local families have been doing it for generations."
- **Rancher-facing:** "We send you pre-screened buyers in your state who are ready to buy a quarter, half, or whole. You close the deal. We take 10%."
- **Mission line:** "We're gonna take back American ranching and agriculture. One family, one rancher, one freezer at a time."

## Em dash policy

No em dashes (—) in NEW copy. Use hyphens (-) or rewrite. Existing transactional emails grandfathered if they're working.

## Audit signal — when reviewing existing copy, flag these

1. Generic "Submit" / "Confirm" / "OK" buttons → suggest verb+object
2. "An error occurred" / "Something went wrong" → demand `what + why + fix` pattern
3. "No data" / "Empty" → demand `what would be here + how to make it appear`
4. Marketing-AI words (delve, robust, foster, etc.) → flag for rewrite
5. `— The BuyHalfCow Team` signatures → fix to `— Ben`
6. ALL CAPS subjects → lowercase
7. Em dashes in new copy → replace with hyphen or rewrite
8. "Half a cow" → "half cow"
9. "Farmer" referring to a BHC rancher → "rancher"
10. "Customer" referring to a BHC buyer → "buyer"

## Source of truth

When this guide conflicts with `docs/BHC.md`, the marketing-throttle reference wins. This file is a compressed lookup for audit subagents; BHC.md is canon.
