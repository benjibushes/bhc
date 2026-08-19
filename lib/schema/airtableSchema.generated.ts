// ───────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT BY HAND.
//   Regenerate:  npm run schema:snapshot
//   Staleness:   npm run schema:snapshot -- --check
//
// A frozen copy of the live Airtable base schema (names + select choices
// only — no record data, no PII). Two consumers:
//   1. lib/schema/selectGuard.ts  — runtime: a select value that is not a
//      real option can never be sent, so Airtable can never mint it.
//   2. tools/schema-guard.ts      — CI: every field name and select literal
//      the code can write is checked against this before merge.
//
// When Ben adds a field or an option in Airtable, re-run the snapshot.
// Until then the guard treats the addition as unknown.
// ───────────────────────────────────────────────────────────────────────

export const SCHEMA_BASE_ID = "appgLT4z009iwAfhs";
export const SCHEMA_GENERATED_AT = "2026-08-19T05:16:00.715Z";

export type SelectKind = 'singleSelect' | 'multipleSelects';

export interface SelectFieldSpec {
  readonly kind: SelectKind;
  readonly choices: readonly string[];
}

/** Every field name that exists on each table (writable or not). */
export const AIRTABLE_TABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "Ad Spend": ["Amount", "Channel", "Date", "Note", "Source"],
  "Add-On Purchases": ["Amount Cents", "Notes", "Purchased At", "Rancher", "Status", "Stripe Invoice Id", "Type"],
  "Admin Config": ["Key", "Value"],
  "Affiliates": ["Click Count", "Code", "Commission Rate", "Created At", "Deactivated At", "Deactivation Reason", "Earnings Pending", "Email", "Full Name", "Last Click At", "Linked Consumer", "Name", "Phone", "Source", "Status"],
  "Agent Log": ["Action Needed", "Agent", "Decided", "Detail", "Headline", "Lane", "Priority", "Status", "Subject", "Timestamp"],
  "Agent Tasks": ["Action Taken", "Detected At", "Finding", "Proposed Action", "Run Mode", "Severity", "Status", "Subject Id", "Subject Type", "Tier", "Title", "Type"],
  "AI Audit Log": ["Actor", "Args", "Result", "Reverse Action", "Reverted", "Target ID", "Target Type", "Telegram Card ID", "Timestamp", "Tool"],
  "Brands": ["Active", "Amount Paid", "Brand Name", "Cancel At Period End", "Cancelled At", "Contact Name", "Created", "Email", "Featured", "Last Renewal At", "Paid At", "Partnership Goals", "Payment Status", "Phone", "Product Category", "Proposed Discount", "Referred By", "Status", "Stripe Customer ID", "Stripe Session ID", "Stripe Subscription Id", "Subscription Status", "Tier", "Website"],
  "Campaigns": ["Audience", "Campaign Name", "CTA Link", "CTA Text", "Date Sent", "Emails Sent", "Failed", "Include CTA", "Message", "Recipients", "Scheduled For", "Sent", "Sent At", "Status", "Subject"],
  "Consumers": ["Admin Notes", "Affiliate Code", "Affiliate Created At", "Affiliate Welcomed At", "Affiliates", "AI Email Draft", "AI Email Draft Subject", "AI Qualification Summary", "AI Recommended Action", "Approved At", "Backer Letter Sent At", "Backer Type", "Backfill Emails Sent", "Backfill Emails Sent At", "Bounced", "Budget", "Buyer Health", "Buyer Stage", "Buyer Stage Updated At", "Callback Handled At", "Callback Note", "Callback Requested At", "Campaign", "Campaign Last Sent At", "Campaign Rail", "Campaign Rancher", "Campaign SMS Recovery Sent At", "Campaign Stage", "Campaign Sunset At", "Campaign Waitlist State", "Clerk User Id", "Complained", "Conversations", "Created", "Email", "Email Clicks", "Email Opens", "Email Sends", "fbclid", "fbclid_ts", "Founder Number", "Founder Tier", "Founder Welcome Sent At", "Full Name", "Funnel Completed At", "Funnel Events", "gclid", "Gear Clicks", "Intent Classification", "Intent Score", "Interest Beef", "Interests", "Last Contacted", "Last Contacted At", "Last Email Clicked At", "Last Email Delivered At", "Last Email Event At", "Last Email Opened At", "Last Match Attempt At", "Last Product Bought", "Last Product Bought At", "Lead Source", "Membership", "Missed Responses", "Nationwide OK", "Nationwide Preference", "Next Follow Up At", "No Action Nudge At", "Notes", "Nurture Touch", "Nurture Touched At", "Order Type", "Payments", "Phone", "Preferred Rancher", "Product Buyer Rancher", "Product Repeat Nudged At", "Qualification Answers", "Qualification Path", "Qualification Score", "Qualified At", "Quiz Nudge Log", "Re-Warm Attempts", "Ready Nudge Count", "Ready Nudge Last Sent At", "Ready to Buy", "Reconfirm Sent At", "Referalls", "Referral Status", "Referred By", "Reservation Hold Paid At", "Reservation Hold Refunded At", "Reservation Hold Session Id", "Response Ack At", "Routing Segment", "Routing Segment Last Sent At", "Routing Segment Send Count", "Segment", "Sequence Sent At", "Sequence Stage", "Share Cross-Sell Sent At", "Shop Drop Sent At", "SMS Opt-In", "SMS Opt-In At", "Source", "State", "Status", "Stripe Customer ID", "Stripe Session ID", "Stripe Subscription ID", "Subscribed At", "Subscription Status", "Threads", "Tier Amount Paid", "Timing", "Unsubscribed", "Unsubscribed At", "UTM Parameters", "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term", "Waiting Nudge Count", "Waiting Nudge Last Sent At", "Wall Opt-In", "Warm List", "Warmup Engaged At", "Warmup Reanimated At", "Warmup Sent At", "Warmup Stage", "Zip"],
  "Conversations": ["Action Needed", "AI Summary", "Body", "Body Plain", "Call Duration Seconds", "Call Sid", "Direction", "From", "Linked Consumer", "Linked Rancher", "Linked Referral", "Message Id", "Objection Category", "Raw Headers", "Recording URL", "Reply Status", "Sender Type", "Sentiment", "Staged Reply", "Subject", "Timestamp", "To", "Transcript"],
  "Cron Pauses": ["Name", "Paused", "Paused At", "Paused By", "Reason"],
  "Cron Runs": ["Duration ms", "Ended At", "Errors", "Name", "Notes", "Records Touched", "Skip Reason Breakdown", "Source Commit", "Started At", "Status"],
  "Deal Events": ["Actor", "At", "Event", "From", "Reason", "Referral", "To"],
  "Email Sends": ["Campaign", "Click Count", "Clicked At", "Delivered At", "Last Event At", "Open Count", "Opened At", "Recipient Consumer", "Recipient Email", "Resend Id", "Sent At", "Status", "Subject", "Suppression Reason", "Template Name", "Variant"],
  "Funnel Events": ["Amount Cents", "Buyer", "Created At", "Metadata", "Rancher", "Reason", "Referral", "Stage"],
  "Gear Clicks": ["Buyer", "Clicked At", "Network", "Product", "Referral", "Surface"],
  "Inquiries": ["Commission Amount", "Commission Paid", "Consumer Email", "Consumer ID", "Consumer Name", "Consumer Phone", "Created", "Interest Type", "Last Activity At", "Matched Rancher IDs", "Message", "Notes", "Ranch Name", "Rancher Email", "Rancher ID", "Sale Amount", "Source", "Status", "Status Changed At"],
  "Land Deals": ["Acreage", "County", "Created", "Description", "Email", "Phone", "Price", "Property Location", "Property Type", "Referred By", "Seller Name", "State", "Status", "Utilities", "Visible to Members", "Zoning"],
  "News": ["Author", "Content", "Created", "Excerpt", "Published Date", "Slug", "Status", "Title"],
  "Payments": ["Abandoned At", "Abandoned Reason", "Amount Cents", "Buyer", "Buyer Email", "Captured At", "Created At", "Dispute Amount", "Dispute Reason", "Dispute Status", "Dispute Updated At", "Fraud Warning At", "Fraud Warning Type", "Payouts", "Platform Fee Cents", "Rancher", "Referral", "Referral Id Text", "Refund Reason", "Refunded Amount Cents", "Refunded At", "Status", "Stripe Checkout Session Id", "Stripe Connect Account Id", "Stripe Payment Intent Id", "Tier", "Type"],
  "Payouts": ["Amount Cents", "Payment", "Rancher", "Reason", "Released At", "Status", "Stripe Transfer Id"],
  "Rancher Orders": ["BHC Margin", "Buyer Delay Notified At", "Buyer Email", "Buyer Name", "Buyer Paid", "Buyer Rating", "Buyer Review", "Cancelled At", "External Order Id", "External Push Status", "External Pushed At", "Order Ref", "Ordered At", "Product Name", "Product Record ID", "Push Retry Requested At", "Quantity", "Rancher Name", "Rancher Payout", "Rancher Record ID", "Refunded At", "Review Asked At", "Review Submitted At", "Ship To Address", "Shipped At", "Shipping Carrier", "SLA Nudged At", "Status", "Stock Restored At", "Stripe Payment Intent", "Tracking Number"],
  "Rancher Products": ["Active", "Category", "Deposit Style", "Description", "Display Price", "External Checkout URL", "External Clicks", "External Product Id", "External SKU", "Feeds", "Image URL", "Last External Click At", "Last Synced At", "Marketplace Approved", "Orders Left", "Packaging", "Price Range", "Product Name", "Rancher Base", "Rancher Name", "Rancher Record ID", "Resistance Tier", "Shelf Stable", "Shipping Cost", "Shipping Included", "Ships In Days", "Ships Nationwide", "Source URL", "Stripe Price Cents", "Stripe Price Id", "Stripe Product Id", "Sync Managed", "Weight / Size", "What's Included"],
  "Rancher Prospects": ["Beef Type", "Booked At", "Booking Uid", "Channel", "City", "Dedup Key", "Disqualifiers", "Email", "Facebook", "First-Touch Draft", "Fit Reasons", "Fit Score", "Found At", "Instagram", "Last Contacted", "Last Reply At", "Last Touch At", "Last Touch Note", "Next Action", "Notes", "Operator Name", "Outreach Status", "Outreach Subject", "Phone", "Proposed Slots", "Ranch Name", "Reply Auth", "Reply Body", "Reply Class", "Reply Draft", "Reply Message Id", "Reply Snippet", "Sells Direct", "Sent Via", "Setter Log", "Size Signal", "Source", "Source URL", "State", "Status", "T1 Sent At", "T2 Sent At", "T3 Sent At", "Touch Count", "Website"],
  "Ranchers": ["About Text", "Active Status", "Add-On Purchases", "Admin Approved Multi-State", "Admin Internal Notes", "Agreement Signed", "Agreement Signed At", "Agreement Version", "Apple Pay Domain Registered", "Applied Chase Last Touch At", "Applied Chase Stage", "Beef Types", "Bounced", "Broker Additional Costs", "Broker Balance Note", "Broker Fulfillment Steps", "Broker Pricing Note", "Broker Rail", "Broker Self Serve", "Cal Event Type Intro Id", "Cal Event Type Sales Id", "Cal OAuth Access Token", "Cal OAuth Refresh Token", "Cal Token Expires At", "Cal User ID", "Cal Username", "Cal Webhook Id", "Cal.com Slug", "Call Completed At", "Call Notes", "Call Scheduled", "Campaign Tier", "Campaign Touch Count", "Certifications", "Certified", "Check In Response", "City", "Claim Sent At", "Claim Status", "Claim Token", "Clerk User Id", "Commission Rate", "Commission Rate Locked At", "Complained", "Connect Detached At", "Connect Restricted At", "Connect Started At", "Consumers", "Consumers 2", "Conversations", "Created", "Current Active Referrals", "Custom Notes", "Custom Products", "Customer References", "Delivery Radius Miles", "Discovered At", "Discovery Confidence", "Docs Sent At", "Email", "Facebook URL", "FAQ", "Featured", "First Payout Celebrated At", "Fulfillment Cost Notes", "Fulfillment Integration", "Fulfillment Types", "Funnel Events", "Gallery Photos", "Google Reviews URL", "Half Clicks", "Half Deposit", "Half lbs", "Half Payment Link", "Half Price", "Half Price Max", "Half Processing Fee", "Instagram URL", "Last Assigned At", "Last Campaign Email Sent At", "Last Check In", "Last Compliance Reminder Sent At", "Last Onboarding Nudge At", "Last Touch At", "Last Touch Note", "Latitude", "Launch Warmup Triggered", "Lead Digest Sent At", "Logo URL", "Longitude", "Match Type", "Max Active Referalls", "Migration Call Booked At", "Migration Call Completed At", "Migration Deadline", "Migration Status", "Monthly Capacity", "Monthly Order Capacity", "Next Processing Date", "Notes", "Onboarding Complete", "Onboarding Intro Pace", "Onboarding Phase Until", "Onboarding Status", "Operation Details", "Operator Name", "Ops Notes (Internal)", "Page Live", "Payments", "Payouts", "Performance Score", "Phone", "Pickup Address", "Pickup City", "Pickup Instructions", "Pilot Closes Goal", "Pilot Upsell Notified At", "Preferred States", "Previous Slugs", "Pricing Model", "Primary Product", "Processing Facility", "Public Map Hidden", "Push Subscriptions", "Quarter Clicks", "Quarter Deposit", "Quarter lbs", "Quarter Payment Link", "Quarter Price", "Quarter Price Max", "Quarter Processing Fee", "Ranch Name", "Ranch Tour Availability", "Ranch Tour Interested", "Rancher Record Id", "Rancher Sequence Stage", "Referalls", "Referalls 2", "Referred By", "Refund Policy", "Release Date", "Reserve Link", "Routing States", "Routing Weight Override", "Self-Submit Drip Stage", "Self-Submitted At", "Service ZIP Prefixes", "Setup Short Code", "Shipping Lead Time Days", "Ships Nationwide", "Signature IP", "Signature Name", "Signature User Agent", "Slug", "Source Type", "Source URL", "State", "State Capacity Override", "States Served", "Status", "Stripe Connect Account Id", "Stripe Connect Connected At", "Stripe Connect Status", "Stripe Customer ID", "Stripe Subscription Id", "Stuck Escalated At", "Stuck Escalated Bucket", "Subscription Next Invoice At", "Subscription Started At", "Subscription Status", "Tagline", "Team Emails", "Testimonials", "Threads", "Tier", "Tier Abandoned Recovery Sent At", "Tier Specialty", "Tier Upgrade Nudge Sent At", "Trust Mode", "Unsubscribed", "Unsubscribed At", "V2 Upgrade Invite Sent At", "Verification Method", "Verification Notes", "Verification Requested At", "Verification Status", "Video URL", "Warmup Last Batch At", "Website", "Welcome Email Failed At", "White Glove Paid At", "White Glove Session Id", "Whole Clicks", "Whole Deposit", "Whole lbs", "Whole Payment Link", "Whole Price", "Whole Price Max", "Whole Processing Fee", "Zip"],
  "Recommended Products": ["Active", "Affiliate URL", "Blurb", "Category", "Commission Note", "Freezer Mandatory", "Gear Clicks", "Image URL", "Name", "Network", "Sort Order", "Target Cuts", "Target Stage"],
  "Referrals": ["AI Chase Draft", "Approval Status", "Approved At", "Auto Released At", "Auto Released From", "Balk Alert Sent At", "BHC Fee Cents", "Budget Range", "Buyer", "Buyer Cut Notes", "Buyer Email", "Buyer Fulfillment Pref", "Buyer Name", "Buyer Phone", "Buyer Preferences Set At", "Buyer Pulse Response", "Buyer Pulse Response At", "Buyer Pulse Sent At", "Buyer Rating", "Buyer Review", "Buyer State", "Buyer Window Pref", "Chase Count", "Close Check Sent At", "Close Class", "Closed At", "Commission Due", "Commission Paid", "Commission Paid At", "Conversations", "Cut Sheet Note", "Deal Events", "Deposit Amount", "Deposit Checkout URL", "Deposit Invite Sent At", "Deposit Link Opened At", "Deposit Nudge Count", "Deposit Nudge Last Sent At", "Deposit Paid At", "Deposit Requested At", "Deposit Watchdog Alerted At", "Fee Captured At", "Final Invoice Amount", "Final Invoice Checkout Session Id", "Final Invoice Link Opened At", "Final Invoice Payment Intent ID", "Final Invoice Reminded At", "Final Invoice Reminder Count", "Final Invoice Sent At", "Final Invoice URL", "Final Paid Amount", "Final Paid At", "First Touch Nudged At", "Fulfillment Chase Count", "Fulfillment Chase Last Sent At", "Fulfillment Confirmed At", "Fulfillment Method", "Fulfillment Status", "Fulfillment Updated At", "Funnel Events", "Gear Clicks", "Handoff Date", "Hide From Wins", "Hold Until", "Intent Classification", "Intent Score", "Intro Sent At", "Last Buyer Activity At", "Last Chased At", "Last Rancher Activity At", "Loss Reason", "Match Type", "Name", "Notes", "Order Type", "Payment Confirmation Method", "Payment Confirmed At", "Payments", "Processing Date", "Processing Fee", "Rancher", "Rancher Accepted At", "Rancher Engaged Flag", "Rancher Re-pinged At", "Rancher Record Id", "Rancher Reminded At", "Recovery Sent At", "Referral Source", "Repeat Outreach Sent", "Replenishment Nudged At", "Reserve Recovery Sent At", "Reserve Recovery SMS Sent At", "Review Submitted At", "Sale Amount", "Sales Call Booked At", "Sales Call Completed At", "Sales Call Start At", "Shipping Carrier", "Stalled Alert Sent At", "State Allocation", "Status", "Stripe Invoice ID", "Stripe Invoice URL", "Stuck Escalated At", "Stuck Escalated Bucket", "Suggested Rancher", "Suggested Rancher Name", "Suggested Rancher Record Id", "Suggested Rancher State", "Terms Accepted At", "Thank You Sent At", "Threads", "Total Sale Amount", "Tracking Number"],
  "Signup Attempts": ["Door", "Email", "IP", "Outcome", "Phone", "Ranch Name", "Reason", "Rescued", "State", "Summary"],
  "Stripe Events": ["Account Id", "Error", "Event Id", "Event Type", "Processed At", "Received At", "Status"],
  "Thread Messages": ["Body", "Created At", "Email Message Id", "Sender Id", "Sender Type", "Sent Via", "Thread"],
  "Threads": ["Buyer", "Created At", "Last Message At", "Rancher", "Rancher Id Text", "Referral", "Referral Id Text", "Status", "Subject", "Thread Messages"],
};

