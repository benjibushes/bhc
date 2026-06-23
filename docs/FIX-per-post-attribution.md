# FIX BRIEF — Per-post IG attribution (which post drove the close)

**For:** the debugging agent. Self-contained.
**Repo:** this one (Next.js App Router + TypeScript + Airtable).
**Why:** today every Instagram post funnels through one bio link, so we can measure
content *engagement* (IG Insights) but cannot tie a *signup or close* back to the
specific post/reel that drove it. All 16 closes are Instagram-sourced; we just
can't say which reel earned them. Closing this gap turns "what works" from a
likes/reach proxy into real dollar attribution.

> Verify with data, not assumptions. Confirm the existing short-link + UTM capture
> path before adding to it. Ship behind a test that shows the post code lands on
> the Consumer record.

## What already exists (reuse, don't reinvent)

- A short-link redirect already exists (commit d097928, "short-link redirect for
  rancher self-serve setup", `/go/...`). Find it (`app/go/` or a route handler)
  and reuse the pattern.
- Signup already captures UTM + source on the Consumer record. Confirm where:
  `app/api/consumers/route.ts` writes `Source`, `UTM Parameters`, `Campaign`.
  Current IG links arrive as `utm_source=ig&utm_medium=social&utm_content=link_in_bio`.
  The key change: make `utm_content` carry a **per-post code** instead of the
  constant `link_in_bio`.

## The change

1. **Per-post short links.** Generate a unique code per IG post, e.g.
   `buyhalfcow.com/go/r/<code>` → 302 to `/access?utm_source=ig&utm_medium=social&utm_content=<code>`
   (preserve any existing `/go` behavior). One link per reel, swapped into the bio
   (or via a link-in-bio tool) when that reel is the active CTA.
2. **Persist the code.** Ensure `app/api/consumers/route.ts` stores the incoming
   `utm_content` post code on the Consumer (it already stores `UTM Parameters`;
   add a dedicated `Post Code` / `Content ID` field if you want clean rollups).
3. **Report.** Add a simple rollup (extend `/admin/funnel` or a stats endpoint):
   signups and closes grouped by post code → "this reel produced N signups, M
   closes, $X GMV." Join Consumers.PostCode → Referrals (Closed Won) for the $ line.

## Acceptance criteria

- A new IG signup arriving via a per-post link lands with that post code on the
  Consumer record (verify one end-to-end).
- The admin rollup shows signups + closes + GMV per post code.
- No regression to the existing `/go` rancher short links or to current UTM capture.
- PII rule intact: reporting is aggregate; no raw buyer data leaves Airtable.

## Key files

- `app/go/...` (existing short-link redirect — find and extend)
- `app/api/consumers/route.ts` (UTM/source capture on signup)
- `app/admin/funnel` + Airtable Consumers (`UTM Parameters`, `Source`, `Campaign`) + Referrals
- `lib/airtable.ts` (add a field if needed)

---
*Prepared 2026-06-17. Pairs with the conversion-leak brief; do that one first (bigger dollar impact).*
