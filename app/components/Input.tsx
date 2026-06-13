interface InputProps {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  placeholder?: string;
}

export default function Input({
  label,
  name,
  type = "text",
  required = false,
  value,
  onChange,
  onBlur,
  placeholder
}: InputProps) {
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
        className="w-full px-4 py-3 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal transition-colors"
      />
    </div>
  );
}


