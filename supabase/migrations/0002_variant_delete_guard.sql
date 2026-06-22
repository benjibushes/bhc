-- BHC Commerce — Variant Delete Guard (2026-06-21)
-- Hardens order_line_items.variant_id against the DELETE-then-recreate oversell
-- hazard. Migration 0001 declared this FK as ON DELETE SET NULL:
--
--   variant_id uuid references product_variants (id) on delete set null,
--
-- That is unsafe. If a rancher deletes a variant that a PAID order references,
-- the line's variant_id is silently nulled. The webhook's stock-consume loop
-- keys off variant_id, so a nulled line is SKIPPED — reserved stock is never
-- consumed. Recreate a like-named variant afterwards and its fresh inventory is
-- oversold against orders that were supposed to have drawn it down.
--
-- Fix: flip the FK to ON DELETE RESTRICT so the database itself refuses to
-- delete a referenced variant. This is the backstop for the application-layer
-- guard in /api/rancher/commerce (delete-variant / delete-product), which now
-- pre-checks getOpenOrdersForVariant() and returns a 409 steering ranchers to
-- ARCHIVE (status='archived') instead of deleting. Archiving hides the variant
-- from buyers while preserving the order history and the consume path.
--
-- The constraint was created inline (unnamed) in 0001, so Postgres auto-named it
-- order_line_items_variant_id_fkey (table + column + "_fkey"). We drop and re-add
-- it. Wrapped in a DO block so the drop tolerates environments where the
-- constraint is absent or differently named (idempotent re-runs).

do $$
declare
  con_name text;
begin
  -- Find the existing FK on order_line_items.variant_id by its target/column,
  -- regardless of the exact constraint name, and drop it.
  select con.conname
    into con_name
    from pg_constraint con
    join pg_class rel        on rel.oid = con.conrelid
    join pg_attribute att    on att.attrelid = con.conrelid
                            and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and rel.relname = 'order_line_items'
     and att.attname = 'variant_id'
   limit 1;

  if con_name is not null then
    execute format('alter table order_line_items drop constraint %I', con_name);
  end if;

  -- Re-add with the canonical name and ON DELETE RESTRICT.
  alter table order_line_items
    add constraint order_line_items_variant_id_fkey
    foreign key (variant_id)
    references product_variants (id)
    on delete restrict;
end
$$;
