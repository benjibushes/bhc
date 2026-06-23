import React from 'react';
import Container from '../../components/Container';
import Pill from '../../components/Pill';

export interface FaqItem {
  q: string;
  a: string;
}

// ── FAQ parsing ──────────────────────────────────────────────────────────
// P1 #3: read rancher['FAQ'] — a long-text JSON array of {q,a}. Parse
// defensively (a bad row must not break the page) and normalize each entry to
// trimmed strings, dropping any item missing a question or answer. Exported
// so the parent can reuse the SAME parsed list for the FAQPage JSON-LD,
// guaranteeing the structured data and the visible accordion never diverge.
export function parseFaq(raw: unknown, onError?: (e: unknown) => void): FaqItem[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => ({
        q: String(item?.q ?? item?.question ?? '').trim(),
        a: String(item?.a ?? item?.answer ?? '').trim(),
      }))
      .filter((item) => item.q.length > 0 && item.a.length > 0);
  } catch (e) {
    onError?.(e);
    return [];
  }
}

// Native <details>/<summary> accordion — fully accessible and works with zero
// client JS (keeps this a server component + the page light). Each item is
// independently expandable. Answers preserve author line breaks.
export default function FaqSection({ items }: { items: FaqItem[] }) {
  if (!items || items.length === 0) return null;

  return (
    <section className="py-16 md:py-20">
      <Container>
        <div className="max-w-3xl mx-auto space-y-10">
          <div className="text-center space-y-2">
            <Pill tone="neutral" className="mx-auto">Good to know</Pill>
            <h2 className="font-serif text-3xl md:text-4xl">Common questions</h2>
          </div>
          <div className="divide-y divide-dust/60 border-y border-dust/60">
            {items.map((item, i) => (
              <details key={i} className="group py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left">
                  <span className="font-serif text-lg md:text-xl text-charcoal">
                    {item.q}
                  </span>
                  <span
                    aria-hidden
                    className="shrink-0 text-saddle transition-transform duration-200 group-open:rotate-45"
                  >
                    {/* plus → rotates to ×-ish on open */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </summary>
                <div className="pb-5 pr-8 text-sm md:text-base text-charcoal/75 leading-relaxed whitespace-pre-line">
                  {item.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
