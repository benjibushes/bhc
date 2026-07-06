// PriceTag — the one way a price renders anywhere on BHC. Serif (Playfair via
// font-serif), tabular numerals so grids align, charcoal. One size prop so
// price typography is identical on the shop grid, PDP, checkout summary, and
// the rancher dashboard — no more per-surface price styling drift.

export default function PriceTag({
  amount,
  size = 'md',
  className = '',
}: {
  amount: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizeClass = { sm: 'text-lg', md: 'text-2xl', lg: 'text-3xl' }[size];
  return (
    <span className={`font-serif ${sizeClass} text-charcoal tabular-nums ${className}`}>
      ${amount.toFixed(2)}
    </span>
  );
}
