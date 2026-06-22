// lib/commerce/types.ts — TypeScript row types mirroring the Phase-0 commerce
// schema (supabase/migrations/0001_commerce_foundation.sql). Money is in integer
// CENTS. rancher_id / buyer_id / referral_id are Airtable record ids (strings).

export type ProductType = 'cow_share' | 'custom' | 'csa';
export type ProductStatus = 'draft' | 'active' | 'archived';

export interface Product {
  id: string;
  rancher_id: string;
  slug: string;
  type: ProductType;
  name: string;
  description: string | null;
  status: ProductStatus;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  label: string;
  price_cents: number;
  deposit_cents: number;
  weight_lbs: number | null;
  stripe_price_id: string | null;
  tax_code: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Inventory {
  variant_id: string;
  qty_available: number;
  qty_reserved: number;
  updated_at: string;
}

export type OrderStatus =
  | 'pending'
  | 'deposit_paid'
  | 'balance_invoiced'
  | 'paid'
  | 'cancelled'
  | 'refunded';

export interface Order {
  id: string;
  rancher_id: string;
  buyer_id: string | null;
  referral_id: string | null;
  status: OrderStatus;
  subtotal_cents: number;
  fee_cents: number;
  deposit_cents: number;
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderLineItem {
  id: string;
  order_id: string;
  variant_id: string | null;
  label: string;
  qty: number;
  unit_price_cents: number;
  fee_cents: number;
  created_at: string;
}

export type PageBlockType =
  | 'hero'
  | 'about'
  | 'gallery'
  | 'pricing'
  | 'testimonials'
  | 'process'
  | 'custom_products'
  | 'cta'
  | 'note';

export interface PageBlock {
  id: string;
  rancher_id: string;
  type: PageBlockType;
  position: number;
  content_json: Record<string, unknown>;
  visible: boolean;
  created_at: string;
  updated_at: string;
}

export type DomainKind = 'subdomain' | 'custom';
export type DomainStatus = 'pending' | 'verifying' | 'active' | 'error' | 'removed';

export interface Domain {
  id: string;
  rancher_id: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

/** A variant priced for sale, with availability resolved (null = unlimited). */
export interface VariantWithStock extends ProductVariant {
  available: number | null;
}
