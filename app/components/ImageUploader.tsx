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
      onChange(data.url);
    } catch (e: any) {
      setError(e?.message || 'Network error. Paste a URL instead?');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">
        {label}
        {hint ? <span className="text-dust font-normal"> {hint}</span> : null}
      </label>

      {/* Preview if URL set */}
      {value ? (
        <div className="flex items-center gap-3">
          <img
            src={value}
            alt="preview"
            className="w-20 h-20 object-cover border border-dust bg-bone"
            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
          />
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-xs text-saddle underline hover:text-charcoal"
          >
            Remove
          </button>
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

      {/* URL fallback */}
      <div className="space-y-1">
        <label className="text-xs text-dust">Or paste an image URL:</label>
        <input
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://..."
          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-xs font-mono"
        />
      </div>

      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
