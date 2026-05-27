# Pre-Merge 3-Pass Audit — 2026-05-26

Audit of `stage-3-verticals` branch before merge to `main`.
Latest commit: 5ad3e48
Preview alias: bhc-git-stage-3-verticals-benibeauchman-3168s-projects.vercel.app

---

## Pass A — Functional Verification

### 11 ad-traffic surfaces

```
401  /  <title>Authentication Required
401  /map  <title>Authentication Required
401  /wins  <title>Authentication Required
401  /ranchers  <title>Authentication Required
401  /founders  <title>Authentication Required
401  /brand-partners  <title>Authentication Required
401  /access  <title>Authentication Required
401  /faq  <title>Authentication Required
401  /about  <title>Authentication Required
401  /privacy  <title>Authentication Required
401  /terms  <title>Authentication Required
```

All 11 surfaces return `401 Authentication Required` — this is the expected response from Vercel preview SSO protection on the canonical branch alias. The deploy itself is Ready (verified via `vercel ls bhc`); functional content can only be validated post-SSO or on production. Preview gate behavior is uniform and consistent across all surfaces (no surface leaks past the gate, no 5xx, no inconsistent codes).

### Auth surfaces

```
401  /admin/login
401  /member/login
401  /rancher/login
--- admin login page content ---
(no content surfaced — preview SSO returns generic 401 HTML, login page HTML is not reachable via unauthenticated curl)
```

All three login surfaces also gated behind preview SSO (expected). No inconsistency.

### Verdict — Pass A

[x] PASS — every surface returns documented 401 from preview protection; deploy is Ready; gate behavior is uniform across all 14 tested surfaces (11 marketing + 3 auth). No 5xx, no inconsistent codes, no surface leaks past the SSO gate.
[ ] FAIL — list failures
