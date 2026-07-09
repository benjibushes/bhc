// Card — surface primitive. Softness overhaul (2026-07-09): borderless,
// rounded-2xl, whisper-shadow elevation (.elev) + warm tint. Primal-clean,
// not hard-bordered paper.
//
// Variants:
//   default   — bone bg, dust border
//   warm      — bone-warm bg, dust border (slight warmth, used in nested cards)
//   inverted  — charcoal bg, bone text (CTA emphasis)
//   outline   — transparent bg, charcoal border (secondary emphasis)
//
// Padding presets: sm | md | lg | none (caller controls)
// Interactive: when `as="a"` or `href`, hover lifts via translate + border deepen.

import Link from 'next/link';

type Variant = 'default' | 'warm' | 'inverted' | 'outline';
type Padding = 'none' | 'sm' | 'md' | 'lg';

interface CardProps {
  children: React.ReactNode;
  variant?: Variant;
  padding?: Padding;
  href?: string;
  external?: boolean;
  className?: string;
  as?: 'div' | 'article' | 'section';
  ariaLabel?: string;
}

// SOFTNESS OVERHAUL (2026-07-09): hard 1px borders → whitespace + whisper
// shadow (.elev) + generous radius. The Primal-Pastures feel on BHC's palette.
const VARIANT_CLASSES: Record<Variant, string> = {
  default: 'bg-bone rounded-2xl elev',
  warm: 'bg-bone-warm rounded-2xl elev',
  inverted: 'bg-charcoal text-bone rounded-2xl dark-surface',
  outline: 'bg-transparent rounded-2xl border border-charcoal',
};

const PADDING_CLASSES: Record<Padding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8 md:p-10',
};

export default function Card({
  children,
  variant = 'default',
  padding = 'md',
  href,
  external = false,
  className = '',
  as = 'div',
  ariaLabel,
}: CardProps) {
  const isInteractive = !!href;
  const styles = [
    VARIANT_CLASSES[variant],
    PADDING_CLASSES[padding],
    'transition-base',
    isInteractive
      ? 'elev-hover hover:-translate-y-0.5 cursor-pointer'
      : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (href) {
    if (external) {
      return (
        <a
          href={href}
          className={styles}
          aria-label={ariaLabel}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={styles} aria-label={ariaLabel}>
        {children}
      </Link>
    );
  }

  const Tag = as;
  return (
    <Tag className={styles} aria-label={ariaLabel}>
      {children}
    </Tag>
  );
}
