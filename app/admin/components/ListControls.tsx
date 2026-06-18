'use client';

import { useMemo, useState } from 'react';

export interface SortOption {
  /** Field key to sort by. Prefix with '-' for descending. */
  key: string;
  label: string;
}

/**
 * Reusable client-side search + sort for admin list pages. Operates on data
 * that's ALREADY loaded in the page (no new endpoints, no server round-trip).
 * Returns the filtered+sorted slice plus the bound state for <SearchSortBar>.
 *
 * Usage:
 *   const { filtered, ...bar } = useListSearch(referrals, {
 *     searchFields: ['buyer_name', 'buyer_email', 'suggested_rancher_name'],
 *     sortOptions: [{ key: '-created_at', label: 'Newest' }, { key: '-intent_score', label: 'Intent' }],
 *   });
 *   <SearchSortBar {...bar} placeholder="Search buyer / rancher…" resultCount={filtered.length} totalCount={referrals.length} />
 *   {filtered.map(...)}
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
        // Strings + ISO dates sort lexically correctly.
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
