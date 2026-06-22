-- BHC Commerce Foundation — Phase 0 (2026-06-20)
-- Supabase (Postgres) becomes the commerce system-of-record: catalog, variants,
-- inventory, orders, storefront blocks, custom domains. Airtable stays the
-- CRM/ops cockpit; Stripe stays money-truth. See
-- docs/superpowers/specs/2026-06-20-rancher-commerce-platform.md.
--
-- TENANT ISOLATION MODEL: BHC uses its OWN JWT auth (rancher/buyer sessions),
-- not Supabase Auth. All access is SERVER-SIDE via the service-role key (which
-- bypasses RLS), and isolation is enforced in the repository layer by always
-- filtering on rancher_id. RLS is enabled deny-all below as a backstop so the
-- public anon key can never read commerce data even if it leaks client-side.
--
-- Money is stored in integer CENTS. rancher_id / buyer_id are the Airtable
-- record IDs (e.g. 'recXXXXXXXXXXXXXX') — Airtable remains the source of truth
-- for ranchers/buyers; this DB references them by string id (no FK to Airtable).

-- ─────────────────────────────────────────────────────────────────────────────
-- products: one row per sellable thing a rancher offers.
-- type: 'cow_share' (variants = quarter/half/whole/eighth), 'custom' (jerky,
-- boxes, etc.), 'csa' (recurring — future). status gates buyer visibility.
create table if not exists products (
  id           uuid primary key default gen_random_uuid(),
  rancher_id   text not null,                       -- Airtable Ranchers rec id
  slug         text not null,                       -- url-safe, unique per rancher
  type         text not null check (type in ('cow_share','custom','csa')),
  name         text not null,
  description  text,
  status       text not null default 'draft' check (status in ('draft','active','archived')),
  position     integer not null default 0,          -- display order on storefront
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (rancher_id, slug)
);
create index if not exists products_rancher_idx on products (rancher_id);
create index if not exists products_rancher_status_idx on products (rancher_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- product_variants: the actual purchasable units. A cow_share product has
-- quarter/half/whole/eighth variants; a custom product may have one or several.
-- price_cents = full sale price; deposit_cents = upfront reserve (lib/pricing
-- deriveDeposit, 25% default). stripe_price_id is created lazily in Phase 1
-- (one Stripe Price per variant) — null until then. weight_lbs supports the
-- future sell-by-hanging-lb model. tax_code feeds Stripe automatic_tax.
create table if not exists product_variants (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products (id) on delete cascade,
  label          text not null,                     -- 'Quarter', 'Half', '5lb box'
  price_cents    integer not null check (price_cents >= 0),
  deposit_cents  integer not null default 0 check (deposit_cents >= 0 and deposit_cents <= price_cents),
  weight_lbs     numeric(8,2),                      -- approx finished/hanging weight, nullable
  stripe_price_id text,                             -- set in Phase 1
  tax_code       text,                              -- Stripe tax code, nullable
  position       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists variants_product_idx on product_variants (product_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory: per-variant finite stock, the thing Airtable CANNOT do safely
-- (no transactions). qty_available = total units; qty_reserved = held by
-- in-flight orders. Available-to-sell = qty_available - qty_reserved. NULL row
-- (no inventory record) = unlimited stock (cow shares are often made-to-order).
create table if not exists inventory (
  variant_id    uuid primary key references product_variants (id) on delete cascade,
  qty_available integer not null default 0 check (qty_available >= 0),
  qty_reserved  integer not null default 0 check (qty_reserved >= 0),
  updated_at    timestamptz not null default now()
);

-- Atomic reserve: succeeds only if enough is available-to-sell, in one statement
-- (the row lock prevents two concurrent buyers overselling finite carcass stock).
-- Returns true on success, false if insufficient. No inventory row = unlimited
-- (returns true without touching anything).
create or replace function reserve_inventory(p_variant_id uuid, p_qty integer)
returns boolean
language plpgsql
as $$
declare
  rows_updated integer;
begin
  if p_qty <= 0 then
    return true;
  end if;
  -- No inventory row tracked for this variant => treated as unlimited stock.
  if not exists (select 1 from inventory where variant_id = p_variant_id) then
    return true;
  end if;
  update inventory
     set qty_reserved = qty_reserved + p_qty,
         updated_at = now()
   where variant_id = p_variant_id
     and qty_available - qty_reserved >= p_qty;
  get diagnostics rows_updated = row_count;
  return rows_updated > 0;
end;
$$;

-- Release a prior reservation (on checkout.session.expired / order cancel) and,
-- when confirmed, optionally convert reserved → consumed by lowering available.
create or replace function release_inventory(p_variant_id uuid, p_qty integer, p_consume boolean default false)
returns void
language plpgsql
as $$
begin
  if p_qty <= 0 then return; end if;
  update inventory
     set qty_reserved  = greatest(0, qty_reserved - p_qty),
         qty_available = case when p_consume then greatest(0, qty_available - p_qty) else qty_available end,
         updated_at = now()
   where variant_id = p_variant_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- orders + line items. fee_cents = total BHC commission on the order (sum of
-- per-line fees; computed app-side from the rancher's tier rate, applied to ALL
-- on-platform sales per the 2026-06-20 decision). stripe_payment_intent_id ties
-- back to the Stripe charge + the Airtable Payments ledger mirror.
create table if not exists orders (
  id                       uuid primary key default gen_random_uuid(),
  rancher_id               text not null,
  buyer_id                 text,                     -- Airtable Consumers rec id, nullable for guest
  referral_id              text,                     -- Airtable Referrals rec id when matched
  status                   text not null default 'pending'
                             check (status in ('pending','deposit_paid','balance_invoiced','paid','cancelled','refunded')),
  subtotal_cents           integer not null default 0,
  fee_cents                integer not null default 0,   -- total BHC commission
  deposit_cents            integer not null default 0,
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists orders_rancher_idx on orders (rancher_id);
create index if not exists orders_buyer_idx on orders (buyer_id);
create index if not exists orders_status_idx on orders (rancher_id, status);

create table if not exists order_line_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders (id) on delete cascade,
  variant_id      uuid references product_variants (id) on delete set null,
  label           text not null,                    -- snapshot of variant label at sale time
  qty             integer not null check (qty > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  fee_cents       integer not null default 0,       -- BHC commission on this line
  created_at      timestamptz not null default now()
);
create index if not exists line_items_order_idx on order_line_items (order_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- page_blocks: the storefront block model (Phase 3). Ordered blocks render
-- through a BRAND-LOCKED component registry — ranchers pick blocks + tokens, not
-- raw CSS, so the matte/flat brand can't drift. content_json holds block props.
create table if not exists page_blocks (
  id          uuid primary key default gen_random_uuid(),
  rancher_id  text not null,
  type        text not null check (type in ('hero','about','gallery','pricing','testimonials','process','custom_products','cta','note')),
  position    integer not null default 0,
  content_json jsonb not null default '{}'::jsonb,
  visible     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists page_blocks_rancher_idx on page_blocks (rancher_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- domains: per-rancher custom domains (Phase 4). hostname is the lookup key the
-- host→slug middleware resolves. 'subdomain' = free ranch.buyhalfcow.com;
-- 'custom' = bring-your-own (paid tier). status tracks Vercel verification.
create table if not exists domains (
  id          uuid primary key default gen_random_uuid(),
  rancher_id  text not null,
  hostname    text not null unique,
  kind        text not null default 'subdomain' check (kind in ('subdomain','custom')),
  status      text not null default 'pending' check (status in ('pending','verifying','active','error','removed')),
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists domains_rancher_idx on domains (rancher_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: enable on every table with NO policies = deny-all for anon/authenticated
-- roles. The server uses the service-role key (bypasses RLS) and enforces
-- rancher_id isolation in the repository layer. This locks out the public anon
-- key as a backstop.
alter table products            enable row level security;
alter table product_variants    enable row level security;
alter table inventory           enable row level security;
alter table orders              enable row level security;
alter table order_line_items    enable row level security;
alter table page_blocks         enable row level security;
alter table domains             enable row level security;
