# ManyChat AI DM Closer — Total TOF Coverage Plan

**Goal:** Every IG entry point routes into the AI closer. Zero leak surface. AI reads intent in 2s, captures state/segment/email, replies conversationally, tags subscriber. Ben gets Telegram alert on every high-intent or escalation.

**Status (2026-05-03):**
- Webhook live in prod: `https://www.buyhalfcow.com/api/webhooks/manychat`
- Code shipped (commit `fdfe1b1`)
- ManyChat data layer pre-provisioned via API (custom fields, tags, bot fields)
- **Remaining work = ManyChat UI clicks below (~15 min total)**

---

## ⚠️ DO BEFORE FLIP-LIVE

### 1. Add `ANTHROPIC_API_KEY` to Vercel (highest priority)

Groq free tier = 12k tokens/min. One DM ≈ 1700 tokens (system + history + reply). Math: ~7 DMs/min before rate-limiting. At burst load (someone goes viral, comment-section explodes), this WILL fail and serve users a fallback "tied up for a sec" reply. Conversion killer.

Anthropic Claude:
- 50k+ TPM on default tier
- Way better at the structured signals block
- ~$0.003 per DM = $30 per 10,000 DMs (negligible at conversion economics)

**Setup:**
1. Go to https://console.anthropic.com → Settings → API Keys → Create
2. `vercel env add ANTHROPIC_API_KEY production` → paste key
3. Redeploy (next git push or `vercel --prod`)

Webhook auto-flips to Anthropic when key present. Groq stays as fallback.

### 2. Rotate ManyChat API token after UI work done

Settings → API → Regenerate. The current token has been in chat history.

---

## TOTAL TOF COVERAGE — 5 ManyChat Flows

```
ENTRY POINT                       ROUTES INTO
──────────────────────────────────────────────
1. Comment "HERD" / keyword       → AI Closer Engine
2. Story reply                    → AI Closer Engine
3. New IG follower                → AI Closer Engine
4. Cold DM (no prior context)     → AI Closer Engine
5. Reply to button-DM (button     → AI Closer Engine
   failed to render, user typed
   free text instead)
```

**ONE engine flow** does the work. All entry-point flows route into it.

---

## STEP 1 — Build the Engine: `Catch-All AI Closer`

You already have this flow (created today). Open it in ManyChat UI.

### Replace the body with ONE node — External Request

Delete any existing nodes (or duplicate the flow first as backup). Add a single **External Request** node. Configure:

| Field | Value |
|-------|-------|
| Method | `POST` |
| URL | `https://www.buyhalfcow.com/api/webhooks/manychat` |
| Header 1 | `Content-Type` → `application/json` |
| Header 2 | `Authorization` → `Bearer 78657e5450050eec08c555193a47f9948f3f66f5ab8b4928afbd5021cccbacc0` |

