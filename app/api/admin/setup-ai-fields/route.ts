import { NextResponse } from 'next/server';

// One-time setup endpoint to create all AI automation fields in Airtable.
// Call GET /api/admin/setup-ai-fields after deploying the AI skills update.
// Requires AIRTABLE_API_KEY to have schema:bases:write scope.

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || '';

async function getTableIds(): Promise<Record<string, string>> {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch tables: ${await res.text()}`);
  const data: any = await res.json();
  const map: Record<string, string> = {};
  for (const table of data.tables || []) {
    map[table.name] = table.id;
    // Also track existing field names per table
    map[`${table.name}:fields`] = (table.fields || []).map((f: any) => f.name).join('||');
  }
  return map;
}

async function createTable(name: string, fields: any[]): Promise<{ created: boolean; name: string; error?: string }> {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, fields }),
  });
  if (res.ok) return { created: true, name };
  const err = await res.text();
  return { created: false, name, error: err };
}

async function createField(tableId: string, field: any): Promise<{ created: boolean; name: string; error?: string }> {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(field),
  });

  if (res.ok) return { created: true, name: field.name };
  const err = await res.text();
  return { created: false, name: field.name, error: err };
}

export async function GET(request: Request) {
  // Admin auth via cookie or password param
  const { searchParams } = new URL(request.url);
  const pw = searchParams.get('password');
  if (pw !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return NextResponse.json({ error: 'AIRTABLE_API_KEY or AIRTABLE_BASE_ID not configured' }, { status: 500 });
  }

  const results: { table: string; field: string; status: string; error?: string }[] = [];

  try {
    const tableMap = await getTableIds();

    const consumersTableId = tableMap['Consumers'];
    const referralsTableId = tableMap['Referrals'];
    const ranchersTableId = tableMap['Ranchers'];

    if (!consumersTableId) return NextResponse.json({ error: 'Consumers table not found. Check table names.' }, { status: 400 });
    if (!referralsTableId) return NextResponse.json({ error: 'Referrals table not found. Check table names.' }, { status: 400 });
    if (!ranchersTableId) return NextResponse.json({ error: 'Ranchers table not found. Check table names.' }, { status: 400 });

    const existingConsumerFields = tableMap['Consumers:fields'] || '';
    const existingReferralFields = tableMap['Referrals:fields'] || '';
    const existingRancherFields = tableMap['Ranchers:fields'] || '';

    // ─── Consumers Table Fields ────────────────────────────────────────────

    const consumerFields = [
      {
        name: 'Sequence Stage',
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'none' },
            { name: 'day3_sent' },
            { name: 'day7_sent' },
            { name: 'community_7d_sent' },
            { name: 'community_14d_sent' },
            { name: 'waitlisted' },
            { name: 'intro_checkin_sent' },
            { name: 'nurture_3d_sent' },
            { name: 'nurture_10d_sent' },
            { name: 'nurture_merch_sent' },
            { name: 'nurture_affiliate_sent' },
          ],
        },
      },
      {
        name: 'Sequence Sent At',
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Denver' },
      },
      {
        name: 'Approved At',
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Denver' },
      },
      {
        name: 'AI Qualification Summary',
        type: 'multilineText',
      },
      {
        name: 'AI Recommended Action',
        type: 'singleSelect',
        options: {
          choices: [{ name: 'approve' }, { name: 'reject' }, { name: 'watch' }],
        },
      },
      {
        name: 'AI Email Draft',
        type: 'multilineText',
      },
      {
        name: 'AI Email Draft Subject',
        type: 'singleLineText',
      },
    ];

    for (const field of consumerFields) {
      if (existingConsumerFields.split('||').includes(field.name)) {
        results.push({ table: 'Consumers', field: field.name, status: 'already_exists' });
        continue;
      }
      const result = await createField(consumersTableId, field);
      results.push({
        table: 'Consumers',
        field: field.name,
        status: result.created ? 'created' : 'error',
        error: result.error,
      });
    }

    // ─── Referrals Table Fields ────────────────────────────────────────────

    const referralFields = [
      {
        name: 'Match Type',
        type: 'singleSelect',
        options: {
          choices: [{ name: 'Local' }, { name: 'Nationwide' }],
        },
      },
      {
        name: 'Last Chased At',
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Denver' },
      },
      {
        name: 'Chase Count',
        type: 'number',
        options: { precision: 0 },
      },
      {
        name: 'AI Chase Draft',
        type: 'multilineText',
      },
      {
        name: 'Repeat Outreach Sent',
        type: 'checkbox',
        options: { icon: 'check', color: 'greenBright' },
      },
      {
        name: 'Closed At',
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Denver' },
      },
      {
        name: 'Intro Sent At',
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Denver' },
      },
    ];

    for (const field of referralFields) {
      if (existingReferralFields.split('||').includes(field.name)) {
        results.push({ table: 'Referrals', field: field.name, status: 'already_exists' });
        continue;
      }
      const result = await createField(referralsTableId, field);
      results.push({
        table: 'Referrals',
        field: field.name,
        status: result.created ? 'created' : 'error',
        error: result.error,
      });
    }

    // ─── Ranchers Table Fields ─────────────────────────────────────────────

    const rancherFields = [
      {
        name: 'Ships Nationwide',
        type: 'checkbox',
        options: { icon: 'check', color: 'greenBright' },
      },
      {
        name: 'Match Type',
        type: 'singleSelect',
        options: {
          choices: [{ name: 'Local' }, { name: 'Nationwide' }],
        },
      },
    ];

    for (const field of rancherFields) {
      if (existingRancherFields.split('||').includes(field.name)) {
        results.push({ table: 'Ranchers', field: field.name, status: 'already_exists' });
        continue;
      }
      const result = await createField(ranchersTableId, field);
      results.push({
        table: 'Ranchers',
        field: field.name,
        status: result.created ? 'created' : 'error',
        error: result.error,
      });
    }

    // ─── Affiliates Table (create if missing) ──────────────────────────────

    if (!tableMap['Affiliates']) {
      const affResult = await createTable('Affiliates', [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Email', type: 'email' },
        { name: 'Code', type: 'singleLineText' },
        { name: 'Status', type: 'singleSelect', options: { choices: [{ name: 'Active' }, { name: 'Inactive' }] } },
      ]);
      results.push({
        table: 'Affiliates',
        field: '(table)',
        status: affResult.created ? 'created' : 'error',
        error: affResult.error,
      });
    } else {
      results.push({ table: 'Affiliates', field: '(table)', status: 'already_exists' });
    }

    const created = results.filter(r => r.status === 'created').length;
    const existing = results.filter(r => r.status === 'already_exists').length;
    const errors = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      success: errors === 0,
      summary: `${created} created, ${existing} already existed, ${errors} errors`,
      results,
      note: errors > 0
        ? 'Some fields failed — your Airtable token may need schema:bases:write scope. Add it in airtable.com/create/tokens'
        : 'All fields ready. You can now deploy and run the AI skills.',
    });
  } catch (error: any) {
    return NextResponse.json({
      error: error.message,
      note: 'Your Airtable token likely needs schema:bases:write scope. Add it at airtable.com/create/tokens',
    }, { status: 500 });
  }
}
