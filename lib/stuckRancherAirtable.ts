// lib/stuckRancherAirtable.ts
//
// Airtable → lib/stuckRancherQueue boundary, extracted VERBATIM from
// app/api/admin/stuck-ranchers/route.ts (Wave 1B, 2026-08-01) so the
// /admin/today cockpit and the stuck-ranchers endpoint flatten records the
// same way. lib/stuckRancherQueue itself stays pure and field-name-free by
// design — this module is where the exact Airtable field strings live.
//
// Every field read here is verified against the live `Ranchers` schema
// (2026-07-25): Stuck Escalated At · Stuck Escalated Bucket · Last Touch At ·
// Onboarding Status · Active Status · Verification Status · Agreement Signed ·
// Page Live · Pricing Model · Stripe Connect Account Id · Stripe Connect
// Status · Slug · Quarter/Half/Whole Price · Quarter/Half/Whole Payment Link ·
// Unsubscribed · Bounced.

import { getOperationalServedStates } from './rancherEligibility';
import type { StuckRancherRow } from './stuckRancherQueue';

export type DemandMap = Record<string, number>;

/**
 * WAITING buyers per state, counted off rows the caller already holds. Same
 * cohort definition as /api/admin/demand-heatmap and the stuck-ranchers
 * endpoint's filtered read: Buyer Stage='WAITING', email on file, not
 * unsubscribed — so every surface agrees on what "demand" means.
 */
export function waitingDemandFromConsumers(consumers: any[]): DemandMap {
  const demand: DemandMap = {};
  for (const c of consumers || []) {
    if (String(c['Buyer Stage'] || '') !== 'WAITING') continue;
    if (!String(c['Email'] || '').trim()) continue;
    if (c['Unsubscribed']) continue;
    const st = String(c['State'] || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) continue;
    demand[st] = (demand[st] || 0) + 1;
  }
  return demand;
}

/** Flatten one Airtable rancher onto the pure scorer's input shape. */
export function toStuckRancherRow(record: any, demand: DemandMap): StuckRancherRow {
  // Routing precedence (home state, plus admin-approved multi-state) — the same
  // helper the match engine uses, so "buyers waiting" means the buyers this
  // rancher would actually be routed.
  const servedStates = getOperationalServedStates(record);
  const buyersWaiting = servedStates.reduce((sum, st) => sum + (demand[st] || 0), 0);

  const readEnum = (v: unknown): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && 'name' in v) {
      return String((v as { name?: unknown }).name || '');
    }
    return String(v);
  };

  return {
    id: record.id,
    ranchName: String(record['Ranch Name'] || ''),
    operatorName: String(record['Operator Name'] || ''),
    state: String(record['State'] || '').trim().toUpperCase(),
    email: String(record['Email'] || '').trim(),
    phone: String(record['Phone'] || '').trim(),
    emailOptOut: !!record['Unsubscribed'] || !!record['Bounced'],
    activeStatus: readEnum(record['Active Status']),
    verificationStatus: readEnum(record['Verification Status']),
    onboardingStatus: readEnum(record['Onboarding Status']),
    agreementSigned: !!record['Agreement Signed'],
    pageLive: !!record['Page Live'],
    pricingModel: String(record['Pricing Model'] || ''),
    connectAccountId: String(record['Stripe Connect Account Id'] || ''),
    connectStatus: String(record['Stripe Connect Status'] || ''),
    hasSlug: !!record['Slug'],
    maxPrice: Math.max(
      0,
      Number(record['Quarter Price']) || 0,
      Number(record['Half Price']) || 0,
      Number(record['Whole Price']) || 0,
    ),
    hasPaymentLink: !!(
      record['Quarter Payment Link'] ||
      record['Half Payment Link'] ||
      record['Whole Payment Link']
    ),
    stuckEscalatedAt: String(record['Stuck Escalated At'] || ''),
    stuckEscalatedBucket: String(record['Stuck Escalated Bucket'] || ''),
    lastTouchAt: String(record['Last Touch At'] || ''),
    buyersWaiting,
    servedStates,
  };
}
