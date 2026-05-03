import Link from 'next/link';

// Brand button — three variants, three sizes, loading state, full a11y.
//   primary    — solid charcoal on bone (default CTA)
//   secondary  — outline charcoal on bone (paired with primary)
//   ghost      — text-only, underline-on-hover (footer / inline)
//   destructive — weathered red (rare; only for irreversible actions)
//
//   sm — chips, inline actions (px-4 py-2 text-xs)
//   md — default CTAs (px-6 py-3 text-sm)
//   lg — hero CTAs (px-8 py-4 text-base)
//
// Loading state shows a spinner + disables click. The spinner is inline
// SVG so there's no layout shift between idle/loading.

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps {
  href?: string;
  children: React.ReactNode;
  variant?: Variant;
  size?: Size;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  ariaLabel?: string;
  fullWidth?: boolean;
  external?: boolean;
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'px-4 py-2 text-xs',
  md: 'px-6 py-3 text-sm',
  lg: 'px-8 py-4 text-base',
};

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'bg-charcoal text-bone border border-charcoal hover:bg-divider hover:border-divider',
  secondary:
    'bg-transparent text-charcoal border border-charcoal hover:bg-charcoal hover:text-bone',
  ghost:
    'bg-transparent text-charcoal border border-transparent underline underline-offset-4 decoration-dust hover:decoration-charcoal',
  destructive:
    'bg-weathered text-bone border border-weathered hover:bg-charcoal hover:border-charcoal',
};

export default function Button({
  href,
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  onClick,
  disabled = false,
  loading = false,
  className = '',
  ariaLabel,
  fullWidth = false,
  external = false,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const styles = [
    'inline-flex items-center justify-center gap-2',
    'font-medium tracking-wide uppercase',
    'transition-base',
    'focus-visible:outline-2 focus-visible:outline-offset-2',
    SIZE_CLASSES[size],
    VARIANT_CLASSES[variant],
    fullWidth ? 'w-full' : '',
    isDisabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : 'cursor-pointer',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      {loading && <Spinner />}
      <span>{children}</span>
    </>
  );

  if (href) {
    if (external) {
      return (
        <a
          href={href}
          className={styles}
          aria-label={ariaLabel}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={isDisabled}
        >
          {content}
        </a>
      );
    }
    return (
      <Link href={href} className={styles} aria-label={ariaLabel} aria-disabled={isDisabled}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      className={styles}
      aria-label={ariaLabel}
      aria-busy={loading}
    >
      {content}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path
        d="M4 12a8 8 0 018-8"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
