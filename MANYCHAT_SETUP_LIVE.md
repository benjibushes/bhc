# ManyChat AI DM Closer — Live Setup Guide

**Status (2026-05-03):** API-side configuration complete. Flow scaffolding
in ManyChat UI is ~15 min of clicks below. Webhook tested locally end-to-end
(rancher / buyer / escalation paths all green).

---

## What's already done (via API)

### Custom Fields
- `email` (text) — captured during DM convo
- `state` (text) — US state for routing
- `segment` (text) — beef-buyer · rancher · merch-buyer · info-seeker · unclear
- `intent_signal` (text) — high · medium · low · research
- `ranch_name` (text) — if rancher
- `conversation_id` (text) — BHC-side thread id
- `first_dm_at` (datetime)
- `last_ai_reply_at` (datetime)
- `needs_human` (boolean)
- `email_captured` (boolean)
- `closer_active` (boolean)

### Tags (existing + new)
Existing kept: `beef-buyer`, `rancher`, `merch-buyer`, `info-seeker`,
`info-no-click`, `rancher-no-click`, `merch-no-click`, `beef-no-click`,
`comment-detected`, `quiz_started`.

New: `closer_engaged`, `escalate_human`, `qualified_lead`,
`dm_session_open`, `ai_replied_once`, `email_captured_tag`,
`founder_lead_flag`.

### Bot Fields (config storage)
- `system_prompt_version` = `v1`
- `escalation_keywords` = `talk to ben,human please,real person,owner,founder,scam,refund,cancel`
- `bhc_webhook_url` = `https://www.buyhalfcow.com/api/webhooks/manychat`

### BHC Webhook
- Endpoint: `POST https://www.buyhalfcow.com/api/webhooks/manychat`
- Auth: `Authorization: Bearer <MANYCHAT_WEBHOOK_SECRET>` (set on Vercel prod)
- Returns ManyChat-shaped response with reply text + custom field updates + tag actions
- Logs all turns to Airtable Conversations table
- Telegram alerts on first contact, high intent, or `needs_human=true`
- AI: Groq (llama-3.3-70b) prod fallback, Anthropic Claude if `ANTHROPIC_API_KEY` set

**Webhook secret** (use this when wiring the External Request in
ManyChat — DO NOT commit to repo):
```
78657e5450050eec08c555193a47f9948f3f66f5ab8b4928afbd5021cccbacc0
```

---

## What you do in ManyChat UI (~15 min)

### Step 1 — Connect IG (skip if done)
ManyChat dashboard → **Settings → Channels → Instagram** → Connect.
Requires IG Business account linked to FB page. If not done yet, do it now.

### Step 2 — Build the AI closer flow

Flows → **+ New Flow** → name it `AI Closer (DM)`.

Add a single **External Request** node:
- **Method:** `POST`
- **URL:** `https://www.buyhalfcow.com/api/webhooks/manychat`
- **Headers:**
  - `Content-Type` → `application/json`
  - `Authorization` → `Bearer 78657e5450050eec08c555193a47f9948f3f66f5ab8b4928afbd5021cccbacc0`
- **Body** (raw JSON, paste this verbatim):
```json
{
  "subscriber_id": "{{user_id}}",
  "username": "{{user.username}}",
  "first_name": "{{first_name}}",
  "last_name": "{{last_name}}",
  "message": "{{last_input_text}}",
  "source": "{{cuf_source}}",
  "custom_fields": {
    "email": "{{cuf_email}}",
    "state": "{{cuf_state}}",
    "segment": "{{cuf_segment}}",
    "intent_signal": "{{cuf_intent_signal}}",
    "ranch_name": "{{cuf_ranch_name}}",
    "conversation_id": "{{cuf_conversation_id}}",
    "needs_human": "{{cuf_needs_human}}"
  },
  "tags": "{{user.tags}}"
}
```
> Note: ManyChat's `{{cuf_X}}` syntax = custom user field reference.
> Field names are exactly the captions you see in the field list. If
> ManyChat complains about a missing variable, double-click the body
> field and use the variable picker UI for each `{{...}}` placeholder.

