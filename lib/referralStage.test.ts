// lib/referralStage.test.ts
//
// Data-layer audit P1-1 (2026-08-18) — the ACCEPTED deal must stay findable
// and closeable in one click after its final invoice goes out.
//
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/referralStage.test.ts
// (or the full suite: npm test)
//
// WHAT THE AUDIT SAW. Of 1,806 referrals, ZERO sit at 'Slot Locked'; exactly
// two sit at 'Awaiting Payment', and BOTH carry `Rancher Accepted At`. The
// send-final-invoice route writes Status 'Awaiting Payment' over the accepted
// row, so the accepted cohort is invisible to any surface that asks
// `{Status}='Slot Locked'`, and the stage button offered those two rows
// 'Slot Locked' — a BACKWARD re-accept — instead of the close.
//
// WHAT THE AUDIT GOT WRONG, and why the Status write STAYS. The brief proposed
// dropping it, on the reading that "dunning requires Closed At". It does not:
// app/api/cron/final-invoice-dunning selects `{Status} = "Awaiting Payment"`
// in Airtable AND re-checks `status !== 'Awaiting Payment'` in
// isDunningEligible, and app/api/cron/awaiting-payment-nudge selects on the
// same string. Dropping the write would silently kill both money-recovery
// rails for every invoiced deal. Those pins live at the bottom of this file.
//
// So Status is OVERLOADED — 'Awaiting Payment' means "deposit not in" before
// the accept and "balance not in" after it — and the fix is to stop asking a
// Status string a question only the timestamps can answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAcceptedInFlight, allowedStagesFrom, nextStageFor } from './referralStage';

// ── The accepted-deal predicate ──────────────────────────────────────────────

test('an accepted deal is in flight whether or not the invoice already went out', () => {
  // The live shape: accepted, then invoiced 78 seconds later.
  assert.equal(
    isAcceptedInFlight({ Status: 'Awaiting Payment', 'Rancher Accepted At': '2026-08-11T21:51:18Z' }),
    true,
  );
  // Accepted, not yet invoiced — the transient 'Slot Locked' window.
  assert.equal(
    isAcceptedInFlight({ Status: 'Slot Locked', 'Rancher Accepted At': '2026-08-11T21:50:00Z' }),
    true,
  );
});

test('an UNaccepted awaiting-payment row is not in the accepted cohort', () => {
  assert.equal(isAcceptedInFlight({ Status: 'Awaiting Payment' }), false);
  assert.equal(isAcceptedInFlight({ Status: 'Awaiting Payment', 'Rancher Accepted At': '' }), false);
});

test('a finished or dead deal is never in flight', () => {
  for (const Status of ['Closed Won', 'Closed Lost', 'Refunded']) {
    assert.equal(
      isAcceptedInFlight({ Status, 'Rancher Accepted At': '2026-08-11T21:50:00Z' }),
      false,
      `${Status} is over`,
    );
  }
});

test('the predicate never throws on junk', () => {
  assert.equal(isAcceptedInFlight(null as any), false);
  assert.equal(isAcceptedInFlight({} as any), false);
  // Airtable's singleSelect object form.
  assert.equal(
    isAcceptedInFlight({ Status: { name: 'Closed Won' }, 'Rancher Accepted At': 'x' } as any),
    false,
  );
});

// ── One-click close ──────────────────────────────────────────────────────────

test('an ACCEPTED awaiting-payment deal advances straight to Closed Won', () => {
  const ref = { Status: 'Awaiting Payment', 'Rancher Accepted At': '2026-08-11T21:51:18Z' };
  assert.equal(nextStageFor(ref), 'Closed Won');
  assert.deepEqual(allowedStagesFrom(ref), ['Closed Won', 'Closed Lost']);
  assert.ok(
    !allowedStagesFrom(ref).includes('Slot Locked'),
    're-accepting an already-accepted deal is backwards, and it cost Ben the one-click close',
  );
});