/** Only singleSelect / multipleSelects fields, with their exact choices. */
export const AIRTABLE_SELECT_FIELDS: Readonly<Record<string, Readonly<Record<string, SelectFieldSpec>>>> = {
  "Ad Spend": {
    "Channel": { kind: "singleSelect", choices: ["Meta", "Google", "TikTok", "Other"] },
  },
  "Add-On Purchases": {
    "Status": { kind: "singleSelect", choices: ["pending", "paid", "canceled"] },
    "Type": { kind: "singleSelect", choices: ["Video Shoot", "Photo Refresh", "Founder Letter", "Brand Intro", "PPC Mgmt"] },
  },
  "Affiliates": {
    "Source": { kind: "singleSelect", choices: ["auto-closed-won", "self-signup", "admin-invite", "manual"] },
    "Status": { kind: "singleSelect", choices: ["Active", "Inactive"] },
  },
  "Agent Log": {
    "Agent": { kind: "singleSelect", choices: ["orchestrator", "sales-briefing", "deal-chaser", "rancher-success", "ops-watch", "growth", "content", "other"] },
    "Lane": { kind: "singleSelect", choices: ["Sales", "Money", "Marketing", "Rancher", "Admin", "Ops", "Content/Podcast", "Other"] },
    "Priority": { kind: "singleSelect", choices: ["P0", "P1", "P2", "P3"] },
    "Status": { kind: "singleSelect", choices: ["OK", "Flag", "Blocked", "Done"] },
  },
  "Agent Tasks": {
    "Run Mode": { kind: "singleSelect", choices: ["observe", "active"] },
    "Severity": { kind: "singleSelect", choices: ["P0_critical", "P1_important", "P2_watch"] },
    "Status": { kind: "singleSelect", choices: ["observed", "escalated", "awaiting_approval", "healed", "dismissed"] },
    "Subject Type": { kind: "singleSelect", choices: ["Rancher", "Referral", "Consumer", "Cron", "Webhook", "System", "webhook"] },
    "Tier": { kind: "singleSelect", choices: ["auto_heal_safe", "escalate", "never_touch"] },
    "Type": { kind: "singleSelect", choices: ["cron_failed", "connect_stuck", "counter_drift", "orphan_referral", "stale_warmup", "signed_not_live", "webhook_drift", "endpoint_error", "money_escalation", "code_escalation", "supply_alert", "other"] },
  },
  "AI Audit Log": {
    "Actor": { kind: "singleSelect", choices: ["ai-auto", "ai-confirmed", "cron", "manual"] },
    "Target Type": { kind: "singleSelect", choices: ["Consumer", "Rancher", "Referral", "Inquiry", "Other"] },
  },
  "Brands": {
    "Subscription Status": { kind: "singleSelect", choices: ["active", "past_due", "canceled", "unpaid", "trialing"] },
    "Tier": { kind: "singleSelect", choices: ["spotlight", "featured", "founding"] },
  },
  "Campaigns": {
    "Status": { kind: "singleSelect", choices: ["Pending", "Sending", "Aborting", "Aborted", "Partial", "Sent", "Failed"] },
  },
  "Consumers": {
    "AI Recommended Action": { kind: "singleSelect", choices: ["approve", "reject", "watch"] },
    "Backer Type": { kind: "singleSelect", choices: ["Individual", "Brand"] },
    "Budget": { kind: "singleSelect", choices: [">$500", "$500-$1000", "$1000", "$2500+", "Unsure", "<$500", "$1000-$2000", "$2000+", "", "$1000-$1500", "$2000-$2500", "Just exploring", "$1000-2000", "$2000-2500", "$5000+", "$4000-$5000", "$500-$1500", "$1500-$2500", "-", "1500-2500", "2500-3500", "$1,000-$1,500", "$2,000-$2,500"] },
    "Buyer Health": { kind: "singleSelect", choices: ["Active", "Non-Responsive", "Closed Won"] },
    "Buyer Stage": { kind: "singleSelect", choices: ["NEW", "WAITING", "READY", "MATCHED", "CLOSED", "NURTURE", "PRODUCT_BUYER"] },
    "Campaign Stage": { kind: "singleSelect", choices: ["Msg1 Sent", "Msg2 Sent", "Msg3 Sent", "Sunset"] },
    "Founder Tier": { kind: "singleSelect", choices: ["Herd", "Outlaw", "Steward", "Founding 100", "Title Founder"] },
    "Intent Classification": { kind: "singleSelect", choices: ["High", "Medium", "Low"] },
    "Interests": { kind: "multipleSelects", choices: ["Beef", "Land", "Merch", "All"] },
    "Nationwide Preference": { kind: "singleSelect", choices: ["nationwide-ok", "local-only"] },
    "Order Type": { kind: "singleSelect", choices: ["Quarter", "Half", "Whole", "Not Sure", "", "Half Cow", "Quarter Cow"] },
    "Qualification Path": { kind: "singleSelect", choices: ["rancher_meet", "direct_deposit", "incomplete"] },
    "Referral Status": { kind: "singleSelect", choices: ["Unmatched", "Pending Approval", "Matched", "Closed", "Waitlisted", "Intro Sent", "Closed Won", "Slot Locked"] },
    "Routing Segment": { kind: "singleSelect", choices: ["MATCH_NOW", "WARM_LEAD", "NUDGE_TO_ENGAGE", "OUT_OF_STATE_FOUNDER_PITCH", "COMMUNITY_NURTURE", "INCOMPLETE_PROFILE", "UNQUALIFIED_NURTURE", "TERMINAL", "STATE_WAITLIST", "NO_BUDGET_FOUNDER_PITCH"] },
    "Segment": { kind: "singleSelect", choices: ["Beef Buyer", "Community", "Wholesale"] },
    "Sequence Stage": { kind: "singleSelect", choices: ["none", "day3_sent", "day7_sent", "community_7d_sent", "community_14d_sent", "nurture_3d_sent", "intro_checkin_sent", "nurture_why_sent", "nurture_how_sent", "nurture_urgency_sent", "nurture_merch_sent", "rerouted", "rerouted_after_pass", "rerouted_after_stall", "waitlisted", "abandoned_pending", "abandoned_email1_sent", "abandoned_email2_sent", "abandoned_email3_sent", "nurture_referral_sent", "", "MATCHED_D4", "WAITING_L1", "READY_NUDGE", "CLOSED_CUTS", "WAITING_L2"] },
    "Status": { kind: "singleSelect", choices: ["Pending", "", "Approved", "Rejected", "Waitlisted"] },
    "Subscription Status": { kind: "singleSelect", choices: ["active", "cancelled", "past_due"] },
    "Timing": { kind: "singleSelect", choices: ["ASAP", "Within 30 days", "Within 60 days", "Within 90 days", "Just exploring", "3-6 months"] },
    "Warmup Stage": { kind: "singleSelect", choices: ["sent", "nudged", "engaged", "matched", "dropped"] },
  },
  "Conversations": {
    "Action Needed": { kind: "singleSelect", choices: ["none", "ben-eyes", "auto-respond", "propose-close-won"] },
    "Direction": { kind: "singleSelect", choices: ["inbound", "outbound", "Inbound", "Outbound"] },
    "Objection Category": { kind: "singleSelect", choices: ["price", "distance", "timing", "cut", "ghost", "ready-to-buy", "scheduling", "capacity", "quality", "other", "none"] },
    "Sender Type": { kind: "singleSelect", choices: ["buyer", "rancher", "unknown", "Prospect", "BHC", "UNKNOWN", "system"] },
    "Sentiment": { kind: "singleSelect", choices: ["positive", "neutral", "blocking", "Neutral", "negative"] },
  },
  "Cron Runs": {
    "Status": { kind: "singleSelect", choices: ["success", "partial", "error", "maintenance-blocked", "paused", "started"] },
  },
  "Email Sends": {
    "Status": { kind: "singleSelect", choices: ["sent", "suppressed", "bounced", "complained", "failed"] },
  },
  "Gear Clicks": {
    "Network": { kind: "singleSelect", choices: ["amazon", "direct"] },
    "Surface": { kind: "singleSelect", choices: ["success", "member", "email", "gear"] },
  },
  "Inquiries": {
    "Status": { kind: "singleSelect", choices: ["Pending", "Approved", "Rejected", "Completed", "Sale Completed", "New"] },
  },
  "Land Deals": {
    "Property Type": { kind: "singleSelect", choices: ["Ranch", ""] },
    "Status": { kind: "singleSelect", choices: ["Approved", ""] },
  },
  "Payments": {
    "Status": { kind: "singleSelect", choices: ["pending", "succeeded", "refunded", "failed", "abandoned"] },
    "Tier": { kind: "singleSelect", choices: ["Pasture", "Ranch", "Operator", "Legacy Connect"] },
  },
  "Payouts": {
    "Reason": { kind: "singleSelect", choices: ["fulfillment_confirmed", "dispute_resolved", "manual"] },
    "Status": { kind: "singleSelect", choices: ["pending", "paid", "failed"] },
  },
  "Rancher Orders": {
    "Status": { kind: "singleSelect", choices: ["New", "Shipped", "Delivered", "Refunded", "Cancelled"] },
  },
  "Rancher Products": {
    "Category": { kind: "singleSelect", choices: ["Snack Sticks", "Jerky", "Sampler Box", "Ground Box", "Bundle", "Eighth Share", "Merch"] },
    "Resistance Tier": { kind: "singleSelect", choices: ["Impulse", "Starter", "Mid", "Share"] },
  },
  "Rancher Prospects": {
    "Channel": { kind: "singleSelect", choices: ["DM (IG)", "DM (FB)", "Text", "Email", "Voice note", "Call", "email"] },
    "Outreach Status": { kind: "singleSelect", choices: ["Draft Ready", "Approved", "Sent", "Replied", "Passed", "Suppressed"] },
    "Reply Class": { kind: "singleSelect", choices: ["interested", "question", "not_now", "stop", "bounce", "other", ""] },
    "Sells Direct": { kind: "singleSelect", choices: ["yes_active", "yes_struggling", "wants_to", "unclear", "no", "Yes"] },
    "Source": { kind: "singleSelect", choices: ["web_search", "instagram", "facebook", "google_maps", "localharvest", "eatwild", "american_grassfed", "state_directory", "other", "WebSearch"] },
    "Status": { kind: "singleSelect", choices: ["new", "reviewed", "contacted", "call_booked", "onboarded", "passed", "duplicate"] },
  },
  "Ranchers": {
    "Active Status": { kind: "singleSelect", choices: ["Active", "At Capacity", "Paused", "Pending Onboarding", "Non-Compliant", ""] },
    "Campaign Tier": { kind: "singleSelect", choices: ["A", "B"] },
    "Check In Response": { kind: "singleSelect", choices: ["Confirmed", "Wants Call", "Declined"] },
    "Claim Status": { kind: "singleSelect", choices: ["unclaimed", "email-sent", "claim-pending", "claimed", "declined", "removed-on-request"] },
    "Fulfillment Types": { kind: "multipleSelects", choices: ["Local Pickup", "Local Delivery", "Cold-Chain Shipping"] },
    "Match Type": { kind: "singleSelect", choices: ["Local", "Nationwide"] },
    "Migration Status": { kind: "singleSelect", choices: ["not_invited", "invited", "call_scheduled", "upgrading", "completed", "paused_overdue"] },
    "Onboarding Status": { kind: "singleSelect", choices: ["Call Scheduled", "Call Complete", "Docs Sent", "Agreement Signed", "Verification Pending", "Verification Complete", "Live"] },
    "Pricing Model": { kind: "singleSelect", choices: ["legacy", "tier_v2"] },
    "Primary Product": { kind: "singleSelect", choices: ["Beef", "Pork", "Lamb", "Multi-species", "Dairy", "Other", "Grass Fed Beef", "Beef/chicken/ raw dairy"] },
    "Self-Submit Drip Stage": { kind: "singleSelect", choices: ["welcome-sent", "day2-sent", "day5-sent", "day14-sent", "completed", "stopped"] },
    "Source Type": { kind: "singleSelect", choices: ["web-search", "manual-add", "claimed", "usda-directory", "state-extension"] },
    "Stripe Connect Status": { kind: "singleSelect", choices: ["not_connected", "onboarding", "active", "restricted", ""] },
    "Subscription Status": { kind: "singleSelect", choices: ["none", "trialing", "active", "past_due", "canceled", "unpaid", ""] },
    "Tier": { kind: "singleSelect", choices: ["None", "Pasture", "Ranch", "Operator", "", "Legacy Connect"] },
    "Tier Specialty": { kind: "multipleSelects", choices: ["Quarter", "Half", "Whole"] },
    "Verification Status": { kind: "singleSelect", choices: ["Not Started", "Beef Shipped", "Beef Recieved", "Verified", "Failed", "Prospect", "Removed"] },
  },
  "Recommended Products": {
    "Category": { kind: "singleSelect", choices: ["freezer", "vacuum-sealer", "cast-iron", "rub-salt", "knives", "supplements", "cooler", "other", "grills", "cooking", "kitchen-prep", "seasonings", "grill-accessories", "coolers"] },
    "Network": { kind: "singleSelect", choices: ["amazon", "direct"] },
    "Target Cuts": { kind: "multipleSelects", choices: ["quarter", "half", "whole"] },
    "Target Stage": { kind: "singleSelect", choices: ["waiting", "delivered", "any"] },
  },
  "Referrals": {
    "Approval Status": { kind: "singleSelect", choices: ["pending-approval", "approved", "held", "skipped", "Pending Rancher Response", "rancher-no-response"] },
    "Buyer Pulse Response": { kind: "singleSelect", choices: ["connected", "ghosted", "stalled"] },
    "Close Class": { kind: "singleSelect", choices: ["real-loss", "auto-hygiene", "never-a-lead", "unknown"] },
    "Fulfillment Method": { kind: "singleSelect", choices: ["pickup", "ship"] },
    "Fulfillment Status": { kind: "singleSelect", choices: ["scheduled", "processing", "ready", "fulfilled"] },
    "Loss Reason": { kind: "singleSelect", choices: ["Price too high", "Timing — buying later", "Couldn't reach buyer", "Bought elsewhere", "Out of service area", "Wrong intent (not a buyer)", "Other"] },
    "Match Type": { kind: "singleSelect", choices: ["Local", "Nationwide", "Direct (Rancher Page)", "Direct (Rancher Page) — Deposit", "Broker — Deposit"] },
    "Payment Confirmation Method": { kind: "singleSelect", choices: ["cash", "check", "venmo", "square", "stripe", "wire", "other"] },
    "Status": { kind: "singleSelect", choices: ["Pending Approval", "Intro Sent", "In Progress", "Closed Won", "Closed Lost", "Rejected", "Rancher Contacted", "Negotiation", "Pending", "Awaiting Payment", "Slot Locked", "Waitlisted", "Dormant"] },
  },
  "Signup Attempts": {
    "Door": { kind: "singleSelect", choices: ["apply", "self-submit"] },
    "Outcome": { kind: "singleSelect", choices: ["created", "rejected-validation", "rate-limited", "server-error", "timeout", "honeypot", "network-error"] },
  },
  "Stripe Events": {
    "Status": { kind: "singleSelect", choices: ["received", "processed", "failed", "skipped_duplicate"] },
  },
  "Thread Messages": {
    "Sender Type": { kind: "singleSelect", choices: ["buyer", "rancher", "admin", "system"] },
    "Sent Via": { kind: "singleSelect", choices: ["web", "email", "telegram"] },
  },
  "Threads": {
    "Status": { kind: "singleSelect", choices: ["Active", "Closed"] },
  },
};

/** Airtable-computed fields — a write to one of these is always a bug. */
export const AIRTABLE_COMPUTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "Ranchers": ["Rancher Record Id"],
};
