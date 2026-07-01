'use client';

/**
 * TCPA / 10DLC SMS-consent checkbox for STORE surfaces (rancher pages,
 * inquiry + contact forms). The legal body copy mirrors the funnel's
 * checkbox in BuyerFunnel.tsx verbatim (only the short lead-in varies by
 * context) so the consent /privacy §11 claims actually exists at every
 * point of phone collection — one component, one place for the copy.
 *
 * UNCHECKED by default and NEVER a condition of submission: the boolean
 * gates SMS consent only, not the form. Servers store it via the existing
 * Consumers `SMS Opt-In` / `SMS Opt-In At` fields (the same ones the
 * funnel writes and sendSMSToConsumer gates on).
 */
export default function SmsConsentCheckbox({
  checked,
  onChange,
  leadIn = 'Text me updates about my order.',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  leadIn?: string;
}) {
  return (
    <label className="flex items-start gap-2.5 text-left">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 flex-shrink-0 accent-charcoal"
      />
      <span className="text-xs leading-relaxed text-saddle">
        {leadIn} By checking this box I agree to receive recurring automated
        marketing &amp; transactional text messages from BuyHalfCow at the
        number provided. Msg &amp; data rates may apply. Reply STOP to cancel,
        HELP for help. Consent is not a condition of purchase. See our{' '}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Privacy Policy
        </a>
        .
      </span>
    </label>
  );
}

/** One-line Terms + Privacy notice for under store-form submit buttons. */
export function TermsNotice() {
  return (
    <p className="text-[11px] text-dust text-center">
      By submitting you agree to our{' '}
      <a
        href="/terms"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        Terms
      </a>{' '}
      &amp;{' '}
      <a
        href="/privacy"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        Privacy Policy
      </a>
      .
    </p>
  );
}
