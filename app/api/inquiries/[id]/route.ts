import { NextResponse, NextRequest } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendInquiryToRancher } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { requireAdmin } from '@/lib/adminAuth';

// Wholesale Status state machine. New is the signup-time default; admin can
// progress New → Routed → Quoted → Closed Won/Lost. We allow free-form
// retraction (e.g. Quoted → Routed if rancher backed out) — wholesale deals
// are bespoke enough that a strict one-way march fights ops, but each
// transition still stamps Status Changed At + fires Telegram so we keep a
// chronology.
const WHOLESALE_STATUSES = new Set(['New', 'Routed', 'Quoted', 'Closed Won', 'Closed Lost']);

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    const { id } = await context.params;
    const body = await request.json();

    // Get current inquiry to check status change + interest type
    const currentInquiry: any = await getRecordById(TABLES.INQUIRIES, id);
    const interestType = currentInquiry['Interest Type'] || '';
    const isWholesale = interestType === 'Wholesale';
    const prevStatus = currentInquiry['Status'] || '';
    const wasApproved = prevStatus === 'Pending' && body.status === 'Approved';

    const fields: any = {};

    // Update fields if provided
    if (body.status) {
      // Validate wholesale Status transitions against the known set so a
      // typo (e.g. "Routes") doesn't corrupt the funnel reporting.
      if (isWholesale && !WHOLESALE_STATUSES.has(body.status)) {
        return NextResponse.json(
          { error: `Invalid wholesale status "${body.status}". Allowed: ${Array.from(WHOLESALE_STATUSES).join(', ')}` },
          { status: 400 },
        );
      }
      fields['Status'] = body.status;
      // Stamp Status Changed At on every transition so the chronology is
      // queryable. Field is auto-stripped if schema doesn't have it yet —
      // see the schema additions list in PR notes.
      if (body.status !== prevStatus) {
        fields['Status Changed At'] = new Date().toISOString();
      }
    }
    if (body.sale_amount !== undefined) fields['Sale Amount'] = body.sale_amount;
    if (body.commission_amount !== undefined) fields['Commission Amount'] = body.commission_amount;
    if (body.commission_paid === true) fields['Commission Paid'] = true;
    else if (body.commission_paid === false) fields['Commission Paid'] = false;
    if (body.notes !== undefined) fields['Notes'] = body.notes;

    // Wholesale match action: admin attaches 1-3 ranchers to a wholesale
    // inquiry by passing matchedRancherIds[]. We store the IDs as a newline-
    // joined string in the "Matched Rancher IDs" long-text field (schema
    // addition flagged) so the GET hydration loop can resolve them back to
    // operator names without a Rancher-Inquiries linked-record migration.
    if (isWholesale && Array.isArray(body.matchedRancherIds)) {
      const cleanIds = body.matchedRancherIds
        .map((s: any) => String(s).trim())
        .filter((s: string) => s.startsWith('rec'))
        .slice(0, 3); // cap at 3 per ops guidance
      fields['Matched Rancher IDs'] = cleanIds.join('\n');
    }

    // Update the record
    const updatedRecord = await updateRecord(TABLES.INQUIRIES, id, fields);

    // ── Telegram alerts on every wholesale Status transition ─────────────
    // Each status change pings the admin chat with context so Ben sees the
    // funnel move in real time. Non-fatal — TG outage shouldn't block ops.
    if (isWholesale && body.status && body.status !== prevStatus) {
      try {
        const businessName = currentInquiry['Ranch Name'] || 'Unknown business';
        const contactName = currentInquiry['Consumer Name'] || 'Unknown contact';
        const email = currentInquiry['Consumer Email'] || '';
        const phone = currentInquiry['Consumer Phone'] || '';
        const statePart = (currentInquiry['Notes'] || '').match(/^State:\s*(.+)$/m)?.[1]?.trim() || '';
        const stamp = `WHOLESALE ${prevStatus || 'New'} → ${body.status}`;
        const lines = [
          stamp,
          `${businessName}${statePart ? ` (${statePart})` : ''}`,
          `${contactName} · ${email} · ${phone}`,
        ];
        if (body.status === 'Routed' && fields['Matched Rancher IDs']) {
          const n = String(fields['Matched Rancher IDs']).split('\n').filter(Boolean).length;
          lines.push(`Matched to ${n} rancher${n === 1 ? '' : 's'}`);
        }
        if (body.status === 'Closed Won' && body.sale_amount) {
          lines.push(`Sale: $${Number(body.sale_amount).toLocaleString()}`);
        }
        if (body.status === 'Closed Lost' && body.notes) {
          lines.push(`Reason: ${String(body.notes).slice(0, 120)}`);
        }
        await sendTelegramUpdate(lines.join('\n'));
      } catch (e: any) {
        console.warn('[inquiries PATCH] telegram alert failed (non-fatal):', e?.message);
      }
    }

    // If retail inquiry was just approved, send email to rancher
    if (wasApproved && !isWholesale) {
      try {
        const rancherId = currentInquiry['Rancher ID'];
        const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);

        await sendInquiryToRancher({
          rancherName: rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher',
          rancherEmail: rancher['Email'] || currentInquiry['Rancher Email'],
          ranchName: rancher['Ranch Name'] || currentInquiry['Ranch Name'],
          consumerName: currentInquiry['Consumer Name'],
          consumerEmail: currentInquiry['Consumer Email'],
          consumerPhone: currentInquiry['Consumer Phone'] || '',
          interestType: currentInquiry['Interest Type'] || '',
          message: currentInquiry['Message'],
          inquiryId: id,
        });
      } catch (emailError) {
        console.error('Error sending approval email to rancher:', emailError);
        // Don't fail the request if email fails
      }
    }

    return NextResponse.json({ success: true, inquiry: updatedRecord });
  } catch (error: any) {
    console.error('API error updating inquiry:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    const { id } = await context.params;
    const { deleteRecord } = await import('@/lib/airtable');
    await deleteRecord(TABLES.INQUIRIES, id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API error deleting inquiry:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
