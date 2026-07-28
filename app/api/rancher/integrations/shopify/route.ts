// Rancher self-serve Shopify connection (PR-F — the "click of a button").
//
// GET  → connection status for the signed-in rancher (never returns secrets).
// POST → { shop, token, apiSecret, mode, markupPercent? } — validates the
//        store LIVE, registers webhooks, encrypts + saves, and for sync mode
//        returns the catalog dry-run report. Same rail /connectstore uses
//        (lib/shopifyConnectFlow) — one engine, two doors.
//
// Auth = requireRancher; the session's own rancherId is the ONLY row touched
// (no id in the body — a rancher can never connect a store to someone else).
// Credentials transit ONCE over TLS, are encrypted immediately, plaintext
// never persisted or logged.

import { NextResponse } from 'next/server';
import { requireRancher } from '@/lib/rancherAuth';
import { getRecordById, TABLES } from '@/lib/airtable';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { publicAppLive } from '@/lib/shopifyOauth';
import { rateLimit, getTrustedClientIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId).catch(() => null);
  const cfg = parseIntegration(rancher?.['Fulfillment Integration']);
  // publicAppLive, NOT creds-presence (audit 2026-07-21): creds exist DURING
  // Shopify review, when merchant installs are refused — the card must keep
  // showing the token form until SHOPIFY_PUBLIC_APP_LIVE flips on approval.
  const publicApp = publicAppLive();
  if (!cfg) return NextResponse.json({ connected: false, publicApp });
  return NextResponse.json({
    connected: true,
    publicApp,
    shop: cfg.shop,
    mode: cfg.mode,
    markupPercent: cfg.markupPercent ?? null,
  });
}

export async function POST(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // Validation + webhook registration hit the rancher's store — keep a tight
  // per-IP lid so a stuck retry loop can't hammer Shopify with bad tokens.
  // 5 → 10 (2026-07-28 listing audit): the manual token-paste path has three
  // copy-paste fields from a multi-step custom-app walkthrough; 5 attempts is
  // exactly a first-timer's fumble budget and locked them out mid-onboarding.
  const rl = await rateLimit(`shopify-connect:${getTrustedClientIp(request)}`, { requests: 10, window: '15m' });
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many attempts — wait a few minutes and try again.' }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const shop = String(body?.shop || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const token = String(body?.token || '').trim();
  const apiSecret = String(body?.apiSecret || '').trim();
  const mode = body?.mode === 'sync' ? 'sync' : body?.mode === 'manual' ? 'manual' : null;
  const markupPercent =
    body?.markupPercent !== undefined && body?.markupPercent !== null && body?.markupPercent !== ''
      && Number.isFinite(Number(body.markupPercent))
      ? Math.min(300, Math.max(0, Number(body.markupPercent)))
      : null;

  if (!shop || !shop.endsWith('.myshopify.com')) {
    return NextResponse.json({ error: 'Shop must be your *.myshopify.com domain (find it in Shopify admin → Settings → Domains).' }, { status: 400 });
  }
  if (!token.startsWith('shpat_')) {
    return NextResponse.json({ error: 'That does not look like an Admin API access token (starts with shpat_).' }, { status: 400 });
  }
  if (!apiSecret) {
    return NextResponse.json({ error: 'API secret key is required (shown next to the token in your custom app).' }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ error: 'Pick a mode: sync your catalog, or manual SKUs.' }, { status: 400 });
  }

  try {
    const { connectShopifyStore } = await import('@/lib/shopifyConnectFlow');
    const result = await connectShopifyStore({
      rancherId: session.rancherId,
      shop,
      token,
      apiSecret,
      mode,
      markupPercent,
    });
    if (!result.ok) return NextResponse.json({ ok: false, report: result.report }, { status: 422 });
    return NextResponse.json({ ok: true, report: result.report });
  } catch (e: any) {
    console.error('[rancher/integrations/shopify] connect failed:', e?.message);
    return NextResponse.json({ error: 'Connection failed on our side — nothing was saved. Try again or text Ben.' }, { status: 500 });
  }
}
