import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { requireAdmin } from '@/lib/adminAuth';

// POST /api/admin/referrals/[id]/revive
//
// Admin tool to resurrect a Closed Lost referral. Use when a lead was
// killed wrongly (old auto-close cron, accidental rancher click,
// manual close that turned out premature). Flips Status back to
// the target (defaults to Pending Approval so batch-approve picks
// up the re-route path), clears Closed At, leaves audit trail in Notes.
//
// Body (optional): { toStatus?: string }
//   - "Pending Approval" (default): batch-approve will re-route
//   - "Intro Sent" / "Rancher Contacted" / "Negotiation": admin wants
//     to drop the lead back into a specific stage instead of re-routing.
//
// Auth (Phase 0): requireAdmin() — Clerk session for browser admins OR
// x-admin-password header for server-to-server. x-internal-secret kept as
// a separate backdoor for cron-style internal callers.

export const maxDuration = 30;

const VALID_TARGETS = new Set([
  'Pending Approval',
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
]);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const internalHeader = request.headers.get('x-internal-secret') || '';
    const isInternal = INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
    if (!isInternal) {
      const unauthorized = await requireAdmin(request);
      if (unauthorized) return unauthorized;
    }

    const { id } = await context.params;
    if (!id || !id.startsWith('rec')) {
      return NextResponse.json({ error: 'Invalid referral id' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const toStatus = (body?.toStatus || 'Pending Approval').toString();
    if (!VALID_TARGETS.has(toStatus)) {
      return NextResponse.json({
        error: `Invalid target status. Allowed: ${[...VALID_TARGETS].join(', ')}`,
      }, { status: 400 });
    }

    let ref: any;
    try {
      ref = await getRecordById(TABLES.REFERRALS, id);
    } catch {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }
    if (!ref) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

    const fromStatus = (ref['Status'] || '').toString();
    const buyerName = (ref['Buyer Name'] || '').toString();
    const buyerEmail = (ref['Buyer Email'] || '').toString();

    // Build the audit note prepended to existing Notes — preserves history.
    const stamp = new Date().toISOString().slice(0, 16);
    const note = `[ADMIN REVIVE ${stamp}] from "${fromStatus}" → "${toStatus}"`;
    const existingNotes = (ref['Notes'] || '').toString();

    const updates: Record<string, any> = {
      'Status': toStatus,
      'Notes': existingNotes ? `${note}\n\n${existingNotes}` : note,
      // Clear Closed At since we're un-closing.
      'Closed At': '',
      // Reset chase + alert throttles so cron treats this like a fresh lead.
      'Last Chased At': '',
      'Stalled Alert Sent At': '',
      'Rancher Reminded At': '',
      // Stamp Last Rancher Activity At so activity-aware staleness gives
      // the lead a fresh 5-day window before next chase.
      'Last Rancher Activity At': new Date().toISOString(),
    };

    await updateRecord(TABLES.REFERRALS, id, updates);

    // Telegram audit so revivals are visible — also useful for spotting
    // mass-revive accidents.
    try {
      await sendOperatorSignal({
        urgency: 'digest',
        kind: 'audit',
        summary: `LEAD REVIVED: ${buyerName} (${buyerEmail})`,
        detail: `Status: ${fromStatus} → ${toStatus}\nClosed At cleared. Activity stamped. Cron will treat as fresh.`,
        refs: [{ type: 'referral', id, label: buyerName }],
      });
    } catch {}

    return NextResponse.json({
      success: true,
      referralId: id,
      fromStatus,
      toStatus,
    });
  } catch (error: any) {
    console.error('revive error:', error);
    return NextResponse.json({ error: 'Could not revive referral' }, { status: 500 });
  }
}
