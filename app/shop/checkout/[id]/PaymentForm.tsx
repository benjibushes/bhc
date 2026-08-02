'use client';

// BRAND-OWNED CHECKOUT form (Payment Element migration — spec §3/§4).
// The payment fields live INSIDE our page, skinned to brand tokens — no
// iframe chrome, no Stripe-looking checkout. Flow (deferred intent):
//   1. buyer fills email (ours) + shipping (AddressElement; local-pickup
//      products ask for a pickup CONTACT — name + phone — instead) +
//      card/wallet (PaymentElement) — no PaymentIntent exists yet
//   2. pay-click: elements.submit() → POST /api/checkout/product/intent
//      (every stock/rancher gate re-runs seconds before the charge) →
//      stripe.confirmPayment with the fresh clientSecret
//   3. success → /order/success; decline → inline error, SAME intent reused
//      (cached clientSecret — no duplicate mint, idempotent by attemptId)
//
// Shipping lands on pi.shipping at confirm (settlement's formatShipping
// reads it); email rides metadata.buyerEmail (settlement receipt chain #1)
// AND payment_method_data.billing_details (chain #2). Billing details the
// page already collected are passed at confirm rather than re-asked by the
// PaymentElement (fields.billingDetails 'never' — the ZIP-dedupe fix).

