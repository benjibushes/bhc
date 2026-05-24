# BHC Operational Transparency + Control System — Design Spec

**Date:** 2026-05-24
**Author:** Ben Beauchman + Claude
**Status:** Approved for implementation
**Estimated effort:** 14-19 hours (single PR overnight feasible)

---

## Problem statement

BHC has grown to 17 ranchers, 1,533 buyers, ~50 API endpoints, 21 crons, ~30 email templates across 14 public pages and 10 Airtable tables. Founder reports two compounding pain points:

1. **Transparency gap** — "I hardly know what I've built" — no consolidated reference for what exists, what fires when, what each surface does.
2. **Control gap** — suspected over-emailing customers, no granular kill switches for specific email templates, no per-Consumer frequency cap, no easy way to audit "who got what email this week."

The result is operational anxiety preventing confident deployment of paid ads ($10k earmarked) and inability to make data-driven decisions about feature removal / optimization. This spec defines the transparency + control foundation. Subsequent specs will tackle UI/UX optimization and conversion rate work using this layer as the source of truth.

---

## Success criteria

The system is considered shipped when:

1. A new contractor could read `docs/SYSTEM-MAP.md` and understand the entire BHC architecture in under 30 minutes.
2. Founder can identify every email a single Consumer received in the past 30 days via one Telegram command.
3. Founder can kill any email template firing by name in one Telegram command, no code deploy required.
4. No Consumer receives more than the configured frequency cap (default 3 emails/week) — enforced at send time, not after.
5. A weekly spam audit Telegram report surfaces top-volume recipients and template usage by Saturday morning.

---

## Architecture overview

Three artifacts plus one always-on guard.

```
┌──────────────────────────────────────────────────────────────────┐
│  ARTIFACT 1 — docs/SYSTEM-MAP.md                                 │
│  Static reference doc. Updated manually when major changes ship. │
│  Sections: pages · endpoints · crons · email templates ·         │
│  Airtable tables · routing logic · Telegram commands             │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  ARTIFACT 2 — Weekly Spam Audit                                  │
│  New cron: spam-audit (Saturday 14:00 UTC)                       │
│  Outputs: Telegram digest + writes to                            │
│  docs/audits/spam-audit-YYYY-MM-DD.md                            │
│  Surfaces: top 20 high-volume recipients · template send counts  │
│  · frequency-cap breaches · suggested template kills             │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  ARTIFACT 3 — Telegram Control Commands (6 new)                  │
│  /emaillog · /pausemail · /resumemail · /freqcap ·               │
│  /templatestats · /whatfired                                     │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  GUARD — Per-Consumer frequency cap (always-on)                  │
│  lib/emailFrequencyGuard.ts — every email send checks recipient's│
│  rolling 7-day count vs cap. 4th send (or whatever cap) silently │
│  suppressed + logged.                                            │
└──────────────────────────────────────────────────────────────────┘
```

---

## Component 1 — `docs/SYSTEM-MAP.md`

### Purpose

Single-page reference that lets the founder (or new contractor) understand the entire BHC system architecture in under 30 minutes.

### Structure

```markdown
# BHC System Map

## 1. Public Pages (14)
For each: URL, purpose, who lands here, where they go next, revenue tier.

## 2. API Endpoints (~50)
Grouped by domain (consumers, ranchers, matching, webhooks, admin, cron).
For each: METHOD /path, what it does, auth required, what it reads/writes.

## 3. Crons (21)
For each: schedule, what it does, what records it touches, what it sends.
Sorted by frequency (hourly first, then daily, then weekly).

## 4. Email Templates (~30)
For each: trigger, recipient type (buyer/rancher/backer), frequency,
revenue tier, kill switch name.

## 5. Airtable Tables (10)
For each: purpose, key fields, who reads/writes, retention.

## 6. Routing Logic
Full buyer-journey diagram + decision tree.

## 7. Telegram Commands (30+)
Grouped: read commands · do commands · email commands · system commands.

## 8. Revenue Streams (6)
Mapped to the surfaces that drive each.

## 9. Known Issues + Deprecated Surfaces
Stuff to clean up or remove.
```

### Format

- Markdown tables for scan-ability
- One-line descriptions, not essays
- Revenue tier column (high / medium / low / zero) on every row
- Status column (live / broken / deprecated) on every row
- Inline links to actual files/endpoints so the doc functions as a hyperlinked TOC for the codebase

### Update cadence

- Initial: written once at ship time
- Ongoing: founder updates when major changes ship
- Future: could be partially auto-generated from a manifest file, but not in this spec

---

