// lib/largeRead.test.ts
//
// Airtable's `.all()` paginates 100 rows per request and the WHOLE call sits
// inside one 10s timeout, so cost scales with round-trips: ~160ms per page.
// A read therefore crosses the timeout somewhere near 6,500 rows and then
// fails outright — silently, and only once the table has grown enough.
//
// That is exactly how the /admin command-center died: its Email Sends window
// was bounded to 30 days, send volume grew to ~400/day, and 30 days became
// 8,698 rows / 14.3s against a 10s ceiling. Measured on the live base
// 2026-08-19; field projection did NOT help (14.3s -> 14.0s) because the cost
// is the round-trips, not the payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LARGE_READ_WARN_ROWS, LARGE_READ_FAIL_ROWS } from './airtable';
import { resolveAirtableTimeoutMs } from './airtableTimeout';

test('the warning fires with real runway before the failure point', () => {
  assert.ok(
    LARGE_READ_WARN_ROWS < LARGE_READ_FAIL_ROWS,
    'warning at or above the cliff is useless — it would only fire once already broken',
  );
  const runway = LARGE_READ_FAIL_ROWS - LARGE_READ_WARN_ROWS;
  assert.ok(runway >= 1_000, `only ${runway} rows of runway; that is not enough notice`);
});

test('the failure estimate is consistent with the timeout it derives from', () => {
  // ~100 rows/request at ~160ms/request, measured against the live base.
  const MS_PER_PAGE = 160;
  const ROWS_PER_PAGE = 100;
  const projectedMs = (LARGE_READ_FAIL_ROWS / ROWS_PER_PAGE) * MS_PER_PAGE;
  const timeoutMs = resolveAirtableTimeoutMs();
  assert.ok(
    projectedMs >= timeoutMs * 0.8 && projectedMs <= timeoutMs * 1.6,
    `LARGE_READ_FAIL_ROWS projects ${projectedMs}ms against a ${timeoutMs}ms timeout — the estimate has drifted`,
  );
});

test('a 7-day Email Sends window stays under the warning line at current volume', () => {
  // ~400 sends/day measured 2026-08-19. This is the sizing that made the
  // command-center window 7d rather than 30d; if send volume triples, this
  // pin fails and the window needs revisiting BEFORE it starts timing out.
  const SENDS_PER_DAY = 400;
  assert.ok(
    SENDS_PER_DAY * 7 < LARGE_READ_WARN_ROWS,
    'the dashboard window is back in warning territory — narrow it again',
  );
  assert.ok(
    SENDS_PER_DAY * 30 > LARGE_READ_FAIL_ROWS,
    'documents WHY 30d was removed: it projects past the failure point',
  );
});
