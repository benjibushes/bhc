# Rancher-Side Verification Audit Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empirically verify every rancher-side function works as designed against LIVE prod before Jesse Zimmerman migration + 4-rancher sales-call batch, producing a crystal-clear "what works / what doesn't" picture.

**Architecture:** Each task corresponds to one rancher-facing surface or pipeline. Each task = (1) read-only state check via curl/Airtable/Stripe, (2) browser E2E via Chrome MCP where applicable, (3) expected output documented, (4) red/green call. NO destructive writes against real ranchers — use synthetic test rancher `recBVR538JW2ZfTuX` ("Synthetic E2E Test Ranch") for any state changes. Real-rancher checks are read-only.

**Tech Stack:** Next.js 16 prod (https://www.buyhalfcow.com), Airtable base `appgLT4z009iwAfhs`, Stripe live mode (acct `acct_1TSn5PGTWWNqassH`), Chrome MCP, Vercel CLI 53.1.0.

**Conventions used in this plan:**
- `TEST_RANCHER_ID` = `recBVR538JW2ZfTuX`
- `TEST_RANCHER_TOKEN` = the 60-day rancher-setup JWT for the test rancher (already minted in session)
- `JESSE_RANCHER_ID` = `rec3K0LsDGQKONNnb`
- `JESSE_TOKEN` = JWT minted earlier in session for Jesse
- `SK` = STRIPE_SECRET_KEY (rk_live_...RGi9RkXY, full perms, set in Vercel prod env)
- `AT_KEY` = AIRTABLE_API_KEY from .env.local
- All commands run from repo root `/Users/benji.bushes/BHC/untitled folder/bhc`

**Stop conditions:**
- Any task fails → STOP. Capture failure. Fix or escalate. Do NOT send Jesse the URL until ALL tasks green.
- If a task can't complete because of missing perms / env / data → flag, document, move to next task.

---

## Task 1: Wizard URL load + force-jump to Step 7 (tier picker)

**Files exercised:**
- `app/rancher/setup/page.tsx`
- `app/rancher/setup/RancherSetupWizard.tsx:732-790` (Already-Onboarded gate)
- `app/api/rancher/setup/route.ts` GET handler

- [ ] **Step 1: Reset test rancher to baseline**

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
export AT_KEY=$(grep -E '^AIRTABLE_API_KEY=' .env.local | head -1 | sed 's/^AIRTABLE_API_KEY=//; s/\\n$//; s/^"//; s/"$//')
curl -sS -X PATCH "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/recBVR538JW2ZfTuX" \
  -H "Authorization: Bearer $AT_KEY" -H "Content-Type: application/json" \
  -d '{"fields":{"Tier":"","Subscription Status":"","Stripe Connect Status":"","Stripe Connect Account Id":"","Stripe Subscription Id":"","Pricing Model":"legacy","Migration Status":"invited"},"typecast":true}' | python3 -m json.tool | grep -E 'Pricing Model|Migration Status'
```

Expected: `"Pricing Model": "legacy"`, `"Migration Status": "invited"`

- [ ] **Step 2: Load wizard URL in Chrome MCP**

```js
// Chrome MCP browser_batch
[
  { name: "navigate", input: { tabId: 644389273, url: "https://www.buyhalfcow.com/rancher/setup?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoicmFuY2hlci1zZXR1cCIsInJhbmNoZXJJZCI6InJlY0JWUjUzOEpXMlpmVHVYIiwiaWF0IjoxNzgxMDQyMTQwLCJleHAiOjE3ODYyMjYxNDB9.Wxq9Lm3vG151NN-J6fi_AKkiEaBDoT0YK6kn3EDm-rM" } },
  { name: "computer", input: { action: "wait", duration: 4, tabId: 644389273 } },
  { name: "javascript_tool", input: { tabId: 644389273, action: "javascript_exec", text: "({step:document.body.innerText.match(/STEP \\d+ · [A-Z ]+/)?.[0],fourCardsVisible:['PICK PASTURE','PICK RANCH','PICK OPERATOR','PICK LEGACY CONNECT'].every(t=>document.body.innerText.includes(t))})" } }
]
```

Expected: `{step:"STEP 6 · PICK YOUR PLAN", fourCardsVisible: true}`

Red flag if: step is something else, or fewer than 4 cards.

- [ ] **Step 3: Verify cookie bootstrapped**

```js
// In wizard tab:
(async()=>{const r=await fetch('/api/rancher/connect/status',{credentials:'include'}); return {status:r.status}})()
```

Expected: status 200 (cookie auths). If 401, cookie bootstrap broke.

---

## Task 2: Legacy Connect click → V2 acct creates → state persists

**Files exercised:**
- `app/api/rancher/tier/select/route.ts`
- `lib/stripeConnect.ts:createConnectAccount` (V2)
- `app/api/rancher/setup/route.ts` (cookie bootstrap on GET)

- [ ] **Step 1: Click Pick Legacy Connect**

```js
(async()=>{
  const btn=Array.from(document.querySelectorAll('button')).find(b=>(b.textContent||'').trim()==='Pick Legacy Connect');
  btn.click();
  await new Promise(r=>setTimeout(r,6000));
  const tok=new URL(location.href).searchParams.get('token');
  const r=await fetch(`/api/rancher/setup?token=${encodeURIComponent(tok)}`);
  const d=await r.json();
  return {
    tier: d.rancher?.['Tier'],
    pricingModel: d.rancher?.['Pricing Model'],
    subStatus: d.rancher?.['Subscription Status'],
    connectAcct: d.rancher?.['Stripe Connect Account Id'],
    migrationStatus: d.rancher?.['Migration Status']
  };
})()
```

Expected:
```
{
  tier: "Legacy Connect",
  pricingModel: "tier_v2",
  subStatus: "active",
  connectAcct: "acct_1Tg...",   // starts with acct_1Tg (new LIVE acct)
  migrationStatus: "upgrading"
}
```

- [ ] **Step 2: Verify Stripe Connect account exists in LIVE Stripe**

```bash
SK=<STRIPE_SECRET_KEY redacted — pull from Vercel env or 1Password>
ACCT=<paste connectAcct from Step 1>
curl -sS "https://api.stripe.com/v2/core/accounts/${ACCT}?include=configuration.merchant&include=requirements" \
  -u "$SK:" -H "Stripe-Version: 2025-09-30.preview" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('id:', d.get('id'))
print('livemode:', d.get('livemode'))
print('merchant_applied:', d.get('configuration',{}).get('merchant',{}).get('applied'))
print('contact_email:', d.get('contact_email'))"
```

Expected: `livemode: True`, `merchant_applied: True`, email matches test rancher.

- [ ] **Step 3: Click Continue → verify wizard advances to Step 9 (Stripe Connect)**

```js
(async()=>{
  await new Promise(r=>setTimeout(r,3000));
  const c=Array.from(document.querySelectorAll('button')).find(b=>(b.textContent||'').includes('picked my plan'));
  c.click();
  await new Promise(r=>setTimeout(r,3000));
  return {
    step: document.body.innerText.match(/STEP \d+ · [A-Z ]+/)?.[0],
    hasBankBtn: document.body.innerText.includes('Connect bank account'),
    onAllSetPage: document.body.innerText.includes('all set')
  };
})()
```

Expected: `step: "STEP 7 · CONNECT YOUR BANK"`, `hasBankBtn: true`, `onAllSetPage: false`.

Red flag if onAllSetPage is true → the Already-Onboarded gate fix at RancherSetupWizard.tsx:732 didn't deploy.

---

## Task 3: Click "Connect bank account" → live onboarding URL generates

**Files exercised:**
- `app/api/rancher/connect/start/route.ts`
- `lib/stripeConnect.ts:createOnboardingLink` (V2)

- [ ] **Step 1: Click bank button + verify redirect URL**

```js
(async()=>{
  const before=location.href;
  const btn=Array.from(document.querySelectorAll('button')).find(b=>(b.textContent||'').includes('Connect bank'));
  // Don't actually navigate — just trace the network request.
  const tok=new URL(location.href).searchParams.get('token');
  const r=await fetch('/api/rancher/connect/start',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'include',
    body:JSON.stringify({rancherId:'recBVR538JW2ZfTuX',from:'wizard',wizardToken:tok})
  });
  const d=await r.json();
  return {status:r.status,urlValid:d.url?.startsWith('https://connect.stripe.com/setup/s/acct_1Tg'),acctMatches:d.accountId?.startsWith('acct_1Tg')};
})()
```

Expected: `{status: 200, urlValid: true, acctMatches: true}`

- [ ] **Step 2: Confirm URL pattern matches Stripe-hosted Express onboarding**

URL shape: `https://connect.stripe.com/setup/s/acct_1Tg<random>/<token>`. Just visually confirm — Chrome MCP refuses connect.stripe.com URLs (financial safety filter).