- **Response Mapping:** ManyChat auto-applies the `actions[]` array
  the webhook returns (set_field_value, add_tag, remove_tag) when you
  toggle **"Apply Actions from Response"** on. Turn this ON.

- **Send Response Message:** ManyChat reads `content.messages[0].text`
  and speaks it back to the subscriber. Toggle ON.

That's the whole flow. One node. The webhook does the work.

### Step 3 — Wire triggers (3 of them)

#### 3a. New IG follower
Automation → **+ New Automation** → trigger = **"User starts a conversation"**
or **"New IG follower"** (whichever is available on Pro plan):
- Action 1 → **Set Custom Field** `source` = `follow`
- Action 2 → **Run Flow** → `AI Closer (DM)`

#### 3b. Story reply
Automation → **+ New Automation** → trigger = **"User replies to your IG story"**:
- Action 1 → **Set Custom Field** `source` = `story_reply`
- Action 2 → **Run Flow** → `AI Closer (DM)`

#### 3c. Keyword catch-all (DM)
Automation → **+ New Automation** → trigger = **"User sends a DM"** with keywords = `*` (any):
- Filter: ONLY if subscriber does NOT have tag `escalate_human` (so
  human-handoff convos don't get re-AI'd)
- Action 1 → **Set Custom Field** `source` = `keyword`
- Action 2 → **Run Flow** → `AI Closer (DM)`

### Step 4 — Comment auto-DM (optional, high-leverage)
ManyChat → **Tools → Instagram → Comment Auto-Reply** → set up a trigger
on any post with keyword `info` / `interested` / `more` etc. Action:
**Send DM via Flow** = `AI Closer (DM)`. Set `source` = `comment`.

### Step 5 — Test

In ManyChat preview / test from your own IG account:
1. DM the page from a test account: `"hey, I run a small farm in CO, how does this work?"`
2. Within 2-3s you should get a tailored reply (rancher segment, state=CO captured).
3. Check Airtable Conversations table — two rows (inbound + outbound) should appear.
4. Check Telegram — first-contact alert should land in admin chat.

---

## Anti-patterns — don't break these

- ❌ Don't let AI handle leads tagged `founder_lead_flag` or anyone who
  identifies as press / podcast / investor. The system prompt sets
  `needs_human=true` automatically on those keywords.
- ❌ Don't let AI quote prices. Prompt blocks this; if you see Groq
  hallucinate a price, lower temperature (handled in code at default).
- ❌ Don't send buyer leads to Calendly. Calendly = rancher channel only.
- ❌ Don't override the 2-paragraph cap. AI gets terse on purpose — DMs
  read on phones in 3 seconds.

---

## Hand-off path

When `needs_human=true` fires:
1. Tag `escalate_human` is added (visible in ManyChat subscriber view).
2. Telegram alert lands with full context (segment, state, message, AI's holding reply).
3. From Telegram, you can either:
   - Reply directly via IG app (ManyChat won't re-AI because the tag blocks it via Step 3c filter)
   - Or use a Telegram callback button to push a custom reply via ManyChat's `sendContent` API (callback handler = TODO)

---

## Future tweaks (not needed for go-live)

- Add `sendContent` Telegram callback so you can reply to DMs without
  leaving Telegram (`/dmreply <subscriber_id> <text>` command).
- Conversation-summary cron: every Sunday, group Conversations by
  subscriber and write a one-line summary to subscriber's `conversation_id`
  for next-week context.
- Switch AI provider to Anthropic Claude once `ANTHROPIC_API_KEY` is
  added to Vercel — better at structured output (signals block) and
  segment detection. Code already supports it; will fall through automatically.

---

## Files touched
- `app/api/webhooks/manychat/route.ts` (new) — main webhook
- `lib/airtable.ts` — added `CONVERSATIONS: 'Conversations'` to `TABLES`
- Vercel env: `MANYCHAT_WEBHOOK_SECRET` added (production)
- `.env.local` — `MANYCHAT_WEBHOOK_SECRET` + pulled `GROQ_API_KEY` for local

## ManyChat IDs (for reference)
- Page id: `506032129267734` (Buyhalfcow.com)
- Plan: Pro (AI Step + External Request unlocked)
- Timezone: America/Denver
