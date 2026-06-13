import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { requireRancher } from '@/lib/rancherAuth';

// POST /api/rancher/upload
//
// Server-side image upload for the rancher dashboard. Accepts multipart
// form-data with a `file` field. Validates the rancher session, uploads
// to Vercel Blob, returns the public URL. Caller stores the URL in their
// pageForm state (Logo URL / Gallery Photos) and PATCHes via existing
// /api/rancher/landing-page flow.
//
// Why server-side put() instead of client-upload signed tokens: simpler,
// no need to expose BLOB_READ_WRITE_TOKEN client-side, and the file size
// cap below keeps the function bounded.
//
// Limits:
//   - 5 MB per file (Vercel function body limit is ~4.5MB on Hobby/Pro)
//   - image/* MIME only (image/jpeg, png, webp, gif)
//   - Filename gets a random suffix so two ranchers can't collide

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export async function POST(request: NextRequest) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({
      error: 'Upload service not configured. Email hello@buyhalfcow.com — we will fix it ASAP.',
      detail: 'BLOB_READ_WRITE_TOKEN env var missing on server',
    }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid upload (expected multipart/form-data)' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      error: `Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB. Resize and try again.`,
    }, { status: 413 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  }
  const contentType = (file.type || '').toLowerCase();
  if (!ALLOWED_MIME.has(contentType)) {
    return NextResponse.json({
      error: `Unsupported image type (${contentType || 'unknown'}). Use JPG, PNG, WEBP, or GIF.`,
    }, { status: 400 });
  }

  // Filename: ranchers/<rancherId>/<random>-<originalName>. Random suffix
  // prevents same-name collisions; rancher folder prefix makes audit easy.
  const rawName = (file as any).name || 'upload';
  const safeName = String(rawName).replace(/[^\w.-]/g, '_').slice(0, 80);
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `ranchers/${session.rancherId}/${rand}-${safeName}`;

  try {
    const result = await put(key, file, {
      access: 'public',
      contentType,
      addRandomSuffix: true, // double-belt against collisions
    });
    return NextResponse.json({
      success: true,
      url: result.url,
      pathname: result.pathname,
      size: file.size,
      contentType,
    });
  } catch (e: any) {
    console.error('Blob upload error:', e?.message);
    return NextResponse.json({
      error: 'Upload failed. Try again or paste an image URL instead.',
      detail: e?.message || 'unknown',
    }, { status: 500 });
  }
}
