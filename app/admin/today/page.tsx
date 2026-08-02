// Wave 1B — THE cockpit. Ben's one daily screen (see docs/GTM-PERFECTION-
// PLAN-2026-08-02.md §1B). Server-side cookie gate (mints ?next= so an
// expired-session deep-link comes back here), then the client cockpit.

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import TodayClient from './TodayClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Today · BHC' };

export default async function TodayPage() {
  const c = await cookies();
  const tok = c.get('bhc-admin-auth')?.value;
  if (!tok) redirect('/admin/login?next=/admin/today');

  // Cookie presence only — /api/admin/today enforces requireAdmin on every
  // call, so the page gate is UX (skip a doomed render), not defense.
  return <TodayClient />;
}
