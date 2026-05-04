# Rebuild: Catch-All AI Closer Flow

**For:** Coworker rebuilding the ManyChat flow from scratch.
**Time:** ~15 minutes.
**Result:** Every Instagram DM gets answered by an AI closer in 2-3 seconds with a tailored, conversational reply that captures intent (segment, state, email) and routes to the right link (`/access`, `/rancher/setup`, `/founders`).

---

## 0. WHAT YOU'RE BUILDING

A single ManyChat flow named **`Catch-All AI Closer`** that:
1. Takes the user's DM text + their custom field state.
2. Sends it to BuyHalfCow's webhook (`https://www.buyhalfcow.com/api/webhooks/manychat`).
3. Receives back a reply text + custom field updates + tag actions.
4. Sends the reply to the user, applies the field/tag changes.

This flow is the "engine" — other entry-point flows (`Instagram Default Reply`, story replies, comment triggers, new follower) just route into this one.

**Architecture:**
```
[Any IG DM] → [Trigger flow] → [Catch-All AI Closer]
                                       ↓
                          [External Request to BHC]
                                       ↓
                          [BHC returns reply + actions]
                                       ↓
                       [ManyChat sends reply + applies tags]
```

---

## 1. CREDENTIALS YOU NEED

You need ONE thing: the webhook secret. It's a long string that authenticates ManyChat to BuyHalfCow's API. Ben has it. Format: `78657e54...` (64 hex characters).

If you can't get the secret, ask Ben — without it the webhook returns 401.

You will NOT need:
- ManyChat API token (this is UI work)
- BuyHalfCow login
- Stripe / Airtable / anything else

---

## 2. PRE-FLIGHT CHECK

Before building, verify these exist in ManyChat (most likely already there — if not, create as you go):

### Custom Fields (Settings → User Fields)
| Field name | Type |
|---|---|
| `email` | Text |
| `state` | Text |
| `segment` | Text |
| `intent_signal` | Text |
| `ranch_name` | Text |
| `conversation_id` | Text |
| `needs_human` | True/False |
| `email_captured` | True/False |
| `closer_active` | True/False |
| `source` | Text |

If any are missing, click **+ New Field** in the User Fields panel, type the name exactly as above, pick the type. Description optional.

### Tags (Audience → Tags)
Required: `closer_engaged`, `escalate_human`, `qualified_lead`, `dm_session_open`, `ai_replied_once`, `email_captured_tag`, `founder_lead_flag`, `supporter`, `beef-buyer`, `rancher`, `merch-buyer`, `info-seeker`.

Most exist. Add any missing via **+ New Tag**.

---

## 3. BUILD THE FLOW

### 3.1 Create the flow shell

1. Sidebar → **Automation** → **Flows**.
2. Top-right → **+ New Flow** button.
3. Name it exactly: `Catch-All AI Closer`.
4. Click into it. Empty canvas with a "Starting Step" node.

### 3.2 Add the External Request node

1. On the Starting Step, click **+ Add Step** (or drag a new node).
2. From the node-type panel, pick **External Request**.
3. Name the step: `Call BHC Webhook`.

You should now have one External Request node connected to the Starting Step.

### 3.3 Configure the External Request

Click the External Request node to open its config panel.

**Method:** select `POST` from the dropdown.

**Request URL:** paste verbatim:
```
https://www.buyhalfcow.com/api/webhooks/manychat
```

**Headers:** click **+ Add Header** twice. You'll add 2 headers.

