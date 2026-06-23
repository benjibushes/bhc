'use client';

import { useRef, useState } from 'react';

// Single-image uploader for the rancher dashboard. Accepts:
//   - Drag-and-drop OR file picker
//   - Paste URL directly (fallback if upload fails or rancher hosts elsewhere)
//
// Posts to /api/rancher/upload (server-side @vercel/blob put). Returns URL
// to onChange. Parent stores URL in their form state.
//
// 5 MB max, JPG/PNG/WEBP/GIF only (enforced server-side too).
//
// IMAGE-URL VALIDATION (P0, 2026-06-23): broken hero covers were caused by
// ranchers pasting Google Drive / Dropbox SHARE links (…/file/d/<id>/view,
// dropbox.com/…?dl=0) thinking they work as <img src>. They don't — those
// URLs serve an HTML interstitial/preview page, not raw image bytes, so the
// public page renders a broken image. Drive's `uc?export=view` rewrite is
// also unreliable now (Google injects a virus-scan interstitial for anything
// non-trivial), so we REJECT share links outright with a clear message telling
// the rancher to upload the actual file. validateImageUrl() is the single gate
// used by both the paste field here and the public-page consumers via the
// shared serializer.

// Exported so the gallery save path (app/rancher/page.tsx) can run the same
// gate before serializing Gallery Photos to Airtable.
export type ImageUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const DIRECT_IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i;

