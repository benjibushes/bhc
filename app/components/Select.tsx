interface SelectProps {
  label?: string;
  name: string;
  required?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLSelectElement>) => void;
  options?: { value: string; label: string }[];
  children?: React.ReactNode;
  /** Browser autofill hint (autocomplete attribute), e.g. "address-level1". */
  autoComplete?: string;
  /**
   * Inline validation message. When set, the field renders in its error
   * state with the message below it (role="alert" so screen readers
   * announce blur-validation without a focus jump).
   */
  error?: string;
}

export default function Select({
  label,
  name,
  required = false,
  value,
  onChange,
  onBlur,
  options,
  children,
  autoComplete,
  error
}: SelectProps) {
  const errorId = `${name}-error`;
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
        onBlur={onBlur}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full px-4 py-3 border bg-bone text-charcoal transition-colors ${
          error ? 'border-weathered' : 'border-dust focus:border-charcoal'
        }`}
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
      {error && (
        <p id={errorId} role="alert" className="text-sm text-weathered">
          {error}
        </p>
      )}
    </div>
  );
}
