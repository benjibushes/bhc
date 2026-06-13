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
          {label} {required && <span className="text-weathered">*</span>}
        </label>
      )}
      <select
        id={name}
        name={name}
        required={required}
        value={value}
        onChange={onChange}
        className="w-full px-4 py-3 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal transition-colors"
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

