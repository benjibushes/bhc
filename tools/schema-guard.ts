#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────
// SCHEMA GUARD — the standing check that this class of bug cannot come back.
//
//   npm run schema:check              # fail on any un-parked mismatch
//   npm run schema:check -- --list    # print every write site it resolved
//   npm run schema:check -- --coverage# print what it could NOT resolve
//
// It reads every .ts/.tsx file git knows about, extracts every Airtable write
// the code can perform (table + field names + select literals), and compares
// all of it against lib/schema/airtableSchema.generated.ts — a committed
// snapshot of the real base. Four failure classes:
//
//   MISSING FIELD    the code writes a field the table does not have.
//                    Airtable 422s and lib/airtable.ts strips it: DATA LOST.
//   COMPUTED FIELD   the code writes a formula/rollup/lookup field.
//                    Always a bug — Airtable computes it, you cannot set it.
//   MISSING OPTION   the code writes a select value that is not an option.
//                    With typecast this MINTS the option: a value no reader
//                    recognizes now exists, and every selector is blind to it.
//   EMPTY SELECT     the code writes '' to a select. That is not "clear" —
//                    it mints (or re-selects) a choice whose name is the empty
//                    string. Four such choices already exist in this base.
//                    Clearing a select is `null`.
//
// Known-failing findings live in lib/schema/schemaGuardAllowlist.ts, which
// requires a reason and a date per entry. This tool PRINTS every one it
// honored on every run — parking a finding is never silent.
//
// No network, no secrets, no Airtable calls. Runs in CI on every PR.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import {
  scanSource,
  parseTablesConst,
  parseExportedStringConstants,
  type ScanContext,
  type WriteSite,
} from '../lib/schema/scanWrites';
import {
  AIRTABLE_TABLE_FIELDS,
  AIRTABLE_SELECT_FIELDS,
  AIRTABLE_COMPUTED_FIELDS,
  SCHEMA_GENERATED_AT,
} from '../lib/schema/airtableSchema.generated';
import {
  SCHEMA_GUARD_ALLOWLIST,
  isFieldAllowlisted,
  isOptionAllowlisted,
} from '../lib/schema/schemaGuardAllowlist';

// Wrappers that write to a fixed table without taking one as an argument.
// Each entry is a deliberate widening of coverage — add one whenever a new
// helper hides a write behind a fixed table.
const WRITE_HELPERS: ScanContext['writeHelpers'] = {
  // lib/airtable.ts — createRecord(TABLES.REFERRALS, stampRancherRecordIds(fields))
  createReferral: { table: 'Referrals', payloadArg: 0 },
};

// Pure functions that RETURN a payload for a fixed table. Without these the
// object literal is invisible at the call site (`updateRecord(T, id, patch)`)
// and some of the most dangerous writes in the codebase — the refund restore,
// the close, the deposit reserve — would sit in the blind-spot list.
// `npm run schema:check -- --coverage` names every builder it could not see,
// so this list has a mechanical way to grow.
const PAYLOAD_BUILDERS: Record<string, string> = {
  brokerReferralMoneyFields: 'Referrals',        // lib/brokerReferral.ts
  buildLeadConsumerFields: 'Consumers',          // app/api/rancher/referrals
  buildLeadReferralFields: 'Referrals',          // app/api/rancher/referrals
  buildPausedOverdueResumeFields: 'Ranchers',    // lib/pauseReversal.ts
  buildQualifyConsumerUpdates: 'Consumers',      // app/api/qualify
  buildRecordCloseUpdates: 'Referrals',          // lib/contracts/rancher.ts
  buildReserveConsumerFields: 'Consumers',       // lib/reserveDeposit.ts
  buildReserveReferralFields: 'Referrals',       // lib/reserveDeposit.ts
  buildSignupAttemptFields: 'Signup Attempts',   // lib/signupAttempts.ts
  mapVariantToProductFields: 'Rancher Products', // lib/shopifyCatalogSync.ts
  orderDecrementPatch: 'Rancher Products',       // app/api/webhooks/shopify
  payingBuyerConsumerPatch: 'Consumers',         // lib/stripeSettlement.ts
  refundReferralClearFields: 'Referrals',        // lib/refundLifecycle.ts
  referralRecordIdRepair: 'Referrals',           // lib/referralRecordId.ts
  resolveFulfillmentStampPatch: 'Rancher Orders',// app/api/webhooks/shopify
  // NOT stampRancherRecordIds — it is a pass-through that decorates the
  // caller's payload, so its fields are already counted at the createReferral.
};

// Files whose "writes" are not Airtable writes.
const SKIP = [
  /\.test\.tsx?$/,
  /^lib\/demo\//,          // in-memory fixture store, never touches Airtable
  /^lib\/schema\//,        // the guard's own machinery
  /^tools\/schema-guard\.ts$/,
];

type Severity = 'MISSING FIELD' | 'COMPUTED FIELD' | 'MISSING OPTION' | 'EMPTY SELECT';

