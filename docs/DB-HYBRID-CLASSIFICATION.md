# Hybrid DB Architecture — what stays in Airtable, what moves to Supabase

*2026-07-23. Grounded in the live table inventory + cron scan pressure + a
codebase usage audit. Principle: **Airtable = the operator/admin UI + low-volume
reference data. Supabase = OLTP event data + high-volume/high-write tables.**
The hybrid keeps Airtable's no-code grid for exactly the tables Ben hand-edits,
and moves only the tables nobody edits by hand — which is why the hybrid
neutralizes the biggest migration risk (losing the ops UI).*

---

## The signals

**5 req/s hogs — cron full-table scans (getAllRecords in cron files):**
`Referrals ×33 · Ranchers ×32 · Consumers ×19` — these three dominate Airtable
pressure. 62 crons total.

**Volume / growth:** Consumers ~2,600 rows (125 fields) and growing fastest with
ad traffic; Ranchers only ~83 rows (184 fields) but heavily hand-edited;
Referrals 104 fields, money-critical. Append-log tables (Email Sends, Cron Runs,
Funnel Events…) grow unbounded and are **never updateRecord'd** (Email Sends 1,
Cron Runs 1, Funnel Events 0 — pure append).

**Operator-UI dependency:** Ben/ops edit Ranchers, Rancher Prospects, Products,
Campaigns, Brands, Admin Config, Cron Pauses **by hand in the grid daily**. They
never hand-edit Email Sends, Cron Runs, Funnel Events, or individual Consumers.

---

## The classification

### 🟢 STAY in Airtable (operator UI + low-volume reference)
The grid IS the value here — hand-edited, low row count, cache the reads.
| Table | Why stay |
|---|---|
| **Ranchers** (184f, ~83 rows) | THE ops surface — Ben edits status/pricing/rail by hand daily. 83 rows = **cache the 32 cron scans to near-zero** (see Phase 0). |
| **Rancher Prospects** (45f) | outreach machine, operator-managed |
| **Brands, Land Deals, Campaigns, Affiliates** | config/relationship data, hand-managed |
| **Rancher Products / Recommended Products** | operator-curated (Marketplace Approved is a hand check) |
| **Admin Config, Cron Pauses, News** | operator toggles/content |

### 🔵 MOVE to Supabase — Phase 1 (append logs: zero money, zero ops-UI, high write)
Pure OLTP event data. Nobody edits these by hand. Prove the hybrid here first.
`Email Sends · Cron Runs · Funnel Events · Gear Clicks · Stripe Events ·
Deal Events · Agent Log · AI Audit Log · Agent Tasks · Signup Attempts ·
Conversations · Threads · Thread Messages`

### 🔵 MOVE to Supabase — Phase 2 (the growth table)
| Table | Why |
|---|---|
| **Consumers** (~2,600, growing) | the ad/reactivation scale pain; scanned by 13 crons; rarely hand-edited individually. Biggest performance win. |

### 🟡 MOVE to Supabase — Phase 3 (money tables — last, most careful)
`Referrals · Payments · Rancher Orders · Payouts · Add-On Purchases` —
the #1 scan hog (Referrals ×33) AND where real transactions matter (deposits,
commissions). Move only after Phase 1/2 proves the machinery; dual-write +
reconciliation mandatory.

---

## Phase 0 — do this FIRST, regardless (cheapest, might defer the migration)
The acute 5 req/s pain is dominated by `Ranchers ×32` + `Referrals ×33` cron
scans. **Ranchers is 83 rows** — hard-cache the rancher list (extend the #254
Redis cache; the reads are already partially cached) and those 32 scans cost
near-nothing. Tonight's filtered-dedupe already removed the worst offender.
**This alone may buy enough headroom to run Airtable for months** while the
migration happens deliberately. Measure req/s after.

---

## The architecture — a per-table router in the chokepoint
`lib/airtable.ts` already funnels ~2,000 call sites through 5 functions
(`getRecordById`, `getAllRecords`, `createRecord`, `updateRecord`,
`deleteRecord`). Add a per-table backend map:
```
const TABLE_BACKEND = { EMAIL_SENDS: 'supabase', CONSUMERS: 'supabase',
                        RANCHERS: 'airtable', ... }  // default 'airtable'
```
Each of the 5 functions dispatches on `TABLE_BACKEND[table]`. **Callers never
change.** Migrate a table by: (1) create the Supabase table (columns = exact
Airtable field names), (2) dual-write both backends, (3) backfill history,
(4) shadow-read + verify parity for a week, (5) flip the flag to `'supabase'`,
(6) stop dual-writing. filterByFormula → a small translator (45 sites) or move
those queries to SQL. Incremental, reversible, one table at a time.

## Operator UI — the question that decides the whole thing (SOLVED by hybrid)
You keep Airtable for **every table you hand-edit** (Ranchers, Prospects,
Products, config). The Supabase tables (logs, Consumers) are ones you edit
through crons + `/admin`, not the grid — the rare manual edit uses Supabase
Studio or a small `/admin` view. **The hybrid means you never lose your ops
UI** — that was the only genuinely hard part, and this design sidesteps it.

## Recommended order
1. **Phase 0** (cache Ranchers reads) — days, huge relief, no migration risk.
2. **Phase 1** (append logs → Supabase) — proves the router + dual-write on
   zero-risk tables; big write relief.
3. Measure. If pain is gone, stop and bank the win.
4. **Phase 2** (Consumers) when ad-scale demands it.
5. **Phase 3** (money tables) last, with reconciliation.

**Do NOT big-bang.** The chokepoint makes table-by-table the correct, safe path.
