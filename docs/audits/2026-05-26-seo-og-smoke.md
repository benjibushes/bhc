# SEO OG Meta Smoke — 2026-05-26

Static analysis of OG meta tags on 14 paid-ad-eligible surfaces (stage-3-verticals).

## Results

| Path | OG Meta | Source |
|---|---|---|
| / | PRESENT | layout.tsx |
| /map | PRESENT | page.tsx |
| /wins | PRESENT | page.tsx |
| /ranchers | PRESENT | page.tsx |
| /founders | PRESENT | page.tsx |
| /brand-partners | PRESENT | page.tsx |
| /access | PRESENT | layout.tsx |
| /faq | PRESENT | layout.tsx |
| /about | PRESENT | page.tsx |
| /privacy | PRESENT | page.tsx |
| /terms | PRESENT | page.tsx |
| /partner | PRESENT | layout.tsx |
| /land | PRESENT | layout.tsx |
| /news | PRESENT | layout.tsx |

## Verdict

- [x] PASS — 14/14 paths have OG meta tags configured
- [ ] PARTIAL — OG meta incomplete

## Notes

All paid-ad-eligible surfaces confirmed with `openGraph:` metadata blocks. No gaps detected. Sitemap audit (Task B4) confirmed all 14 routes present in `app/sitemap.ts`.