interface Finding {
  severity: Severity;
  table: string;
  field: string;
  value?: string;
  file: string;
  line: number;
  hint: string;
  allowlisted: boolean;
}

function sourceFiles(): string[] {
  const tracked = execSync('git ls-files', { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  return tracked
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !SKIP.some((re) => re.test(f)));
}

function nearest(candidates: readonly string[], value: string): string | null {
  // Cheap "did you mean" — case-insensitive match first, then a prefix match.
  const lower = value.toLowerCase();
  const ci = candidates.find((c) => c.toLowerCase() === lower);
  if (ci) return ci;
  const pre = candidates.find((c) => c.toLowerCase().startsWith(lower.slice(0, Math.max(3, lower.length - 3))));
  return pre ?? null;
}

function checkSite(site: WriteSite, findings: Finding[]): void {
  if (!site.table) return;
  const tableFields = AIRTABLE_TABLE_FIELDS[site.table];
  if (!tableFields) return; // table not in the snapshot — reported as coverage, not a finding
  const selects = AIRTABLE_SELECT_FIELDS[site.table] ?? {};
  const computed = AIRTABLE_COMPUTED_FIELDS[site.table] ?? [];

  for (const f of site.fields) {
    if (!tableFields.includes(f.name)) {
      const did = nearest(tableFields, f.name);
      findings.push({
        severity: 'MISSING FIELD',
        table: site.table, field: f.name, file: site.file, line: f.line,
        hint: did ? `no such field — did you mean "${did}"?` : 'no such field on this table; the write is silently stripped',
        allowlisted: isFieldAllowlisted(site.table, f.name),
      });
      continue;
    }
    if (computed.includes(f.name)) {
      findings.push({
        severity: 'COMPUTED FIELD',
        table: site.table, field: f.name, file: site.file, line: f.line,
        hint: 'Airtable computes this field — it cannot be written',
        allowlisted: isFieldAllowlisted(site.table, f.name),
      });
      continue;
    }
    const spec = selects[f.name];
    if (!spec) continue;
    for (const value of f.values) {
      if (value === '') {
        findings.push({
          severity: 'EMPTY SELECT',
          table: site.table, field: f.name, value: '', file: site.file, line: f.line,
          hint: "writing '' to a select mints an empty-named choice — clear it with null instead",
          allowlisted: isOptionAllowlisted(site.table, f.name, ''),
        });
        continue;
      }
      if (spec.choices.includes(value)) continue;
      const did = nearest(spec.choices, value);
      findings.push({
        severity: 'MISSING OPTION',
        table: site.table, field: f.name, value, file: site.file, line: f.line,
        hint: did
          ? `not an option — did you mean "${did}"?`
          : `not an option (real options: ${spec.choices.filter(Boolean).join(', ')})`,
        allowlisted: isOptionAllowlisted(site.table, f.name, value),
      });
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const wantList = argv.includes('--list');
  const wantCoverage = argv.includes('--coverage');

  const tables = parseTablesConst(readFileSync(resolve(process.cwd(), 'lib/airtable.ts'), 'utf-8'));
  if (Object.keys(tables).length === 0) {
    console.error('schema-guard: could not parse the TABLES const out of lib/airtable.ts. Aborting rather than reporting a false all-clear.');
    process.exit(2);
  }
  const files = sourceFiles();
  const sources = new Map<string, string>();
  for (const file of files) {
    // A file git still lists but that no longer exists on disk (a deletion not
    // yet staged) must not crash the guard — skip it and keep checking the
    // rest. Crashing here reports NO violations, which reads exactly like a
    // clean base.
    try {
      sources.set(file, readFileSync(resolve(process.cwd(), file), 'utf-8'));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }

  // Pass A — every exported string constant, so a table alias defined in one
  // module (`export const PAYMENTS_TABLE = TABLES.PAYMENTS`) still resolves at
  // the 18 call sites in other files that import it.
  const externalConstants: Record<string, string[]> = {};
  for (const [file, source] of sources) {
    if (!source.includes('export const')) continue;
    const mod = file.replace(/\.(tsx?|jsx?)$/, '');
    for (const [name, value] of Object.entries(parseExportedStringConstants(file, source, tables))) {
      const key = `${mod}#${name}`;
      (externalConstants[key] ||= []).push(value);
    }
  }

  const ctx: ScanContext = { tables, writeHelpers: WRITE_HELPERS, payloadBuilders: PAYLOAD_BUILDERS, externalConstants };

  // Pass B — the writes.
  const sites: WriteSite[] = [];
  for (const [file, source] of sources) {
    const buildersHere = Object.keys(PAYLOAD_BUILDERS).some((b) => source.includes(b));
    if (!buildersHere && !source.includes('createRecord') && !source.includes('updateRecord') && !source.includes('createReferral')) continue;
    sites.push(...scanSource(file, source, ctx));
  }

  const raw: Finding[] = [];
  for (const site of sites) checkSite(site, raw);
  // One payload const reached from several call sites reports the same
  // file:line more than once. Same bug, one line of output.
  const seenFinding = new Set<string>();
  const findings: Finding[] = [];
  for (const f of raw) {
    const k = `${f.severity}|${f.table}|${f.field}|${f.value ?? ''}|${f.file}|${f.line}`;
    if (seenFinding.has(k)) continue;
    seenFinding.add(k);
    findings.push(f);
  }

  const live = findings.filter((f) => !f.allowlisted);
  const parked = findings.filter((f) => f.allowlisted);

  // ── report ────────────────────────────────────────────────────────────
  const resolvedSites = sites.filter((s) => s.table !== null);
  const checkedFields = resolvedSites.reduce((n, s) => n + s.fields.length, 0);
  console.log(`schema-guard — ${sites.length} write sites in ${files.length} files; ` +
    `${resolvedSites.length} with a resolved table, ${checkedFields} field writes checked ` +
    `against the base snapshot of ${SCHEMA_GENERATED_AT.slice(0, 10)}.`);

  if (wantList) {
    for (const s of resolvedSites) {
      console.log(`  ${s.file}:${s.line} ${s.callee} → ${s.table} [${s.fields.map((f) => f.name).join(', ')}]${s.partial ? ' (partial)' : ''}`);
    }
  }

  if (wantCoverage) {
    const blind = sites.filter((s) => !s.resolved);
    console.log(`\nBLIND SPOTS — ${blind.length} write site(s) the scanner could not fully resolve:`);
    for (const s of blind) console.log(`  ${s.file}:${s.line} ${s.callee} — ${s.unresolvedReason}`);
    const partial = sites.filter((s) => s.resolved && s.partial);
    console.log(`\nPARTIAL — ${partial.length} site(s) with an opaque spread (findings are a subset):`);
    for (const s of partial) console.log(`  ${s.file}:${s.line} ${s.callee} → ${s.table}`);
  }

  if (parked.length) {
    const today = new Date().toISOString().slice(0, 10);
    console.log(`\nPARKED (lib/schema/schemaGuardAllowlist.ts) — ${parked.length} known mismatch(es), not failing the build:`);
    const seen = new Set<string>();
    for (const f of parked) {
      const k = `${f.table}.${f.field}${f.value !== undefined ? ` = ${JSON.stringify(f.value)}` : ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const entry = SCHEMA_GUARD_ALLOWLIST.find(
        (e) => e.table === f.table && e.field === f.field && (e.value ?? undefined) === f.value,
      );
      const expired = entry && entry.expiresOn < today ? '  ** EXPIRED — chase the schema change **' : '';
      console.log(`  ${k}  (parked ${entry?.addedOn}, expires ${entry?.expiresOn})${expired}`);
    }
  }

  // An allowlist entry nothing writes any more is rot — it hides a future
  // regression under an approval nobody re-examined.
  // \u0000 sentinel so a FIELD entry (no value) can never collide with an
  // OPTION entry whose value is the empty string.
  const fkey = (t: string, fl: string, v?: string) => `${t}|${fl}|${v === undefined ? '\u0000FIELD' : v}`;
  const writtenKeys = new Set(findings.map((f) => fkey(f.table, f.field, f.value)));
  const orphaned = SCHEMA_GUARD_ALLOWLIST.filter(
    (e) => !writtenKeys.has(fkey(e.table, e.field, e.value)),
  );
  if (orphaned.length) {
    console.error(`\nSTALE ALLOWLIST — ${orphaned.length} entr(ies) no longer match any write in the codebase. Delete them:`);
    for (const e of orphaned) console.error(`  ${e.table}.${e.field}${e.value !== undefined ? ` = ${JSON.stringify(e.value)}` : ''} (parked ${e.addedOn})`);
  }

  if (live.length) {
    console.error(`\n${live.length} SCHEMA VIOLATION(S):\n`);
    const order: Severity[] = ['MISSING OPTION', 'MISSING FIELD', 'COMPUTED FIELD', 'EMPTY SELECT'];
    for (const sev of order) {
      const group = live.filter((f) => f.severity === sev);
      if (!group.length) continue;
      console.error(`  ── ${sev} ──`);
      for (const f of group) {
        const val = f.value !== undefined ? ` = ${JSON.stringify(f.value)}` : '';
        console.error(`  ${f.table}.${f.field}${val}\n      ${f.file}:${f.line} — ${f.hint}`);
      }
      console.error('');
    }
    console.error('Fix the write, or add the field/option in Airtable and run `npm run schema:snapshot`.');
    console.error('If it is genuinely pending, park it in lib/schema/schemaGuardAllowlist.ts with a reason and a date.');
  }

  if (live.length || orphaned.length) process.exit(1);
  console.log(`\nschema-guard: clean. ${parked.length} parked, 0 live violations.`);
}

main();
