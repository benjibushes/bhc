interface TextareaProps {
  label: string;
  name: string;
  required?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  /** Browser autofill hint (autocomplete attribute). */
  autoComplete?: string;
  /**
   * Inline validation message. When set, the field renders in its error
   * state with the message below it (role="alert" so screen readers
   * announce blur-validation without a focus jump).
   */
  error?: string;
}

export default function Textarea({
  label,
  name,
  required = false,
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 4,
  autoComplete,
  error
}: TextareaProps) {
  const errorId = `${name}-error`;
  return (
    <div className="space-y-2">
      <label htmlFor={name} className="block text-sm font-medium">
        {label} {required && <span className="text-weathered">*</span>}
      </label>
      <textarea
        id={name}
        name={name}
        required={required}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        rows={rows}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full px-4 py-3 border bg-bone text-charcoal transition-colors resize-y ${
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
