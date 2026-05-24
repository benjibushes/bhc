# first-month-founder-letter

**Audience:** all backers + Founding Herd (founder segment, MOFU retention)
**Channel:** email broadcast (manual send via broadcast tool) + Founders Wall mirror
**Length target:** ≤700 words
**Voice:** founder-letter — long-form, conversational, lowercase opener, mission line once, "— Ben + the herd" sign-off
**`{verify}` placeholders:** flagged for operator fact-check before send

---

**Subject:** four weeks in — what we shipped, what we learned, what's next

**Preheader:** the food revolution doesn't happen unless ranchers win. here's how the first month went.

---

hey — Ben here.

four weeks since the founding herd opened. i owe you a real update — not a recap, not a victory lap, just what actually happened.

**what we shipped**

the founding herd opened with 100 numbered spots, 5 tiers, no equity. four weeks later: {founding100Claimed}{verify} founding 100 spots claimed, {titleFoundersClaimed}{verify} title founders in, and {totalBackers}{verify} total backers across all five tiers including the $100 herd subscribers. every one of you got a personal email from me within 24 hours. if i missed yours, reply to this and i'll fix it today.

on the marketplace side: we went from 7 verified ranches to {currentRancherCount}{verify} verified, with {selfSubmittedCount}{verify} more self-submitted ranches now sitting as yellow pins on the public map waiting to complete onboarding. the 5-minute self-serve wizard is live and working — median onboarding time dropped from ~5 days (when i was doing it by hand) to {medianOnboardMinutes}{verify} minutes.

closed deals through the network: {closedDealCount}{verify} since launch, total GMV {closedGMV}{verify}. every one of those deals means a real family got real beef from a real ranch in their state, and a rancher got paid without losing their customer to a marketplace skim.

the founders wall went live at /founders#wall on day three. every backer name is on it, numbered, signed.

**what we learned**

three things that surprised me.

one — the bottleneck wasn't buyer demand. it was rancher supply. we have {buyerPipelineCount}{verify} buyers sitting in the pipeline ready to close in the next 60 days. we don't have enough verified ranchers in {topUnderservedStates}{verify} to route them all. that's the wall we're hitting now.

two — the self-serve wizard outperformed the call-based onboarding by a huge margin. when i was personally walking ranchers through it, completion rate was about {oldCompletionRate}{verify}%. the new wizard, with no human call required, is hitting {newCompletionRate}{verify}%. ranchers don't want a sales call. they want a working tool.

three — the founding herd is not who i thought it would be. about half the backers are existing buyers who already trust the product. the other half are people i've never met, who saw the founder content and wanted skin in the game before this got easy to bet on. that second group is the surprise. thank you for trusting it cold.

**what's next**

three priorities for the next four weeks.

one — cold rancher outreach in the top underserved states. we're sending state-targeted emails to D2C operators in {targetStates}{verify} with concrete buyer-count numbers for their state. goal: {rancherTarget}{verify} new verified ranches by end of june.

two — brand partner program goes public. three tiers — $99, $499, $2,500/quarter — for D2C-aligned product brands. coolers, knives, cutting boards, regen supplements, ranching media. revenue here funds the engineering side of the build.

three — first quarterly open ledger drops at end of june. every dollar in, every dollar out, line-itemed. that's the deal we made with you. no surprises.

the food revolution doesn't happen unless ranchers win. ranchers win when families buy direct. families buy direct when we route them, screen them, and get out of the way. the first month proved the model. month two is about volume.

if you want the numbers behind any of the above, reply to this — i'll send the raw airtable counts. if you want to see your name on the wall, it's at buyhalfcow.com/founders#wall.

talk in four weeks.

— Ben + the herd

---

*Word count (body, no subject/preheader): 632*

---

## OPERATOR PRE-SEND CHECKLIST

Pull and replace before sending:

- `{founding100Claimed}` — Airtable Consumers · Founder Tier=Founding 100 count
- `{titleFoundersClaimed}` — Airtable Consumers · Founder Tier=Title Founder count
- `{totalBackers}` — Airtable Consumers · Founding Herd MRR active + one-time-paid count
- `{currentRancherCount}` — Airtable Ranchers · Verification Status=Verified count
- `{selfSubmittedCount}` — Airtable Ranchers · Self-Submitted At not blank AND Verification Status!=Verified
- `{medianOnboardMinutes}` — Airtable Ranchers · time between Self-Submitted At and Wizard Completed At, median
- `{closedDealCount}` — Airtable Referrals · Status=Closed Won count (since 2026-04-24)
- `{closedGMV}` — Sum of Sale Amount on Closed Won (since 2026-04-24)
- `{buyerPipelineCount}` — Consumers · Segment=Beef Buyer · Status=WAITING or READY
- `{topUnderservedStates}` — top 3 states by buyer count where verified rancher count = 0
- `{oldCompletionRate}` — pre-wizard, manual onboarding completion rate (operator memory)
- `{newCompletionRate}` — current wizard funnel completion (Airtable + analytics)
- `{targetStates}` — pick from cold-outreach-rancher-templates.md state clusters
- `{rancherTarget}` — pick a number Ben can actually hit
