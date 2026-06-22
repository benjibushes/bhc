# BHC Commerce DB (Supabase) — provisioning runbook

Supabase (Postgres) is the commerce system-of-record (catalog, variants, inventory, orders, storefront blocks, custom domains). Airtable stays the CRM/ops cockpit; Stripe stays money-truth. Full plan: `docs/superpowers/specs/2026-06-20-rancher-commerce-platform.md`.

## Owner action (one-time, gates Phase 0 run + everything downstream)

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier is fine to start). Pick a region near your Vercel deployment.
2. **Grab the keys** — Project Settings → API:
   - Project URL → `SUPABASE_URL`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` (server-only — NEVER expose client-side)
   - `anon` public key → `SUPABASE_ANON_KEY` (not used yet; set it for completeness)
3. **Set them in Vercel** → Project → Settings → Environment Variables (Production + Preview), then redeploy.
4. **Run the migration** — paste `supabase/migrations/0001_commerce_foundation.sql` into the Supabase SQL Editor and run it (or `supabase db push` with the CLI). Creates the 7 tables + the atomic `reserve_inventory` / `release_inventory` functions + RLS deny-all.

Until step 3 is done, the app is **build-dark**: `getCommerceDb()` returns null and every commerce path falls back to the existing Airtable flow — nothing breaks.

## After provisioning
Tell Claude "Supabase is live" → it runs the catalog/Custom-Products **ETL** (Airtable → `products`/`product_variants`, quarantining any malformed JSON) and continues Phase 1 (Stripe Price per variant + real cart checkout).

## Isolation model
BHC uses its own JWT auth, not Supabase Auth. All access is server-side via the service-role key (bypasses RLS); tenant isolation is enforced in `lib/commerce/*` by always filtering on `rancher_id`. RLS deny-all locks out the anon key as a backstop.
