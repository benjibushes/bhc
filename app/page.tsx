import { isMaintenanceMode } from '@/lib/maintenance';
import FullHomepage from './components/FullHomepage';
import WaitlistLanding from './components/WaitlistLanding';

// Server component — picks the landing page based on MAINTENANCE_MODE env var.
// Flip the env var in Vercel + redeploy to swap between waitlist capture and
// the full marketing site. No code changes required to pause or resume.
export default function Home() {
  if (isMaintenanceMode()) {
    return <WaitlistLanding />;
  }
  return <FullHomepage />;
}
