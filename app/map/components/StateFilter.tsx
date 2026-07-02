'use client';

export default function StateFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-[10px] uppercase tracking-wide text-saddle">State</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-dust bg-bone px-2 py-1.5 text-xs text-charcoal focus:border-charcoal focus:outline-none"
      >
        <option value="">All states</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}
