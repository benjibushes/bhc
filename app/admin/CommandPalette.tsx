'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { ADMIN_NAV } from './nav';

interface SearchResult {
  type: 'consumer' | 'rancher';
  id: string;
  name: string;
  subtitle: string;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Cmd-K / Ctrl-K toggles the palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape' && open) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Reset search state when closed
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data.results || []);
        }
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 180);
    return () => clearTimeout(t);
  }, [query]);

  const go = (path: string) => {
    setOpen(false);
    router.push(path);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 flex items-start justify-center pt-[15vh] px-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl bg-white border border-dust shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command Menu" shouldFilter={false}>
          <div className="border-b border-dust px-4">
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search buyers, ranchers, or jump to a page…"
              className="w-full py-4 text-base bg-transparent outline-none placeholder:text-dust"
              autoFocus
            />
          </div>
          <Command.List className="max-h-[55vh] overflow-auto p-2">
            {query.length < 2 && (
              <Command.Group heading="Jump to" className="text-xs text-dust px-2 pb-1 uppercase tracking-wider">
                {ADMIN_NAV.map((item) => (
                  <PaletteItem
                    key={item.href}
                    onSelect={() => go(item.href)}
                    label={`${item.icon} ${item.label}`}
                    shortcut={item.shortcut}
                  />
                ))}
              </Command.Group>
            )}

            {query.length >= 2 && loading && (
              <div className="px-4 py-3 text-sm text-dust">Searching…</div>
            )}

            {query.length >= 2 && !loading && results.length === 0 && (
              <div className="px-4 py-3 text-sm text-dust">No matches for &ldquo;{query}&rdquo;</div>
            )}

            {results.length > 0 && (
              <Command.Group heading="Matches" className="text-xs text-dust px-2 pb-1 uppercase tracking-wider">
                {results.map((r) => (
                  <PaletteItem
                    key={`${r.type}-${r.id}`}
                    onSelect={() => go(r.type === 'consumer' ? `/admin/consumers/${r.id}` : `/admin/ranchers/${r.id}`)}
                    label={`${r.type === 'consumer' ? '👤' : '🤠'} ${r.name}`}
                    subtitle={r.subtitle}
                  />
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function PaletteItem({
  onSelect,
  label,
  subtitle,
  shortcut,
}: {
  onSelect: () => void;
  label: string;
  subtitle?: string;
  shortcut?: string;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center justify-between px-3 py-2 text-sm cursor-pointer rounded data-[selected=true]:bg-bone"
    >
      <div className="flex-1">
        <div className="text-charcoal">{label}</div>
        {subtitle && <div className="text-xs text-dust mt-0.5">{subtitle}</div>}
      </div>
      {shortcut && <span className="text-xs text-dust font-mono">{shortcut}</span>}
    </Command.Item>
  );
}