**Request body** (raw JSON — paste verbatim, then double-click each `{{...}}` to map via ManyChat's variable picker):
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

**Toggles** (both ON):
- ✅ Apply Actions from Response (ManyChat applies the `actions[]` array we return — set field, add tag, remove tag)
- ✅ Send Response Message (ManyChat speaks `content.messages[0].text` to the user)

Save. That's the entire engine. No other nodes.

---

## STEP 2 — Wire Entry Point #1: Cold DM Catch-All

This catches anyone who DMs you cold without hitting a comment trigger or button. Includes free-text replies that didn't match any keyword (the leaked button-fail bucket).

Open `Instagram Default Reply` flow. ManyChat fires this for any DM that doesn't match a more-specific trigger.

**Body:** delete existing nodes. Add ONE node:
- Type: **Run Flow**
- Target: `Catch-All AI Closer`

That's it. Save. Activate.

(Why not put External Request directly here? Because reusing the same Engine flow for all entry points means you only ever update ONE place when you change the prompt or webhook URL.)

**Before this:** user types free text → ManyChat says nothing → leak.
**After this:** every cold DM → AI Closer Engine fires → tailored reply in 2s.

---

## STEP 3 — Wire Entry Point #2: Comment "HERD" → AI

The big one. This is where leaks happen today (button DMs failing to render).

You currently have a comment-trigger flow with buttons. Two options:

### Option A — Quickest (preserves existing UX, adds fallback)
1. Keep your existing button-DM flow as-is (don't break what's working for some users).
2. Make sure the user-input node after the buttons has a **fallback action** for free text:
   - When user replies with text that isn't a button click → **Run Flow** = `Catch-All AI Closer`.
3. Save.

### Option B — Recommended (conversational, higher conversion)
Replace the button-DM with a one-line warm hook + AI handoff. Way higher response rate because it feels like a human texting back, not a bot menu.

1. Open the comment-trigger flow.
2. Replace the multi-button question node with a single **Send Message** node:
   ```
   hey — saw you commented HERD. what brought you in?
   ```
3. Add a **User Input** node (capture text) right after.
4. Connect the User Input output → **Run Flow** = `Catch-All AI Closer`.
5. Set custom field `source` = `comment` before the External Request fires (so your Telegram alerts know the lead came from a comment).

Save. Test by commenting HERD on a post yourself.

---

## STEP 4 — Wire Entry Point #3: Story Reply

Stories are massive on IG. Anyone replying to a story = warm lead, often unprompted intent.

In ManyChat: **Automation** → New Automation → trigger **"User replies to your IG story"**.

Action sequence:
1. **Set Custom Field** `source` = `story_reply`
2. **Run Flow** = `Catch-All AI Closer`

Save + activate.

---

## STEP 5 — Wire Entry Point #4: New Follower

You already have `Say hi to new followers`. Modify it.

1. Open `Say hi to new followers`.
2. Keep the welcome message (or shorten it: "hey, glad you're here. what brought you in?").
3. After the welcome message, add a **User Input** node (capture text).
4. Connect User Input output → **Set Custom Field** `source` = `follow` → **Run Flow** = `Catch-All AI Closer`.

Save.

(If a follower says nothing back, no AI fires — that's fine. Only fires when they engage.)

---

## STEP 6 — Test End-to-End

From your personal IG (NOT the BuyHalfCow account):

1. **Comment HERD on a recent post** → wait for DM → reply with free text "im in TX, looking for half a cow" → confirm AI replies in 2-3s with `/access` link.
2. **Reply to a Story** → confirm AI replies.
3. **Send a cold DM** (e.g. "yo, you guys real?") → confirm AI replies.

After each test:
- Check Airtable `Conversations` table → 2 rows per turn (inbound + outbound).
- Check Telegram → admin chat alert with first-contact flag.
- Check ManyChat subscriber view → tags applied (`closer_engaged`, segment tag, `qualified_lead` if intent=high).

---

## ANTI-LEAK CHECKLIST

After steps 1-5, every TOF entry path leads to AI:

- [ ] Comment HERD → DM with buttons → buttons fail → user types free text → **caught by `Instagram Default Reply` → AI Closer**
- [ ] Comment HERD → DM with buttons → user clicks button → existing keyword path runs → if user replies again → **`Instagram Default Reply` → AI Closer**
- [ ] Cold DM (no comment context) → **`Instagram Default Reply` → AI Closer**
- [ ] Story reply → **Story reply Automation → AI Closer**
- [ ] New follower says something → **`Say hi to new followers` → User Input → AI Closer**
- [ ] Anyone DMs after Day 1 (subscriber returning) → **`Instagram Default Reply` → AI Closer**

The only path that doesn't auto-fire AI = subscriber with `escalate_human` tag (intentional — Ben handles those manually so we don't double-reply over a human convo).

---

## WHAT'S DONE (for reference)

### Custom Fields (in ManyChat already)
`email`, `state`, `segment`, `intent_signal`, `ranch_name`, `conversation_id`, `first_dm_at`, `last_ai_reply_at`, `needs_human` (bool), `email_captured` (bool), `closer_active` (bool)

### Tags (in ManyChat already)
Existing: `beef-buyer`, `rancher`, `merch-buyer`, `info-seeker`, `comment-detected`, `quiz_started`, `*-no-click` variants.

New (from this build): `closer_engaged`, `escalate_human`, `qualified_lead`, `dm_session_open`, `ai_replied_once`, `email_captured_tag`, `founder_lead_flag`, `supporter`.

### Bot Fields (config storage)
- `system_prompt_version` = `v1`
- `escalation_keywords` = `talk to ben,human please,real person,owner,founder,scam,refund,cancel`
- `bhc_webhook_url` = `https://www.buyhalfcow.com/api/webhooks/manychat`

### BHC code shipped
- `app/api/webhooks/manychat/route.ts` — webhook (commit `fdfe1b1` on main)
- `lib/airtable.ts` — `Conversations` table added to `TABLES`
- Vercel prod env: `MANYCHAT_WEBHOOK_SECRET` (`78657e5450050eec08c555193a47f9948f3f66f5ab8b4928afbd5021cccbacc0`)
- Telegram alerts wired (first contact / high intent / needs_human)
- Airtable `Conversations` row per turn

### Webhook behavior summary
- Prefers Anthropic Claude (if `ANTHROPIC_API_KEY` set), falls back to Groq llama-3.3-70b, falls to llama-3.1-8b on rate limit
- 1-3 sentence replies enforced via system prompt
- One question per reply (sanitizer)
- Segment-specific CTAs:
  - `beef-buyer` → `/access` quiz (only after state captured)
  - `rancher` → `/rancher/setup` or `cal.com/ben-beauchman-1itnsg/30min`
  - `merch-buyer` → `/merch`
  - `supporter` → `/founders` (always — never lets supporter exit without the link)
  - `info-seeker` → brief mission line + offer to chat
  - `press / VC / Title-Founder` → holding-reply only (`needs_human=true`, Telegram fires)

---

## REGISTERED IDS

- ManyChat Page ID: `506032129267734` (Buyhalfcow.com)
- ManyChat plan: Pro
- Existing flows present (queried via `/fb/page/getFlows`):
  - `Catch-All AI Closer` (ns `content20260503084640_597525`)
  - `IG Herd Funnel — Buyer/Merch/Rancher/Info` (ns `content20260429180117_589530`)
  - `Instagram Default Reply` (ns `content20260426214749_130306`)
  - `Say hi to new followers` (ns `content20251013163002_607385`)
  - Plus several `Auto-DM links from comments` flows

---

## WHY MANYCHAT API CAN'T BUILD FLOWS FOR YOU

ManyChat's public REST API exposes only:
- Subscriber CRUD
- Custom field / tag / bot field create + read
- Send-content / send-flow (outbound to existing subscribers)
- Page info

`createFlow`, `editFlow`, `getFlow` (with content), `createTrigger`, `getKeywords`, `getAutomations` — **all return 404**. ManyChat decided flow building is UI-only. Same on every plan tier.

If full programmatic control matters long-term: migrate off ManyChat to **Meta's IG Messaging API direct** (Graph API webhook). ~4 hours to build, requires Meta dev portal app + business verification + Advanced Messaging permission (3-5 day approval). Trade-off: full code ownership, no per-message ManyChat fee, no UI dependency. Worth doing once volume justifies it.
