#!/usr/bin/env node
// scripts/leak-backfill.mjs
//
// One-shot recovery for buyers stranded by the too-strict qualifyUrl gate
// (pre-LEAK-1 fix). Pulls Consumers created in the past N days who:
//   - have Status=Approved
//   - have Buyer Stage in [WAITING, READY, MATCHED]
//   - have Qualified At blank
//   - are NOT Unsubscribed / Bounced / Complained
//   - haven't already been backfilled (Notes dedup)
// Mints a fresh 24h qualify JWT and sends a "finish your match" email.
// Stamps `[leak-backfill YYYY-MM-DD]` on Notes for dedup.
//
// Usage:
//   AIRTABLE_PAT=<pat> node scripts/leak-backfill.mjs --days=7 [--dry-run] [--limit=N]

import jwt from 'jsonwebtoken';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const DAYS = Number(args.days || 7);
const LIMIT = Number(args.limit || 500);
const DRY = !!args['dry-run'];

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE_ID || 'appgLT4z009iwAfhs';
const JWT_SECRET = process.env.JWT_SECRET;
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const FROM = process.env.RESEND_FROM_EMAIL || 'Benjamin @ BuyHalfCow <hello@buyhalfcow.com>';

if (!PAT) { console.error('Missing AIRTABLE_PAT'); process.exit(1); }
if (!JWT_SECRET) { console.error('Missing JWT_SECRET'); process.exit(1); }
if (!RESEND_API_KEY && !DRY) { console.error('Missing RESEND_API_KEY'); process.exit(1); }

const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
const today = new Date().toISOString().slice(0, 10);
const DEDUP_TAG = '[leak-backfill';

async function airtableQuery(table, params) {
  const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.append(k, v);
  }
  const r = await fetch(url, { headers: { Authorization: `Bearer ${PAT}` } });
  if (!r.ok) throw new Error(`airtable ${r.status}: ${await r.text()}`);
  return r.json();
}

async function airtableUpdate(table, id, fields) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`airtable update ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sendResend({ to, subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  return r.json();
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEmail({ firstName, qualifyUrl, state }) {
  const subject = `${firstName}, finish your beef match — 30 seconds`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <p style="font-family:Georgia,serif;font-size:24px;margin:0 0 14px;">Hey ${esc(firstName)} —</p>
  <p>Quick note: when you signed up at BuyHalfCow we skipped a few questions. I just shipped a 30-second qualifier so I can match you with the right rancher in ${esc(state)}.</p>
  <p><strong>What it gets you:</strong></p>
  <ul>
    <li>The rancher actually closest to you (not a generic intro)</li>
    <li>Pricing for your tier (quarter / half / whole) before any call</li>
    <li>First crack at their next processing date</li>
  </ul>
  <div style="text-align:center;margin:28px 0;">
    <a href="${qualifyUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Take the 30-second qualifier →</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">Reply STOP to opt out. — Benjamin, BuyHalfCow founder</p>
</div>
</body></html>`;
  return { subject, html };
}

(async () => {
  console.log(`leak-backfill: days=${DAYS} limit=${LIMIT} dryRun=${DRY}`);
  const formula = `AND(
    IS_AFTER({Created}, '${cutoff}'),
    {Status}='Approved',
    OR({Buyer Stage}='WAITING', {Buyer Stage}='READY', {Buyer Stage}='MATCHED'),
    {Qualified At}=BLANK(),
    {Unsubscribed}!=TRUE(),
    {Bounced}!=TRUE(),
    {Complained}!=TRUE(),
    NOT(FIND('${DEDUP_TAG}', {Notes}))
  )`.replace(/\s+/g, ' ');

  const all = [];
  let offset = undefined;
  do {
    const params = { filterByFormula: formula, pageSize: '100' };
    if (offset) params.offset = offset;
    const j = await airtableQuery('Consumers', params);
    all.push(...(j.records || []));
    offset = j.offset;
  } while (offset && all.length < LIMIT);

  const eligible = all.slice(0, LIMIT);
  console.log(`Eligible: ${eligible.length}`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const rec of eligible) {
    const f = rec.fields;
    const email = String(f['Email'] || '').trim();
    const state = String(f['State'] || '').trim();
    const firstName = String(f['Full Name'] || '').split(' ')[0] || 'there';
    if (!email) { skipped++; continue; }

    const token = jwt.sign(
      { type: 'qualify-access', consumerId: rec.id, email: email.toLowerCase() },
      JWT_SECRET,
      { expiresIn: '7d' },
    );
    const qualifyUrl = `${SITE_URL}/qualify/${encodeURIComponent(rec.id)}?token=${encodeURIComponent(token)}`;
    const { subject, html } = buildEmail({ firstName, qualifyUrl, state: state || 'your state' });

    if (DRY) {
      console.log(`[DRY] ${email} → ${qualifyUrl}`);
      continue;
    }

    try {
      await sendResend({ to: email, subject, html });
      const newNotes = `${DEDUP_TAG} ${today}] ${(f['Notes'] || '')}`.slice(0, 2000);
      await airtableUpdate('Consumers', rec.id, { 'Notes': newNotes });
      sent++;
      if (sent % 5 === 0) console.log(`  sent ${sent}/${eligible.length}`);
      // Soft pacing — stay well under Resend's 10 req/sec.
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      console.error(`  ✗ ${email}: ${e?.message || e}`);
      failed++;
    }
  }

  console.log(`\nDone. sent=${sent} failed=${failed} skipped=${skipped} (of ${eligible.length} eligible)`);
})().catch((e) => {
  console.error('FATAL:', e?.message || e);
  process.exit(1);
});
