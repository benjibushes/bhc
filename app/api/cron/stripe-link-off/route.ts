// app/api/cron/stripe-link-off/route.ts
//
// ONE-SHOT MAINTENANCE (2026-07-14, invoked manually — NOT scheduled): turn
// Stripe Link's display preference OFF on every connected account's payment
// method configuration, plus any platform-level configurations.
//
// WHY: Link walls the ENTIRE embedded Checkout behind "Confirm it's you —
// enter the code sent to (•••) ••96" whenever the buyer's email matches a
// Link account. Blocked a live $827 deposit (Dave @ Champion Valley) — the
// OTP goes to a possibly years-old phone. `payment_method_types: ['card']`
// does NOT disable it (verified live: Link rides ON the card method); the
// real lever is the payment-method configuration's link.display_preference.
//
// Runs on prod because only prod holds STRIPE_SECRET_KEY. Dry-run by
// default; ?apply=1 to write. Reversible (preference can be flipped back in
// the Stripe dashboard). Safe to re-run — already-off configs are skipped.

import { getAllRecords, TABLES } from '@/lib/airtable';
import { getStripeClient } from '@/lib/stripeConnect';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 120;

interface Result {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

function handlerFor(apply: boolean) {
  return async function realHandler(_request: Request): Promise<Result> {
    const stripe = getStripeClient();

    const ranchers = await getAllRecords(TABLES.RANCHERS, `{Stripe Connect Account Id} != ''`);
    const accounts: Array<string | undefined> = [
      undefined, // the platform's own configurations (incl. the Connect default)
      ...Array.from(new Set(
        ranchers.map((r: any) => String(r['Stripe Connect Account Id'] || '').trim()).filter(Boolean),
      )),
    ];

    let flipped = 0;
    let alreadyOff = 0;
    const errors: string[] = [];
    const lines: string[] = [];

    for (const acct of accounts) {
      const opts = acct ? { stripeAccount: acct } : undefined;
      const label = acct || 'platform';
      try {
        const configs = await stripe.paymentMethodConfigurations.list({ limit: 20 }, opts);
        for (const cfg of configs.data as any[]) {
          const pref = cfg?.link?.display_preference?.preference;
          if (pref === 'off') { alreadyOff += 1; continue; }
          lines.push(`${label} ${cfg.id} link=${pref ?? 'unset'}${apply ? ' → off' : ' (would set off)'}`);
          if (!apply) continue;
          await stripe.paymentMethodConfigurations.update(
            cfg.id,
            { link: { display_preference: { preference: 'off' } } } as any,
            opts,
          );
          flipped += 1;
        }
      } catch (e: any) {
        errors.push(`${label}: ${e?.message || 'failed'}`);
      }
    }

    const notes =
      `${apply ? 'APPLY' : 'DRY'}: ${accounts.length - 1} accts+platform, ` +
      `${apply ? `${flipped} flipped` : `${lines.length} would flip`}, ${alreadyOff} already off` +
      (errors.length ? `; errors ${errors.length}: ${errors.slice(0, 3).join(' | ')}` : '') +
      (lines.length ? ` :: ${lines.slice(0, 8).join(' ; ')}` : '');

    return {
      status: errors.length > 0 ? 'partial' : 'success',
      recordsTouched: flipped,
      notes,
    };
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  const apply = new URL(request.url).searchParams.get('apply') === '1';
  return withCronRun('stripe-link-off', handlerFor(apply))(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
