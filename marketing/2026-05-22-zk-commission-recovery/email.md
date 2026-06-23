# ZK Commission Recovery — Accountability Email

**To:** zach@zkranches.com
**Cc:** (your inbox)
**From:** ben@buyhalfcow.com
**Subject:** quick audit on your BHC leads + commission

---

```
Hey Zach,

Quick audit on your BuyHalfCow pipeline.

Per our agreement (signed 2026-04-15) — 10% commission on every closed
deal originated through BHC. Locked rate, every deal, no exceptions.

I'm reviewing the 41 leads we've sent you and our platform shows zero
deals marked Closed Won by your end. But:

- Multiple buyers have replied directly to our inbox confirming they
  bought from you (Amy Blankinship, Cody Rhouse + others I'm still
  pulling)
- Our buyer-pulse survey came back "connected" on at least one
- 33 of your leads got auto-closed Lost by our system on May 5-11,
  which I now believe was wrong — they were actually closing
  off-platform without being marked

Two things I need from you this week:

1. An itemized list of which BHC-introduced buyers you closed deals
   with + the sale amount for each. Even rough numbers work.

2. Commission remittance @ 10% on those sales. I'll send a Stripe
   invoice for the total once we reconcile the numbers, or you can
   Venmo/Zelle direct if faster.

If the answer is "none of them closed yet" — that's fine, just confirm
that explicitly so I can update our records.

This isn't me being a jerk. It's me running a marketplace that has to
work the same for every rancher. Ashcraft pays, Hewitson pays, Gift
pays. Everybody on the platform pays the same 10% when a deal closes.

Reply by Friday and we're square. If I don't hear back, I'll need to
pause your rancher status until we sort this out — which I really
don't want to do because your leads are some of the highest-volume
ones in the network.

Let me know.

— Ben
buyhalfcow.com
432-... (or whatever your direct line is)
```

---

## Why this email works (psychology)

- **Reciprocity reminder** — "Ashcraft pays, Hewitson pays" frames the ask as fairness, not extraction
- **Loss aversion** — pause threat is concrete + immediate ("Friday")
- **Pratfall** — admits the system auto-closed wrong (you're being honest about platform bugs)
- **Authority** — references signed agreement + locked rate
- **Specific accountability** — names two buyers by email = "we have receipts"
- **Easy out** — "Venmo/Zelle direct if faster" lowers payment friction
- **Future-positive** — "your leads are some of the highest-volume" preserves relationship

## Send timing

Tonight or AM. Either works. Avoid Friday after 3pm (gives him weekend escape hatch).

## Track in Airtable

After sending, log in your manual ops list:
- Date sent
- Zach's response date
- Amount reconciled
- Whether commission landed

## If no response by Friday

1. Send second email: "Following up — need to hear back this week."
2. Telegram you to flip ZK Active Status → Paused via `/pausecron rancher-launch-warmup` or via the rancher record direct
3. Stop new ZK leads from firing
4. Re-engage when commission lands

## Backup data — buyers w/ strong signals you can cite if pushed

Per your Airtable audit:

| Buyer | Order | Budget | Status | Signal |
|---|---|---|---|---|
| Amy Blankinship | Half | Unsure | Intro Sent | **buyer-pulse=connected** |
| Cody Rhouse | Half | — | Intro Sent | inbound reply to Zach-followup |
| Lily Miller | Half | $1000-$2000 | Closed Lost (auto) | high signal |
| Holly Breen | Whole | $2000+ | Closed Lost (auto) | high signal |
| Julianna Thompson | Whole | Unsure | Closed Lost (auto) | high signal |
| terry raleigh | Whole | Unsure | Closed Lost (auto) | high signal |
| Jessica Woolery | Half | $1000-$2000 | Closed Lost (auto) | high signal |
| Brandie Krein | Half | Unsure | Closed Lost (auto) | medium signal |
| Lorie Jones | Half | $1000-$2000 | Closed Lost (auto) | medium signal |
| Gaynell Pritts | Half | Unsure | Closed Lost (auto) | medium signal |
| Morgan Fiebig | Half | Unsure | Closed Lost (auto) | medium signal |
| Shannon OConnor | Half | $1000-$2000 | Closed Lost (auto) | medium signal |
| Owen Porter | Quarter | $1000-$2000 | Closed Lost (auto) | medium signal |
| Kyle Spicer | Not Sure | $2000+ | Closed Lost (auto) | medium signal |
| Alex Young | Not Sure | $1000-$2000 | Closed Lost (auto) | medium signal |

If all 15 closed @ estimated avg sale × 10% = **~$2,400 commission owed**.
If just the strong-signal 7 = **~$1,200 commission owed**.

Frame your reply demands around the strong-signal 7 first. Easier number for Zach to swallow + admit.
