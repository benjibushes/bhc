# Phase 0 Setup — what Ben needs to do once before this works

Auto-mode shipped the code. Three small one-time setup steps need your hands
on the dashboards (Airtable + Vercel + Resend). Total time: ~10 minutes.

---

## 1. Airtable schema additions (5 min)

Open the BHC Airtable base. Two changes:

### 1a. Add field to **Referrals** table

Field name: `Close Check Sent At`
Type: **Date with time** (datetime)
Why: Tracks last time the close-detector cron sent a check-in card for this
referral. Without this field, the cron will re-fire cards every run instead
of cooling down for 7 days. Code degrades gracefully (logs a warning) but
is louder than ideal.

### 1b. Create new table: **AI Audit Log**

Click "+ Add a table" → "Start from scratch". Name it exactly: `AI Audit Log`.

Fields (in this order):
| Field name        | Type                  | Notes |
|-------------------|-----------------------|-------|
| Timestamp         | Date with time (primary) | The "name" field; primary key |
| Actor             | Single select         | Options: `ai-auto`, `ai-confirmed`, `cron`, `manual` |
| Tool              | Single line text      | Name of the tool/cron/operation |
| Target Type       | Single select         | Options: `Consumer`, `Rancher`, `Referral`, `Inquiry`, `Other` |
| Target ID         | Single line text      | Airtable record ID of the affected record |
| Args              | Long text             | JSON blob of input args |
| Result            | Long text             | JSON blob of result/output |
| Reverse Action    | Long text             | JSON blob describing how to undo |
| Telegram Card ID  | Single line text      | Optional — message_id for undo cards |
| Reverted          | Checkbox              | True if the action was rolled back |

Why: Every AI write logs here with a `Reverse Action` blob describing how to
undo it. Telegram "undo" cards (Phase 1) replay this. Code degrades
gracefully if the table doesn't exist (logs to console only) — but you lose
the rollback safety net until you create it.

---

## 2. Vercel deploy (auto)

The `vercel.json` change registers the new cron `/api/cron/close-detector`
to fire daily at **10 PM UTC** (4 PM MT, 6 PM ET). Once you push:

```bash
git push origin main
```

Vercel auto-detects the cron and registers it. No dashboard step needed.

---

## 3. Resend inbound webhook (5 min — Phase 2 prerequisite)

**Skip this for tonight.** Required when we ship the inbound reply parser
(Phase 2 / MVP item #4) but not blocking Phase 0.

When you're ready: Resend dashboard → **Inbound** → Create endpoint:
- URL: `https://www.buyhalfcow.com/api/webhooks/resend-inbound`
- Forward replies to: `intros@buyhalfcow.com` (or whatever sub-address you choose)

Update DNS: add an MX record pointing the chosen subdomain to Resend's
inbound MX. They show the exact value in the dashboard.

---

## 4. Verification — make sure it works

After Step 1 + Step 2 land:

```bash
# Trigger the cron manually
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://www.buyhalfcow.com/api/cron/close-detector

# Expected response:
# { "ok": true, "posted": N, "candidates_total": M, "warnings": [] }
```

You should receive Telegram cards for up to 15 stale referrals, each with
4 buttons: ✅ Closed Won, ❌ Closed Lost, ⏳ Still working, 🔇 Stop asking.

Tap one. The card should:
- Update Airtable (Status flips, Closed At timestamp set)
- Edit the Telegram message in place to confirm
- Write an `AI Audit Log` row with the reverse action

If something looks off, the audit log shows exactly what happened and how
to roll it back.

---

## 5. What this unblocks

Before this:
- 0 Closed Won across the entire platform — every metric was a guess
- No way to measure conversion rate
- No commission tracking

After this:
- Daily check-in card per stale referral → one tap → Closed Won/Lost recorded
- Audit log captures every AI/manual write with rollback
- Phase 1 can build on top: tiered autonomy, daily audit cron, undo cards
- Phase 2 layers in inbound email parsing for fully-automated close detection

---

## Files shipped this round

| Path | What it does |
|---|---|
| `lib/auditLog.ts` | NEW — audit log + reverse-action helpers |
| `lib/ai.ts` | Prompt caching enabled on system prompts + tool schemas (~90% input token discount on cache hits) |
| `lib/aiTools.ts` | Autonomy tier metadata (`auto` / `confirm` / `forbidden`) for all 14 existing tools |
| `app/api/cron/close-detector/route.ts` | NEW — daily cron posting Telegram check-in cards |
| `app/api/webhooks/telegram/route.ts` | NEW callback handlers `clcheck_won_*`, `clcheck_lost_*`, `clcheck_working_*`, `clcheck_mute_*` |
| `vercel.json` | NEW cron registration for `close-detector` (daily 22:00 UTC) |
