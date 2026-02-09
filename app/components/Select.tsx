interface SelectProps {
  label?: string;
  name: string;
  required?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options?: { value: string; label: string }[];
  children?: React.ReactNode;
}

export default function Select({
  label,
  name,
  required = false,
  value,
  onChange,
  options,
  children
}: SelectProps) {
  return (
    <div className="space-y-2">
      {label && (
        <label htmlFor={name} className="block text-sm font-medium">
          {label} {required && <span className="text-[#8C2F2F]">*</span>}
        </label>
      )}
      <select
        id={name}
        name={name}
        required={required}
        value={value}
        onChange={onChange}
        className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-[#0E0E0E] focus:outline-none focus:border-[#0E0E0E] transition-colors"
      >
        {options ? (
          options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))
        ) : (
          children
        )}
      </select>
    </div>
  );
}