| Header name | Header value |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <PASTE THE WEBHOOK SECRET HERE>` |

For the second one — type the word `Bearer` followed by a space, then paste the 64-character secret Ben gave you. Example shape: `Bearer 78657e5450050eec...` (do not include angle brackets).

**Request Body:** select **Raw JSON** as the body type. Paste this exactly:

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

**ManyChat variable mapping** (this is the most error-prone step — read carefully):

ManyChat does NOT auto-substitute `{{cuf_email}}` etc. when you paste raw text. You must double-click each `{{...}}` placeholder in the body field, and ManyChat will pop a variable picker. Pick the matching variable:

| Placeholder | ManyChat picker selection |
|---|---|
| `{{user_id}}` | System → User ID |
| `{{user.username}}` | System → Instagram Username (or User → Username) |
| `{{first_name}}` | System → First Name |
| `{{last_name}}` | System → Last Name |
| `{{last_input_text}}` | System → Last User Input |
| `{{cuf_source}}` | Custom Field → source |
| `{{cuf_email}}` | Custom Field → email |
| `{{cuf_state}}` | Custom Field → state |
| `{{cuf_segment}}` | Custom Field → segment |
| `{{cuf_intent_signal}}` | Custom Field → intent_signal |
| `{{cuf_ranch_name}}` | Custom Field → ranch_name |
| `{{cuf_conversation_id}}` | Custom Field → conversation_id |
| `{{cuf_needs_human}}` | Custom Field → needs_human |
| `{{user.tags}}` | System → Tags |

If a variable doesn't appear in the picker, the custom field doesn't exist yet — go back to Section 2 and create it.

### 3.4 Configure response handling (CRITICAL)

Still inside the External Request config panel, scroll down. You'll see toggles / settings for what to do with the response:

- ✅ Toggle ON: **Apply Actions from Response** (or "Apply API Actions" — wording varies by ManyChat version). This makes ManyChat read the `actions[]` array we return and apply each one (set custom field, add tag, remove tag).
- ✅ Toggle ON: **Send Response Message** (or "Send Reply from Response"). This makes ManyChat read `content.messages[0].text` from the JSON response and send it to the user.

If you see a "Save Response" / "Map Response Fields" section, you can leave it unmapped — both toggles above handle the response automatically. The webhook returns the exact shape ManyChat expects:

```json
{
  "version": "v2",
  "content": { "messages": [{ "type": "text", "text": "the AI reply" }] },
  "actions": [
    { "action": "set_field_value", "field_name": "segment", "value": "beef-buyer" },
    { "action": "add_tag", "tag_name": "qualified_lead" }
  ]
}
```

### 3.5 Save the flow

Top-right → **Save**. The flow now has one node (Starting Step → External Request) and is ready to use.

You don't need any further nodes. The webhook does all the work.

---

## 4. WIRE THE TRIGGERS

The flow itself doesn't fire on its own. You need to point ManyChat's various entry points at this flow.

### 4.1 Default Reply trigger (catches everything missed)

This is the most important — it catches every DM that doesn't match a more-specific trigger, including users replying with free text after buttons fail to render.

1. Sidebar → **Automation** → **Default Reply** (Instagram). If you don't see "Default Reply" as a top-level item, look under **Automation → Triggers → Default Reply** or search "default reply" in the search bar.
2. Open the existing `Instagram Default Reply` flow (ManyChat creates one by default when you connect IG).
3. Replace its body: delete any existing nodes, add a single **Run Flow** node.
4. Set the Run Flow target to `Catch-All AI Closer`.
5. Activate / save.

Now every cold DM and every leaked free-text reply hits the AI closer.

### 4.2 Story Reply trigger

1. **Automation** → **+ New Automation**.
2. Trigger type: **User Replies to Your IG Story**.
3. Action 1: **Set Custom Field** → field `source` → value `story_reply`.
4. Action 2: **Run Flow** → `Catch-All AI Closer`.
5. Save + activate.

### 4.3 Comment trigger (for "HERD" keyword on posts)

If Ben already has a comment auto-DM flow with buttons (e.g. `IG Herd Funnel — Buyer/Merch/Rancher/Info`), choose ONE of the following based on what Ben prefers:

**Option A — keep buttons, add fallback (safer):**
1. Open the existing comment-trigger flow.
2. Find the "User Input" node after the buttons.
3. Set its **fallback path** (when user replies with text instead of clicking a button) → **Run Flow** = `Catch-All AI Closer`.
4. Before that, add a **Set Custom Field** node: `source` = `comment`.

**Option B — replace buttons with conversational AI (higher conversion):**
1. Open the existing comment-trigger flow.
2. Replace the multi-button question node with a **Send Message** node containing a single warm line:
   ```
   hey — saw you commented HERD. what brought you in?
   ```
3. Add a **User Input** node (capture text) right after the message.
4. Connect User Input → **Set Custom Field** `source` = `comment` → **Run Flow** = `Catch-All AI Closer`.

Whichever option, save + activate.

### 4.4 New Follower trigger (optional but recommended)

1. Open the existing `Say hi to new followers` flow (or create one).
2. Keep the welcome message — shorten it to one line: `hey, glad you're here. what brought you in?`
3. After the welcome, add a **User Input** node.
4. Connect User Input → **Set Custom Field** `source` = `follow` → **Run Flow** = `Catch-All AI Closer`.
5. Save + activate.

