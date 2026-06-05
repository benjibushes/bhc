// app/components/CutBreakdown.tsx
//
// "What you actually get" visual — converts abstract weight ("170 lbs") into
// concrete dinner-table mental picture. Real data: typical USDA-graded beef
// cut yields from a half-cow processed by a custom processor. Same shape
// across Quarter / Half / Whole. Used on /qualify result page, intro email,
// and public /ranchers/[slug] page to anchor expectations.
//
// Numbers sourced from standard USDA carcass yield tables + common Montana
// processor cut sheets. Vary ±10% by rancher. Shown as "approximately" so
// buyer doesn't anchor on exact pounds.

import React from 'react';

export type Tier = 'Quarter' | 'Half' | 'Whole';

interface CutLine {
  cut: string;
  approxLbs: number;
  hint: string;
}

const CUT_TABLES: Record<Tier, { totalLbs: number; lines: CutLine[] }> = {
  Quarter: {
    totalLbs: 85,
    lines: [
      { cut: 'Ground beef', approxLbs: 32, hint: '~64 quarter-pounders' },
      { cut: 'Steaks (ribeye, NY strip, sirloin)', approxLbs: 14, hint: '~10-14 steaks' },
      { cut: 'Roasts (chuck, round, brisket)', approxLbs: 18, hint: '~6 family roasts' },
      { cut: 'Stew meat + short ribs', approxLbs: 8, hint: '~8 stew dinners' },
      { cut: 'Bones + organ + tallow', approxLbs: 13, hint: 'broth + cooking fat' },
    ],
  },
  Half: {
    totalLbs: 170,
    lines: [
      { cut: 'Ground beef', approxLbs: 64, hint: '~128 quarter-pounders' },
      { cut: 'Steaks (ribeye, NY strip, sirloin)', approxLbs: 28, hint: '~20-28 steaks' },
      { cut: 'Roasts (chuck, round, brisket)', approxLbs: 36, hint: '~12 family roasts' },
      { cut: 'Stew meat + short ribs', approxLbs: 16, hint: '~16 stew dinners' },
      { cut: 'Bones + organ + tallow', approxLbs: 26, hint: 'broth + cooking fat' },
    ],
  },
  Whole: {
    totalLbs: 340,
    lines: [
      { cut: 'Ground beef', approxLbs: 128, hint: '~256 quarter-pounders' },
      { cut: 'Steaks (ribeye, NY strip, sirloin)', approxLbs: 56, hint: '~40-56 steaks' },
      { cut: 'Roasts (chuck, round, brisket)', approxLbs: 72, hint: '~24 family roasts' },
      { cut: 'Stew meat + short ribs', approxLbs: 32, hint: '~32 stew dinners' },
      { cut: 'Bones + organ + tallow', approxLbs: 52, hint: 'broth + cooking fat' },
    ],
  },
};

interface Props {
  tier: Tier;
  /** When set, shows total cost framing (cost-per-lb + cost-per-serving). */
  totalCost?: number;
  /** Visual variant — full card vs compact list. */
  variant?: 'card' | 'compact';
  /** Optional className override for outer wrapper */
  className?: string;
}

/**
 * Server-safe (no client hooks). Used in both client pages and email HTML.
 * For email HTML, render to string via React.renderToString on the server.
 */
export function CutBreakdown({ tier, totalCost, variant = 'card', className = '' }: Props) {
  const table = CUT_TABLES[tier];
  const totalServings = Math.round(table.totalLbs * 2); // ~2 servings/lb conservative
  const costPerLb = totalCost ? totalCost / table.totalLbs : null;
  const costPerServing = totalCost ? totalCost / totalServings : null;

  if (variant === 'compact') {
    return (
      <div className={`text-sm space-y-1 ${className}`}>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">
          {tier} share · ~{table.totalLbs} lbs
        </p>
        {table.lines.map((line) => (
          <div key={line.cut} className="flex justify-between text-charcoal">
            <span>{line.cut}</span>
            <span className="text-saddle">~{line.approxLbs} lbs</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`border border-dust bg-bone p-5 md:p-6 ${className}`}>
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <div>
          <p className="text-xs uppercase tracking-widest text-saddle">What you actually get</p>
          <p className="font-serif text-2xl text-charcoal mt-1">{tier} share · ~{table.totalLbs} lbs</p>
        </div>
        {costPerServing && (
          <div className="text-right">
            <p className="text-xs uppercase tracking-widest text-saddle">Per dinner</p>
            <p className="font-serif text-2xl text-charcoal mt-1">~${costPerServing.toFixed(2)}</p>
          </div>
        )}
      </div>

      <ul className="space-y-2.5">
        {table.lines.map((line) => (
          <li key={line.cut} className="flex items-baseline justify-between gap-3 text-sm border-b border-dust/60 pb-2 last:border-0">
            <div>
              <p className="text-charcoal">{line.cut}</p>
              <p className="text-xs text-saddle">{line.hint}</p>
            </div>
            <span className="text-saddle whitespace-nowrap">~{line.approxLbs} lbs</span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-saddle mt-4 leading-relaxed">
        Approximate yields from a USDA-inspected processor. Your rancher confirms exact cut sheet before processing — you choose ground vs steaks vs roasts ratio.
      </p>

      {totalCost && costPerLb && (
        <div className="mt-4 pt-4 border-t border-dust text-xs text-saddle">
          ~${costPerLb.toFixed(2)}/lb · ~{totalServings} servings · ~${costPerServing!.toFixed(2)} per family dinner (4 servings).
        </div>
      )}
    </div>
  );
}

/**
 * Email-safe HTML string (inline styles, no React). For use inside Resend
 * email templates that can't render React components.
 */
export function cutBreakdownEmailHtml(tier: Tier, totalCost?: number): string {
  const table = CUT_TABLES[tier];
  const totalServings = Math.round(table.totalLbs * 2);
  const costPerLb = totalCost ? totalCost / table.totalLbs : null;
  const costPerServing = totalCost ? totalCost / totalServings : null;
  const linesHtml = table.lines
    .map(
      (line) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #E5E2DC;color:#0E0E0E;font-size:14px;">
            <strong>${line.cut}</strong><br>
            <span style="color:#6B4F3F;font-size:12px;">${line.hint}</span>
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #E5E2DC;text-align:right;color:#6B4F3F;font-size:14px;white-space:nowrap;">
            ~${line.approxLbs} lbs
          </td>
        </tr>`,
    )
    .join('');

  const costFooter = costPerServing && costPerLb
    ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #A7A29A;font-size:12px;color:#6B4F3F;">~$${costPerLb.toFixed(2)}/lb · ~${totalServings} servings · ~$${costPerServing.toFixed(2)} per family dinner (4 servings).</div>`
    : '';

  return `<div style="border:1px solid #A7A29A;background:#F4F1EC;padding:18px;margin:18px 0;">
  <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#6B4F3F;">What you actually get</p>
  <p style="margin:4px 0 14px;font-family:Georgia,serif;font-size:20px;color:#0E0E0E;">${tier} share · ~${table.totalLbs} lbs</p>
  <table style="width:100%;border-collapse:collapse;">${linesHtml}</table>
  <p style="margin:12px 0 0;font-size:12px;color:#6B4F3F;line-height:1.5;">Approximate yields from a USDA-inspected processor. Your rancher confirms exact cut sheet before processing.</p>
  ${costFooter}
</div>`;
}
