// lib/syncManagedProductFence.ts
//
// Pure decision: how the rancher ProductsTab must treat a Rancher Products row
// that the Shopify catalog-sync engine owns ('Sync Managed' = true).
//
// WHY THIS EXISTS — the 6h catalog cron (lib/shopifyCatalogSync) is the source
// of truth for synced rows: every run it clobbers Product Name / Display Price
// / Orders Left, RE-derives Active = (Marketplace Approved && store ACTIVE &&
// qty > 0), and RESURRECTS a locally-deleted row by its SKU. So any self-serve
// edit, hide, stock change, or delete a rancher makes on a synced row is
// silently reverted within hours. Two concrete harms the tab must prevent:
//   1. Curation-gate bypass: a working-looking 'show' on an UNAPPROVED synced
//      row writes Active=true and flashes it onto /shop until the next sync —
//      defeating the 'Marketplace Approved' gate (a human BHC call).
//   2. Misleading the rancher: edit/duplicate/delete look like they worked,
//      then the cron reverts them and Ben gets pinged to clean up by hand.
//
// This mirrors the existing deposit-style ops fence already in ProductsTab and
// the products route — an ops-owned row the rancher may see but not mutate.

export type SyncBadge = 'pending-review' | 'managed' | null;

export interface SyncFenceDecision {
  /** True when the Shopify catalog-sync engine owns this row. */
  managed: boolean;
  /**
   * Distinct badge for a synced row:
   *   'pending-review' — synced, not yet 'Marketplace Approved' (awaiting BHC).
   *                      Render this INSTEAD of the generic 'hidden' state.
   *   'managed'        — synced AND approved: its real live/hidden state is
   *                      meaningful, so the caller's existing live badge wins;
   *                      this value just flags that mutation controls are fenced.
   *   null             — hand-entered row: no sync badge, existing logic applies.
   */
  badge: SyncBadge;
  /**
   * May the rancher use the show/publish toggle? False for EVERY synced row —
   * Active is cron-owned, and an unapproved row literally cannot be published
   * from here (only BHC approval lists it).
   */
  canShow: boolean;
  /** May the rancher edit or duplicate this row? False for synced rows. */
  canEdit: boolean;
  /** May the rancher delete this row? False for synced rows (the cron
   *  resurrects it by SKU on the next run). */
  canDelete: boolean;
}

export function decideSyncManagedRow(input: {
  syncManaged?: boolean;
  marketplaceApproved?: boolean;
}): SyncFenceDecision {
  const managed = input.syncManaged === true;
  if (!managed) {
    // Hand-entered: the rancher owns it end to end.
    return { managed: false, badge: null, canShow: true, canEdit: true, canDelete: true };
  }
  const approved = input.marketplaceApproved === true;
  return {
    managed: true,
    badge: approved ? 'managed' : 'pending-review',
    canShow: false,
    canEdit: false,
    canDelete: false,
  };
}