## Component 2 — Weekly Spam Audit

### Trigger

New cron `/api/cron/spam-audit`, schedule `0 14 * * 6` (Saturday 14:00 UTC = 7am MT Saturday).

### Process

1. Read Cron Runs table + email-send logs (need new lightweight log — see "Open question" below) for the past 7 days.
2. For each Consumer who received any email past 7d:
   - Count emails received
   - List template names that fired
   - Compute send-cadence (emails per day)
3. Identify top 20 high-volume recipients (>= cap or trending toward it).
4. Per-template aggregate: which templates sent most past 7d.
5. Identify frequency-cap breaches (any Consumer with > cap last 7d).
6. Suggested kills: templates with high send volume + low engagement (need open/click data — see "Open question").

### Outputs

1. **Telegram digest** to operator chat, posted Saturday morning:

```
📊 SPAM AUDIT — Week ending YYYY-MM-DD

Top 20 high-volume recipients:
1. Karie Suarez-Brill — 5 emails (warmup × 2, nudge × 1, founder-letter × 1, intro × 1)
2. Caleb Cunningham — 4 emails ...
...

Templates by volume:
1. sendNudgeToEngage — 47 sends
2. sendRancherLaunchWarmup — 28 sends
...

Frequency-cap breaches: 3 Consumers exceeded 3 emails/week
- See /emaillog <email> for detail

Suggested template kills (low engagement):
- sendRancherCheckIn — 14 sends, 0 opens, 0 clicks → review

Full report: docs/audits/spam-audit-YYYY-MM-DD.md
```

2. **Markdown file** committed to `docs/audits/spam-audit-YYYY-MM-DD.md` — full data table for archival reference.

### New Airtable surface needed

To avoid building a separate email-log database, log every send to a new Airtable table:

**Table: `Email Sends`** (new)

| Field | Type | Purpose |
|---|---|---|
| Sent At | dateTime | Timestamp |
| Recipient Email | email | To address |
| Recipient Consumer | linked | Optional link to Consumer record |
| Template Name | singleLineText | Function name (sendNudgeToEngage etc) |
| Subject | singleLineText | Subject line |
| Status | singleSelect | sent / suppressed / bounced / complained |
| Suppression Reason | singleLineText | If suppressed: cap-hit / unsubscribed / etc |

`lib/email.ts::sendEmail` and every named send helper write to this table after a successful resend.emails.send call. Failure to log is non-fatal (logged to console).

This table also feeds the `/emaillog` Telegram command + frequency guard + template stats.

---

## Component 3 — Telegram Control Commands

### `/emaillog <email-or-name>`

**Returns:** Last 30 days of emails sent to a Consumer.

```
📧 EMAIL LOG — Karie Suarez-Brill (karie.suarez@gmail.com)

Past 30 days (5 emails):
2026-05-22 14:30 — sendIncompleteProfileAsk · "two questions on your beef"
2026-05-19 10:15 — sendNudgeToEngage · "quick question on your WV beef timing"
2026-05-14 10:15 — sendRancherLaunchWarmup · "Renick Valley Meats just went live..."
2026-05-08 10:30 — sendFounderLetterWaiting · "Week 4 — what's happening"
2026-05-03 10:00 — sendRancherLaunchWarmup · "we found you a rancher"

Rolling 7-day count: 2 (within cap of 3)
```

### `/pausemail <template-name>`

**Effect:** Kills the named email template. Sets a flag in the Cron Pauses table (existing schema, just add string entries for template names). Every send helper checks this flag and short-circuits if paused.

```
/pausemail sendRancherCheckIn
↓
⏸️ PAUSED sendRancherCheckIn. No future sends until /resumemail.
```

### `/resumemail <template-name>`

**Effect:** Re-enables the template.

### `/freqcap <number>` and `/freqcap show`

**Effect:** Sets the global per-Consumer 7-day frequency cap. Default 3. Stored as a single row in a new Airtable `Settings` table OR as env var (decision in "Open question").

```
/freqcap 5
↓
✅ Frequency cap set to 5 emails/Consumer/7d.

/freqcap show
↓
Current cap: 3 emails/Consumer/7d (default)
```

### `/templatestats`

**Returns:** Per-template aggregate stats for past 30 days.

```
📈 TEMPLATE STATS — Past 30 days

Template                       Sends   Opens   Clicks  Pause?
sendNudgeToEngage              47      —       —       ▶️
sendRancherLaunchWarmup        28      —       —       ▶️
sendFounderLetterWaiting       64      —       —       ▶️
sendRancherCheckIn             14      —       —       ⏸️ PAUSED
...

Open/click data requires Resend webhook integration (Phase 2).
For now: send counts only.
```

