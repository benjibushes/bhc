'use client';

// PushSetupCard — the "get the app" card on the rancher dashboard.
//
// Three states, detected client-side:
//   1. Push live on this device → quiet confirmation + turn-off link.
//   2. Installable + push supported → one-tap "turn on notifications".
//   3. iOS Safari NOT installed → Apple only allows Web Push for
//      home-screen apps, so show the 2-step install instructions.
//
// Renders NOTHING when NEXT_PUBLIC_VAPID_PUBLIC_KEY is unset (push dark),
// when the browser can't do push at all, or while state is unknown — the
// dashboard never shows a broken toggle.

import { useEffect, useState } from 'react';

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

type State = 'hidden' | 'enabled' | 'available' | 'ios-install' | 'denied';

export default function PushSetupCard() {
  const [state, setState] = useState<State>('hidden');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!VAPID_PUBLIC) return;
    if (typeof window === 'undefined') return;

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true;

    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

    if (!supported) {
      // iOS Safari (not installed) reports no PushManager — that's the
      // install-first case, not a dead end.
      if (isIOS && !standalone) setState('ios-install');
      return;
    }
    if (isIOS && !standalone) { setState('ios-install'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }

    // Supported — check whether this device is already subscribed.
    navigator.serviceWorker
      .register('/rancher-sw.js')
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? 'enabled' : 'available'))
      .catch(() => setState('available'));
  }, []);

  async function enable() {
    setBusy(true);
    setErr('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState('denied'); return; }
      const reg = await navigator.serviceWorker.register('/rancher-sw.js');
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as unknown as BufferSource,
      });
      const res = await fetch('/api/rancher/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error('save failed');
      setState('enabled');
    } catch (e: any) {
      setErr('could not turn on notifications — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/rancher-sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/rancher/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setState('available');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'hidden' || state === 'denied') return null;

  if (state === 'enabled') {
    return (
      <p className="text-xs text-sage">
        🔔 order alerts are on for this device.{' '}
        <button onClick={disable} disabled={busy} className="underline text-saddle hover:text-charcoal">
          turn off
        </button>
      </p>
    );
  }

  if (state === 'ios-install') {
    return (
      <div className="border border-dust bg-bone-warm px-4 py-3 text-sm space-y-1">
        <div className="font-medium">📲 put your ranch in your pocket</div>
        <p className="text-[13px] text-saddle leading-snug">
          get a ping the second a buyer pays: tap <strong>Share</strong> →{' '}
          <strong>Add to Home Screen</strong>, then open the app and turn on notifications.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-dust bg-bone-warm px-4 py-3 text-sm flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div className="font-medium">🔔 know the second money lands</div>
        <p className="text-[13px] text-saddle leading-snug">
          get a notification on this device when a buyer pays a deposit or orders a product.
        </p>
        {err && <p className="text-[12px] text-weathered mt-1">{err}</p>}
      </div>
      <button
        onClick={enable}
        disabled={busy}
        className="px-4 py-2 bg-charcoal text-bone text-xs font-medium uppercase tracking-wider hover:bg-saddle transition-colors disabled:opacity-50"
      >
        {busy ? 'turning on…' : 'turn on alerts'}
      </button>
    </div>
  );
}
