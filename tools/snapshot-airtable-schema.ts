#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────
// Airtable schema snapshotter — the ONE way lib/schema/airtableSchema.generated.ts
// gets written.
//
// Pulls the base's real schema from the READ-ONLY meta endpoint
// (GET /v0/meta/bases/{baseId}/tables) and emits a committed TypeScript
// module that both the runtime select guard (lib/schema/selectGuard.ts) and
// the static CI guard (tools/schema-guard.ts) read as truth.
//
//   npm run schema:snapshot          # rewrite the generated module
//   npm run schema:snapshot -- --check   # exit 1 if the committed file is stale
//
// Needs AIRTABLE_API_KEY + AIRTABLE_BASE_ID. Reads .env.local when they are
// not already in the environment. NEVER prints the key. NEVER writes to
// Airtable — this endpoint is GET-only.
//
// Re-run this whenever Ben adds a field or a select option in Airtable.
// Until it is re-run, the runtime guard treats the new option as unknown and
// DROPS the write (loudly) — that is the intended trade: a stale snapshot
// costs a label, a missing guard costs a phantom record.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const GENERATED_PATH = resolve(process.cwd(), 'lib/schema/airtableSchema.generated.ts');

// Field types Airtable computes — a write to one of these is ALWAYS a bug
// (422 "cannot accept a value" or a silent no-op depending on the endpoint).
const COMPUTED_TYPES = new Set([
  'formula', 'rollup', 'count', 'lookup', 'multipleLookupValues',
  'autoNumber', 'createdTime', 'lastModifiedTime', 'createdBy',
  'lastModifiedBy', 'button', 'externalSyncSource', 'aiText',
]);

function loadEnvLocal(): void {
  if (process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) return;
  const envPath = resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== 'AIRTABLE_API_KEY' && key !== 'AIRTABLE_BASE_ID') continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

interface MetaField { id: string; name: string; type: string; options?: { choices?: Array<{ name: string }> } }
interface MetaTable { id: string; name: string; fields: MetaField[] }

async function fetchSchema(baseId: string, apiKey: string): Promise<MetaTable[]> {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Airtable meta endpoint returned ${res.status}. (Key needs schema.bases:read on this base.)`);
  }
  const body = (await res.json()) as { tables?: MetaTable[] };
  if (!Array.isArray(body.tables)) throw new Error('Airtable meta response had no `tables` array.');
  return body.tables;
}

const q = (s: string) => JSON.stringify(s);

export function renderModule(tables: MetaTable[], baseId: string, generatedAt: string): string {
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));

  const fieldLines: string[] = [];
  const selectLines: string[] = [];
  const computedLines: string[] = [];

  for (const t of sorted) {
    const names = t.fields.map((f) => f.name).sort((a, b) => a.localeCompare(b));
    fieldLines.push(`  ${q(t.name)}: [${names.map(q).join(', ')}],`);

    const selects = t.fields
      .filter((f) => f.type === 'singleSelect' || f.type === 'multipleSelects')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (selects.length) {
      selectLines.push(`  ${q(t.name)}: {`);
      for (const f of selects) {
        const choices = (f.options?.choices || []).map((c) => c.name);
        selectLines.push(`    ${q(f.name)}: { kind: ${q(f.type)}, choices: [${choices.map(q).join(', ')}] },`);
      }
      selectLines.push('  },');
    }

    const computed = t.fields.filter((f) => COMPUTED_TYPES.has(f.type)).map((f) => f.name).sort((a, b) => a.localeCompare(b));
    if (computed.length) computedLines.push(`  ${q(t.name)}: [${computed.map(q).join(', ')}],`);
  }

  return `// ───────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT BY HAND.
//   Regenerate:  npm run schema:snapshot
//   Staleness:   npm run schema:snapshot -- --check
//
// A frozen copy of the live Airtable base schema (names + select choices
// only — no record data, no PII). Two consumers:
//   1. lib/schema/selectGuard.ts  — runtime: a select value that is not a
//      real option can never be sent, so Airtable can never mint it.
//   2. tools/schema-guard.ts      — CI: every field name and select literal
//      the code can write is checked against this before merge.
//
// When Ben adds a field or an option in Airtable, re-run the snapshot.
// Until then the guard treats the addition as unknown.
// ───────────────────────────────────────────────────────────────────────

export const SCHEMA_BASE_ID = ${q(baseId)};
export const SCHEMA_GENERATED_AT = ${q(generatedAt)};

export type SelectKind = 'singleSelect' | 'multipleSelects';

export interface SelectFieldSpec {
  readonly kind: SelectKind;
  readonly choices: readonly string[];
}

/** Every field name that exists on each table (writable or not). */
export const AIRTABLE_TABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
${fieldLines.join('\n')}
};

/** Only singleSelect / multipleSelects fields, with their exact choices. */
export const AIRTABLE_SELECT_FIELDS: Readonly<Record<string, Readonly<Record<string, SelectFieldSpec>>>> = {
${selectLines.join('\n')}
};

/** Airtable-computed fields — a write to one of these is always a bug. */
export const AIRTABLE_COMPUTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
${computedLines.join('\n')}
};
`;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  loadEnvLocal();
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) {
    console.error('schema:snapshot needs AIRTABLE_API_KEY + AIRTABLE_BASE_ID (env or .env.local).');
    process.exit(2);
  }

  const tables = await fetchSchema(baseId, apiKey);
  // --check must not report drift just because the clock moved: reuse the
  // committed timestamp so the ONLY diff that can fail is a real schema change.
  let generatedAt = new Date().toISOString();
  if (checkOnly && existsSync(GENERATED_PATH)) {
    const prev = readFileSync(GENERATED_PATH, 'utf-8').match(/SCHEMA_GENERATED_AT = "([^"]+)"/);
    if (prev) generatedAt = prev[1];
  }
  const next = renderModule(tables, baseId, generatedAt);

  if (checkOnly) {
    const current = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, 'utf-8') : '';
    if (current === next) {
      console.log(`schema:snapshot --check: committed snapshot matches the live base (${tables.length} tables).`);
      return;
    }
    console.error('schema:snapshot --check: the committed snapshot is STALE vs the live base.');
    console.error('  Run `npm run schema:snapshot` and commit lib/schema/airtableSchema.generated.ts.');
    process.exit(1);
  }

  writeFileSync(GENERATED_PATH, next, 'utf-8');
  const selectCount = tables.reduce(
    (n, t) => n + t.fields.filter((f) => f.type === 'singleSelect' || f.type === 'multipleSelects').length, 0);
  const fieldCount = tables.reduce((n, t) => n + t.fields.length, 0);
  console.log(`Wrote lib/schema/airtableSchema.generated.ts — ${tables.length} tables, ${fieldCount} fields, ${selectCount} select fields.`);
}

main().catch((e) => {
  console.error(`schema:snapshot failed: ${e?.message || e}`);
  process.exit(2);
});
