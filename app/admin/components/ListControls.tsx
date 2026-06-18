'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';

export interface SortOption {
  /** Field key to sort by. Prefix with '-' for descending. */
  key: string;
  label: string;
}

/**
 * Reusable client-side search + sort for admin list pages. Operates on data
 * that's ALREADY loaded in the page (no new endpoints, no server round-trip).
 * Returns the filtered+sorted slice plus the bound state for <SearchSortBar>.
 */
export function useListSearch<T extends Record<string, any>>(
  items: T[],
  opts: { searchFields: (keyof T)[]; sortOptions?: SortOption[]; defaultSort?: string },
) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string>(
    opts.defaultSort || (opts.sortOptions?.[0]?.key ?? ''),
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = items;
    if (q) {
      out = items.filter((it) =>
        opts.searchFields.some((f) => String(it[f] ?? '').toLowerCase().includes(q)),
      );
    }
    if (sortKey) {
      const desc = sortKey.startsWith('-');
      const key = desc ? sortKey.slice(1) : sortKey;
      out = [...out].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (typeof av === 'number' && typeof bv === 'number') return desc ? bv - av : av - bv;
        const as = String(av ?? '');
        const bs = String(bv ?? '');
        return desc ? bs.localeCompare(as) : as.localeCompare(bs);
      });
    }
    return out;
  }, [items, query, sortKey, opts.searchFields]);

  return { filtered, query, setQuery, sortKey, setSortKey };
}

export function SearchSortBar({
  query,
  setQuery,
  sortKey,
  setSortKey,
  sortOptions,
  placeholder,
  resultCount,
  totalCount,
}: {
  query: string;
  setQuery: (v: string) => void;
  sortKey?: string;
  setSortKey?: (v: string) => void;
  sortOptions?: SortOption[];
  placeholder?: string;
  resultCount?: number;
  totalCount?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <div className="relative flex-1 min-w-[220px]">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder || 'Search…'}
          className="w-full border border-dust bg-white px-3 py-2 text-sm text-charcoal placeholder-saddle/60 focus:outline-none focus:border-charcoal"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-saddle hover:text-charcoal text-sm"
          >
            ✕
          </button>
        )}
      </div>
      {sortOptions && sortOptions.length > 0 && setSortKey && (
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          className="border border-dust bg-white px-3 py-2 text-sm text-charcoal focus:outline-none focus:border-charcoal"
        >
          {sortOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {resultCount !== undefined && (
        <span className="text-xs text-saddle whitespace-nowrap">
          {resultCount}
          {totalCount !== undefined && totalCount !== resultCount ? ` of ${totalCount}` : ''} shown
        </span>
      )}
    </div>
  );
}

// ── DENSITY ────────────────────────────────────────────────────────────────
// Compact/default/comfortable row density, persisted per page in localStorage.
export type Density = 'compact' | 'default' | 'comfortable';

export function useDensity(pageKey: string): [Density, (d: Density) => void] {
  const [density, setDensityState] = useState<Density>('default');
  useEffect(() => {
    try {
      const s = localStorage.getItem(`admin:density:${pageKey}`);
      if (s === 'compact' || s === 'comfortable' || s === 'default') setDensityState(s);
    } catch { /* ignore */ }
  }, [pageKey]);
  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    try { localStorage.setItem(`admin:density:${pageKey}`, d); } catch { /* ignore */ }
  }, [pageKey]);
  return [density, setDensity];
}

/** Vertical padding class for a row/card at the current density. */
export const densityPad: Record<Density, string> = {
  compact: 'py-1.5',
  default: 'py-3',
  comfortable: 'py-5',
};

export function DensityToggle({ density, setDensity }: { density: Density; setDensity: (d: Density) => void }) {
  const opts: Density[] = ['compact', 'default', 'comfortable'];
  return (
    <div className="inline-flex border border-dust" role="group" aria-label="Row density">
      {opts.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => setDensity(d)}
          title={d}
          aria-pressed={density === d}
          className={`px-2 py-1 text-xs ${density === d ? 'bg-charcoal text-bone' : 'text-saddle hover:bg-dust'}`}
        >
          {d === 'compact' ? '▪' : d === 'default' ? '▬' : '▭'}
        </button>
      ))}
    </div>
  );
}

// ── SAVED VIEWS ──────────────────────────────────────────────────────────────
// Named filter/sort/state presets, persisted per page in localStorage. The page
// owns the shape S of its view state (e.g. { query, sortKey, statusFilter }).
export interface SavedView<S> { name: string; state: S; }

export function useSavedViews<S>(pageKey: string) {
  const [views, setViews] = useState<SavedView<S>[]>([]);
  useEffect(() => {
    try {
      const s = localStorage.getItem(`admin:views:${pageKey}`);
      if (s) setViews(JSON.parse(s));
    } catch { /* ignore */ }
  }, [pageKey]);
  const persist = useCallback((v: SavedView<S>[]) => {
    setViews(v);
    try { localStorage.setItem(`admin:views:${pageKey}`, JSON.stringify(v)); } catch { /* ignore */ }
  }, [pageKey]);
  const save = useCallback((name: string, state: S) => {
    if (!name.trim()) return;
    persist([...views.filter((x) => x.name !== name), { name: name.trim(), state }]);
  }, [views, persist]);
  const remove = useCallback((name: string) => {
    persist(views.filter((x) => x.name !== name));
  }, [views, persist]);
  return { views, save, remove };
}

export function SavedViewsBar<S>({
  views,
  onApply,
  onSaveCurrent,
  onDelete,
}: {
  views: SavedView<S>[];
  onApply: (s: S) => void;
  onSaveCurrent: () => void;
  onDelete: (name: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <span className="text-xs text-saddle">Views:</span>
      {views.length === 0 && <span className="text-xs text-saddle/60">none saved</span>}
      {views.map((v) => (
        <span key={v.name} className="inline-flex items-center border border-dust text-xs">
          <button type="button" onClick={() => onApply(v.state)} className="px-2 py-1 text-charcoal hover:bg-dust">
            {v.name}
          </button>
          <button
            type="button"
            onClick={() => onDelete(v.name)}
            aria-label={`Delete view ${v.name}`}
            className="px-1.5 py-1 text-saddle hover:text-weathered border-l border-dust"
          >
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onSaveCurrent}
        className="px-2 py-1 text-xs border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone"
      >
        + Save current
      </button>
    </div>
  );
}

// ── CONFIRM GUARD ────────────────────────────────────────────────────────────
// Use before ANY one-click action that sends live email/SMS to real people.
// Shows the recipient count + an irreversibility warning. Returns true to proceed.
export function confirmBlast(count: number, action: string): boolean {
  if (count <= 0) {
    if (typeof window !== 'undefined') window.alert(`Nothing to ${action} — 0 recipients.`);
    return false;
  }
  if (typeof window === 'undefined') return false;
  return window.confirm(
    `${action} — this sends to ${count} real ${count === 1 ? 'person' : 'people'} and cannot be undone. Continue?`,
  );
}
