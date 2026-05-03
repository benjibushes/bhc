// Card — surface primitive for any contained content (tier card, alert,
// form section). Elevation via subtle border + warm bone tint instead of
// drop shadow (Western paper aesthetic, not Material).
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

const VARIANT_CLASSES: Record<Variant, string> = {
  default: 'bg-bone border border-dust',
  warm: 'bg-bone-warm border border-dust',
  inverted: 'bg-charcoal text-bone border border-charcoal dark-surface',
  outline: 'bg-transparent border-2 border-charcoal',
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
      ? 'hover:-translate-y-0.5 hover:border-charcoal cursor-pointer'
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
