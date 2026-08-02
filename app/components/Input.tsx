interface InputProps {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  placeholder?: string;
  /**
   * Browser autofill hint (autocomplete attribute). Pass "email", "name",
   * "tel", "postal-code", … — without it, autofill on mobile is a coin flip.
   */
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  /**
   * Inline validation message. When set, the field renders in its error
   * state with the message below it (aria-live so screen readers announce
   * it on blur-validation without a focus jump).
   */
  error?: string;
}

export default function Input({
  label,
  name,
  type = "text",
  required = false,
  value,
  onChange,
  onBlur,
  placeholder,
  autoComplete,
  inputMode,
  error
}: InputProps) {
  const errorId = `${name}-error`;
  return (
    <div className="space-y-2">
      <label htmlFor={name} className="block text-sm font-medium">
        {label} {required && <span className="text-weathered">*</span>}
      </label>
      <input
        type={type}
        id={name}
        name={name}
        required={required}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full px-4 py-3 border bg-bone text-charcoal transition-colors ${
          error ? 'border-weathered' : 'border-dust focus:border-charcoal'
        }`}
      />
      {error && (
        <p id={errorId} role="alert" className="text-sm text-weathered">
          {error}
        </p>
      )}
    </div>
  );
}
