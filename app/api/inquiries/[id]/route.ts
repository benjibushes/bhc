import { NextResponse, NextRequest } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendInquiryToRancher } from '@/lib/email';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    
    // Get current inquiry to check status change
    const currentInquiry: any = await getRecordById(TABLES.INQUIRIES, id);
    const wasApproved = currentInquiry['Status'] === 'Pending' && body.status === 'Approved';
    
    const fields: any = {};
    
    // Update fields if provided
    if (body.status) fields['Status'] = body.status;
    if (body.sale_amount !== undefined) fields['Sale Amount'] = body.sale_amount;
    if (body.commission_amount !== undefined) fields['Commission Amount'] = body.commission_amount;
    if (body.commission_paid === true) fields['Commission Paid'] = true;
    else if (body.commission_paid === false) fields['Commission Paid'] = false;
    if (body.notes !== undefined) fields['Notes'] = body.notes;
    
    // Update the record
    const updatedRecord = await updateRecord(TABLES.INQUIRIES, id, fields);
    
    // If inquiry was just approved, send email to rancher
    if (wasApproved) {
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