- [ ] **Step 3: Document the URL — user opens it manually in their own browser to complete KYC**

User actions outside Chrome MCP:
1. Open URL in regular Chrome
2. Fill: company type (Individual), name, address, DOB, last-4 SSN
3. Add bank acct (use real bank for live; test rancher can use fake but Stripe will gate routing)
4. Submit → Stripe redirects back to `https://www.buyhalfcow.com/rancher/setup?connectComplete=1`
5. Wizard advances to Step 8 (Fulfillment)

Verification: after KYC completes, query Airtable:

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/recBVR538JW2ZfTuX" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
f=json.load(sys.stdin).get('fields',{})
for k in ('Stripe Connect Status','Migration Status'):
    print(f'{k}: {f.get(k,\"<empty>\")}')"
```

Expected post-KYC: `Stripe Connect Status: active`, `Migration Status: completed`

---

## Task 4: Webhook fires v2.core.account[configuration.merchant].capability_status_updated → status syncs to Airtable

**Files exercised:**
- `app/api/webhooks/stripe-connect/route.ts:189-198` (V2 event handlers)
- `app/api/webhooks/stripe-connect/route.ts:syncRancherConnectStatus`

- [ ] **Step 1: Verify webhook endpoint subscribed to V2 events in Stripe Dashboard**

Open in browser (user): `https://dashboard.stripe.com/webhooks` (LIVE mode)

