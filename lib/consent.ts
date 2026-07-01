// Client-side tracking-consent state (F3 — CCPA/GPC posture). One tiny module
// so ConsentBanner (writes the choice) and PixelTracker (reads it + gates the
// pixel scripts) can never drift on key names or semantics.
//
// Storage: localStorage 'bhc-consent' is the primary record; a mirrored
// 1-year 'bhc_consent' cookie lets the server read the same choice later
// (e.g. to gate server-rendered tags in a future slice). Values are exactly
// 'granted' | 'denied' — anything else is treated as "no choice yet".
//
// Global Privacy Control: a browser sending navigator.globalPrivacyControl
// === true is a binding universal opt-out (legally required handling in
// CO/CT). Callers treat it as 'denied' WITHOUT ever showing a banner, and it
// overrides any previously stored grant.

export type ConsentValue = 'granted' | 'denied';

export const CONSENT_STORAGE_KEY = 'bhc-consent';
export const CONSENT_COOKIE_NAME = 'bhc_consent';

// Fired by ConsentBanner the moment the visitor clicks OK, so PixelTracker
// can start loading scripts immediately — no reload required.
export const CONSENT_GRANTED_EVENT = 'bhc-consent-granted';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

export function hasGlobalPrivacyControl(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl === true
  );
}

export function readConsent(): ConsentValue | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (stored === 'granted' || stored === 'denied') return stored;
  } catch {
    // localStorage blocked (private mode / storage policy) — fall through.
  }
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE_NAME}=(granted|denied)(?:;|$)`)
    );
    if (match) return match[1] as ConsentValue;
  } catch {
    // document.cookie unavailable — treat as no choice.
  }
  return null;
}

export function persistConsent(value: ConsentValue): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
  } catch {
    // Non-fatal — the cookie below still records the choice.
  }
  try {
    document.cookie = `${CONSENT_COOKIE_NAME}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    // Non-fatal.
  }
}
