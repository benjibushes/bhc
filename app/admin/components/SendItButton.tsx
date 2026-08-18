'use client';

// SendItButton — the operator "send it" control, shared by every console that
// mints a buyer link (/admin/sell for both share rails, /admin/products for the
// low-ticket rail).
//
// THE PROBLEM IT EXISTS FOR. Ben closes buyers off-platform — phone, text, DM,
// farmers market. The consoles minted the right link and then handed delivery
// back to him: copy it, or open an `sms:` composer in HIS OWN Messages app.
// The platform never sent anything, so every close ended in a manual,
// forgettable step. A minted-but-never-sent link is a Pending referral, a held
// slot, and a buyer who heard from nobody.
//
// WHAT THIS RENDERS, AND WHY IT IS SHAPED THIS WAY:
//   • one primary action that actually delivers, server-side;
//   • an SMS toggle that is DISABLED AND ANNOTATED when the channel is off —
//     the probe runs on mount, so Ben learns the channel is dark BEFORE he taps
//     rather than after a send that quietly did nothing (ENABLE_SMS defaults
//     OFF platform-wide, so today it is always dark);
//   • per-channel TRUTH afterwards. 'sent ✓' is the only state that means the
//     buyer has the link. Suppressed, failed, channel-off, no-consent and
//     nowhere-to-send each name themselves and carry the reason;
//   • a LOUD block when nothing reached the buyer at all, because the useful
//     move at that moment — read the link out while they are still on the
//     phone — only happens if Ben knows.
//
// It never hides the manual fallback. Whatever this component reports, the
// caller's "copy link" and `sms:` composer stay exactly where they were.

import { useCallback, useEffect, useState } from 'react';

export interface ChannelOutcome {
  state:
    | 'delivered'
    | 'already-sent'
    | 'suppressed'
    | 'failed'
    | 'channel-disabled'
    | 'no-consent'
    | 'no-destination'
    | 'not-requested';
  reason: string;
}

interface SendResponse {
  ok: boolean;
  /** Nothing reached the buyer on any attempted channel. */
  loud: boolean;
  stamped: boolean;
  channels: { email: ChannelOutcome; sms: ChannelOutcome };
}

const CHANNEL_LABEL: Record<ChannelOutcome['state'], string> = {
  delivered: 'sent ✓',
  'already-sent': 'already sent',
  suppressed: 'blocked',
  failed: 'FAILED',
  'channel-disabled': 'channel off',
  'no-consent': 'no consent',
  'no-destination': 'nowhere to send',
  'not-requested': '',
};

export interface SendItButtonProps {
  /**
   * The DURABLE link to deliver — /r/d/<token>, /r/b/<token>, or /shop/<id>.
   * Never a Stripe checkout URL: the server refuses those (they expire in ~24h
   * inside an inbox), which is why the product consoles pass the product page
   * here while still showing the session URL for the operator's own copy-paste.
   */
  sendUrl: string;
  buyerEmail: string;
  buyerName?: string;
  /** "Half Cow" / the product name — what they just agreed to. */
  itemLabel: string;
  sellerName?: string;
  /** Deposit or product price, display-only. */
  amount?: number;
  /** Share total (share rails only). */
  total?: number;
  /** Weight-priced ceiling — presence turns the buyer's total into a range. */
  totalMax?: number;
  /** PRODUCT rail: the amount RESERVES the box; the ranch confirms size and
   *  balance before shipping. Never let one of these read as a full-price
   *  shipped purchase. */
  depositStyle?: boolean;
  /** PRODUCT deposit-style: human range for the eventual total. */
  priceRange?: string;
  /** Changes whenever a NEW link is minted, clearing the previous verdict. */
  resetKey?: string;
}

