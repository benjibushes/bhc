import { NextResponse } from 'next/server';

// One-time setup endpoint to create all rancher landing page fields in Airtable.
// Call GET /api/admin/setup-rancher-page-fields?password=ADMIN_PASSWORD after deploying.
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
    map[`${table.name}:fields`] = (table.fields || []).map((f: any) => f.name).join('||');
  }
  return map;
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
    const ranchersTableId = tableMap['Ranchers'];
    if (!ranchersTableId) {
      return NextResponse.json({ error: 'Ranchers table not found. Check table names.' }, { status: 400 });
    }

    const existingFields = tableMap['Ranchers:fields'] || '';

    const fields = [
      // ── Page Control ──────────────────────────────────────────────────────
      { name: 'Slug', type: 'singleLineText' },
      { name: 'Page Live', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
      // ── Brand / Story ─────────────────────────────────────────────────────
      { name: 'Logo URL', type: 'url' },
      { name: 'Tagline', type: 'singleLineText' },
      { name: 'About Text', type: 'multilineText' },
      { name: 'Video URL', type: 'url' },
      // ── Pricing ───────────────────────────────────────────────────────────
      { name: 'Quarter Price', type: 'number', options: { precision: 0 } },
      { name: 'Quarter lbs', type: 'singleLineText' },
      { name: 'Quarter Payment Link', type: 'url' },
      { name: 'Half Price', type: 'number', options: { precision: 0 } },
      { name: 'Half lbs', type: 'singleLineText' },
      { name: 'Half Payment Link', type: 'url' },
      { name: 'Whole Price', type: 'number', options: { precision: 0 } },
      { name: 'Whole lbs', type: 'singleLineText' },
      { name: 'Whole Payment Link', type: 'url' },
      // ── Reservation ───────────────────────────────────────────────────────
      {
        name: 'Next Processing Date',
        type: 'date',
        options: { dateFormat: { name: 'friendly' } },
      },
      { name: 'Reserve Link', type: 'url' },
      // ── Extras ────────────────────────────────────────────────────────────
      { name: 'Custom Notes', type: 'multilineText' },
      // ── Testimonials (JSON array: [{name, quote, location?, photo?}]) ───
      { name: 'Testimonials', type: 'multilineText' },
      // ── Photo Gallery (JSON array of image URLs) ────────────────────────
      { name: 'Gallery Photos', type: 'multilineText' },
      // ── Custom Products (JSON array: [{name, price, description, link}]) ─
      { name: 'Custom Products', type: 'multilineText' },
      // ── Verification ────────────────────────────────────────────────────
      { name: 'Verification Method', type: 'singleLineText' },
      { name: 'Verification Notes', type: 'multilineText' },
      { name: 'Verification Status', type: 'singleLineText' },
      { name: 'Google Reviews URL', type: 'url' },
      { name: 'Facebook URL', type: 'url' },
      { name: 'Instagram URL', type: 'url' },
      { name: 'Processing Facility', type: 'singleLineText' },
      // ── Sequence tracking ──────────────────────────────────────────────────
      { name: 'Rancher Sequence Stage', type: 'singleLineText' },
      // ── Attribution tracking ──────────────────────────────────────────────
      { name: 'Quarter Clicks', type: 'number', options: { precision: 0 } },
      { name: 'Half Clicks', type: 'number', options: { precision: 0 } },
      { name: 'Whole Clicks', type: 'number', options: { precision: 0 } },
    ];

    for (const field of fields) {
      if (existingFields.split('||').includes(field.name)) {
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

    const created = results.filter(r => r.status === 'created').length;
    const existing = results.filter(r => r.status === 'already_exists').length;
    const errors = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      success: errors === 0,
      summary: `${created} created, ${existing} already existed, ${errors} errors`,
      results,
      note: errors > 0
        ? 'Some fields failed — your Airtable token may need schema:bases:write scope. Add it in airtable.com/create/tokens'
        : 'All rancher page fields ready. Fill in Airtable and set Page Live = true to publish a rancher page.',
    });
  } catch (error: any) {
    return NextResponse.json({
      error: error.message,
      note: 'Your Airtable token likely needs schema:bases:write scope. Add it at airtable.com/create/tokens',
    }, { status: 500 });
  }
}