export function validateImageUrl(raw: string): ImageUrlCheck {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: false, reason: 'Empty URL.' };

  // Allow our own uploaded blobs + data URIs straight through.
  if (trimmed.startsWith('data:image/')) return { ok: true, url: trimmed };

  let u: URL;
  try {
    u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: 'That doesn’t look like a valid web address.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'Image links must start with https://' };
  }

  const host = u.hostname.toLowerCase();

  // ── Google Drive (any form) — REJECT ────────────────────────────────
  // /file/d/<id>/view, /open?id=, /uc?export=view all fail as <img src>
  // on the public page (HTML preview or virus-scan interstitial, not bytes).
  if (host.endsWith('drive.google.com') || host.endsWith('docs.google.com')) {
    return {
      ok: false,
      reason:
        'Google Drive links don’t work as images — they show a preview page, not the photo. Download the photo to your phone/computer and upload the actual image file (drop it above).',
    };
  }

  // ── Dropbox / OneDrive share links — REJECT ─────────────────────────
  if (host.endsWith('dropbox.com') || host.endsWith('1drv.ms') || host.endsWith('onedrive.live.com')) {
    return {
      ok: false,
      reason:
        'Cloud share links (Dropbox/OneDrive) don’t reliably load as images. Upload the actual image file instead (drop it above).',
    };
  }

  // ── Google Photos share links — REJECT ──────────────────────────────
  // photos.app.goo.gl / photos.google.com are albums, not direct images.
  if (host.endsWith('photos.app.goo.gl') || host.endsWith('photos.google.com')) {
    return {
      ok: false,
      reason:
        'Google Photos links are albums, not direct image files. Download the photo and upload it above.',
    };
  }

  // ── Looks like a direct image? Accept. ──────────────────────────────
  // Accept if it ends in a known image extension OR is hosted on a known
  // image/CDN/blob host (our own Vercel Blob, common CDNs). This is a soft
  // allow — the live preview's onError still surfaces anything that 404s.
  const KNOWN_IMAGE_HOSTS = [
    'blob.vercel-storage.com',
    'public.blob.vercel-storage.com',
    'googleusercontent.com', // lh3.googleusercontent.com = direct image bytes
    'cloudinary.com',
    'imgix.net',
    'amazonaws.com',
    'cloudfront.net',
    'squarespace-cdn.com',
    'shopify.com',
    'cdn.shopify.com',
    'unsplash.com',
    'images.unsplash.com',
    'wixstatic.com',
    'fbcdn.net',
    'cdninstagram.com',
  ];
  const hostKnown = KNOWN_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`) || host.endsWith(h));

  if (DIRECT_IMAGE_EXT.test(u.pathname) || hostKnown) {
    return { ok: true, url: u.toString() };
  }

  // ── Otherwise: probably a page URL, not an image. REJECT. ───────────
  return {
    ok: false,
    reason:
      'That link doesn’t point straight at an image file (it should end in .jpg, .png, .webp, or .gif). The easiest fix: drop the image file above and we’ll host it for you.',
  };
}

interface Props {
  label: string;
  hint?: string;
  value: string;        // current URL (may be empty)
  onChange: (url: string) => void;
}

export default function ImageUploader({ label, hint, value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  // Local buffer for the paste-URL field so a rancher can type/paste freely;
  // we only validate + commit on blur or Enter (not on every keystroke, which
  // would reject mid-paste). Falls back to `value` for an already-saved URL.
  const [urlDraft, setUrlDraft] = useState('');
  // True when the live preview <img> fired onError — surfaces a "failed to
  // load" warning so the rancher knows the stored URL is broken even though
  // it passed the paste-time format check (e.g. a 404 / hotlink-blocked host).
  const [previewBroken, setPreviewBroken] = useState(false);

  const uploadFile = async (file: File) => {
    setError('');
    if (!file.type.startsWith('image/')) {
      setError('That doesn’t look like an image. Use JPG, PNG, WEBP, or GIF.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError(`Image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max 5 MB — resize and try again.`);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/rancher/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Upload failed. Paste a URL instead?');
        return;
      }
      setPreviewBroken(false);
      setUrlDraft('');
      onChange(data.url);
    } catch (e: any) {
      setError(e?.message || 'Network error. Paste a URL instead?');
    } finally {
      setUploading(false);
    }
  };

  // Validate + commit a pasted/typed URL. Rejects share links + non-image
  // URLs with an inline message; only a passing direct URL reaches onChange.
  const commitUrl = (raw: string) => {
    const trimmed = (raw || '').trim();
    if (!trimmed) {
      // Cleared the field — propagate the clear (only if there was a value).
      if (value) onChange('');
      setError('');
      setPreviewBroken(false);
      return;
    }
    const check = validateImageUrl(trimmed);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setError('');
    setPreviewBroken(false);
    setUrlDraft('');
    onChange(check.url);
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">
        {label}
        {hint ? <span className="text-dust font-normal"> {hint}</span> : null}
      </label>

      {/* Preview if URL set */}
      {value ? (
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <img
              src={value}
              alt="preview"
              className="w-20 h-20 object-cover border border-dust bg-bone"
              onLoad={() => setPreviewBroken(false)}
              onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; setPreviewBroken(true); }}
            />
            <button
              type="button"
              onClick={() => { onChange(''); setPreviewBroken(false); setUrlDraft(''); }}
              className="text-xs text-saddle underline hover:text-charcoal"
            >
              Remove
            </button>
          </div>
          {previewBroken && (
            <p className="text-xs text-red-700">
              ⚠ This image failed to load — buyers will see a broken image. Replace it by uploading the file above.
            </p>
          )}
        </div>
      ) : null}

      {/* Drop zone + click-to-pick */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) uploadFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer px-4 py-6 border-2 border-dashed text-center text-sm transition-colors ${
          dragOver ? 'border-charcoal bg-bone' : 'border-dust bg-white hover:border-charcoal'
        }`}
      >
        {uploading
          ? 'Uploading…'
          : (
            <>
              <strong className="text-charcoal">Drop an image here</strong>
              <span className="text-dust"> or click to pick a file</span>
              <span className="block text-xs text-dust mt-1">JPG/PNG/WEBP/GIF · max 5 MB</span>
            </>
          )
        }
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadFile(f);
            e.target.value = ''; // reset so same file can be re-picked
          }}
        />
      </div>

      {/* URL fallback — validated on blur / Enter, not on every keystroke */}
      <div className="space-y-1">
        <label className="text-xs text-dust">Or paste a direct image URL (ends in .jpg/.png — not a Google Drive link):</label>
        <input
          type="url"
          value={urlDraft || value}
          onChange={(e) => { setUrlDraft(e.target.value); if (error) setError(''); }}
          onBlur={(e) => commitUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitUrl((e.target as HTMLInputElement).value); } }}
          placeholder="https://…/photo.jpg"
          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-xs font-mono"
        />
      </div>

      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
