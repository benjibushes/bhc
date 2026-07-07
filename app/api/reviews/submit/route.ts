import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { funnelRecord } from '@/lib/funnelMetrics';

// =====================================================
// /api/reviews/submit — buyer review capture endpoint
// =====================================================
//
// Closes the loop on `sendTestimonialAsk`: that email goes out 7-90d
// post-Closed-Won via the `testimonial-collection` cron and now embeds
// a magic link → /reviews/submit?token=<jwt>. The page posts here with
// { token, rating, review }. We verify the token (type=review-submit,
// referralId encoded), then write Buyer Rating / Buyer Review /
// Review Submitted At onto the Referrals row.
//
// Fields written are auto-stripped by updateRecord if the operator hasn't
// added them to Airtable yet — so this ships safely without a schema
// migration step. Operator can add the three fields (Buyer Rating: number 1-5,
// Buyer Review: long text, Review Submitted At: date) at their leisure.
//
// Surfacing reviews (on /wins, /ranchers/[slug], etc) is intentionally
// out of scope here — this is the data-capture loop only.

export const maxDuration = 30;

// Review-submit JWT lifetime. Cron asks 7-90d post-Closed-Won, buyer
// might reply weeks later. 120d gives plenty of headroom.
export const REVIEW_TOKEN_TTL = '120d';

// PRODUCT REVIEWS (2026-07-06): the same rail now serves marketplace orders.
// A token carries EITHER referralId (share review → Referrals row) OR orderId
// (product review → Rancher Orders row). Field names are identical on both
// tables (Buyer Rating / Buyer Review / Review Submitted At), so everything
// below is table-parameterized rather than forked.
interface ReviewTokenPayload {
  type: 'review-submit';
  referralId?: string;
  orderId?: string;
  iat?: number;
  exp?: number;
}

function verifyReviewToken(token: string): ReviewTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (
      decoded &&
      decoded.type === 'review-submit' &&
      (typeof decoded.referralId === 'string' || typeof decoded.orderId === 'string')
    ) {
      return decoded as ReviewTokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// Resolve which table + record a token points at.
function tokenTarget(payload: ReviewTokenPayload): { table: string; id: string } {
  return payload.orderId
    ? { table: TABLES.RANCHER_ORDERS, id: payload.orderId }
    : { table: TABLES.REFERRALS, id: payload.referralId! };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token : '';
    const rating = Number(body?.rating);
    const review = typeof body?.review === 'string' ? body.review.slice(0, 2000).trim() : '';

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return NextResponse.json({ error: 'Rating must be 1-5' }, { status: 400 });
    }

    const payload = verifyReviewToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // Confirm the target row still exists. Don't 500 if it was deleted —
    // return a friendly 410 so the page can render "this review link is no
    // longer valid" instead of a generic error.
    const target = tokenTarget(payload);
    let row: any;
    try {
      row = await getRecordById(target.table, target.id);
      if (!row) {
        return NextResponse.json({ error: 'Record not found' }, { status: 410 });
      }
    } catch {
      return NextResponse.json({ error: 'Record not found' }, { status: 410 });
    }

    // F-4 audit fix: idempotency guard. Pre-fix the 120d JWT magic link
    // accepted unlimited submits — each overwrote Buyer Rating + Buyer
    // Review. Now: if Review Submitted At is already set, return 409 +
    // the prior submittedAt so the form can show "you already submitted
    // a review" instead of a generic error or silent overwrite.
    const existingSubmittedAt = row['Review Submitted At'];
    if (existingSubmittedAt) {
      return NextResponse.json({
        error: 'Review already submitted',
        submittedAt: existingSubmittedAt,
      }, { status: 409 });
    }

    // updateRecord auto-strips unknown field names → these three fields
    // can be added to Airtable on demand without a code redeploy.
    await updateRecord(target.table, target.id, {
      'Buyer Rating': Math.round(rating),
      'Buyer Review': review,
      'Review Submitted At': new Date().toISOString(),
    });

    // Product reviews land on the PDP within the ISR window; refresh sooner.
    if (payload.orderId) {
      try {
        const { revalidatePath } = await import('next/cache');
        const productId = String(row['Product Record ID'] || '').trim();
        if (productId) revalidatePath(`/shop/${productId}`);
        revalidatePath('/shop');
      } catch { /* ISR backstop */ }
    }

    // Non-fatal funnel event (share rail only — orders have no referral).
    if (payload.referralId) {
      funnelRecord({
        stage: 'review_collected',
        referralId: payload.referralId,
        metadata: { rating: Math.round(rating), reviewLength: review.length },
      }).catch(() => {});
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('[reviews/submit] unexpected error:', e?.message);
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}

// Token sanity-check helper for the GET handler in app/reviews/submit/page.tsx.
// Returns minimal info to the page so it can render the form (or a
// not-valid-anymore message) without exposing the full referral row.
// F-4 audit: also surfaces alreadySubmitted=true + submittedAt so the
// form can render the "thanks, you've already submitted a review" state
// instead of letting the user fill out a doomed second submission.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token') || '';
  if (!token) return NextResponse.json({ ok: false, reason: 'missing-token' }, { status: 400 });
  const payload = verifyReviewToken(token);
  if (!payload) return NextResponse.json({ ok: false, reason: 'invalid-token' }, { status: 401 });
  try {
    const target = tokenTarget(payload);
    const ref: any = await getRecordById(target.table, target.id);
    if (!ref) return NextResponse.json({ ok: false, reason: 'record-not-found' }, { status: 410 });
    const submittedAt = ref['Review Submitted At'];
    if (submittedAt) {
      return NextResponse.json({ ok: true, alreadySubmitted: true, submittedAt });
    }
    return NextResponse.json({ ok: true, alreadySubmitted: false });
  } catch {
    // Soft-fail: token is valid but Airtable hiccup — let the form render.
    // Server-side idempotency in POST will still catch any re-submit.
    return NextResponse.json({ ok: true });
  }
}