### `/whatfired today` / `/whatfired yesterday` / `/whatfired <YYYY-MM-DD>`

**Returns:** What every cron + email send did that day.

```
🤖 WHAT FIRED — 2026-05-24

Crons (5 ran):
✅ batch-approve 09:00 — 0 approved, 1124 skipped, 0 errors
✅ rancher-launch-warmup 13:30 — 5 ranchers processed, 12 buyers warmed
✅ email-sequences 16:00 — 18 emails sent (segment=10, stage=8)
✅ healthcheck 13:00 — all green
⏸️ daily-audit — PAUSED

Emails (18 total):
- 5 sendNudgeToEngage to CO/CA/TX buyers
- 3 sendOutOfStateFounderPitch to FL/AZ buyers
- ...

Top 3 surprises (anomalies vs 30-day average):
- sendNudgeToEngage 2x normal volume (was 2/day, today 5)
- 0 closed deals (vs avg 1/day) — investigate
```

---

## Component 4 — Always-on Frequency Guard

### Location

New file: `lib/emailFrequencyGuard.ts`

### Public API

```typescript
export async function checkFrequencyCap(recipientEmail: string): Promise<{
  ok: boolean;
  reason?: 'cap-exceeded' | 'paused' | 'unsubscribed' | 'bounced' | 'complained';
  weekCount: number;
  cap: number;
}>;

export async function logEmailSend(input: {
  recipientEmail: string;
  recipientConsumerId?: string;
  templateName: string;
  subject: string;
  status: 'sent' | 'suppressed' | 'bounced' | 'complained';
  suppressionReason?: string;
}): Promise<void>;
```

### Integration

Every named send helper in `lib/email.ts` wrapped:

```typescript
export async function sendNudgeToEngage(data: {...}) {
  const gate = await checkFrequencyCap(data.email);
  if (!gate.ok) {
    await logEmailSend({
      recipientEmail: data.email,
      templateName: 'sendNudgeToEngage',
      subject: '(suppressed)',
      status: 'suppressed',
      suppressionReason: gate.reason,
    });
    return { success: false, suppressed: true, reason: gate.reason };
  }
  // ... existing send logic ...
  await logEmailSend({
    recipientEmail: data.email,
    templateName: 'sendNudgeToEngage',
    subject: '...',
    status: 'sent',
  });
  return { success: true };
}
```

Existing suppression checks (Unsubscribed / Bounced / Complained) move into `checkFrequencyCap` for centralization.

### Performance