import { useMemo, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, AddressElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { bhcAppearance, bhcFonts } from '@/lib/stripeAppearance';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function InnerForm({
  productId,
  quantity,
  totalCents,
  depositStyle,
  localOnly,
}: {
  productId: string;
  quantity: number;
  totalCents: number;
  depositStyle: boolean;
  localOnly: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [email, setEmail] = useState('');
  // LOCAL PICKUP contact (friction cut 2026-08-02): a pickup order needs a
  // person to coordinate with, not a shipping address — the old full
  // AddressElement's own label admitted it ("contact info only").
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [err, setErr] = useState('');
  const [paying, setPaying] = useState(false);
  // Consent (checkout audit 2026-07-14): perishable-goods + policy
  // acknowledgment before charging — enforced server-side by the mint route.
  const [consent, setConsent] = useState(false);
  // One attempt id per mount → Stripe idempotency; cached secret on decline
  // so retries re-confirm the SAME intent instead of minting another.
  const attemptIdRef = useRef<string>('');
  if (!attemptIdRef.current && typeof crypto !== 'undefined') {
    attemptIdRef.current = crypto.randomUUID();
  }
  const cachedSecretRef = useRef<string>('');
  const inFlightRef = useRef(false);

  const pay = async () => {
    if (!stripe || !elements || inFlightRef.current) return;
    setErr('');
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErr('add your email — it’s where your receipt and tracking go.');
      return;
    }
    if (localOnly && !contactName.trim()) {
      setErr('add your name — the ranch needs it to set up your pickup.');
      return;
    }
    if (localOnly && !contactPhone.trim()) {
      setErr('add your phone — the ranch calls or texts to set the pickup time.');
      return;
    }
    if (!consent) {
      setErr('check the box to agree to the shipping & refund policy first.');
      return;
    }
    inFlightRef.current = true;
    setPaying(true);
    try {
      // Validate the collected fields BEFORE minting anything.
      const submitted = await elements.submit();
      if (submitted.error) {
        setErr(submitted.error.message || 'check the highlighted fields.');
        return;
      }

      // Billing details for confirm. The PaymentElement is configured with
      // fields.billingDetails 'never' for everything we already collected
      // (ZIP-dedupe: the buyer types their address exactly once), so those
      // values MUST be passed here via payment_method_data.billing_details.
      //   - shipping orders: name + address from the AddressElement above
      //   - local pickup: our own contact inputs (card ZIP stays with the
      //     PaymentElement — it's the only address anyone types)
      let billingDetails: Record<string, any>;
      if (localOnly) {
        billingDetails = {
          name: contactName.trim(),
          email: cleanEmail,
          phone: contactPhone.trim(),
        };
      } else {
        const addressEl = elements.getElement(AddressElement);
        const av = addressEl ? await addressEl.getValue() : null;
        const a = av?.value?.address;
        if (!a) {
          setErr('check the shipping address fields.');
          return;
        }
        billingDetails = {
          name: av?.value?.name || '',
          email: cleanEmail,
          address: {
            line1: a.line1,
            ...(a.line2 ? { line2: a.line2 } : {}),
            city: a.city,
            state: a.state,
            postal_code: a.postal_code,
            country: a.country,
          },
        };
      }

      let clientSecret = cachedSecretRef.current;
      if (!clientSecret) {
        const res = await fetch('/api/checkout/product/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId,
            quantity,
            email: cleanEmail,
            attemptId: attemptIdRef.current,
            expectedTotalCents: totalCents,
            consent: true,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.demoUrl) {
          window.location.href = data.demoUrl;
          return;
        }
        // `fallback` = not fixable on this page (today: the ranch is contracted
        // to a service area that doesn't cover this buyer). Send them to the
        // quiz to be re-matched rather than dead-ending them on an error.
        if (!res.ok && data?.fallback) {
          window.location.href = '/access';
          return;
        }
        if (!res.ok) {
          setErr(data?.message || data?.error || 'could not start checkout — try again.');
          return;
        }
        if (!data?.clientSecret) {
          setErr('could not start checkout — try again.');
          return;
        }
        clientSecret = data.clientSecret;
        cachedSecretRef.current = clientSecret;
      }

      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: {
          return_url: `${SITE_URL}/order/success?pid=${productId}`,
          payment_method_data: { billing_details: billingDetails },
        },
        redirect: 'if_required',
      });
      if (error) {
        // Card declined / auth failed — intent stays reusable; honest message.
        setErr(error.message || 'that payment didn’t go through — nothing was charged. try another card.');
        return;
      }
      if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
        // Carry the PI id like Stripe's own redirect flows do — /order/success
        // uses it (best-effort) to link the buyer's signed order-status page.
        window.location.href = `/order/success?pid=${productId}&payment_intent=${encodeURIComponent(paymentIntent.id)}`;
      }
    } catch {
      setErr('network hiccup — nothing was charged. try again.');
    } finally {
      inFlightRef.current = false;
      setPaying(false);
    }
  };

  return (
    <div className="bg-white border border-dust p-5 space-y-4">
      <label className="block">
        <span className="block text-[13px] text-saddle mb-1.5">
          email — for your receipt + tracking
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="w-full p-3 border border-dust bg-white text-[15px]"
        />
      </label>

      {localOnly ? (
        // LOCAL PICKUP: no shipping address exists — the order is collected at
        // the ranch, so we ask only for the contact the ranch coordinates with.
        <div>
          <span className="block text-[13px] text-saddle mb-1.5">
            pickup contact — the ranch reaches out to set the time + place
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="full name"
              autoComplete="name"
              aria-label="Full name"
              className="w-full p-3 border border-dust bg-white text-[15px]"
            />
            <input
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="phone"
              autoComplete="tel"
              aria-label="Phone"
              className="w-full p-3 border border-dust bg-white text-[15px]"
            />
          </div>
        </div>
      ) : (
        <div>
          <span className="block text-[13px] text-saddle mb-1.5">shipping address</span>
          <AddressElement options={{ mode: 'shipping', allowedCountries: ['US'] }} />
        </div>
      )}

      <div>
        <span className="block text-[13px] text-saddle mb-1.5">payment</span>
        {/* ZIP-dedupe (friction cut 2026-08-02): every billing field we already
            collect is set to 'never' so the buyer is never asked twice — the
            values ride payment_method_data.billing_details at confirm (see
            pay()). Shipping orders: billing address comes from the
            AddressElement, so the card form shows no second postal-code box.
            Local pickup: no AddressElement exists, so the card form keeps its
            own postal-code field — still typed exactly once. */}
        <PaymentElement
          options={{
            layout: 'accordion',
            fields: {
              billingDetails: localOnly
                ? { name: 'never', email: 'never', phone: 'never' }
                : { name: 'never', email: 'never', address: 'never' },
            },
          }}
        />
      </div>

      {/* Consent gate — links the written policy the charge relies on. */}
      <label className="flex items-start gap-2.5 text-[13px] text-saddle leading-snug cursor-pointer">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#26251E] shrink-0"
          aria-describedby="consent-copy"
        />
        <span id="consent-copy">
          I agree to the{' '}
          <a href="/promise" target="_blank" rel="noopener noreferrer" className="underline hover:text-charcoal">
            shipping &amp; refund policy
          </a>{' '}
          — this is perishable food, shipped frozen; if anything arrives wrong,
          BuyHalfCow makes it right.
        </span>
      </label>

      {err && <p className="text-sm text-weathered" role="alert" aria-live="polite">{err}</p>}

      <button
        onClick={pay}
        disabled={paying || !stripe || !elements}
        className="w-full bg-charcoal text-bone px-6 py-4 min-h-[48px] text-base font-medium hover:bg-saddle transition-colors disabled:opacity-50"
      >
        {paying
          ? 'securing your order…'
          : depositStyle
            ? `reserve — $${(totalCents / 100).toFixed(2)} deposit`
            : `pay $${(totalCents / 100).toFixed(2)}`}
      </button>
      <p className="text-xs text-saddle text-center leading-relaxed">
        secured by stripe · we never see or store your card · nothing is charged until you tap pay
      </p>
    </div>
  );
}

export default function PaymentForm({
  publishableKey,
  connectAccountId,
  productId,
  quantity,
  totalCents,
  depositStyle,
  localOnly = false,
}: {
  publishableKey: string;
  connectAccountId: string;
  productId: string;
  quantity: number;
  totalCents: number;
  depositStyle: boolean;
  localOnly?: boolean;
}) {
  // Scope Stripe.js to the connected account — direct charge confirm requires it.
  const stripePromise = useMemo<Promise<Stripe | null>>(
    () => loadStripe(publishableKey, { stripeAccount: connectAccountId }),
    [publishableKey, connectAccountId],
  );

  return (
    <Elements
      stripe={stripePromise}
      options={{
        mode: 'payment',
        amount: totalCents,
        currency: 'usd',
        appearance: bhcAppearance,
        fonts: bhcFonts,
      }}
    >
      <InnerForm
        productId={productId}
        quantity={quantity}
        totalCents={totalCents}
        depositStyle={depositStyle}
        localOnly={localOnly}
      />
    </Elements>
  );
}