Find webhook with URL `https://www.buyhalfcow.com/api/webhooks/stripe-connect`. Click → "Events" tab. Confirm subscribed events include:
- `v2.core.account.updated`
- `v2.core.account[configuration.merchant].capability_status_updated`
- `v2.core.account[requirements].updated`
- `account.updated` (V1 fallback)
- `capability.updated` (V1 fallback)
- `charge.dispute.created`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`
- `payout.failed`
- `account.application.deauthorized`
- `charge.refunded`

If V2 events not subscribed → user must add them (or BHC won't auto-flip Migration Status on Connect activate).

- [ ] **Step 2: Inspect recent webhook deliveries**

`https://dashboard.stripe.com/webhooks/we_<id>/attempts` — check last 24h: all 200s, no signature failures, no 500s.

If 500s — query Vercel logs:

```bash
# Vercel MCP
get_runtime_logs(projectId='prj_UiTlxTHcMl277z0QyrAVz82nclVA', teamId='team_LtooF0XS8M8oDBUwxphrC1RJ', query='stripe-connect webhook', since='1h', limit=20)
```

Expected: no signature errors, no `handler exception`.

- [ ] **Step 3: Verify syncRancherConnectStatus reads V2 fields correctly**

```bash
# Read-only — confirm the function would succeed on test rancher's Connect acct
curl -sS "https://api.stripe.com/v2/core/accounts/acct_1TgYqpGSr2P9OxLm?include=configuration.merchant&include=requirements" \
  -u "$SK:" -H "Stripe-Version: 2025-09-30.preview" | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=d.get('configuration',{}).get('merchant',{}) or {}
print('card_payments status:', (m.get('capabilities') or {}).get('card_payments',{}).get('status'))
print('requirements minimum_deadline status:', (d.get('requirements',{}) or {}).get('summary',{}).get('minimum_deadline',{}).get('status'))"
```

Expected (pre-KYC): `card_payments status: None`, `requirements minimum_deadline status: currently_due` (or null if no requirements collected yet).

---

## Task 5: Pasture/Ranch/Operator subscription tier paths

**Files exercised:**
- `app/api/rancher/tier/select/route.ts` (non-legacy_connect branch)
- `lib/stripeSubscription.ts:createTierCheckoutSession`
- `app/partner/checkout/[tier]/page.tsx`
- `app/partner/checkout/[tier]/success/page.tsx`

- [ ] **Step 1: Confirm STRIPE_*_PRICE_ID env vars set in Vercel prod**

```bash
vercel env ls production 2>&1 | grep -E 'STRIPE_PASTURE_PRICE_ID|STRIPE_RANCH_PRICE_ID|STRIPE_OPERATOR_PRICE_ID'
```

Expected: all 3 listed.

- [ ] **Step 2: Reset test rancher, pick Pasture instead of Legacy Connect**

```bash
# Reset
curl -sS -X PATCH "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/recBVR538JW2ZfTuX" \
  -H "Authorization: Bearer $AT_KEY" -H "Content-Type: application/json" \
  -d '{"fields":{"Tier":"","Subscription Status":"","Stripe Connect Status":"","Stripe Connect Account Id":"","Stripe Subscription Id":"","Pricing Model":"legacy","Migration Status":"invited"},"typecast":true}' >/dev/null
echo "Reset"

# Mint test session token
export JWT_SECRET=$(grep -E '^JWT_SECRET=' .env.local | head -1 | sed 's/^JWT_SECRET=//; s/\\n$//; s/^"//; s/"$//')
SESSION_TOK=$(node -e "const j=require('jsonwebtoken');console.log(j.sign({type:'rancher-session',rancherId:'recBVR538JW2ZfTuX',email:'ben+e2etest@buyhalfcow.com',name:'E2E Test Jesse',ranchName:'Synthetic E2E Test Ranch',state:'WV'},process.env.JWT_SECRET,{expiresIn:'60d'}))")

# Hit prod tier/select w/ pasture
curl -sS -X POST https://www.buyhalfcow.com/api/rancher/tier/select \
  -H "Content-Type: application/json" \
  -H "Cookie: bhc-rancher-auth=$SESSION_TOK" \
  -d '{"tier":"pasture"}' | python3 -m json.tool
```

Expected: `{"url":"https://checkout.stripe.com/c/pay/cs_live_..."}` — real Stripe Checkout URL.

- [ ] **Step 3: Verify URL loads + Stripe Checkout for $150/mo subscription**

User opens URL in browser → confirms:
- "Pasture" product
- $150.00/month recurring
- BHC as platform name
- "Stripe-Account" context = the test rancher's acct_1Tg... (Connect direct charge subscription)