`checkFrequencyCap` reads the Email Sends Airtable table filtered by recipient email AND `Sent At > now - 7d`. This is a hot call so the helper memoizes per-recipient counts in process memory for 60 seconds. Acceptable staleness because the cap is enforced at the per-call level (one extra email past cap doesn't break anything).

---

## Open questions (resolved during implementation)

1. **Email Sends table → write before or after Resend send call?**
   - Decision: write AFTER successful send. If Resend fails, no log (logged to console instead).

2. **Frequency cap storage**
   - Decision: env var `EMAIL_FREQUENCY_CAP_PER_WEEK` (default 3). Allows env-level overrides per environment. `/freqcap` Telegram command provides ephemeral runtime override via process memory + persistence to a `Settings` Airtable row.

3. **Open/click data**
   - Decision: not in this spec. Phase 2 wires Resend `email.opened` and `email.clicked` webhook events to the Email Sends table. Spec mentions this as future work.

4. **Pre-existing emails (before Email Sends table exists) — included in cap?**
   - Decision: no — frequency cap counts only logged sends from the table. Soft launch acceptable because the cap activates the moment the table starts logging.

---

## File / directory plan

### Files created

| File | Purpose |
|---|---|
| `docs/SYSTEM-MAP.md` | The reference doc |
| `docs/audits/` | Directory for weekly spam audit outputs |
| `docs/audits/.gitkeep` | Keep dir in git |
| `lib/emailFrequencyGuard.ts` | Frequency cap + send logging |
| `app/api/cron/spam-audit/route.ts` | Weekly audit cron |

### Files modified

| File | Modification |
|---|---|
| `lib/email.ts` | Wrap every named send helper w/ frequency guard + logEmailSend |
| `app/api/webhooks/telegram/route.ts` | Add 6 new commands + help text |
| `vercel.json` | Add spam-audit cron schedule |

### Airtable schema additions

| Table | Field | Type |
|---|---|---|
| Email Sends (NEW) | Sent At | dateTime |
| Email Sends (NEW) | Recipient Email | email |
| Email Sends (NEW) | Recipient Consumer | multipleRecordLinks → Consumers |
| Email Sends (NEW) | Template Name | singleLineText |
| Email Sends (NEW) | Subject | singleLineText |
| Email Sends (NEW) | Status | singleSelect (sent / suppressed / bounced / complained) |
| Email Sends (NEW) | Suppression Reason | singleLineText |

Add via MCP. Add `EMAIL_SENDS` table-name constant to `lib/airtable.ts`.

---

## Testing approach

No formal test framework in the project (`package.json` doesn't include jest). Verification = manual.

### Manual verification steps (in order)

1. **After deploy:** Hit `/api/cron/spam-audit?secret=$CRON_SECRET` manually. Confirm Telegram report fires + markdown file written.
2. **Frequency guard:** Set EMAIL_FREQUENCY_CAP_PER_WEEK=1. Fire same buyer 2x via email-sequences. Second send should suppress + log w/ `suppressionReason='cap-exceeded'`.
3. **`/pausemail`:** `/pausemail sendNudgeToEngage` → trigger email-sequences cron manually → confirm zero sendNudgeToEngage emails sent + Email Sends rows show suppressed status with `suppressionReason='paused'`.
4. **`/emaillog`:** Run `/emaillog karie.suarez@gmail.com` → confirm 30-day email list returned.
5. **`/whatfired today`:** Run after a known cron run → confirm cron + email summary matches Cron Runs + Email Sends data.

### Regression risk

The frequency guard wraps every existing email send. If misconfigured (e.g. cap=0), no emails fire. Mitigation: default cap is 3, env override required to lower. Initial deploy ships with cap=10 to allow soft transition.

---

## Rollout plan

### Phase 1 — Single PR (overnight)

1. Add Email Sends Airtable table via MCP
2. Build `lib/emailFrequencyGuard.ts`
3. Wrap every named send helper in `lib/email.ts` w/ guard + log
4. Build `/api/cron/spam-audit` route
5. Add cron schedule to `vercel.json`
6. Build 6 Telegram commands
7. Write initial `docs/SYSTEM-MAP.md` (the big inventory pass)
8. Type-check, commit, push
9. Verify deploys, run smoke checks (manual steps 1-5 above)

### Phase 2 — Follow-up PR (after Phase 1 shipped)

1. Wire Resend `email.opened` + `email.clicked` webhook events to Email Sends table
2. Add open-rate + click-rate columns to `/templatestats` output
3. Auto-suggest kill candidates in spam audit (high volume + zero engagement)
4. Auto-update SYSTEM-MAP.md sections from manifest file (future work)

---

## Risks + mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Frequency cap too aggressive — drops critical transactional emails (invoice, password reset) | High | Whitelist template names that bypass the guard: `sendInstantCommissionInvoice`, `sendRancherApproval`, `sendMatchedDay4CheckIn`, `sendBuyerIntroNotification`. These ALWAYS send regardless of cap. |
| Email Sends table write fails → cap miscounts | Medium | Wrap in try/catch, log failure to console, fall back to allowing send (fail-open). Won't suppress over-cap during outages. |
| 60-second memoization shows stale count → over-cap by 1-2 sends | Low | Acceptable. The whole point of a soft cap is to avoid 10 sends/day. 1-2 extra is noise. |
| SYSTEM-MAP.md goes stale immediately | Medium | Founder commits an update whenever shipping major changes. Linked to git history so reviewers see drift. |
| Spam-audit cron writes too-large Telegram message | Low | Cap at 20 recipients + truncate template lists at 5 each. Full data in markdown file. |

---

## What's NOT in this spec

- UI/UX redesign of any surface (separate spec)
- Conversion rate optimization experiments (separate spec)
- New revenue streams (separate spec)
- Postgres migration (not happening this year)
- Analytics dashboard rebuild (separate spec)

---

## Success metrics — 14 days post-launch

| Metric | Target |
|---|---|
| SYSTEM-MAP.md page views by founder | 5+ in first 7 days |
| `/emaillog` Telegram command usage | 3+ different Consumers checked first week |
| `/pausemail` usage | At least 1 template paused based on spam audit |
| Frequency-cap suppressions logged | 5-20/week (signals guard working — too high means cap too low) |
| Customer complaints about email frequency | Zero |

If after 14 days `/emaillog` is never used, the founder doesn't trust the data → iterate on UX. If suppressions are zero, cap is too high (no actual protection). If suppressions are >50/week, cap too low (legitimate emails blocked).
