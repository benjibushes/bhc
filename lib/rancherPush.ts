// lib/rancherPush.ts
//
// RANCHER PWA WEB PUSH (2026-07-08). The rancher dashboard installs to the
// home screen (public/rancher.webmanifest + public/rancher-sw.js); this
// module is the server side: store per-rancher push subscriptions on the
// Ranchers row and fire notifications for the two moments that make or
// break the promise to buyers:
//
//   deposit paid  → "call {buyer} NOW — their number is on the order"
//   product order → "new order to ship — {product}"
//
// DARK-SAFE (platform contract): without VAPID_PRIVATE_KEY +
// NEXT_PUBLIC_VAPID_PUBLIC_KEY in env, every send is a silent no-op and the
// dashboard hides the enable card — push can never block or break the
// money-path notifies it rides along with (email/SMS stay primary).
//
// Subscriptions live in the 'Push Subscriptions' multiline field on the
// rancher's row as a JSON array (a rancher can have several devices).
// Expired/revoked endpoints (410/404 from the push service) are pruned on
// send — the list is self-healing.

import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';

export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PRIVATE_KEY && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
}

/** Parse the stored JSON defensively — bad JSON/shape → []. Pure. */
export function parseSubscriptions(raw: unknown): StoredPushSubscription[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s: any) =>
        s &&
        typeof s.endpoint === 'string' &&
        s.endpoint.startsWith('https://') &&
        s.keys &&
        typeof s.keys.p256dh === 'string' &&
        typeof s.keys.auth === 'string',
    );
  } catch {
    return [];
  }
}

/** Add a subscription (dedupe by endpoint, cap 5 devices — oldest out). Pure. */
export function addSubscription(
  existing: StoredPushSubscription[],
  sub: StoredPushSubscription,
): StoredPushSubscription[] {
  const rest = existing.filter((s) => s.endpoint !== sub.endpoint);
  return [...rest, sub].slice(-5);
}

/** Remove by endpoint. Pure. */
export function removeSubscription(
  existing: StoredPushSubscription[],
  endpoint: string,
): StoredPushSubscription[] {
  return existing.filter((s) => s.endpoint !== endpoint);
}

/**
 * Fire a push to every device the rancher registered. Best-effort by
 * contract: never throws, prunes dead endpoints, no-op when dark.
 * Returns how many devices were reached.
 */
export async function sendRancherPush(
  rancherId: string,
  payload: { title: string; body: string; url?: string },
): Promise<number> {
  if (!pushConfigured() || !rancherId) return 0;

  let rancher: any = null;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch {
    return 0;
  }
  const subs = parseSubscriptions(rancher?.['Push Subscriptions']);
  if (subs.length === 0) return 0;

  // Lazy import — web-push pulls crypto deps; only pay for it when firing.
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(
    'mailto:ben@buyhalfcow.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url || '/rancher',
  });

  let delivered = 0;
  const dead: string[] = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub as any, body, { TTL: 60 * 60 * 12 });
      delivered++;
    } catch (e: any) {
      const status = Number(e?.statusCode || 0);
      // 404/410 = subscription expired or revoked — prune it.
      if (status === 404 || status === 410) dead.push(sub.endpoint);
      // anything else (throttle, transient) — leave the subscription alone.
    }
  }

  if (dead.length > 0) {
    try {
      const next = subs.filter((s) => !dead.includes(s.endpoint));
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Push Subscriptions': next.length ? JSON.stringify(next) : '',
      });
    } catch {
      /* prune is hygiene, never fatal */
    }
  }

  return delivered;
}