User does NOT complete checkout (would create real subscription). User confirms visual only.

- [ ] **Step 4: Verify same flow for Ranch + Operator**

Repeat Steps 2-3 with `{"tier":"ranch"}` then `{"tier":"operator"}`. Confirm $350/mo + $500/mo respectively.

---

## Task 6: Rancher Dashboard /rancher loads w/ live data

**Files exercised:**
- `app/rancher/page.tsx`
- `app/rancher/layout.tsx`
- `app/api/rancher/data/route.ts`
- `lib/rancherAuth.ts:requireRancher`

- [ ] **Step 1: Verify dashboard route auth flow**

```js
// In Chrome tab, navigate to /rancher (must have rancher-session cookie from wizard)
fetch('/rancher', {credentials:'include'}).then(r => ({status: r.status, redirect: r.redirected, url: r.url}))
```

Expected: status 200, url ends in `/rancher` (NOT redirect to login).

- [ ] **Step 2: Verify referral list endpoint**

```js
fetch('/api/rancher/data', {credentials:'include'}).then(r => r.json()).then(d => ({
  rancherName: d.rancher?.['Operator Name'],
  referralCount: (d.referrals || []).length,
  tier: d.rancher?.['Tier'],
  pricingModel: d.rancher?.['Pricing Model']
}))
```

Expected: rancher name matches test rancher, tier present, pricing model present, referral list populated or empty array (no error).

- [ ] **Step 3: Verify Marketing tab loads**

```bash
curl -s "https://www.buyhalfcow.com/api/rancher/data" -H "Cookie: bhc-rancher-auth=$SESSION_TOK" | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=d.get('marketing') or {}
print('marketingFields:', list(m.keys()))"
```

Expected: keys include leadCount, conversionRate, recentActivity, or similar marketing stats.

---

## Task 7: Accept Deposit button (NRD policy)

**Files exercised:**
- `app/api/rancher/referrals/[id]/accept/route.ts`
- `app/rancher/RancherDashboard.tsx` (Accept Deposit modal)

- [ ] **Step 1: Find a referral in Awaiting Payment state on prod (read-only)**

```bash
export AT_KEY=$(grep -E '^AIRTABLE_API_KEY=' .env.local | head -1 | sed 's/^AIRTABLE_API_KEY=//; s/\\n$//; s/^"//; s/"$//')
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Referrals?filterByFormula=%7BStatus%7D%3D%22Awaiting+Payment%22&maxRecords=1" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
recs=d.get('records',[])
if not recs: print('No Awaiting Payment referrals — skip this task')
else:
    r=recs[0]
    print('id:', r['id'])
    print('Buyer:', r['fields'].get('Buyer Email'))
    print('Rancher Accepted At:', r['fields'].get('Rancher Accepted At','<unset>'))"
```

If "No Awaiting Payment referrals" → skip Task 7 (manual verification only when real one exists).

- [ ] **Step 2: Verify Accept button shows on rancher dashboard**

```js
fetch('/rancher').then(r=>r.text()).then(html=>({
  hasAcceptButton: /Accept Deposit/i.test(html) || /Accept Slot/i.test(html)
}))
```

Expected: true if a referral in Awaiting Payment exists for this rancher.

- [ ] **Step 3: Verify endpoint structure (no actual write)**

```bash
# Dry-run: send malformed body, expect 400 — proves endpoint exists + auth works
curl -sS -X POST "https://www.buyhalfcow.com/api/rancher/referrals/recXXXNOTREAL/accept" \
  -H "Cookie: bhc-rancher-auth=$SESSION_TOK" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: 404 (referral not found) — NOT 500 / 401 / 403.

---

## Task 8: Send Final Invoice button + endpoint

**Files exercised:**
- `app/api/rancher/referrals/[id]/send-final-invoice/route.ts`
- `lib/email.ts:sendBuyerFinalInvoice`
- `lib/stripeConnect.ts:depositCommissionCalc`

- [ ] **Step 1: Verify endpoint exists + auth gates**

```bash
curl -sS -X POST "https://www.buyhalfcow.com/api/rancher/referrals/recNOTREAL/send-final-invoice" \
  -H "Content-Type: application/json" \
  -d '{"finalSaleAmount":0}'
```

Expected: 401 (no session cookie).

- [ ] **Step 2: Verify endpoint w/ session, malformed body**

```bash
curl -sS -X POST "https://www.buyhalfcow.com/api/rancher/referrals/recNOTREAL/send-final-invoice" \
  -H "Content-Type: application/json" \
  -H "Cookie: bhc-rancher-auth=$SESSION_TOK" \
  -d '{}'
