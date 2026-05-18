// Svix-style HMAC signature verification for Resend Inbound webhooks.
// Resend sends three headers: svix-id, svix-timestamp, svix-signature.
// Signed payload = `${svix-id}.${svix-timestamp}.${body}`. Signature is
// base64(hmac-sha256(secret, signedPayload)) prefixed with `v1,`.
// Multiple signatures space-separated → any match passes.

import crypto from 'crypto';

export function verifySvixSignature(opts: {
  body: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  secret: string;
}): { ok: boolean; reason?: string } {
  const { body, svixId, svixTimestamp, svixSignature, secret } = opts;
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, reason: 'missing svix headers' };
  }
  const ts = Number(svixTimestamp);
  if (!isFinite(ts)) return { ok: false, reason: 'invalid timestamp' };
  const skewSec = Math.abs(Date.now() / 1000 - ts);
  if (skewSec > 300) return { ok: false, reason: `timestamp skew ${skewSec}s` };

  const cleanSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBuf = Buffer.from(cleanSecret, 'base64');
  const signedPayload = `${svixId}.${svixTimestamp}.${body}`;
  const expected = crypto.createHmac('sha256', keyBuf).update(signedPayload).digest('base64');

  const provided = svixSignature
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  for (const p of provided) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(p), Buffer.from(expected))) {
        return { ok: true };
      }
    } catch {
      // length mismatch on timingSafeEqual; treat as mismatch
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}