(Followers who say nothing won't trigger AI — only fires when they engage.)

---

## 5. TEST FROM YOUR PHONE

From your personal IG account (NOT the BuyHalfCow account):

### Test 1 — cold DM
1. DM the BuyHalfCow IG account with: `hey do you guys have beef`
2. Expected: AI replies in 2-3 seconds with something like:
   `yeah we do. what state are you in?`
3. Reply: `im in TX`
4. Expected: `easiest way → 60-sec quiz, matches you with a rancher near you: /access`

### Test 2 — supporter
1. New conversation (different test account or clear chat).
2. DM: `love what you're doing`
3. Expected: a reply that surfaces /founders, e.g.:
   `appreciate that, means a lot. we just opened the founding herd — backer tiers that fund the build. /founders has the breakdown.`

### Test 3 — escalation
1. DM: `is this an equity raise? what are the SAFE terms`
2. Expected: a holding reply, e.g.:
   `tied up for a sec — getting ben on this. he'll reply shortly.`
3. The subscriber should now have the `escalate_human` tag in ManyChat.

### Test 4 — story reply
1. From your personal account, reply to one of the BuyHalfCow stories with any text.
2. Expected: AI replies in DMs within 2-3 seconds.

### Test 5 — comment trigger
1. Comment `HERD` on a recent BuyHalfCow post.
2. Expected: existing comment-DM flow fires. If you typed free text instead of clicking buttons → AI closer takes over.

If any test returns silence → check next section.

---

## 6. TROUBLESHOOTING

### AI never replies
- Most common: the External Request response toggles weren't switched on. Re-open the External Request node, confirm both **Apply Actions from Response** AND **Send Response Message** are ON.
- Second most common: webhook URL typo. Should be exactly `https://www.buyhalfcow.com/api/webhooks/manychat` (no trailing slash, must be `https`).
- Check ManyChat's **Live Activity** panel for the External Request — should show 200 status. 401 = wrong/missing webhook secret. 500 = server error (tell Ben).

### Reply text is `tied up for a sec — getting ben on this`
- This is the AI provider error fallback. Means Anthropic + Groq both failed. Tell Ben to check provider rate limits / API keys.

### Reply works but tags / custom fields don't update
- "Apply Actions from Response" toggle is OFF. Re-open External Request → toggle ON → save.

### Variables show as literal `{{user_id}}` text in the body
- They weren't mapped. Double-click each `{{...}}` placeholder and pick the matching variable from the picker (Section 3.3 table).

### Test DM gets multiple replies
- More than one trigger is firing for the same DM. Check Automation panel — if both "Default Reply" AND a keyword trigger fire on the same input, ManyChat sends both. Make keyword triggers more specific OR remove the duplicate.

### `Default Reply` doesn't fire
- ManyChat's Instagram Default Reply only triggers if NO other trigger matched. Check that you don't have a wildcard keyword (`*`) trigger eating everything.

---

## 7. WHEN YOU'RE DONE

Tell Ben:
- "Catch-All AI Closer flow built and wired into Default Reply / Story Reply / Comment / New Follower triggers."
- "Ran 5 test scenarios from my IG, all passed."

He'll verify:
- Airtable `Conversations` table has 2 rows per turn (inbound + outbound).
- Telegram admin chat got first-contact alerts on test DMs.
- ManyChat subscriber view shows tags applied (`closer_engaged`, segment tag, `qualified_lead` if intent=high).

---

## 8. WHAT NOT TO TOUCH

These are intentional configurations — leave them alone:

- The `escalate_human` tag — applied automatically when AI flags VC / press / Title Founder / scam / refund. Subscribers with this tag should NOT auto-receive AI replies (Ben handles manually). The Default Reply trigger should have a filter: "subscriber does NOT have tag `escalate_human`" → skip.
- The webhook URL — never put a URL with a different domain or `/manychat` path. The webhook is unique to BuyHalfCow.
- Custom field names — must match exactly (`email`, `state`, `segment`, etc). Renaming any of them breaks the webhook payload.

---

## 9. APPENDIX — WHAT THE WEBHOOK ACTUALLY DOES

For your understanding (not required to build):

When ManyChat fires the External Request, BuyHalfCow's server:
1. Verifies the webhook secret in the Authorization header.
2. Pulls the last ~12 turns of this subscriber's conversation history from Airtable.
3. Sends `{system prompt, history, new message}` to Anthropic Claude (with Groq llama-3 fallback).
4. Parses Claude's reply for a structured "signals" block (segment, intent, state, email, needs_human).
5. Saves the inbound + outbound message to Airtable's `Conversations` table.
6. If first contact / high intent / needs_human → sends Telegram alert to Ben.
7. Returns to ManyChat: `{ content.messages[0].text: "the reply", actions: [...]}`.
8. ManyChat speaks the reply, applies the field/tag actions.

Total roundtrip: ~1.5-3 seconds.