```

Expected: 400 or 404 — NOT 500.

- [ ] **Step 3: Verify final invoice email template renders**

Check `lib/email.ts` `sendBuyerFinalInvoice` was added in FINAL-3 task. Visual verification:

```bash
grep -n "sendBuyerFinalInvoice" lib/email.ts | head -5
```

Expected: function defined, has subject + body w/ deposit-paid + balance-owed math.

---

## Task 9: Closed Won w/ Sale Amount → Stripe invoice fires

**Files exercised:**
- `app/api/rancher/referrals/[id]/route.ts` PATCH
- `lib/stripeWebhookHelpers.ts:createCommissionInvoice` (legacy path)
- `lib/operatorSignal.ts` (loud failure alert)

- [ ] **Step 1: Verify endpoint accepts positive sale amount only**

```bash
curl -sS -X PATCH "https://www.buyhalfcow.com/api/rancher/referrals/recNOTREAL" \
  -H "Cookie: bhc-rancher-auth=$SESSION_TOK" \
  -H "Content-Type: application/json" \
  -d '{"status":"Closed Won","saleAmount":0}'
```

Expected: 400 "Sale amount must be positive" (PR #30 gate).

- [ ] **Step 2: Verify positive amount fires invoice (read-only — check recent closed-won)**

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Referrals?filterByFormula=AND(%7BStatus%7D%3D%22Closed+Won%22%2C%7BStripe+Invoice+URL%7D!%3D%22%22)&maxRecords=1&sort%5B0%5D%5Bfield%5D=Last+Modified&sort%5B0%5D%5Bdirection%5D=desc" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
recs=d.get('records',[])
if recs:
    f=recs[0]['fields']
    print('Buyer:', f.get('Buyer Email'))
    print('Sale Amount:', f.get('Sale Amount'))
    print('Stripe Invoice URL:', f.get('Stripe Invoice URL','<empty>')[:80])
else:
    print('No closed-won referrals with invoice URL yet')"
```

Expected: at least one closed-won referral with Stripe Invoice URL populated. If none — invoice path may be broken (escalate).

---

## Task 10: Quick-action email buttons (rancher intro email)

**Files exercised:**
- `app/api/rancher/quick-action/route.ts`
- `lib/email.ts:sendRancherIntro` (button hrefs)

- [ ] **Step 1: Verify endpoint accepts won/lost/pass actions**

```bash
# Send invalid action — should 400
curl -sS "https://www.buyhalfcow.com/api/rancher/quick-action?token=invalid&action=foo"
```

Expected: 400 or 401, not 500.

- [ ] **Step 2: Verify quick-action token JWT shape**

```bash
grep -n "quick-action" app/api/rancher/quick-action/route.ts | head -5
```

Expected: JWT type='rancher-quick-action', 30-day expiry, payload includes referralId.

- [ ] **Step 3: Sample a real recent rancher-intro email subject**

User checks personal Resend inbox or asks for recent `sendRancherIntro` fires:

```bash
# Vercel runtime logs filtered by recent intro emails
get_runtime_logs(projectId='prj_UiTlxTHcMl277z0QyrAVz82nclVA', teamId='team_LtooF0XS8M8oDBUwxphrC1RJ', query='sendRancherIntro OR rancher_intro', since='24h', limit=10)
```

Expected: at least one fire in last 24h (intros fire from matching/suggest).

---

## Task 11: Buyer intro email — Cal.com Book-a-call CTA

