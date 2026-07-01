import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAllRecords, getRecordById, updateRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { normalizeAffiliateCode } from '@/lib/affiliates';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

// Reserved codes — block affiliates from claiming auth-sensitive or marketing
// reserved URL paths. Must stay lowercase. New public routes that should be
// banned belong here too.
const RESERVED_CODES = new Set<string>([
  'admin', 'api', 'access', 'apply', 'login', 'logout', 'member', 'rancher',
  'ranchers', 'qualify', 'checkout', 'thanks', 'matched', 'partner', 'partners',
  'brand', 'brands', 'brand-partners', 'wholesale', 'about', 'faq', 'start',
  'home', 'index', 'app', 'auth', 'verify', 'unsubscribe', 'webhooks', 'cron',
  'health', 'version', 'affiliate', 'affiliates', 'r', 'tos', 'terms', 'privacy',
  'refund', 'refund-policy', 'promise', 'founders', 'backer', 'backers',
  'wholesale-buyer', 'land-deals', 'land', 'profile', 'settings', 'help',
  'support', 'contact', 'press', 'team', 'careers', 'blog', 'news', 'docs',
  'doc', 'sitemap', 'robots', 'favicon', 'null', 'undefined', 'true', 'false',
]);

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-affiliate-auth');

    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (decoded.type !== 'affiliate-session') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const affiliate = await getRecordById(TABLES.AFFILIATES, decoded.affiliateId) as any;
    if (!affiliate) {
      return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });
    }

    const status = (affiliate['Status'] || '').toLowerCase();
    if (status !== 'active') {
      return NextResponse.json({ error: 'Your affiliate account is not active' }, { status: 403 });
    }

    const rawCode = affiliate['Code'] || '';
    if (!rawCode) {
      return NextResponse.json({ error: 'Affiliate code not configured' }, { status: 400 });
    }
    const code = normalizeAffiliateCode(rawCode);

    const safeCode = escapeAirtableValue(String(code));
    const consumerFilter = `{Referred By} = "${safeCode}"`;
    const rancherFilter = `{Referred By} = "${safeCode}"`;

    const [consumers, ranchers] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS, consumerFilter).catch(() => []),
      getAllRecords(TABLES.RANCHERS, rancherFilter).catch(() => []),
    ]);

    const referredConsumerIds = new Set((consumers as any[]).map((c: any) => c.id));
    const referredRancherIds = new Set((ranchers as any[]).map((r: any) => r.id));

    // Count Closed Won deals attributed to this affiliate's referred buyers.
    // Counts only — no dollar amounts surfaced. Affiliates evangelize the
    // mission, not chase commissions. Showing $ would create the wrong
    // incentive + the wrong expectation.
    let referrals: any[] = [];
    try {
      referrals = (await getAllRecords(TABLES.REFERRALS)) as any[];
    } catch {
      referrals = [];
    }

    let closedWonCount = 0;
    const recentCloses: Array<{ id: string; buyer: string; closedAt: string }> = [];
    for (const ref of referrals) {
      if ((ref['Status'] || '') !== 'Closed Won') continue;
      const buyerIds: string[] = ref['Buyer'] || [];
      if (!Array.isArray(buyerIds) || !buyerIds.some((b) => referredConsumerIds.has(b))) continue;
      closedWonCount++;
      recentCloses.push({
        id: ref.id,
        buyer: ref['Buyer Name'] || '',
        closedAt: ref['Closed At'] || '',
      });
    }
    recentCloses.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());

    const clicks = Number(affiliate['Click Count']) || 0;
    const signups = referredConsumerIds.size + referredRancherIds.size;
    const conversionPct = clicks > 0 ? Math.round((signups / clicks) * 1000) / 10 : 0;

    const referredConsumers = (consumers as any[]).map((c) => ({
      id: c.id,
      name: c['Full Name'] || '',
      state: c['State'] || '',
      created: c['Created'] || c.createdTime || c._createdTime || '',
    }));

    const referredRanchers = (ranchers as any[]).map((r) => ({
      id: r.id,
      name: r['Operator Name'] || r['Ranch Name'] || '',
      state: r['State'] || '',
      created: r['Created'] || r.createdTime || r._createdTime || '',
    }));

    const buyerLink = `${SITE_URL}/access?ref=${encodeURIComponent(code)}`;
    const rancherLink = `${SITE_URL}/partner?ref=${encodeURIComponent(code)}`;
    // New canonical short link — single URL that drops the lead into the
    // segment self-select picker (/r/<code>). Recommended share link.
    const landingLink = `${SITE_URL}/r/${encodeURIComponent(code)}`;

    return NextResponse.json({
      code,
      profile: {
        fullName: String(affiliate['Full Name'] || affiliate['Name'] || ''),
        email: String(affiliate['Email'] || ''),
      },
      links: {
        landing: landingLink,
        buyer: buyerLink,
        rancher: rancherLink,
      },
      stats: {
        clicks,
        signups,
        conversionPct,
        closedWonCount,
        lastClickAt: affiliate['Last Click At'] || null,
      },
      referredConsumersCount: referredConsumers.length,
      referredRanchersCount: referredRanchers.length,
      referredConsumers,
      referredRanchers,
      recentCloses: recentCloses.slice(0, 20),
    });
  } catch (error: any) {
    console.error('Affiliate dashboard error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

// PATCH — affiliate self-edit profile.
// Accepts: { fullName, email, code }. Each field optional. Uniqueness
// enforced on email + code change. Reserved codes blocked.
export async function PATCH(request: Request) {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-affiliate-auth');
    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (decoded.type !== 'affiliate-session') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const affiliateId = decoded.affiliateId;
    const affiliate = (await getRecordById(TABLES.AFFILIATES, affiliateId)) as any;
    if (!affiliate) {
      return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });
    }
    if (String(affiliate['Status'] || '').toLowerCase() !== 'active') {
      return NextResponse.json({ error: 'Account inactive' }, { status: 403 });
    }

    let body: any = {};
    try { body = await request.json(); } catch { /* empty body fine */ }

    const updates: Record<string, any> = {};

    if (typeof body.fullName === 'string') {
      const fullName = body.fullName.trim().slice(0, 100);
      if (fullName.length < 2) {
        return NextResponse.json({ error: 'Name must be at least 2 characters' }, { status: 400 });
      }
      updates['Full Name'] = fullName;
    }

    if (typeof body.email === 'string') {
      const email = body.email.trim().toLowerCase().slice(0, 200);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
      }
      const currentEmail = String(affiliate['Email'] || '').toLowerCase();
      if (email !== currentEmail) {
        try {
          const dupes = (await getAllRecords(
            TABLES.AFFILIATES,
            `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
          )) as any[];
          if (dupes.some((d: any) => d.id !== affiliateId)) {
            return NextResponse.json(
              { error: 'Another affiliate is already using that email' },
              { status: 409 },
            );
          }
        } catch (e: any) {
          console.warn('[affiliate PATCH] email dup check failed (fail-open):', e?.message);
        }
        updates['Email'] = email;
      }
    }

    if (typeof body.code === 'string') {
      const raw = body.code.trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(raw)) {
        return NextResponse.json(
          { error: 'Code can only contain letters, numbers, hyphens, underscores' },
          { status: 400 },
        );
      }
      if (raw.length < 3 || raw.length > 32) {
        return NextResponse.json(
          { error: 'Code must be 3-32 characters' },
          { status: 400 },
        );
      }
      if (RESERVED_CODES.has(raw)) {
        return NextResponse.json(
          { error: 'That code is reserved. Pick another.' },
          { status: 400 },
        );
      }
      const currentCode = normalizeAffiliateCode(affiliate['Code']);
      if (raw !== currentCode) {
        try {
          const dupes = (await getAllRecords(
            TABLES.AFFILIATES,
            `LOWER({Code}) = "${escapeAirtableValue(raw)}"`,
          )) as any[];
          if (dupes.some((d: any) => d.id !== affiliateId)) {
            return NextResponse.json(
              { error: 'That code is already taken' },
              { status: 409 },
            );
          }
        } catch (e: any) {
          console.warn('[affiliate PATCH] code dup check failed (fail-open):', e?.message);
        }
        updates['Code'] = raw;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ ok: true, noChange: true });
    }

    try {
      await updateRecord(TABLES.AFFILIATES, affiliateId, updates);
    } catch (e: any) {
      console.error('[affiliate PATCH] write failed:', e?.message);
      return NextResponse.json(
        { error: 'Could not save changes. Try again.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      saved: Object.keys(updates),
    });
  } catch (error: any) {
    console.error('[affiliate PATCH] error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
