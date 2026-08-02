import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBackupPrunes, BACKUP_KEEP, BACKUP_TABLES } from './airtableBackup';

const p = (day: string, suffix = 'abc123') => `backups/bhc-entities-${day}.json.enc-${suffix}`;

test('prunes oldest beyond the keep window, newest kept', () => {
  const days = Array.from({ length: 20 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
  const prunes = selectBackupPrunes(days.map((d) => p(d)));
  // 20 backups, keep 14 → 6 oldest go.
  assert.equal(prunes.length, 20 - BACKUP_KEEP);
  assert.ok(prunes.includes(p('2026-07-01')));
  assert.ok(prunes.includes(p('2026-07-06')));
  assert.ok(!prunes.includes(p('2026-07-07')));
  assert.ok(!prunes.includes(p('2026-07-20')));
});

test('sorts by embedded date, not listing order', () => {
  const shuffled = [p('2026-07-03'), p('2026-07-15'), p('2026-07-01'), p('2026-07-10')];
  const prunes = selectBackupPrunes(shuffled, 2);
  assert.deepEqual(prunes.sort(), [p('2026-07-01'), p('2026-07-03')].sort());
});

test('fewer than keep → nothing pruned', () => {
  assert.deepEqual(selectBackupPrunes([p('2026-07-01'), p('2026-07-02')]), []);
  assert.deepEqual(selectBackupPrunes([]), []);
});

test('non-matching pathnames are never selected for deletion (fail-safe)', () => {
  const prunes = selectBackupPrunes(
    ['backups/manual-export.json', 'backups/README', ...Array.from({ length: 16 }, (_, i) => p(`2026-07-${String(i + 1).padStart(2, '0')}`))],
  );
  assert.ok(!prunes.includes('backups/manual-export.json'));
  assert.ok(!prunes.includes('backups/README'));
  assert.equal(prunes.length, 2); // 16 dated − 14 kept
});

test('backup table list covers the money-and-people core, never the log tables', () => {
  for (const required of ['Consumers', 'Ranchers', 'Referrals', 'Payments', 'Rancher Orders']) {
    assert.ok(BACKUP_TABLES.includes(required), `${required} must be backed up`);
  }
  for (const excluded of ['Cron Runs', 'Email Sends', 'Gear Clicks']) {
    assert.ok(!BACKUP_TABLES.includes(excluded), `${excluded} is a pruned log, not backup material`);
  }
});