**Files exercised:**
- `lib/email.ts:sendBuyerIntroNotification`
- `lib/cal.ts` (Operator-tier routing to Ben's Cal)
- `app/api/matching/suggest/route.ts` (passes calComSlug)

- [ ] **Step 1: Verify Cal.com slug field populated on test rancher**

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/recBVR538JW2ZfTuX" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
f=json.load(sys.stdin).get('fields',{})
print('Cal.com Slug:', f.get('Cal.com Slug','<empty>'))"
```

Expected: a Cal slug populated (or empty — Cal CTA is optional per CONN-3 implementation).

- [ ] **Step 2: Verify Operator-tier emails route to Ben's Cal**

```bash
grep -n "BHC_OPERATOR_CAL_SLUG\|Operator.*Cal" lib/email.ts | head -5
```

Expected: code branches on rancherTier === 'Operator' → uses BHC_OPERATOR_CAL_SLUG env, else uses rancher's own slug.

- [ ] **Step 3: Confirm env var BHC_OPERATOR_CAL_SLUG set**

```bash
vercel env ls production 2>&1 | grep -i 'BHC_OPERATOR_CAL_SLUG'
```

Expected: variable present.

---

## Task 12: Public rancher page /ranchers/[slug]

**Files exercised:**
- `app/ranchers/[slug]/page.tsx`
- `app/ranchers/[slug]/RancherPage.tsx`

- [ ] **Step 1: Visit live ranchers/renick-valley-meats**

```bash
curl -s "https://www.buyhalfcow.com/ranchers/renick-valley-meats" | python3 -c "
import sys
html=sys.stdin.read()
print('hasBookCallCTA:', 'Book a call' in html or 'Book Now' in html or 'cal.com' in html)
print('hasPricing:', 'Quarter' in html or 'Half' in html or 'Whole' in html)
print('htmlLength:', len(html))"
```

Expected: hasBookCallCTA=true (if rancher has cal slug), hasPricing=true, htmlLength > 5000.

- [ ] **Step 2: Visit test rancher's page (if generated)**

```bash
curl -sI "https://www.buyhalfcow.com/ranchers/synthetic-e2e-test-ranch" 2>&1 | head -3
```

Expected: 200 OK or 404 (if slug not generated for test rancher).

- [ ] **Step 3: Confirm pricing-click tracking**

```bash
grep -n "pricing-click\|trackPricingClick" app/ranchers/\[slug\]/*.tsx | head -5
```

Expected: event handler for pricing-click + CAPI fire wired.

---

## Task 13: Buyer deposit checkout direct charge

**Files exercised:**
- `app/api/checkout/deposit/route.ts`
- `lib/stripeConnect.ts:createDepositCheckout`

- [ ] **Step 1: Find recent deposit checkout (read-only)**

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Payments?maxRecords=3&sort%5B0%5D%5Bfield%5D=Created+Time&sort%5B0%5D%5Bdirection%5D=desc" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
recs=json.load(sys.stdin).get('records',[])
for r in recs:
    f=r['fields']
    print(f\"Buyer: {f.get('Buyer Email','?')[:40]:40} Stripe PI: {f.get('Stripe PaymentIntent Id','?')[:30]} Status: {f.get('Status')}\")"
```

Expected: at least one recent payment row w/ Stripe PI id. If none — deposit checkout path may be broken.

- [ ] **Step 2: Verify deposit endpoint structure (read-only)**

```bash
grep -n "application_fee_amount\|stripeAccount\|nonRefundablePolicy" lib/stripeConnect.ts | head -10
```

Expected: all 3 in createDepositCheckout — direct charge + app fee + NRD metadata.

- [ ] **Step 3: Verify orphan reaper protects against Airtable failure**

```bash
grep -n "expireCheckoutSession\|recordDeposit" lib/stripeConnect.ts app/api/checkout/deposit/route.ts | head -10
```

Expected: if recordDeposit fails, expireCheckoutSession fires.

---

## Task 14: Subscription billing — tier change + cancel + portal

**Files exercised:**
- `app/api/rancher/tier/change/route.ts`
- `lib/stripeSubscription.ts:changeSubscriptionTier`
- `app/api/rancher/billing-portal/route.ts`

- [ ] **Step 1: Verify tier-change endpoint exists**

```bash
ls app/api/rancher/tier/change/route.ts 2>&1 && grep -n "changeSubscriptionTier" app/api/rancher/tier/change/route.ts | head -3
```

Expected: file exists, imports changeSubscriptionTier.

- [ ] **Step 2: Verify portal endpoint structure**

```bash
ls app/api/rancher/billing-portal/route.ts 2>&1 && grep -n "createBillingPortalSession\|customer_account" app/api/rancher/billing-portal/route.ts | head -5
```

Expected: file exists, uses customer_account (V2 acct).

- [ ] **Step 3: Verify past-due dunning email exists**

```bash
grep -n "sendBrandPartnerPastDue\|past_due" lib/email.ts | head -5
```

Expected: dunning template defined.

---

## Task 15: Webhook handlers — V2 + dispute + payout.failed + deauthorize + refund

**Files exercised:**
- `app/api/webhooks/stripe-connect/route.ts`

- [ ] **Step 1: Verify all 9 event types handled**

```bash
grep -n "case '" app/api/webhooks/stripe-connect/route.ts | head -20
```

Expected: cases for:
- `account.updated`, `capability.updated` (V1 fallback)
- `v2.core.account[requirements].updated`
- `v2.core.account[configuration.merchant].capability_status_updated`
- `v2.core.account.updated`
- `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.closed`
- `payout.failed`
- `account.application.deauthorized`
- `charge.refunded`

- [ ] **Step 2: Verify idempotency via Stripe Events table**

```bash
grep -n "STRIPE_EVENTS_TABLE\|Event Id.*existing" app/api/webhooks/stripe-connect/route.ts | head -10
```

Expected: dedupe before processing, flip to 'processed' after.

- [ ] **Step 3: Verify audit log on all mutations**

```bash
grep -n "logAuditEntry" app/api/webhooks/stripe-connect/route.ts | head -5
```

Expected: at least 1 logAuditEntry call.

---

## Task 16: Crons (capacity-drift, batch-approve, referral-chasup, migration-nudge, launch-warmup)

**Files exercised:**
- `app/api/cron/*/route.ts`
- `vercel.json` cron schedule

- [ ] **Step 1: Inventory cron files**

```bash
ls app/api/cron/ && cat vercel.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('Cron jobs:'); [print(f' {c[\"path\"]} @ {c[\"schedule\"]}') for c in d.get('crons',[])]"
```

Expected: 10+ crons scheduled.

- [ ] **Step 2: Verify all crons logged successful run in last 24h**

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Cron%20Runs?filterByFormula=DATETIME_DIFF(NOW()%2C%7BStarted+At%7D%2C%27hours%27)%3C24&fields%5B%5D=Cron+Name&fields%5B%5D=Status&fields%5B%5D=Started+At&maxRecords=100" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
recs=json.load(sys.stdin).get('records',[])
from collections import defaultdict
status={}
for r in recs:
    n=r['fields'].get('Cron Name','?')
    s=r['fields'].get('Status','?')
    status.setdefault(n,[]).append(s)
for n,sl in sorted(status.items()):
    ok=sum(1 for s in sl if s=='succeeded')
    fl=sum(1 for s in sl if s=='failed')
    print(f'  {n}: {ok} ok / {fl} fail')"
```

Expected: all crons have at least 1 success, 0 failures.

- [ ] **Step 3: Spot-check capacity-drift output**

```bash
get_runtime_logs(projectId='prj_UiTlxTHcMl277z0QyrAVz82nclVA', teamId='team_LtooF0XS8M8oDBUwxphrC1RJ', query='capacity-drift', since='24h', limit=10)
```

Expected: ran successfully, no errors.

---

## Task 17: Admin /admin/migration tracker

**Files exercised:**
- `app/admin/migration/page.tsx`
- `app/api/admin/migration/data/route.ts`

- [ ] **Step 1: Load tracker (requires admin password)**

User opens `https://www.buyhalfcow.com/admin/migration` in browser → enters admin pwd → expects table showing all legacy ranchers w/ Migration Status.

- [ ] **Step 2: Verify Jesse Zimmerman row visible**

User scans table for `Renick Valley Meats` / `Jesse Zimmerman` / rec3K0LsDGQKONNnb. Migration Status column should show `invited` (or `upgrading` if started).

- [ ] **Step 3: Verify manual unblock button**

User looks for "Send Upgrade Link" button next to each rancher. Click → expects new email to fire (or skip without firing — read-only verification only).

---

## Task 18: V1 endpoints still functional w/ new restricted key (post-rotation regression check)

**Files exercised:** all V1 Stripe touchpoints

- [ ] **Step 1: Recent subscription invoice fires**

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Brand%20Partners?filterByFormula=DATETIME_DIFF(NOW()%2C%7BSubscription+Renewed+At%7D%2C%27hours%27)%3C72&fields%5B%5D=Brand+Name&fields%5B%5D=Subscription+Renewed+At&maxRecords=10" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
recs=json.load(sys.stdin).get('records',[])
print(f'Brand partner renewals last 72h: {len(recs)}')"
```

Expected: any value (could be 0 if no renewals scheduled). If >0, those used the new key successfully.

- [ ] **Step 2: Recent buyer deposit checkout fires**

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Payments?filterByFormula=DATETIME_DIFF(NOW()%2C%7BCreated+Time%7D%2C%27hours%27)%3C24&maxRecords=10" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
recs=json.load(sys.stdin).get('records',[])
print(f'New buyer deposits last 24h: {len(recs)}')
ok=sum(1 for r in recs if r['fields'].get('Status')=='succeeded')
fail=sum(1 for r in recs if r['fields'].get('Status') in ('failed','requires_action'))
print(f'  succeeded: {ok}')
print(f'  failed/blocked: {fail}')"
```

Expected: if any deposits in last 24h, succeeded count > 0 + failed count == 0 (post-rotation regressions).

- [ ] **Step 3: No 500s in recent Stripe-related routes**

```bash
get_runtime_logs(projectId='prj_UiTlxTHcMl277z0QyrAVz82nclVA', teamId='team_LtooF0XS8M8oDBUwxphrC1RJ', query='Stripe OR stripe', since='2h', level=['error','fatal'], limit=20)
```

Expected: no permission-denied errors, no createCheckout failures.

---

## Task 19: Jesse Zimmerman ready-state verification

**Files exercised:** N/A (read-only audit)

- [ ] **Step 1: Verify Jesse's Airtable row state**

```bash
curl -sS "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/rec3K0LsDGQKONNnb" \
  -H "Authorization: Bearer $AT_KEY" | python3 -c "
import json,sys
f=json.load(sys.stdin).get('fields',{})
print('Operator Name:', f.get('Operator Name'))
print('Ranch Name:', f.get('Ranch Name'))
print('Pricing Model:', f.get('Pricing Model'))
print('Agreement Signed:', f.get('Agreement Signed'))
print('Active Status:', f.get('Active Status'))
print('Migration Status:', f.get('Migration Status'))
print('Stripe Connect Account Id:', f.get('Stripe Connect Account Id','<empty>'))
print('Tier:', f.get('Tier','<empty>'))"
```

Expected: Pricing Model=legacy, Agreement Signed=true, Active Status=Active, Migration Status=invited (or upgrading if he's started), no Stripe Connect acct yet.

- [ ] **Step 2: Mint fresh 60-day token for Jesse (if needed)**

```bash
export JWT_SECRET=$(grep -E '^JWT_SECRET=' .env.local | head -1 | sed 's/^JWT_SECRET=//; s/\\n$//; s/^"//; s/"$//')
JESSE_TOK=$(node -e "const j=require('jsonwebtoken');console.log(j.sign({type:'rancher-setup',rancherId:'rec3K0LsDGQKONNnb'},process.env.JWT_SECRET,{expiresIn:'60d'}))")
echo "https://www.buyhalfcow.com/rancher/setup?token=$JESSE_TOK"
```

Expected: URL printed, ready to send Jesse.

- [ ] **Step 3: Test the wizard load with Jesse's URL (read-only, do NOT click anything that mutates)**

```js
// Chrome MCP — open Jesse URL, verify Step 6 renders + 4 cards
navigate to https://www.buyhalfcow.com/rancher/setup?token=<JESSE_TOK>
verify: step="STEP 6 · PICK YOUR PLAN", 4 cards visible, no error banner
```

Expected: identical to test rancher wizard load. If different — escalate.

DO NOT click anything in Jesse's wizard. Read-only verify only.

---

## Task 20: Final smoke (close out)

- [ ] **Step 1: Confirm prod sha matches HEAD**

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
echo "HEAD: $(git rev-parse --short HEAD)"
curl -s https://www.buyhalfcow.com/api/version | python3 -c "import json,sys; print('prod:', json.load(sys.stdin).get('shortSha'))"
```

Expected: same sha.

- [ ] **Step 2: Reset test rancher to baseline (cleanup)**

```bash
curl -sS -X PATCH "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/recBVR538JW2ZfTuX" \
  -H "Authorization: Bearer $AT_KEY" -H "Content-Type: application/json" \
  -d '{"fields":{"Tier":"","Subscription Status":"","Stripe Connect Status":"","Stripe Connect Account Id":"","Stripe Subscription Id":"","Pricing Model":"legacy","Migration Status":"invited"},"typecast":true}' >/dev/null
echo "Cleaned"
```

- [ ] **Step 3: Send Jesse the URL**

ONLY if Tasks 1-19 all green. Otherwise stop + report.

```
Send URL to Jesse via SMS or email:
https://www.buyhalfcow.com/rancher/setup?token=<JESSE_TOK>

Watch Telegram for:
  - 🏦 STRIPE CONNECT ACTIVE — Renick Valley Meats
  - Migration Status auto-flip to 'completed' in /admin/migration
```

---

## Failure handling protocol

If any task fails:

1. Capture: paste exact error / response
2. Classify: code bug / env config / data state / external (Stripe / Cal)
3. Fix path:
   - Code → patch + redeploy + retest same task
   - Env → update env + redeploy + retest
   - Data → fix Airtable record + retest
   - External → flag + work around if possible
4. If 3 fix attempts fail → STOP. Surface to user. Do NOT send Jesse the URL.

## Reversibility plan

State changes are isolated to test rancher recBVR538JW2ZfTuX. To fully reset:

```bash
curl -sS -X PATCH "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/recBVR538JW2ZfTuX" \
  -H "Authorization: Bearer $AT_KEY" -H "Content-Type: application/json" \
  -d '{"fields":{"Tier":"","Subscription Status":"","Stripe Connect Status":"","Stripe Connect Account Id":"","Stripe Subscription Id":"","Pricing Model":"legacy","Migration Status":"invited"},"typecast":true}' >/dev/null
```

LIVE Stripe Connect accounts created during testing (`acct_1Tg...`) remain on platform. They're dormant — no customers, no charges, no payouts. Optionally close via Stripe Dashboard → Connected Accounts → search test rancher email → Close. Not required.

## Pass/fail summary template

After all tasks, fill in:

```
Task 1 [Wizard load]:                ✅ / ❌
Task 2 [Legacy Connect persist]:     ✅ / ❌
Task 3 [Bank onboarding URL]:        ✅ / ❌
Task 4 [Webhook V2 events]:          ✅ / ❌
Task 5 [Subscription tiers]:         ✅ / ❌
Task 6 [Dashboard load]:             ✅ / ❌
Task 7 [Accept Deposit]:             ✅ / ❌
Task 8 [Send Final Invoice]:         ✅ / ❌
Task 9 [Closed Won + invoice]:       ✅ / ❌
Task 10 [Quick-action buttons]:      ✅ / ❌
Task 11 [Buyer intro w/ Cal.com]:    ✅ / ❌
Task 12 [Public rancher page]:       ✅ / ❌
Task 13 [Buyer deposit checkout]:    ✅ / ❌
Task 14 [Subscription change/portal]: ✅ / ❌
Task 15 [Webhook handlers]:          ✅ / ❌
Task 16 [Crons]:                     ✅ / ❌
Task 17 [Admin migration tracker]:   ✅ / ❌
Task 18 [V1 regression check]:       ✅ / ❌
Task 19 [Jesse ready-state]:         ✅ / ❌
Task 20 [Final smoke]:               ✅ / ❌

OVERALL: ___/20 green → SEND JESSE / HOLD JESSE
```

If <20/20 → HOLD Jesse. Fix gaps first.
