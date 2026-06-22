-- BHC Commerce — restock_inventory() (2026-06-22)
-- Refund/cancel restock primitive. release_inventory(consume=false) only lowers
-- qty_reserved; on an already-CONSUMED (paid) order qty_reserved is 0, so it
-- can't return a refunded unit to sellable stock. restock_inventory RAISES
-- qty_available directly. No-op when no inventory row exists (unlimited variant).
create or replace function restock_inventory(p_variant_id uuid, p_qty integer)
returns void
language plpgsql
as $$
begin
  if p_qty <= 0 then return; end if;
  update inventory
     set qty_available = qty_available + p_qty,
         updated_at = now()
   where variant_id = p_variant_id;
end;
$$;
