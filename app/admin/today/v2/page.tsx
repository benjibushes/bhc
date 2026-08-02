// Wave 1B (2026-08-01): /admin/today is the one cockpit now. This route
// forwards so old bookmarks / Telegram deep-links keep working. The v2 desk
// client components remain on disk pending the archival decision — nothing
// routes to them.

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function TodayV2Redirect() {
  redirect('/admin/today');
}
