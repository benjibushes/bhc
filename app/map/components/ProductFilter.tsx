'use client';

export default function ProductFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="text-sm flex items-center gap-2">
      <span className="text-[#6B4F3F]">Product</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC] text-[#0E0E0E]"
      >
        <option value="">All products</option>
        {options.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </label>
  );
}
