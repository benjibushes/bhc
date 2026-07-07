'use client';

// Partner signup form — posts to the EXISTING self-serve affiliate rail
// (POST /api/affiliates/signup: idempotent by email, mints a 6-char code).
// On success we surface the /r/<code> chooser link as the canonical share URL
// (it fans to buyer/rancher/brand paths with the ref stamped) rather than the
// raw /access?ref= the API returns — one link a creator can put anywhere.

import { useState } from 'react';
import Button from '../components/Button';

const SITE = 'https://www.buyhalfcow.com';

export default function PartnerSignupForm() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  const shareUrl = code ? `${SITE}/r/${code}` : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/affiliates/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), fullName: fullName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.code) throw new Error(data?.error || 'signup failed — try again');
      setCode(String(data.code));
    } catch (err: any) {
      setError(err?.message || 'something went wrong — try again');
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    navigator.clipboard?.writeText(shareUrl).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  if (code) {
    return (
      <div className="border-2 border-sage bg-bone-warm p-6 text-center space-y-4">
        <p className="text-xs uppercase tracking-widest text-sage font-semibold">
          you&rsquo;re in — here&rsquo;s your link
        </p>
        <div className="font-mono text-[15px] bg-bone border border-dust px-4 py-3 break-all">
          {shareUrl}
        </div>
        <div className="flex gap-2 justify-center flex-wrap">
          <button
            onClick={copy}
            className="px-5 py-2.5 border border-charcoal text-sm cursor-pointer transition-base hover:bg-charcoal hover:text-bone"
          >
            {copied ? 'copied ✓' : 'copy link'}
          </button>
          <Button href="/affiliate/login" variant="secondary" size="md">
            open your dashboard
          </Button>
        </div>
        <p className="text-[13px] text-saddle m-0">
          share it anywhere — every buyer who comes through it is yours. save it now; your
          dashboard always has it too. code: <strong className="font-mono">{code}</strong>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="border border-dust bg-bone-warm p-6 space-y-4">
      <h2 className="font-serif text-xl m-0">get your link</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">name</span>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="First Last"
            maxLength={100}
            className="w-full p-3 border border-dust bg-bone text-[15px]"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
            email (required)
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@email.com"
            className="w-full p-3 border border-dust bg-bone text-[15px]"
          />
        </label>
      </div>
      {error && <p className="text-weathered text-sm m-0">{error}</p>}
      <Button type="submit" size="lg" fullWidth loading={busy} disabled={busy}>
        {busy ? 'minting your link…' : 'get my partner link →'}
      </Button>
      <p className="text-[11.5px] text-saddle m-0 text-center">
        free forever · no exclusivity · commissions on closes attributed to your link
      </p>
    </form>
  );
}
