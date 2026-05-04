'use client';

import { useState } from 'react';
import Card from '../../components/Card';
import Pill from '../../components/Pill';
import Button from '../../components/Button';

// Self vs community submission — drives email copy + Telegram framing.
// Both paths POST to /api/prospects/self-submit; the endpoint keys off
// `submitterType` to decide which welcome email to fire and what to put
// in the Notes field.

type SubmitterType = 'self' | 'community';

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

export default function AddRancherForm() {
  const [submitterType, setSubmitterType] = useState<SubmitterType>('self');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'idle' }
    | { kind: 'success'; ranchName: string; submitterType: SubmitterType }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setResult({ kind: 'idle' });

    const fd = new FormData(e.currentTarget);
    const payload = {
      submitterType,
      ranchName: String(fd.get('ranchName') || '').trim(),
      operatorName: String(fd.get('operatorName') || '').trim(),
      rancherEmail: String(fd.get('rancherEmail') || '').trim(),
      rancherPhone: String(fd.get('rancherPhone') || '').trim(),
      city: String(fd.get('city') || '').trim(),
      state: String(fd.get('state') || '').trim(),
      zip: String(fd.get('zip') || '').trim().slice(0, 5),
      website: String(fd.get('website') || '').trim(),
      primaryProduct: String(fd.get('primaryProduct') || 'Beef').trim(),
      notes: String(fd.get('notes') || '').trim(),
      submitterName: String(fd.get('submitterName') || '').trim(),
      submitterEmail: String(fd.get('submitterEmail') || '').trim(),
      relationship: String(fd.get('relationship') || '').trim(),
      website2: String(fd.get('website2') || ''), // honeypot
    };

    try {
      const res = await fetch('/api/prospects/self-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ kind: 'error', message: data?.error || 'Submission failed' });
        setSubmitting(false);
      } else if (submitterType === 'self' && data?.setupUrl) {
        // INSTANT FLOW — boom-boom-bam. Self-submitting rancher goes straight
        // into the setup wizard. No email round-trip. The setupUrl carries
        // a 60d JWT so they can come back later via the welcome email if
        // they bail mid-wizard. window.location for full reload + clean state.
        window.location.href = data.setupUrl;
      } else {
        // Community-submit (or fallback if setupUrl mint failed) — show the
        // success card. Community-submits don't go to a wizard because the
        // submitter isn't the rancher.
        setResult({
          kind: 'success',
          ranchName: payload.ranchName,
          submitterType,
        });
        setSubmitting(false);
      }
    } catch {
      setResult({ kind: 'error', message: 'Network error — try again' });
      setSubmitting(false);
    }
  }

  if (result.kind === 'success') {
    const isSelf = result.submitterType === 'self';
    return (
      <Card variant="default" padding="lg" className="max-w-2xl border-sage">
        <Pill tone="positive" className="mb-4">
          {isSelf ? 'You’re on the map' : 'Submitted'}
        </Pill>
        <h2 className="font-serif text-3xl md:text-4xl text-charcoal mb-3">
          {isSelf ? 'Welcome to the network.' : 'Thank you for the flag.'}
        </h2>
        <div className="prose-bhc">
          <p>
            {isSelf ? (
              <>
                <strong>{result.ranchName}</strong> just landed as a yellow pin on the
                public discover map. Check your inbox — I just sent over what this is and
                how to book a 15-minute call to see if BuyHalfCow is a fit for your
                operation.
              </>
            ) : (
              <>
                <strong>{result.ranchName}</strong> is on the map as a yellow pin. I’ll
                reach out within 48 hours and let them know you flagged them. If they
                sign on, you’ve helped one more direct-to-consumer rancher skip the
                grocery middleman. That’s the food revolution.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button href="/map" variant="primary" size="md">
            View the map
          </Button>
          <Button href="/founders" variant="secondary" size="md">
            Back the build
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
      {/* ── Submitter-type toggle ─────────────────────────────────────── */}
      <Card variant="default" padding="md">
        <p className="text-xs uppercase tracking-widest text-saddle mb-3">
          Who is submitting?
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          {(
            [
              {
                value: 'self' as const,
                title: 'I am this rancher',
                blurb: 'I run the operation. Add me to the map.',
              },
              {
                value: 'community' as const,
                title: 'I know this rancher',
                blurb: 'I’m flagging a rancher you should know about.',
              },
            ]
          ).map((opt) => {
            const active = submitterType === opt.value;
            return (
              <label
                key={opt.value}
                className={`relative cursor-pointer p-4 border-2 transition-base ${
                  active
                    ? 'border-charcoal bg-bone-warm'
                    : 'border-dust hover:border-saddle'
                }`}
              >
                <input
                  type="radio"
                  name="submitterType"
                  value={opt.value}
                  checked={active}
                  onChange={() => setSubmitterType(opt.value)}
                  className="sr-only"
                />
                <div className="font-bold text-sm text-charcoal">{opt.title}</div>
                <div className="text-xs text-saddle mt-1 leading-relaxed">{opt.blurb}</div>
              </label>
            );
          })}
        </div>
      </Card>

      {/* ── Rancher details ───────────────────────────────────────────── */}
      <Card variant="default" padding="md">
        <legend className="text-xs uppercase tracking-widest text-saddle mb-4 block">
          Rancher details
        </legend>

        <div className="space-y-4">
          <Field label="Ranch name" name="ranchName" required placeholder="Smith Family Ranch" />
          <Field
            label={submitterType === 'self' ? 'Your name (operator)' : 'Operator name (if known)'}
            name="operatorName"
            required={submitterType === 'self'}
            placeholder="John Smith"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label={submitterType === 'self' ? 'Your email' : 'Rancher email (if known)'}
              name="rancherEmail"
              type="email"
              required={submitterType === 'self'}
              placeholder="ranch@example.com"
            />
            <Field
              label={submitterType === 'self' ? 'Your phone' : 'Rancher phone (optional)'}
              name="rancherPhone"
              type="tel"
              placeholder="(555) 555-5555"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
            <div className="sm:col-span-3">
              <Field label="City" name="city" required placeholder="Bozeman" />
            </div>
            <div className="sm:col-span-1">
              <SelectField label="State" name="state" required>
                <option value="" disabled>—</option>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="sm:col-span-2">
              <Field
                label="ZIP"
                name="zip"
                required
                placeholder="59715"
                pattern="\d{5}"
                inputMode="numeric"
                maxLength={5}
              />
            </div>
          </div>
          <Field label="Website / shop URL" name="website" type="url" placeholder="https://smithranch.com" />
          <Field
            label="Primary product"
            name="primaryProduct"
            defaultValue="Beef"
            placeholder="Beef, Pork, Lamb, Poultry"
          />
          <TextareaField
            label="Notes (optional)"
            name="notes"
            rows={3}
            placeholder={
              submitterType === 'self'
                ? 'What you raise, how you sell today, anything else you want me to know.'
                : 'How you know this ranch, what makes them a good fit, anything we should know.'
            }
          />
        </div>
      </Card>

      {/* ── Submitter info (community only) ───────────────────────────── */}
      {submitterType === 'community' && (
        <Card variant="default" padding="md">
          <legend className="text-xs uppercase tracking-widest text-saddle mb-4 block">
            Your info (so we can credit you)
          </legend>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Your name" name="submitterName" required placeholder="Jane Doe" />
              <Field label="Your email" name="submitterEmail" type="email" required placeholder="you@example.com" />
            </div>
            <Field
              label="How do you know them?"
              name="relationship"
              placeholder="Customer, neighbor, met at farmers market…"
            />
          </div>
        </Card>
      )}

      {/* Honeypot — hidden from humans + screen readers */}
      <input
        type="text"
        name="website2"
        tabIndex={-1}
        autoComplete="off"
        className="absolute left-[-9999px]"
        aria-hidden="true"
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Button type="submit" variant="primary" size="md" loading={submitting}>
          {submitting
            ? 'Submitting'
            : submitterType === 'self'
            ? 'Add me to the map'
            : 'Add them to the map'}
        </Button>
        <p className="text-xs text-saddle leading-relaxed sm:max-w-xs">
          By submitting you agree we may reach out about BuyHalfCow’s direct-to-consumer
          marketing services.
        </p>
      </div>

      {result.kind === 'error' && (
        <div className="text-sm text-weathered border border-weathered/40 bg-weathered/5 p-3" role="alert">
          {result.message}
        </div>
      )}
    </form>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  placeholder,
  defaultValue,
  pattern,
  inputMode,
  maxLength,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  pattern?: string;
  inputMode?: 'numeric' | 'text' | 'email' | 'tel' | 'url' | 'search' | 'decimal' | 'none';
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-charcoal mb-1.5">
        {label} {required && <span className="text-weathered">*</span>}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        pattern={pattern}
        inputMode={inputMode}
        maxLength={maxLength}
        className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle"
      />
    </label>
  );
}

function SelectField({
  label,
  name,
  required,
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-charcoal mb-1.5">
        {label} {required && <span className="text-weathered">*</span>}
      </span>
      <select
        name={name}
        required={required}
        defaultValue=""
        className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle"
      >
        {children}
      </select>
    </label>
  );
}

function TextareaField({
  label,
  name,
  rows = 3,
  placeholder,
}: {
  label: string;
  name: string;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-charcoal mb-1.5">{label}</span>
      <textarea
        name={name}
        rows={rows}
        placeholder={placeholder}
        className="w-full px-3 py-3 border border-dust bg-bone text-base text-charcoal transition-base focus:outline-none focus:border-charcoal hover:border-saddle resize-y"
      />
    </label>
  );
}
