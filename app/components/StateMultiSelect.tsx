'use client';

import { useState, useMemo } from 'react';
import { US_STATES } from '@/lib/states';

interface Props {
  // Comma-separated string of 2-letter codes (e.g. "MT, WY, ID")
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

// Multi-select grid of all 50 US states. Stores comma-separated 2-letter codes.
// Replaces the old free-text input that let ranchers type "Montana" — which the
// matching engine then failed to match against buyer state "MT".
export default function StateMultiSelect({ value, onChange, disabled }: Props) {
  const [filter, setFilter] = useState('');

  const selected = useMemo(() => {
    return new Set(
      value
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    );
  }, [value]);

  const visibleStates = useMemo(() => {
    if (!filter.trim()) return US_STATES;
    const f = filter.trim().toLowerCase();
    return US_STATES.filter(
      (s) => s.code.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)
    );
  }, [filter]);

  const toggle = (code: string) => {
    const next = new Set(selected);
    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }
    onChange(Array.from(next).join(', '));
  };

  const selectAll = () => {
    onChange(US_STATES.map((s) => s.code).join(', '));
  };

  const clearAll = () => {
    onChange('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter states (e.g. MT or Montana)"
          className="flex-1 px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
          disabled={disabled}
        />
        <span className="text-xs text-dust whitespace-nowrap">
          {selected.size} selected
        </span>
      </div>

      <div className="flex gap-3 text-xs">
        <button
          type="button"
          onClick={selectAll}
          disabled={disabled}
          className="text-saddle hover:text-charcoal underline disabled:opacity-50"
        >
          Select all 50
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={disabled}
          className="text-saddle hover:text-charcoal underline disabled:opacity-50"
        >
          Clear
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 max-h-80 overflow-y-auto border border-dust p-3 bg-white">
        {visibleStates.map((s) => {
          const isSelected = selected.has(s.code);
          return (
            <button
              key={s.code}
              type="button"
              onClick={() => toggle(s.code)}
              disabled={disabled}
              className={`text-left px-2 py-1.5 text-xs border transition-colors disabled:opacity-50 ${
                isSelected
                  ? 'border-charcoal bg-charcoal text-bone'
                  : 'border-dust bg-bone hover:border-charcoal'
              }`}
            >
              <span className="font-mono font-bold">{s.code}</span>{' '}
              <span className={isSelected ? 'opacity-90' : 'text-dust'}>{s.name}</span>
            </button>
          );
        })}
        {visibleStates.length === 0 && (
          <p className="col-span-full text-xs text-dust text-center py-4">
            No states match &ldquo;{filter}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}
