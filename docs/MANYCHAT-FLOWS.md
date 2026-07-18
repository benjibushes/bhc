# ManyChat — the HERD flow (research-backed rebuild)

*2026-07-17. ONE CTA on every reel: **comment HERD**. Replaces the 5-keyword
sprawl + the 8-turn open-AI closer that leaked. Design is button-first: the
DM's only job is the right link, fast — qualification lives on the landing
page, not in the DMs.*

**The one rule that fixes everything:** the link lands on **message 2, behind
a button tap** — never in the first DM. The tap is the opt-in that moves the
thread out of Instagram's Message Requests folder, refreshes the 24-hour
window, and earns the link. First DM = the fork, nothing else. Never more than
2 messages before the link. Never a question the person has to answer before
they get it. (Sources: ManyChat IG DM guide; creatorflow DM-funnel teardown —
"link past message 3 = most people drop off"; button flows complete ~72% vs
~33% for open text.)

**Canonical links — use EXACTLY these (UTM tags the IG lead scorer #263):**
- buyer quiz → `https://www.buyhalfcow.com/access?utm_source=ig&utm_medium=manychat&utm_campaign=herd`
- rancher apply → `https://www.buyhalfcow.com/sell?utm_source=ig&utm_medium=manychat&utm_campaign=herd`
- free guide → `https://www.buyhalfcow.com/guide?utm_source=ig&utm_medium=manychat&utm_campaign=herd`

---

## The flow — keyword `HERD`

**Trigger:** comment or DM contains `herd` (case-insensitive, loose/contains).
Keep `beef` / `share` / `cow` / `sell` / `price` as **silent fuzzy synonyms
that dump into this same flow** — NOT as their own advertised CTAs. One CTA per
reel: *"comment HERD."*

### Step 1 — public comment reply (rotate 5, so it doesn't read as botted)

1. `sent it to your dms 🤝`
2. `just dm'd you`
3. `check your dms — it's there`
4. `in your dms now 🤝`
5. `dm'd you, go look`

### Step 2 — first DM = the fork (NO link, 3 SOLID buttons)

> hey — ben here 🤠 you commented HERD — which one's you?

**Buttons (SOLID buttons, not quick-replies — verbatim labels):**
- `i want a freezer of beef`
- `i raise cattle + want buyers`
- `just looking around`

### Step 3 — message 2, per button (one link each, delivered on the tap)

**→ `i want a freezer of beef`**
> perfect. the quiz matches you to a verified ranch in your state — budget,
> freezer size, timing, all in about 90 seconds. that's where it happens 👉
> https://www.buyhalfcow.com/access?utm_source=ig&utm_medium=manychat&utm_campaign=herd
>
> reply STOP anytime to opt out.

*(tag `beef-buyer` + `ig-herd`)*

**→ `i raise cattle + want buyers`**
> you're who i built this for. we route qualified, deposit-down buyers in your
> state straight to your ranch — your stripe, your customers. free to start,
> apply's 90 seconds 👉
> https://www.buyhalfcow.com/sell?utm_source=ig&utm_medium=manychat&utm_campaign=herd
>
> what state are you ranching in? drop it here and i'll flag your area. — ben

*(tag `rancher-lead` + `ig-herd`. The link is NOT gated behind the state
answer — it's already sent above. The state question just warms the handoff.
Check `rancher-lead` weekly, hand warm ones to the call list.)*

**→ `just looking around`**
> no pressure. here's the free guide — what a share actually costs per pound,
> how much freezer you need, how the deposit works 👉
> https://www.buyhalfcow.com/guide?utm_source=ig&utm_medium=manychat&utm_campaign=herd
>
> whenever you're ready, comment HERD on any reel and i'll get you sorted.
> reply STOP to opt out.

*(tag `curious` + `ig-herd`)*

---

## Where qualification goes

**In-DM: only the fork tap.** That single tap segments the audience AND is the
opt-in micro-commitment. Ask nothing else before the link.

- **Buyers** → 100% of qualification (state, email, budget, freezer, timing) is
  on the `/access` quiz. Ask NONE of it in the DM — every field moved off the
  page costs ~5–10% completion.
- **Ranchers** → link first (above), then exactly ONE ungated question: state.
  `/sell` does the real qualification (herd size, tier, Stripe Connect, sign).
  Do not turn this branch back into an in-DM form.
- **Curious** → no qualification. Deliver the guide, leave the door open.

---

## The AI catch-all (tiny, caged — only for free-typers)

Only fires when someone free-types with **no button tap and no keyword**.
Everyone else never touches it. This replaces the deleted 8-turn closer.

**Hard limits (enforce in the system prompt — see `MANYCHAT_AI_CLOSER.md`):**
- **Max 2 turns, then it MUST show the 3 fork buttons or hand to a human.** No
  exceptions. This one rule kills the old 8-turn leak.
- **1–2 short sentences per reply. One question per turn, max.** No walls of
  text. Never volunteer pricing, availability, deposit mechanics, or policy
  unless asked — answer only what was asked, then route.
- **Scope = route + light FAQ only** ("do you ship to my state?", "what's the
  difference between a share and the shop?"), answered in Ben's voice, always
  ending by presenting the 3 buttons.
- **NEVER captures email / phone / address in the DM.** That lives on the page.
- **Support keywords** (`refund`, `wrong`, `problem`, `melted`, `charged`) →
  assign to human + tag `support`. No bot answer.

---

## What was DELETED (and why)

- ❌ **The open-ended AI closer that free-chats up to 8 turns** capturing
  state+email+timing before giving a link — the entire reported problem.
- ❌ **In-DM email capture** — moved to `/access`.
- ❌ **The BEEF DM's "anything you're hunting for? just reply — it's really
  me"** open-chat invite — that line was the mouth of the 8-turn hole.
- ❌ **Multi-keyword sprawl** (BEEF/SHARE/RANCH/GUIDE/HAT/price/cost as separate
  advertised triggers) — collapsed to one `HERD` + the fork.
- ❌ **The "type BEEF / SHARE / RANCH" default menu** — tapping beats typing.
- ❌ **Any DM that opens with a raw link to a cold recipient** — links now live
  on message 2 behind the tap, or they rot in Requests + trip Meta's spam
  classifier.
- ❌ **The HAT/gear front-door CTA** — folded into `/links`; not one of the 3
  audiences worth a fork slot.

**KEPT:** rotate-5 public replies · one link per message · UTM on every link ·
support-keyword human handoff · loose/case-insensitive matching.

---

## Build it in ManyChat (no-code, ~15 min)

1. Open the IG Herd Funnel automation. **Delete** the old keyword triggers +
   the AI-Step qualifier + the default keyword menu (see DELETED list).
2. New trigger: **Instagram → Comment/DM contains `herd`** (+ silent synonyms).
3. Public reply: enable comment auto-reply, paste the 5 rotate lines.
4. First DM = the fork text + **3 Buttons** (Button type, NOT Quick Reply) with
   the 3 verbatim labels.
5. Each button → a **Send Message** with that branch's message 2 + link + tag.
6. Rancher branch: after the message, a **User Input (text) → save to `State`**.
7. Fallback (no keyword / free text) → the **AI Step** using the caged prompt
   in `MANYCHAT_AI_CLOSER.md`; set **Max turns = 2**; on completion → show the
   3 fork buttons.
8. Support-keyword rule: message contains refund/wrong/problem/melted/charged →
   assign to human + tag `support`.
9. Turn OFF every old flow pointing at retired links or the 5 old keywords.

## The content loop this powers

Every reel caption ends **"comment HERD 👇"**. Comments spike reach → the
public reply feeds the algorithm → the button fork routes in 2 taps → UTM'd
links let the lead scorer grade IG sources. Free ads until Meta flips on.
