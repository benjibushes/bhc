// Shopify webhook HMAC verification (X-Shopify-Hmac-Sha256). For custom
// apps the signer is the app's API secret key — stored per-rancher
// (encrypted) in the Fulfillment Integration config. Constant-time compare.

import { createHmac, timingSafeEqual } from 'crypto';

export function verifyShopifyHmac(rawBody: string, headerSig: string | null, secret: string): boolean {
  if (!headerSig || !secret) return false;
  try {
    const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    const given = Buffer.from(headerSig, 'base64');
    return given.length === digest.length && timingSafeEqual(digest, given);
  } catch {
    return false;
  }
}
