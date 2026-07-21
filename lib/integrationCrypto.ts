// AES-256-GCM at-rest encryption for per-rancher integration credentials
// (Shopify admin tokens etc). REQUIRED because the Airtable base is shared
// with ~/bhc-prospects-dashboard — plaintext third-party tokens in a shared
// base are an unacceptable exposure class. Key is platform-global env
// (INTEGRATION_TOKEN_KEY, 32 bytes base64), fail-loud like lib/secrets.ts.
// Format: v1:<iv b64>:<authTag b64>:<ciphertext b64>

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function key(): Buffer {
  const raw = process.env.INTEGRATION_TOKEN_KEY || '';
  if (!raw) throw new Error('INTEGRATION_TOKEN_KEY unset');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('INTEGRATION_TOKEN_KEY must be 32 bytes base64');
  return k;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(token: string): string {
  const [v, ivB64, tagB64, ctB64, extra] = String(token || '').split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64 || extra !== undefined) {
    throw new Error('integrationCrypto: malformed token');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
