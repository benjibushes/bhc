// Sales-floor pivot 2026-06-09: Ben's single login screen.
// Server-side admin gate, then renders the client desk.

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import DeskClient from './DeskClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Today · BHC' };

export default async function TodayV2Page() {
  const c = await cookies();
  const tok = c.get('bhc-admin-auth')?.value;
  if (!tok) redirect('/admin/login?next=/admin/today/v2');

  // Verify admin cookie. We trust the cookie because /api/admin/* already
  // gates every server endpoint via requireAdmin — the page just routes
  // the user to login if there's no cookie at all.
  return <DeskClient />;
}
