// lib/airtableBackup.ts
//
// NIGHTLY ENTITY BACKUP (blindspot fix, 2026-08-02). Airtable is the
// production database and had ZERO backups — one bad bulk script (it happened
// 2026-05-06) and the business data is unrecoverable. This closes that.
//
// DESIGN CONSTRAINTS (operator's call: "no more crons"):
//   - No new cron slot. This is a LEG on the existing daily log-retention run
//     (app/api/cron/log-retention) — it already scans the base daily and has
//     maxDuration headroom.
//   - ENTITY tables only (the business: buyers, ranchers, deals, money).
//     Log tables (Cron Runs / Email Sends / Funnel Events / …) are excluded —
//     they're retention-pruned journals, huge, and not restore-critical.
//   - ENCRYPTED AT REST, ALWAYS. The export contains every buyer's PII. It is
//     AES-256-GCM encrypted (lib/integrationCrypto, INTEGRATION_TOKEN_KEY —
//     deliberately reusing the existing platform key so the backup works with
//     ZERO new env vars; rotating that key orphans older backups, so decrypt
//     what you need BEFORE a key rotation) and stored in Vercel Blob under an
//     unguessable random-suffix URL. Even a leaked URL exposes only
//     ciphertext.
//   - Retention: newest 14 dailies kept, older pruned (pure selector below).
//
// RESTORE PROCEDURE (tested shape — the backup is flattened getAllRecords
// rows: { id, _createdTime, ...fields } per table):
//   1. Download the blob (URL in the log-retention Cron Runs note, or
//      `vercel blob list backups/`).
//   2. Locally, with the prod INTEGRATION_TOKEN_KEY in env:
//        node -e "const {decryptSecret}=require('./lib/integrationCrypto');
//          const fs=require('fs');
//          fs.writeFileSync('restore.json',
//            decryptSecret(fs.readFileSync('backup.enc','utf8')))"
//      (via tsx/ts-node for the TS import, or copy the 20-line decrypt.)
//   3. restore.json holds { exportedAt, tables: { [tableName]: rows[] } } —
//      re-create records per table with typecast:true, mapping old record ids
//      to new ones for the link fields (Buyer/Rancher links reference ids).
//      Restore is a deliberate manual act — never automated, never partial.

import { put, list, del } from '@vercel/blob';
import { getAllRecords, TABLES } from './airtable';
import { encryptSecret } from './integrationCrypto';

/** The business — everything that cannot be regenerated. */
export const BACKUP_TABLES: string[] = [
  TABLES.CONSUMERS,
  TABLES.RANCHERS,
  TABLES.REFERRALS,
  TABLES.PAYMENTS,
  TABLES.RANCHER_PRODUCTS,
  TABLES.RANCHER_ORDERS,
  TABLES.BRANDS,
  TABLES.INQUIRIES,
  TABLES.CONVERSATIONS,
  TABLES.AFFILIATES,
  TABLES.CAMPAIGNS,
  TABLES.LAND_DEALS,
  TABLES.RECOMMENDED_PRODUCTS,
  TABLES.AD_SPEND,
];

export const BACKUP_PREFIX = 'backups/bhc-entities-';
export const BACKUP_KEEP = 14;

/**
 * Which blob pathnames to delete, keeping the newest `keep` backups.
 * Pure — sorts by the date embedded in the pathname (bhc-entities-YYYY-MM-DD),
 * which is stable regardless of blob-store listing order or upload jitter.
 * Non-matching pathnames are never selected for deletion (fail-safe: an
 * unexpected file in the prefix is left alone, not destroyed).
 */
export function selectBackupPrunes(pathnames: string[], keep: number = BACKUP_KEEP): string[] {
  const dated = pathnames
    .map((p) => {
      const m = p.match(/bhc-entities-(\d{4}-\d{2}-\d{2})/);
      return m ? { pathname: p, date: m[1] } : null;
    })
    .filter((x): x is { pathname: string; date: string } => x !== null)
    .sort((a, b) => b.date.localeCompare(a.date)); // newest first
  return dated.slice(Math.max(0, keep)).map((x) => x.pathname);
}

export interface BackupSummary {
  ok: boolean;
  tables: number;
  rows: number;
  bytes: number;
  blobPathname?: string;
  pruned: number;
  error?: string;
}

/**
 * Export every entity table, encrypt, upload, prune. Never throws — the
 * log-retention leg reports the summary in its Cron Runs note and flips the
 * run to 'partial' on failure so the missing-backup state is visible without
 * its own alert channel.
 *
 * Airtable cost: ~60 paginated GETs across the entity tables, paced by
 * getAllRecords' own pagination — well inside log-retention's rate budget.
 */
export async function runAirtableBackup(nowMs: number): Promise<BackupSummary> {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return { ok: false, tables: 0, rows: 0, bytes: 0, pruned: 0, error: 'BLOB_READ_WRITE_TOKEN unset' };
    }

    const tables: Record<string, unknown[]> = {};
    let rows = 0;
    for (const t of BACKUP_TABLES) {
      // Sequential on purpose — shares the 5 req/s org budget politely.
      const records = (await getAllRecords(t)) as unknown[];
      tables[t] = records;
      rows += records.length;
    }

    const day = new Date(nowMs).toISOString().slice(0, 10);
    const payload = JSON.stringify({ exportedAt: new Date(nowMs).toISOString(), tables });
    // Throws IntegrationCryptoError if the key is missing — caught below and
    // surfaced in the summary; an UNencrypted backup is never written.
    const encrypted = encryptSecret(payload);

    const blob = await put(`${BACKUP_PREFIX}${day}.json.enc`, encrypted, {
      access: 'public', // ciphertext-only; random-suffix URL, never linked anywhere
      addRandomSuffix: true,
      contentType: 'application/octet-stream',
    });

    let pruned = 0;
    try {
      const existing = await list({ prefix: BACKUP_PREFIX });
      const toDelete = selectBackupPrunes(existing.blobs.map((b) => b.pathname));
      const urlByPathname = new Map(existing.blobs.map((b) => [b.pathname, b.url]));
      for (const pathname of toDelete) {
        const url = urlByPathname.get(pathname);
        if (!url) continue;
        await del(url);
        pruned++;
      }
    } catch (e: any) {
      // Prune failure is not backup failure — today's backup is safe; note it.
      console.warn('[airtableBackup] prune failed (backup itself OK):', e?.message);
    }

    return { ok: true, tables: BACKUP_TABLES.length, rows, bytes: encrypted.length, blobPathname: blob.pathname, pruned };
  } catch (e: any) {
    return { ok: false, tables: 0, rows: 0, bytes: 0, pruned: 0, error: String(e?.message || e).slice(0, 200) };
  }
}