test('an UNaccepted awaiting-payment deal still advances to Slot Locked', () => {
  const ref = { Status: 'Awaiting Payment' };
  assert.equal(nextStageFor(ref), 'Slot Locked');
  assert.deepEqual(allowedStagesFrom(ref), ['Slot Locked', 'Closed Lost']);
});

test('every other stage is unchanged', () => {
  assert.deepEqual(allowedStagesFrom({ Status: 'Intro Sent' }), ['Awaiting Payment', 'Closed Lost']);
  assert.deepEqual(allowedStagesFrom({ Status: 'Slot Locked' }), ['Closed Won', 'Closed Lost']);
  assert.deepEqual(allowedStagesFrom({ Status: 'Closed Lost' }), ['Intro Sent']);
  assert.deepEqual(allowedStagesFrom({ Status: 'Closed Won' }), []);
  assert.equal(nextStageFor({ Status: 'Closed Won' }), null);
  assert.equal(nextStageFor({ Status: 'Refunded' }), null);
});

test('nextStageFor is always the first allowed stage — client and server agree', () => {
  for (const ref of [
    { Status: 'Intro Sent' },
    { Status: 'Awaiting Payment' },
    { Status: 'Awaiting Payment', 'Rancher Accepted At': 'x' },
    { Status: 'Slot Locked' },
    { Status: 'Closed Lost' },
    { Status: 'Closed Won' },
  ]) {
    assert.equal(nextStageFor(ref), allowedStagesFrom(ref)[0] ?? null);
  }
});

// ── The surfaces ─────────────────────────────────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('no operator surface builds its accepted queue from {Status}=Slot Locked', () => {
  for (const rel of ['../app/api/admin/desk/route.ts', '../app/api/admin/today/route.ts']) {
    const src = read(rel);
    assert.ok(
      !/\{Status\}\s*=\s*'Slot Locked'/.test(src),
      `${rel} still queries a Status the final-invoice write erases — that queue is permanently empty`,
    );
    assert.ok(
      !/str\(r\['Status'\]\)\s*===\s*'Slot Locked'/.test(src),
      `${rel} still filters in JS on the erased Status`,
    );
    assert.match(src, /isAcceptedInFlight|Rancher Accepted At/, `${rel} must read the accept STAMP`);
  }
});

test('the stage endpoint and the desk button share one next-step definition', () => {
  assert.match(read('../app/api/admin/referrals/[id]/stage/route.ts'), /allowedStagesFrom/);
  assert.match(read('../app/admin/today/v2/DeskClient.tsx'), /nextStageFor/);
});

// ── The write the audit wanted removed, and the two rails that need it ───────

test('send-final-invoice still writes Awaiting Payment — two money rails select on it', () => {
  const src = read('../app/api/rancher/referrals/[id]/send-final-invoice/route.ts');
  assert.match(
    src,
    /Status:\s*'Awaiting Payment'/,
    'removing this write kills final-invoice dunning AND the awaiting-payment nudge',
  );
});

test('both money rails really do select on that exact Status', () => {
  const dunning = read('../app/api/cron/final-invoice-dunning/route.ts');
  assert.match(dunning, /\{Status\} = "Awaiting Payment"/);
  assert.match(dunning, /status !== 'Awaiting Payment'/);
  assert.match(read('../app/api/cron/awaiting-payment-nudge/route.ts'), /\{Status\} = "Awaiting Payment"/);
});

test('neither rail can mis-select the two live invoiced rows', () => {
  // Dunning needs an invoice sent + a live pay link; the nudge is throttled on
  // its own stamp. Both are about money not yet collected — which is exactly
  // what an invoiced accepted deal is. The audit's worry was the reverse case
  // (mis-selecting a deposit-stage row): dunning requires Final Invoice Sent
  // At + Final Invoice URL, neither of which a deposit-stage row carries.
  const dunning = read('../app/api/cron/final-invoice-dunning/route.ts');
  assert.match(dunning, /const sentAt = toMs\(ref\['Final Invoice Sent At'\]\);\s*\n\s*if \(!sentAt\) return false;/);
  assert.match(dunning, /if \(!String\(ref\['Final Invoice URL'\] \|\| ''\)\.trim\(\)\) return false;/);
});
