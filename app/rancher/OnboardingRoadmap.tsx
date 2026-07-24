'use client';

// OnboardingRoadmap — "here is the deal, here is the road, here is what's left."
//
// The setup wizard used to open with a business-model video and then ask for
// ten screens of input without ever telling a rancher how anyone gets paid.
// This card says it in plain money up front, shows BOTH ways to sell, and
// lists exactly what remains — marking the two steps only they can do.
//
// PRESENTATIONAL ON PURPOSE: it computes from a rancher record passed in
// (lib/onboardingPaths is pure) rather than fetching. The wizard authenticates
// with a ?token= link and has no rancher session cookie, so a fetch-based card
// would render empty exactly where it matters most. Session-authed surfaces
// (dashboard/admin) can use /api/rancher/onboarding-status for the same verdict.
//
// STYLE LANDMINE (#360): the global button-softener force-pills any charcoal/
// tallow/sage <a>/<button> that lacks a `rounded` class — a tall card link
// becomes an ellipse. Every colored link here carries `rounded-sm`.

import { evaluateOnboarding, MONEY_MODEL, type SellPath } from '@/lib/onboardingPaths';

export default function OnboardingRoadmap({
  rancher,
  onChoosePath,
  compact = false,
}: {
  rancher: Record<string, unknown> | null | undefined;
  /** Optional: render the path switcher. Omit to show the detected path only. */
  onChoosePath?: (path: SellPath) => void;
  compact?: boolean;
}) {
  if (!rancher) return null;
  const state = evaluateOnboarding(rancher);
  const remaining = state.requirements.filter((r) => !r.done);

  return (
    <div className="border border-dust/60 bg-bone/40 p-5 md:p-6">
      {/* THE DEAL — stated before we ask for anything. */}
      <p className="text-[11px] uppercase tracking-[0.15em] text-saddle/70">How this works</p>
      <p className="font-serif text-xl md:text-2xl text-charcoal mt-1 leading-snug">
        {MONEY_MODEL.headline}
      </p>

      {!compact && (
        <>
          {/* THE OPTIONALITY — both ways to sell, side by side, no fine print. */}
          <div className="grid md:grid-cols-2 gap-3 mt-5">
            {(
              [
                { key: 'shares' as SellPath, title: 'Sell beef shares', body: MONEY_MODEL.sharePath },
                { key: 'store' as SellPath, title: 'Sync my existing store', body: MONEY_MODEL.storePath },
              ]
            ).map((opt) => {
              const active = state.path === opt.key;
              return (
                <div
                  key={opt.key}
                  className={`p-4 border text-sm ${
                    active ? 'border-charcoal bg-white' : 'border-dust/50 bg-white/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-charcoal">{opt.title}</p>
                    {active && (
                      <span className="text-[10px] uppercase tracking-wider bg-charcoal text-bone px-2 py-0.5">
                        Your path
                      </span>
                    )}
                  </div>
                  <p className="text-saddle mt-2 leading-relaxed">{opt.body}</p>
                  {onChoosePath && !active && (
                    <button
                      type="button"
                      onClick={() => onChoosePath(opt.key)}
                      className="mt-3 text-xs font-semibold text-charcoal underline underline-offset-4"
                    >
                      Use this instead
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* THE ONE ROAD — the thing both paths share. */}
          <p className="text-xs text-saddle mt-4 leading-relaxed border-l-2 border-tallow pl-3">
            {MONEY_MODEL.connect}
          </p>
        </>
      )}

      {/* WHAT'S LEFT */}
      <div className="mt-5">
        {state.isLive ? (
          <p className="text-sm font-semibold text-charcoal">
            You&rsquo;re live — buyers can be routed to you now.
          </p>
        ) : state.readyToGoLive ? (
          <p className="text-sm font-semibold text-charcoal">
            Everything&rsquo;s done — you&rsquo;re ready to go live.
          </p>
        ) : (
          <>
            <p className="text-[11px] uppercase tracking-[0.15em] text-saddle/70 mb-2">
              {remaining.length} step{remaining.length === 1 ? '' : 's'} left
            </p>
            <ul className="space-y-2">
              {state.requirements.map((req) => (
                <li key={req.key} className="flex gap-3 text-sm">
                  <span
                    aria-hidden
                    className={`mt-[3px] h-4 w-4 shrink-0 border flex items-center justify-center text-[10px] ${
                      req.done
                        ? 'bg-charcoal border-charcoal text-bone'
                        : 'border-dust bg-white text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                  <span>
                    <span className={req.done ? 'text-saddle/60 line-through' : 'text-charcoal font-medium'}>
                      {req.label}
                    </span>
                    {req.actor === 'rancher' && !req.done && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-saddle/70">
                        only you
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
