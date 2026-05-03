// Pill — small label / status badge. Used for "Verified Partner" / "Prospect"
// / "On the map" / "Founding 100" / etc. Subtle, never shouty.

type Tone = 'neutral' | 'positive' | 'amber' | 'negative' | 'inverted';

interface PillProps {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  icon?: React.ReactNode;
}

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-bone-deep text-charcoal',
  positive: 'bg-sage/15 text-sage-dark border border-sage/30',
  amber: 'bg-amber/20 text-amber-dark border border-amber/40',
  negative: 'bg-weathered/10 text-weathered border border-weathered/30',
  inverted: 'bg-charcoal text-bone',
};

export default function Pill({ children, tone = 'neutral', className = '', icon }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] uppercase tracking-widest font-semibold ${TONE_CLASSES[tone]} ${className}`}
    >
      {icon && <span aria-hidden>{icon}</span>}
      {children}
    </span>
  );
}
