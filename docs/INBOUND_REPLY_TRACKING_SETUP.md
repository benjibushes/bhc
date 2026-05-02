# Inbound Reply Tracking Setup

Captures **every reply** to BHC outbound emails, classifies via Claude, logs
to the `Conversations` Airtable table, and mirrors to Telegram in real time.
Drives the answer to "why aren't buyers closing?"

## How it works

```
Outbound BHC email
  Reply-To: ref-recXXX@replies.buyhalfcow.com
        ↓
Buyer/rancher hits Reply
        ↓
Email lands at replies.buyhalfcow.com (via MX)
        ↓
Resend Inbound parses + POSTs to webhook
        ↓
/api/webhooks/resend-inbound (NEW)
        ↓
Claude classifies: objection category, sentiment, action needed
        ↓
Conversations Airtable row + Telegram mirror
        ↓
If "propose-close-won": one-tap card → close-detector flow
```

---

## Three setup steps you need to do

### Step 1: DNS records on `replies.buyhalfcow.com` (5 min)

In your DNS provider (wherever buyhalfcow.com is hosted), add the records
Resend's dashboard shows you for the new domain. Typically:

| Type | Host | Value | Priority |
|------|------|-------|----------|
| MX | replies | (whatever Resend provides — usually inbound.resend.com or feedback-smtp.*) | 10 |
| TXT | replies | (SPF — Resend provides) | — |
| TXT | resend._domainkey.replies | (DKIM key — Resend provides) | — |

Resend's domain verification page shows the exact values. Copy them straight
across.

### Step 2: Inbound endpoint in Resend dashboard (2 min)

Resend dashboard → **Inbound** (or "Email Receiving") → Add endpoint:

- **Domain:** `replies.buyhalfcow.com`
- **URL:** `https://www.buyhalfcow.com/api/webhooks/resend-inbound`
- **Mode:** Catch-all (route all `*@replies.buyhalfcow.com` here)
- **Format:** JSON parsed (default)

Once saved, Resend will start POSTing parsed inbound emails to that URL.

### Step 3: Create `Conversations` Airtable table (5 min)

In the BHC base, "+ Add a table" → "Start from scratch" → name it `Conversations`.

Fields (in this order):

| Field name | Type | Options |
|---|---|---|
| Timestamp | Date with time (primary) | — |
| Direction | Single select | `inbound`, `outbound` |
| From | Single line text | — |
| To | Single line text | — |
| Subject | Single line text | — |
| Body | Long text | — |
| Body Plain | Long text | — |
| Linked Referral | Link to another record → Referrals | Allow multiple = OFF |
| Linked Consumer | Link to another record → Consumers | Allow multiple = OFF |
| Linked Rancher | Link to another record → Ranchers | Allow multiple = OFF |
| Sender Type | Single select | `buyer`, `rancher`, `unknown` |
| Objection Category | Single select | `price`, `distance`, `timing`, `cut`, `ghost`, `ready-to-buy`, `scheduling`, `capacity`, `quality`, `other`, `none` |
| Sentiment | Single select | `positive`, `neutral`, `blocking` |
| Action Needed | Single select | `none`, `ben-eyes`, `auto-respond`, `propose-close-won` |
| AI Summary | Long text | — |
| Raw Headers | Long text | — |

The webhook degrades gracefully if this table doesn't exist yet (logs to
console + Telegram only), but you lose the searchable history until it's
created.

### Optional Step 4: env var (only if your domain isn't `replies.buyhalfcow.com`)

If you used a different subdomain, add to `.env.local` AND Vercel:
```
REPLIES_DOMAIN=your-actual-replies-subdomain.buyhalfcow.com
```

Default fallback is `replies.buyhalfcow.com` so this only matters if you
named it differently.

---

## What gets tracked vs. what doesn't

| Source | Tracked? |
|---|---|
| Reply to a BHC intro email (buyer or rancher) | ✅ Tagged Reply-To → captured |
| Reply to a BHC chase-up / pulse / sequence email | ✅ As outbound emails get tagged (Phase 2 will tag the rest) |
| Direct email to `ben@buyhalfcow.com` | ❌ Lands in your inbox unless you add a forward rule |
| Buyer fills out `/r/[slug]/contact` form | ✅ Already in Inquiries table; can mirror to Conversations |
| SMS / phone calls | ❌ Not yet (Phase 4 voice agent) |

To capture direct emails to `ben@buyhalfcow.com` too, set up a Gmail/Outlook
forwarding rule:
- Filter: `to:ben@buyhalfcow.com`
- Action: Forward to `inbox@replies.buyhalfcow.com`

The webhook handles `inbox@` as a generic fallback (no thread, AI still
classifies).

---

## Verifying it works

After Steps 1–3 land:

```bash
# Health check (no auth needed)
curl https://www.buyhalfcow.com/api/webhooks/resend-inbound
# → {"ok":true,"endpoint":"resend-inbound","domain":"replies.buyhalfcow.com"}
```

Send yourself a test:
1. Use Gmail or any client to email `ref-recTESTXXX@replies.buyhalfcow.com` with a real-looking reply ("Yeah we picked up the half cow last week, was great!")
2. Within ~30 seconds you should get a Telegram card showing the classified reply
3. Check the `Conversations` table — new row appears with `Direction: inbound` and the AI's read

For an end-to-end test, route a fresh signup through `/api/matching/suggest`,
then reply to either the buyer's or rancher's intro email. The reply should
thread back to the referral and show up in `Conversations` with the linked
referral record.

---

## What's tagged today

Outbound emails currently using tagged Reply-To:
- ✅ `sendBuyerIntroNotification` (buyer → rancher intro)
- ✅ Rancher intro email in `app/api/matching/suggest/route.ts`

Coming next (Phase 2):
- Chase-up emails (`sendChaseUpEmail`)
- Buyer pulse emails (new cron — coming next ship)
- Re-engagement / RTB prompts (`sendReadyToBuyPrompt`)
- Welcome / approval emails (`sendConsumerApproval`)

Existing emails without `_replyContext` fall through to the legacy `ben@<domain>`
Reply-To — they still work, just don't thread to a specific record. Safe to
ship the change incrementally.
