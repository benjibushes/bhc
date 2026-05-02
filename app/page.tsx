import FullHomepage from './components/FullHomepage';

// Single homepage. The pre-rebuild version had a maintenance-mode fork that
// rendered a separate <WaitlistLanding/> page when MAINTENANCE_MODE=true —
// deleted in the strip pass because it was actively confusing buyers (said
// nothing about beef) and only existed as an emergency holding page during
// past outages. If we ever need to halt customer flow again, the cleaner
// path is isMaintenanceMode() at the cron/endpoint layer (already wired) —
// not a separate homepage that contradicts the brand.
export default function Home() {
  return <FullHomepage />;
}