export default function SendItButton(props: SendItButtonProps) {
  // null = not probed yet. Unknown is treated as OFF: never imply a live
  // channel we have not confirmed.
  const [smsCapable, setSmsCapable] = useState<boolean | null>(null);
  const [alsoSms, setAlsoSms] = useState(false);
  const [sending, setSending] = useState(false);
  const [out, setOut] = useState<SendResponse | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/sell-links/send');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setSmsCapable(res.ok ? data?.smsEnabled === true : false);
      } catch {
        if (!cancelled) setSmsCapable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A fresh mint clears the previous verdict — a stale "sent ✓" sitting next to
  // a new link is the exact lie this control exists to remove.
  //
  // buyerEmail is in the dependency list ON PURPOSE, and it is load-bearing.
  // The consoles' result bar survives edits to the buyer-email field, so after
  // one call the operator can type the NEXT buyer's address while the previous
  // buyer's minted link is still on screen — the button would relabel itself
  // "send it to <new address>" over the old token. The server refuses that
  // outright (recipient binding), but the verdict must clear here too so the
  // UI stops implying the pair is still current.
  useEffect(() => {
    setOut(null);
    setErr('');
  }, [props.resetKey, props.sendUrl, props.buyerEmail]);

  const ready = props.buyerEmail.includes('@') && !!props.sendUrl;

  const send = useCallback(async () => {
    setSending(true);
    setErr('');
    setOut(null);
    try {
      const res = await fetch('/api/admin/sell-links/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: props.sendUrl,
          buyerEmail: props.buyerEmail.trim(),
          buyerName: (props.buyerName || '').trim(),
          email: true,
          sms: alsoSms && smsCapable === true,
          itemLabel: props.itemLabel,
          sellerName: props.sellerName || '',
          amount: props.amount || 0,
          total: props.total || 0,
          totalMax: props.totalMax || 0,
          depositStyle: props.depositStyle === true,
          priceRange: props.priceRange || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `send failed (${res.status})`);
      setOut(data as SendResponse);
    } catch (e: any) {
      // The request itself never came back with an answer, so we do not know
      // and must not guess. The link is still on screen to send by hand.
      setErr(e?.message || 'the request never came back');
    } finally {
      setSending(false);
    }
  }, [props, alsoSms, smsCapable]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={send}
          disabled={sending || !ready}
          title={ready ? '' : 'enter the buyer email first'}
          className="px-4 py-2.5 min-h-[44px] bg-charcoal text-bone text-[13px] uppercase tracking-wider cursor-pointer transition-base hover:bg-saddle disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? 'sending…' : `send it to ${props.buyerEmail.trim() || 'the buyer'} →`}
        </button>
        <label
          className={`flex items-center gap-1.5 text-xs ${smsCapable === true ? 'text-charcoal cursor-pointer' : 'text-saddle cursor-not-allowed'}`}
          title={
            smsCapable === true
              ? 'also text the buyer from the platform'
              : 'sms is off platform-wide (ENABLE_SMS) — use "text it" to send from your own phone'
          }
        >
          <input
            type="checkbox"
            checked={alsoSms && smsCapable === true}
            disabled={smsCapable !== true}
            onChange={(e) => setAlsoSms(e.target.checked)}
          />
          {smsCapable === null
            ? 'checking sms…'
            : smsCapable
              ? 'also text them'
              : 'sms off (ENABLE_SMS) — text it from your phone below'}
        </label>
      </div>

      {err && (
        <p className="text-weathered text-[13px] m-0">
          <strong>the send never went through</strong> — {err}. copy the link and send it yourself.
        </p>
      )}

      {out && (
        <div className="flex flex-col gap-1 text-[13px]">
          {(['email', 'sms'] as const).map((ch) => {
            const o = out.channels?.[ch];
            if (!o || o.state === 'not-requested') return null;
            const good = o.state === 'delivered' || o.state === 'already-sent';
            return (
              <div key={ch} className={good ? 'text-sage' : 'text-weathered'}>
                <strong>
                  {ch}: {CHANNEL_LABEL[o.state] || o.state}
                </strong>
                {o.reason ? ` — ${o.reason}` : ''}
              </div>
            );
          })}
          {out.loud && (
            <p className="text-weathered font-semibold m-0 border border-weathered p-2.5">
              the buyer did not get anything. copy the link and send it yourself, or read it out while
              you still have them on the phone.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
